"""Regression tests for the 2026-11-03 code review fixes."""

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import documents
from backend.app import create_app
from backend.learning import wants_recall
from backend.store import AUTOMATIC_VERSIONS_KEPT

FIXTURES = Path(__file__).parent / "fixtures"


class Boundary:
    def __init__(self):
        self.during = None

    def available(self):
        return {"available": True}

    def ask(self, prompt, **options):
        if self.during:
            self.during()
        return {"text": "导师回复", "thread_id": options.get("thread_id") or "thread"}


@pytest.fixture
def app_session(tmp_path):
    model = Boundary()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def test_docling_source_validation_returns_the_pdf_page_count():
    assert documents._validate_docling_source(FIXTURES / "sample-text-formula-table.pdf") >= 1


@pytest.mark.parametrize("message", ["我忘了，帮我找回思路", "回忆一下", "Recall", "忘记之前说的了"])
def test_bare_recall_commands_show_saved_history(message):
    assert wants_recall(message)


@pytest.mark.parametrize("message", ["帮我回忆一下定义", "能回忆一下第二步吗", "我忘了这个公式怎么推"])
def test_questions_that_mention_recall_still_reach_the_tutor(message):
    assert not wants_recall(message)


def test_edit_to_another_node_during_ai_keeps_the_reply(app_session):
    client, store, model, course = app_session
    first, other = course["nodes"][0]["id"], course["nodes"][1]["id"]

    def mark_other_node():
        with store.edit(course["id"]) as (current, _):
            next(n for n in current["nodes"] if n["id"] == other)["status"] = "studied"

    model.during = mark_other_node
    response = client.post(f"/api/courses/{course['id']}/nodes/{first}/chat", json={"message": "解释一下"})
    assert response.status_code == 200, response.text
    saved = store.course(course["id"])
    assert [c["content"] for c in saved["nodes"][0]["chats"][-2:]] == ["解释一下", "导师回复"]
    assert saved["nodes"][1]["status"] == "studied"


def test_duplicate_upload_leaves_no_orphan_copy(app_session):
    client, store, _, course = app_session
    url = f"/api/courses/{course['id']}/materials"
    note = ("note.txt", io.BytesIO("同一份笔记".encode()), "text/plain")
    assert client.post(url, files={"files": note}).status_code == 200
    note = ("note.txt", io.BytesIO("同一份笔记".encode()), "text/plain")
    assert client.post(url, files={"files": note}).status_code == 200
    saved = store.course(course["id"])
    on_disk = {p.name for p in (store.root / "courses" / course["id"] / "materials").iterdir()}
    assert on_disk == {m["id"] for m in saved["materials"]}


def test_failed_batch_import_removes_every_copied_file(app_session):
    client, store, _, course = app_session
    materials = store.root / "courses" / course["id"] / "materials"
    before = set(materials.iterdir()) if materials.exists() else set()
    files = [
        ("files", ("good.txt", io.BytesIO(b"fine"), "text/plain")),
        ("files", ("bad.exe", io.BytesIO(b"nope"), "application/octet-stream")),
    ]
    assert client.post(f"/api/courses/{course['id']}/materials", files=files).status_code == 400
    after = set(materials.iterdir()) if materials.exists() else set()
    assert after == before


def test_automatic_backups_are_pruned_but_manual_saves_stay(app_session):
    client, store, _, course = app_session
    client.post(f"/api/courses/{course['id']}/snapshot")
    for _ in range(AUTOMATIC_VERSIONS_KEPT + 5):
        with store.edit(course["id"]) as (current, connection):
            store.snapshot(current, "生成地图前自动备份", connection)
    reasons = [v["reason"] for v in store.versions(course["id"])]
    assert reasons.count("生成地图前自动备份") == AUTOMATIC_VERSIONS_KEPT
    assert "手动保存" in reasons and "示例课程初始状态" in reasons


def _long_pdf(pages):
    from reportlab.pdfgen import canvas as pdf_canvas
    buffer = io.BytesIO()
    output = pdf_canvas.Canvas(buffer)
    for number in range(1, pages + 1):
        output.drawString(20, 20, f"page {number}")
        output.showPage()
    output.save()
    return buffer.getvalue()


def test_pdf_over_page_limit_is_split_into_parts_and_reimport_is_a_duplicate(app_session):
    client, store, _, course = app_session
    url = f"/api/courses/{course['id']}/materials"
    data = _long_pdf(450)
    assert client.post(url, files={"files": ("book.pdf", io.BytesIO(data), "application/pdf")}).status_code == 200
    saved = [m for m in store.course(course["id"])["materials"] if m["name"].startswith("book.pdf")]
    assert [m["name"] for m in saved] == ["book.pdf（第 1–200 页）", "book.pdf（第 201–400 页）", "book.pdf（第 401–450 页）"]
    assert [len(m["pages"]) for m in saved] == [200, 200, 50]
    assert "page 201" in saved[1]["pages"][0]["text"]
    on_disk = {p.name for p in (store.root / "courses" / course["id"] / "materials").iterdir()}
    assert on_disk == {m["id"] for m in store.course(course["id"])["materials"]}
    # The same book again adds nothing and leaves no copies behind.
    assert client.post(url, files={"files": ("book.pdf", io.BytesIO(data), "application/pdf")}).status_code == 200
    assert len([m for m in store.course(course["id"])["materials"] if m["name"].startswith("book.pdf")]) == 3
    assert {p.name for p in (store.root / "courses" / course["id"] / "materials").iterdir()} == on_disk
