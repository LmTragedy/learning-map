"""Integration coverage for recovering source visuals from saved lesson citations."""

import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


class NoModelCalls:
    def ask(self, *_args, **_kwargs):
        raise AssertionError("visual recovery must not call a generation model")

    def read_turn(self, *_args, **_kwargs):
        raise AssertionError("visual recovery must not query model history")


@pytest.fixture
def visual_session(tmp_path):
    app = create_app(tmp_path / "data", lambda _settings: NoModelCalls())
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    store = app.state.store
    with store.edit(course["id"]) as (current, _connection):
        node = current["nodes"][0]
        material = current["materials"][0]
        page = material["pages"][0]
        quote = page["text"].splitlines()[0]
        node["sources"] = [dict(material_id=material["id"], page=1, quote=quote)]
        node.setdefault("lessons", []).append(dict(
            id="lesson-visual-test",
            title="示例小课",
            goal="从课程原文理解一个例子。",
            html="<!doctype html><html><body>existing lesson html</body></html>",
            check_question="如何核对原文？",
            check_answer="回到对应页核对。",
            recap="对照来源页。",
            read_at="2026-11-03T00:00:00+00:00",
            request_id="lesson-request-visual-0001",
            sources=[dict(name=material["name"], material_id=material["id"], page=1, quote=quote)],
            review_scope_key="course",
            material_ids=[],
            visuals=[dict(id="kept-visual", number=1, kind="example", provenance="source", quote=quote,
                          material_id=material["id"], page=1, matched=True)],
        ))
    course = store.course(course["id"])
    lesson = course["nodes"][0]["lessons"][0]
    base = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/lessons/{lesson['id']}/visuals/recover"
    return client, store, course, lesson, base


def test_recovery_persists_source_visuals_and_page_png_across_restart(visual_session):
    client, store, course, lesson, endpoint = visual_session
    revision = store.course(course["id"])["revision"]

    response = client.post(endpoint, json={"revision": revision})

    assert response.status_code == 200, response.text
    saved_lesson = response.json()["nodes"][0]["lessons"][0]
    visuals = saved_lesson["visuals"]
    assert any(item["kind"] == "example" and item.get("source", {}).get("matched") for item in visuals)
    figure = next(item for item in visuals if item["kind"] == "figure" and item.get("source"))
    assert figure["source"]["page"] == 1
    material_id = figure["source"]["material_id"]
    page_response = client.get(f"/api/courses/{course['id']}/materials/{material_id}/pages/1")
    assert page_response.status_code == 200
    assert page_response.headers["content-type"].startswith("image/png")
    assert page_response.content.startswith(b"\x89PNG\r\n\x1a\n")

    restarted = TestClient(create_app(store.root, lambda _settings: NoModelCalls()),
                           headers={"X-Learning-Map": "1"})
    reopened = restarted.get(f"/api/courses/{course['id']}").json()
    reopened_lesson = reopened["nodes"][0]["lessons"][0]
    assert reopened_lesson["visuals"] == visuals
    html_response = restarted.get(
        f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/lessons/{lesson['id']}/html"
    )
    assert html_response.status_code == 200
    assert "existing lesson html" in html_response.text
    assert restarted.get(f"/api/courses/{course['id']}/materials/{material_id}/pages/1").content.startswith(
        b"\x89PNG\r\n\x1a\n"
    )
    raw_lesson = store.course(course["id"])["nodes"][0]["lessons"][0]
    assert raw_lesson["html"] == lesson["html"]
    assert raw_lesson["read_at"] == lesson["read_at"]


def test_recovery_is_idempotent_and_does_not_advance_revision_on_repeat(visual_session):
    client, store, course, _lesson, endpoint = visual_session
    revision = store.course(course["id"])["revision"]
    first = client.post(endpoint, json={"revision": revision})
    assert first.status_code == 200, first.text
    after_first = store.course(course["id"])
    first_visuals = after_first["nodes"][0]["lessons"][0]["visuals"]
    second = client.post(endpoint, json={"revision": after_first["revision"]})
    assert second.status_code == 200, second.text
    after_second = store.course(course["id"])

    assert after_second["revision"] == after_first["revision"]
    assert after_second["nodes"][0]["lessons"][0]["visuals"] == first_visuals
    assert sum(item["kind"] == "figure" for item in first_visuals) == sum(
        item["kind"] == "figure" for item in after_second["nodes"][0]["lessons"][0]["visuals"]
    )


@pytest.mark.parametrize("failure", ["bad_page", "cross_scope", "stale_revision"])
def test_invalid_recovery_request_leaves_course_unchanged(visual_session, failure):
    client, store, course, lesson, endpoint = visual_session
    current = store.course(course["id"])
    body = {"revision": current["revision"]}
    if failure == "bad_page":
        body["processes"] = [dict(title="不合法流程", material_id=lesson["sources"][0]["material_id"], pages=[1, 999])]
    elif failure == "cross_scope":
        other = current["materials"][1]["id"] if len(current["materials"]) > 1 else "outside-scope-material"
        with store.edit(course["id"]) as (updated, _connection):
            updated["review_scope"] = dict(enabled=True, material_ids=[other], ai_scope="selected")
        current = store.course(course["id"])
        body["revision"] = current["revision"]
    else:
        body["revision"] -= 1
    before = store.course(course["id"])

    response = client.post(endpoint, json=body)

    assert response.status_code in {400, 404, 409, 422}
    assert store.course(course["id"]) == before


