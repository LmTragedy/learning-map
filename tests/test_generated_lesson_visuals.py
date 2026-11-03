"""Lesson requests, page images and durable legacy receipts (visual-era receipts still recover)."""

import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.learning import _strict_output_schema
from backend.lessons import LessonDraft


def legacy_lesson_draft():
    return {
        "title": "关系中的一行",
        "goal": "用选课记录理解关系中的一行。",
        "html": (
            "<h2>看一个例子</h2><p>Enrollment 的每一行表示一次选课。</p>"
            "<script>alert('blocked')</script>"
        ),
        "check_question": "两行选课记录是否一定来自两个学生？",
        "check_answer": "不一定，同一学生可以选多门课。",
        "recap": "一行表示一条记录。",
    }


class VisualLessonModel:
    def __init__(self):
        self.replies = []
        self.calls = []

    def ask(self, prompt, **options):
        images = options.get("images", [])
        assert all(path.exists() for path in images)
        self.calls.append((prompt, options))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(prompt, options)
        return {"text": json.dumps(reply, ensure_ascii=False), "thread_id": "visual-lesson-thread"}


@pytest.fixture
def visual_lesson_session(tmp_path):
    model = VisualLessonModel()
    app = create_app(tmp_path / "data", lambda _settings: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app, app.state.store, model, course


def _lesson_path(course, node_id=None):
    node_id = node_id or course["nodes"][0]["id"]
    return f"/api/courses/{course['id']}/nodes/{node_id}/lessons"


def test_existing_lesson_initial_request_returns_unchanged_without_external_work(visual_lesson_session):
    client, _app, store, model, course = visual_lesson_session
    saved = legacy_lesson_draft() | {
        "id": "old-lesson-record",
        "created_at": "2026-10-20T00:00:00+00:00",
        "read_at": "2026-10-21T00:00:00+00:00",
        "kind": "initial",
        "focus": "",
        "request_id": "old-lesson-request-0001",
        "sources": [],
        "visuals": [{"id": "legacy-visual", "number": 1, "kind": "example", "provenance": "invented"}],
    }
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0].setdefault("lessons", []).append(copy.deepcopy(saved))
    before = store.course(course["id"])

    response = client.post(_lesson_path(course), json={
        "request_id": "initial-after-old-lesson-01", "kind": "initial", "focus": "",
    })

    assert response.status_code == 200, response.text
    after = store.course(course["id"])
    assert after == before
    returned = response.json()["nodes"][0]["lessons"]
    assert len(returned) == 1 and returned[0]["id"] == saved["id"]
    assert returned[0]["visuals"] == saved["visuals"]
    assert model.calls == []


def test_old_pending_lesson_receipt_recovers_with_saved_legacy_contract(visual_lesson_session, monkeypatch):
    client, _app, store, model, course = visual_lesson_session
    model.replies.append(legacy_lesson_draft())
    save = store.save_course
    first_save = True

    def fail_first_course_save(current, connection):
        nonlocal first_save
        if first_save:
            first_save = False
            raise OSError("simulated course persistence failure")
        return save(current, connection)

    monkeypatch.setattr(store, "save_course", fail_first_course_save)
    failed_client = TestClient(_app, raise_server_exceptions=False, headers={"X-Learning-Map": "1"})
    failed = failed_client.post(_lesson_path(course), json={
        "request_id": "legacy-recovery-request-01", "kind": "initial", "focus": "",
    })
    assert failed.status_code == 500
    task = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]
    task_id = task["id"]
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()
    assert detail["raw_reply"]["text"]
    calls_before_recovery = len(model.calls)

    # Emulate a durable receipt created before `visuals` was added to LessonDraft.
    with store.connect() as connection:
        row = connection.execute("SELECT body FROM ai_tasks WHERE id=?", (task_id,)).fetchone()
        body = json.loads(row["body"])
        body["request"]["prompt"] = "saved legacy lesson prompt"
        body["request"]["schema"] = _strict_output_schema(LessonDraft.model_json_schema())
        body["raw_reply"]["text"] = json.dumps(legacy_lesson_draft(), ensure_ascii=False)
        connection.execute("UPDATE ai_tasks SET body=? WHERE id=?", (json.dumps(body, ensure_ascii=False), task_id))

    monkeypatch.setattr(store, "save_course", save)
    restarted = TestClient(create_app(store.root, lambda _settings: model), headers={"X-Learning-Map": "1"})
    recovered = restarted.post(f"/api/courses/{course['id']}/ai-tasks/{task_id}/recover")

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    lesson = recovered.json()["course"]["nodes"][0]["lessons"][0]
    assert lesson["title"] == legacy_lesson_draft()["title"]
    assert "visuals" not in lesson
    assert len(model.calls) == calls_before_recovery
    final_receipt = restarted.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()
    assert final_receipt["request"]["prompt"] == "saved legacy lesson prompt"
    assert final_receipt["request"]["schema"] == _strict_output_schema(LessonDraft.model_json_schema())


def test_new_lessons_send_page_images_and_checklist_without_a_visual_contract(visual_lesson_session):
    client, _app, store, model, course = visual_lesson_session
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["pieces"] = [{"id": "p1", "kind": "定义", "title": "CHECKLIST_PIECE", "detail": "d"}]
        current["nodes"][0]["steps"] = [{"id": "s1", "title": "CHECKLIST_STEP"}]
    model.replies.append(legacy_lesson_draft())
    response = client.post(_lesson_path(course), json={
        "request_id": "plain-lesson-request-0001", "kind": "initial", "focus": "",
    })
    assert response.status_code == 200, response.text
    lesson = response.json()["nodes"][0]["lessons"][0]
    assert "visuals" not in lesson
    prompt, options = model.calls[-1]
    assert options["images"] and all(path.is_file() for path in options["images"])
    assert options["schema"] == _strict_output_schema(LessonDraft.model_json_schema())
    assert "CHECKLIST_PIECE" in prompt and "CHECKLIST_STEP" in prompt
    assert '"image_provided": true' in prompt and "visuals" not in prompt

