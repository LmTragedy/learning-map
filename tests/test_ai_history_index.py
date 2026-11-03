"""Integration coverage for importing legacy turns as read-only history."""

import json

from fastapi.testclient import TestClient

from backend.ai_history_import import import_legacy_receipt
from backend.ai_legacy_history import scan_legacy_history
from backend.app import create_app
from backend.lesson_html import render_lesson
from backend.lessons import LessonRequest, _lesson_context


def lesson_draft(title="A short lesson"):
    return {
        "title": title,
        "goal": "Use a small example to understand one idea.",
        "html": "<p>One student selects two courses. Each selection is a separate record.</p>",
        "check_question": "Do two records always mean two students?",
        "check_answer": "No. One student can make two selections.",
        "recap": "A record describes one selection.",
    }


class HistoryModel:
    def __init__(self, replies=None, thread_id="generated-thread", turn_id="generated-turn"):
        self.replies = list(replies or [])
        self.thread_id, self.turn_id = thread_id, turn_id

    def available(self):
        return {"available": True, "test_boundary": True}

    def ask(self, _prompt, **_options):
        return {
            "text": json.dumps(self.replies.pop(0), ensure_ascii=False),
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
        }


def make_session(tmp_path, model):
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, course


def lesson_prompt(course, node, request):
    return "Teach integration.\n学习上下文：\n" + _lesson_context(course, node, request)


def write_rollout(root, cwd, turns, thread_id="legacy-thread"):
    rows = [{"type": "session_meta", "payload": {"session_id": thread_id, "cwd": str(cwd)}}]
    for turn_id, prompt, reply, complete in turns:
        rows.append({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn_id}})
        rows.append({"type": "response_item", "payload": {
            "type": "message", "role": "user", "content": [{"type": "text", "text": prompt}],
        }})
        rows.append({"type": "response_item", "payload": {
            "type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "text", "text": reply}],
        }})
        if complete:
            rows.append({"type": "event_msg", "payload": {
                "type": "task_complete", "turn_id": turn_id, "last_agent_message": reply,
            }})
    path = root / "2026" / "11" / "03" / "rollout.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")


def test_import_recognizes_rendered_lesson_as_already_applied_without_writing_course(tmp_path):
    model = HistoryModel([lesson_draft()])
    client, store, course = make_session(tmp_path, model)
    cid, node = course["id"], course["nodes"][0]
    request = LessonRequest(request_id="lesson-live-request-01", kind="initial", focus="")
    prompt = lesson_prompt(course, node, request)
    current = client.post(
        f"/api/courses/{cid}/nodes/{node['id']}/lessons", json=request.model_dump(),
    )
    assert current.status_code == 200, current.text
    saved = store.course(cid)
    current_lesson = saved["nodes"][0]["lessons"][0]
    assert current_lesson["html"] == render_lesson(lesson_draft(), current_lesson["sources"])

    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    raw = json.dumps(lesson_draft(), ensure_ascii=False)
    write_rollout(tmp_path / "sessions", cwd, [("old-lesson-turn", prompt, raw, True)])
    candidate = scan_legacy_history(tmp_path / "sessions", cwd, [saved])[0]
    revision = saved["revision"]

    tasks = client.app.state.learning.tasks
    imported = import_legacy_receipt(tasks, cid, candidate)
    repeated = import_legacy_receipt(tasks, cid, candidate)

    assert imported["history_disposition"] == "already_applied"
    assert imported["result_object"]["id"] == current_lesson["id"]
    assert repeated["id"] == imported["id"]
    assert store.course(cid)["revision"] == revision


def test_same_prompt_keeps_distinct_turns_and_reuses_existing_local_turn(tmp_path):
    model = HistoryModel([lesson_draft()], thread_id="legacy-thread", turn_id="existing-turn")
    client, store, course = make_session(tmp_path, model)
    cid, node = course["id"], course["nodes"][0]
    request = LessonRequest(request_id="lesson-live-request-02", kind="initial", focus="")
    prompt = lesson_prompt(course, node, request)
    generated = client.post(
        f"/api/courses/{cid}/nodes/{node['id']}/lessons", json=request.model_dump(),
    )
    assert generated.status_code == 200, generated.text
    live_task = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    raw = json.dumps(lesson_draft(), ensure_ascii=False)
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [
        ("existing-turn", prompt, raw, True),
        ("second-turn", prompt, raw, True),
    ])
    candidates = scan_legacy_history(tmp_path / "sessions", cwd, [store.course(cid)])

    tasks = client.app.state.learning.tasks
    first = import_legacy_receipt(tasks, cid, candidates[0])
    second = import_legacy_receipt(tasks, cid, candidates[1])

    assert [candidate["turn_id"] for candidate in candidates] == ["existing-turn", "second-turn"]
    assert first["id"] == live_task["id"]
    assert second["id"] != first["id"]
    assert len(client.get(f"/api/courses/{cid}/ai-tasks").json()) == 2


def test_nonmatching_completed_history_raw_is_readable_but_cannot_recover_or_regenerate(tmp_path):
    model = HistoryModel()
    client, store, course = make_session(tmp_path, model)
    cid, node = course["id"], course["nodes"][0]
    request = LessonRequest(request_id="lesson-old-request-03", kind="initial", focus="")
    prompt = lesson_prompt(course, node, request)
    raw = json.dumps(lesson_draft("Unmatched old lesson"), ensure_ascii=False)
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [("nonmatching-turn", prompt, raw, True)])
    candidate = scan_legacy_history(tmp_path / "sessions", cwd, [store.course(cid)])[0]
    task = import_legacy_receipt(client.app.state.learning.tasks, cid, candidate)
    path = f"/api/courses/{cid}/ai-tasks/{task['id']}"

    detail = client.get(path)
    result = client.get(path + "/result")
    recovered = client.post(path + "/recover")
    regenerated = client.post(path + "/regenerate", json={"request_id": "retry-history-0001"})

    assert detail.status_code == result.status_code == 200
    assert task["history_only"]
    assert task["history_disposition"] == "recovered"
    assert detail.json()["historical_raw"] == raw
    assert result.json()["object"] == candidate["parsed_output"]
    assert recovered.status_code == regenerated.status_code == 409
    assert client.get(f"/api/courses/{cid}/ai-tasks/{task['id']}").json()["state"] == "archived"