def test_unmatched_quote_is_not_claimed_as_source_evidence(visual_session):
    client, store, course, lesson, endpoint = visual_session
    with store.edit(course["id"]) as (current, _connection):
        current_lesson = current["nodes"][0]["lessons"][0]
        current_lesson["sources"][0]["quote"] = "这段内容并不存在于来源页。"
    current = store.course(course["id"])

    response = client.post(endpoint, json={"revision": current["revision"]})

    assert response.status_code == 200, response.text
    visuals = response.json()["nodes"][0]["lessons"][0]["visuals"]
    assert all(item["source"]["matched"] is False for item in visuals
               if item["kind"] == "example" and item.get("source"))
    assert store.course(course["id"])["nodes"][0]["lessons"][0]["read_at"] == lesson["read_at"]


def test_recovery_preserves_existing_visuals_and_rejects_client_supplied_urls(visual_session):
    client, store, course, _lesson, endpoint = visual_session
    before = store.course(course["id"])
    existing = copy.deepcopy(before["nodes"][0]["lessons"][0]["visuals"])
    revision = before["revision"]

    unsafe = client.post(endpoint, json={"revision": revision, "image_url": "https://example.invalid/evil.png"})

    assert unsafe.status_code == 422
    assert store.course(course["id"]) == before
    safe = client.post(endpoint, json={"revision": revision})
    assert safe.status_code == 200, safe.text
    saved = store.course(course["id"])["nodes"][0]["lessons"][0]
    assert next(item for item in saved["visuals"] if item["id"] == "kept-visual") == existing[0]
    assert all("image_url" not in item for item in saved["visuals"])


@pytest.mark.parametrize("malformed", [[{"id": "missing-number"}], None])
def test_malformed_saved_visuals_are_rejected_without_writes(visual_session, malformed):
    client, store, course, _lesson, endpoint = visual_session
    with store.edit(course["id"]) as (current, _connection):
        current["nodes"][0]["lessons"][0]["visuals"] = malformed
    before = store.course(course["id"])

    response = client.post(endpoint, json={"revision": before["revision"]})

    assert response.status_code == 400
    assert store.course(course["id"]) == before


def test_recovery_updates_an_available_lesson_receipt_without_changing_raw_reply(visual_session):
    client, store, course, lesson, endpoint = visual_session
    from backend.ai_result_refs import result_record
    from backend.store import timestamp

    task = dict(
        id="visual-receipt-task",
        course_id=course["id"],
        kind="lesson",
        target=course["nodes"][0]["id"],
        state="applied",
        request_id=lesson["request_id"],
        before=store.course(course["id"]),
        raw_reply={"text": '{"title":"original raw response"}', "thread_id": "visual-receipt-thread"},
        created_at=timestamp(),
    )
    task.update(result_record(task, task["before"]))
    with store.connect() as connection:
        connection.execute(
            "INSERT INTO ai_tasks VALUES(?,?,?,?,?,?,?,?)",
            (task["id"], task["course_id"], "visual-receipt-request", task["kind"], task["target"],
             task["state"], json.dumps({key: value for key, value in task.items()
                                       if key not in {"id", "course_id", "kind", "target", "state"}},
                                       ensure_ascii=False), timestamp()),
        )
    original_raw = task["raw_reply"]

    response = client.post(endpoint, json={"revision": task["before"]["revision"]})

    assert response.status_code == 200, response.text
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    saved_visuals = store.course(course["id"])["nodes"][0]["lessons"][0]["visuals"]
    assert detail["result_ref"]["available"] is True
    assert detail["result_object"]["visuals"] == saved_visuals
    assert detail["raw_reply"] == original_raw


def test_user_supplied_process_stores_and_restores_exact_source_pages(visual_session):
    client, store, course, lesson, endpoint = visual_session
    material_id = lesson["sources"][0]["material_id"]
    response = client.post(endpoint, json={
        "revision": store.course(course["id"])["revision"],
        "processes": [dict(title="按页理解事务", material_id=material_id, pages=[1, 2])],
    })

    assert response.status_code == 200, response.text
    process = next(item for item in response.json()["nodes"][0]["lessons"][0]["visuals"]
                   if item["kind"] == "process")
    pages = [step["page"] for step in process["steps"]]
    assert pages == [1, 2]
    for step, page_number in zip(process["steps"], pages, strict=True):
        original_text = store.course(course["id"])["materials"][0]["pages"][page_number - 1]["text"]
        assert step["quote"]
        assert " ".join(step["quote"].split()) in " ".join(original_text.split())
        assert step["matched"] is True
        assert step["uncertain"] is False
    assert process["source"]["matched"] is True
    assert process["source"]["uncertain"] is False

    restarted = TestClient(create_app(store.root, lambda _settings: NoModelCalls()),
                           headers={"X-Learning-Map": "1"})
    restored = restarted.get(f"/api/courses/{course['id']}").json()["nodes"][0]["lessons"][0]
    restored_process = next(item for item in restored["visuals"] if item["kind"] == "process")
    assert restored_process == process
    for page_number in pages:
        image = restarted.get(
            f"/api/courses/{course['id']}/materials/{material_id}/pages/{page_number}"
        )
        assert image.status_code == 200
        assert image.content.startswith(b"\x89PNG\r\n\x1a\n")
