"""Integration checks for durable AI task receipts across provider and API boundaries."""

import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.ai import CodexAI
from backend.ai_tasks import TaskManager
from backend.app import create_app


class _CapturedInput(io.BytesIO):
    def close(self):
        self.saved = self.getvalue()
        super().close()

    def getvalue(self):
        return self.saved if self.closed else super().getvalue()


class FakeAppServer:
    def __init__(self, messages):
        self.stdin = _CapturedInput()
        self.stdout = io.BytesIO(
            b"".join(json.dumps(message).encode("utf-8") + b"\n" for message in messages)
        )
        self.stderr = io.BytesIO()
        self.returncode = None

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        self.returncode = self.returncode or 0
        return self.returncode


def rpc(request_id, result):
    return {"id": request_id, "result": result}


def app_server_messages(text="A concise answer.", *, metadata_failure=False):
    events = [rpc(1, {}), rpc(2, {"thread": {"id": "thread-integration"}})]
    if metadata_failure:
        events.append({"id": 4, "error": {"code": -32000, "message": "metadata unavailable"}})
    else:
        events.append(rpc(4, {}))
    events.extend([
        rpc(3, {}),
        {"method": "item/agentMessage/delta", "params": {
            "delta": text, "itemId": "item-1", "threadId": "thread-integration", "turnId": "turn-integration",
        }},
        {"method": "turn/completed", "params": {
            "threadId": "thread-integration", "turn": {"id": "turn-integration", "status": "completed"},
        }},
    ])
    return events


def app_server_failed_turn_messages():
    return [
        rpc(1, {}),
        rpc(2, {"thread": {"id": "thread-integration"}}),
        {"id": 4, "error": {"code": -32000, "message": "metadata unavailable"}},
        rpc(3, {}),
        {"method": "turn/completed", "params": {
            "threadId": "thread-integration", "turn": {"id": "turn-integration", "status": "failed"},
        }},
    ]


def bridge_reply(prompt, seen=None):
    relation_text = prompt.split("\n联系：", 1)[1].split("\n材料：", 1)[0]
    relations = json.loads(relation_text)
    if seen is not None:
        seen.extend(relation["id"] for relation in relations)
    return json.dumps({
        "nodes": [],
        "relations": [{"id": relation["id"], "bridges": [{
            "piece": {"kind": "性质", "title": "传递性", "detail": "关系可沿两步传递。", "sources": []},
            "step": "连接两步", "how": "利用传递性完成推导。", "if_missing": "不能连接两步。",
            "strength": "required", "check_question": "两步可推出什么？", "check_answer": "推出第三步。",
            "sources": [], "uncertain": True,
        }]} for relation in relations],
    }, ensure_ascii=False)


class ScriptedModel:
    def __init__(self, reply=None):
        self.reply = reply
        self.ask_count = 0
        self.entered = threading.Event()
        self.release = threading.Event()

    def available(self):
        return {"available": True}

    def ask(self, prompt, **options):
        self.ask_count += 1
        self.entered.set()
        if self.release.is_set() is False and self.reply == "block":
            if not self.release.wait(timeout=8):
                raise TimeoutError("test release was not signaled")
        if isinstance(self.reply, BaseException):
            raise self.reply
        reply = self.reply(prompt) if callable(self.reply) else self.reply
        return {"text": reply, "thread_id": "scripted-thread", "turn_id": "scripted-turn"}


@pytest.fixture
def session(tmp_path):
    model = ScriptedModel("A concise answer.")
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def _chat_path(course, node_index=0):
    return f"/api/courses/{course['id']}/nodes/{course['nodes'][node_index]['id']}/chat"


def test_codex_app_server_metadata_failure_keeps_completed_raw_receipt_and_applies_task(session):
    client, store, _, course = session
    client.post("/api/settings", json={
        "ai_enabled": True, "model": "boundary-model", "reasoning_effort": "high",
    })
    server = FakeAppServer(app_server_messages(metadata_failure=True))
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        app = create_app(store.root, lambda settings: CodexAI(store.root / "ai-workspace"))
        response = TestClient(app, headers={"X-Learning-Map": "1"}).post(
            _chat_path(course), json={"message": "Explain this material."}
        )

    assert response.status_code == 200, response.text
    tasks = client.get(f"/api/courses/{course['id']}/ai-tasks").json()
    assert len(tasks) == 1 and tasks[0]["state"] == "applied"
    task_id = tasks[0]["id"]
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()
    assert detail["raw_reply"] == {
        "text": "A concise answer.", "thread_id": "thread-integration", "turn_id": "turn-integration",
    }
    event_names = [event["event"] for event in client.get(
        f"/api/courses/{course['id']}/ai-tasks/{task_id}/events"
    ).json()]
    assert "metadata/failed" in event_names and "response/completed" in event_names
    assert (detail["model"], detail["effort"]) == ("boundary-model", "high")
    imported = client.app.state.learning.tasks.import_bridge_history(course["id"], {
        "thread_id": detail["thread_id"], "turn_id": detail["turn_id"],
        "prompt": detail["request"]["prompt"], "raw_reply": detail["raw_reply"]["text"],
        "status": "completed", "relation_ids": [], "match_error": None, "matched": True,
    })
    assert imported["id"] == task_id
    assert len(client.get(f"/api/courses/{course['id']}/ai-tasks").json()) == 1


def test_raw_reply_is_saved_before_schema_failure_and_events_are_queryable(session):
    client, store, _, course = session
    server = FakeAppServer(app_server_messages("not valid JSON", metadata_failure=True))
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        app = create_app(store.root, lambda settings: CodexAI(store.root / "ai-workspace"))
        response = TestClient(app, headers={"X-Learning-Map": "1"}).post(
            f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/question"
        )

    assert response.status_code == 400
    tasks = client.get(f"/api/courses/{course['id']}/ai-tasks").json()
    assert len(tasks) == 1 and tasks[0]["state"] == "invalid"
    task_id = tasks[0]["id"]
    assert client.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()["raw_reply"]["text"] == (
        "not valid JSON"
    )
    events = client.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}/events").json()
    assert "response/completed" in [event["event"] for event in events]


def test_in_progress_recovery_returns_202_and_uses_read_only_query(session):
    client, store, _, course = session
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=FakeAppServer(app_server_failed_turn_messages())),
    ):
        app = create_app(store.root, lambda settings: CodexAI(store.root / "ai-workspace"))
        failed = TestClient(app, raise_server_exceptions=False,
                            headers={"X-Learning-Map": "1"}).post(
            _chat_path(course), json={"message": "Explain this material."}
        )
    assert failed.status_code == 503
    task_id = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]["id"]
    persisted = client.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()
    assert persisted["state"] == "unknown"
    assert (persisted["thread_id"], persisted["turn_id"]) == (
        "thread-integration", "turn-integration"
    )

    class ReadOnlyProvider:
        def __init__(self):
            self.read_calls = 0
            self.ask_calls = 0

        def read_turn(self, thread_id, turn_id, *, prompt=None):
            self.read_calls += 1
            assert (thread_id, turn_id) == ("thread-integration", "turn-integration")
            return {"status": "inProgress", "text": "", "thread_id": thread_id, "turn_id": turn_id}

        def ask(self, *_args, **_kwargs):
            self.ask_calls += 1
            raise AssertionError("recover must not start a new generation")

    reader = ReadOnlyProvider()
    restarted = TestClient(create_app(store.root, lambda _: reader), headers={"X-Learning-Map": "1"})
    recovered = restarted.post(f"/api/courses/{course['id']}/ai-tasks/{task_id}/recover")
    assert recovered.status_code == 202
    assert recovered.json()["course"] is None
    assert reader.read_calls == 1 and reader.ask_calls == 0


def test_concurrent_same_request_generates_once_and_replays_applied_result(session):
    client, _, model, course = session
    model.reply = "block"
    request = {"message": "Explain this material.", "request_id": "concurrent-chat-request-01"}
    path = _chat_path(course)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(client.post, path, json=request)
        assert model.entered.wait(timeout=5)
        duplicate = client.post(path, json=request)
        assert duplicate.status_code == 409
        model.release.set()
        first = first_future.result(timeout=5)

    assert first.status_code == 200, first.text
    repeated = client.post(path, json=request)
    assert repeated.status_code == 200, repeated.text
    assert model.ask_count == 1
    assert len(repeated.json()["nodes"][0]["chats"]) == 2
    task = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]
    assert task["state"] == "applied"


def test_relation_scoped_backfill_ignores_all_other_pending_relations(session):
    client, store, model, course = session
    cid = course["id"]
    with store.edit(cid) as (current, _):
        template = current["edges"][0]
        for _ in range(10):
            edge = {**template, "id": uuid4().hex}
            edge.pop("bridges", None)
            current["edges"].append(edge)
    current = store.course(cid)
    target = current["edges"][-1]
    seen = []

    model.reply = lambda prompt: bridge_reply(prompt, seen)
    response = client.post(
        f"/api/courses/{cid}/relations/{target['id']}/backfill",
        json={"revision": current["revision"]},
    )
    assert response.status_code == 200, response.text
    assert seen == [target["id"]]
    saved = store.course(cid)
    assert "bridges" in next(edge for edge in saved["edges"] if edge["id"] == target["id"])
    assert all("bridges" not in edge for edge in saved["edges"] if edge["id"] != target["id"])


def test_bridge_regeneration_request_id_replays_applied_result_after_revision_changes(session):
    client, store, model, course = session
    cid = course["id"]
    initial = store.course(cid)
    relation_id = initial["edges"][0]["id"]
    original_request_id = "bridge-original-request-01"
    model.reply = "not valid JSON"
    failed = client.post(
        f"/api/courses/{cid}/relations/{relation_id}/backfill",
        json={"revision": initial["revision"], "request_id": original_request_id},
    )
    assert failed.status_code == 400
    original = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    assert original["kind"] == "bridge" and original["target"] == relation_id

    seen = []

    model.reply = lambda prompt: bridge_reply(prompt, seen)
    regenerate = {"request_id": "bridge-regeneration-request-01"}
    route = f"/api/courses/{cid}/ai-tasks/{original['id']}/regenerate"
    first = client.post(route, json=regenerate)
    assert first.status_code == 200, first.text
    revision_after_first = store.course(cid)["revision"]
    assert seen == [relation_id]

    second = client.post(route, json=regenerate)
    assert second.status_code == 200, second.text
    assert store.course(cid)["revision"] == revision_after_first
    assert model.ask_count == 2
    tasks = client.get(f"/api/courses/{cid}/ai-tasks").json()
    regenerated = next(task for task in tasks if task["request_id"] == regenerate["request_id"])
    assert regenerated["regenerated_from"] == original["id"]
    assert regenerated["state"] == "applied"


@pytest.mark.parametrize(
    ("initial_state", "has_request", "has_raw_reply", "expected_state"),
    [
        ("prepared", True, False, "unknown"),
        ("sending", True, False, "unknown"),
        ("running", True, False, "unknown"),
        ("processing", True, True, "received"),
        ("prepared", False, False, "rejected"),
    ],
)
def test_service_startup_reconciles_persisted_active_tasks_without_sending(
    session, initial_state, has_request, has_raw_reply, expected_state
):
    client, store, model, course = session
    response = client.post(_chat_path(course), json={"message": "Explain this material."})
    assert response.status_code == 200, response.text
    task_id = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]["id"]
    manager = client.app.state.learning.tasks
    task = manager.get(task_id)
    task["request"] = task.get("request") if has_request else None
    task["raw_reply"] = (
        {"text": "A previously received reply.", "thread_id": "thread-1", "turn_id": "turn-1"}
        if has_raw_reply else None
    )
    with store.connect() as connection:
        connection.execute(
            "UPDATE ai_tasks SET state=?,body=? WHERE id=?",
            (initial_state, json.dumps(task, ensure_ascii=False), task_id),
        )

    restarted_manager = TaskManager(store, lambda _: model)
    assert restarted_manager.get(task_id)["state"] == initial_state
    restarted_manager.reconcile_startup()

    reconciled = restarted_manager.get(task_id)
    assert reconciled["state"] == expected_state
    assert model.ask_count == 1


def test_imported_history_after_course_restore_stays_historical_only(session):
    client, store, model, course = session
    course_id = course["id"]
    client.post(f"/api/courses/{course_id}/snapshot")
    version_id = client.get(f"/api/courses/{course_id}/versions").json()[0]["id"]
    preview = client.post(
        f"/api/courses/{course_id}/restore-preview", json={"version_id": version_id}
    )
    restored = client.post(f"/api/courses/{course_id}/restore", json={"token": preview.json()["token"]})
    assert restored.status_code == 200, restored.text

    tasks = client.app.state.learning.tasks
    relation_id = store.course(course_id)["edges"][0]["id"]
    candidate = {
        "thread_id": "pre-restore-thread", "turn_id": "pre-restore-turn",
        "prompt": "Historical request", "raw_reply": '{"relations":[]}',
        "status": "completed", "relation_ids": [relation_id], "match_error": None, "matched": True,
    }
    imported = tasks.import_bridge_history(course_id, candidate)

    assert imported["history_matched"] is False
    assert imported["historical_raw"] == candidate["raw_reply"]
    assert "raw_reply" not in imported
    detail = client.get(f"/api/courses/{course_id}/ai-tasks/{imported['id']}").json()
    assert detail["historical_raw"] == candidate["raw_reply"]
    assert "raw_reply" not in detail
    assert model.ask_count == 0


def test_duplicate_assessment_request_rejects_changed_attachment_before_importing_it(session):
    client, store, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    model.reply = json.dumps({
        "outcome": "passed", "reasoning": "The concept is applied correctly.",
        "blockers": [], "next_step": "Try another example.",
    })
    path = f"/api/courses/{cid}/nodes/{node_id}/attempts"
    headers = {"X-AI-Request-ID": "duplicate-attempt-files-01"}
    first = client.post(
        path,
        data={"answer": "My written answer.", "reference": "Reference response."},
        files={"files": ("answer.txt", b"original attachment", "text/plain")},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    material_root = store.root / "courses" / cid / "materials"
    imported_before = sorted(path.name for path in material_root.iterdir())

    duplicate = client.post(
        path,
        data={"answer": "My written answer.", "reference": "Reference response."},
        files={"files": ("answer.txt", b"changed attachment", "text/plain")},
        headers=headers,
    )

    assert duplicate.status_code == 409
    assert sorted(path.name for path in material_root.iterdir()) == imported_before
    assert model.ask_count == 1


def _valid_map_reply(material):
    return json.dumps({
        "nodes": [{
            "key": "recovery-topic", "title": "Recovery Topic", "summary": "A recovered concept.",
            "week": "1", "sources": [{"material_id": material["id"], "page": 1, "quote": "database"}],
            "prerequisites": [], "uncertain": True,
        }],
        "relations": [],
    }, ensure_ascii=False)


@pytest.mark.parametrize("operation", ["map", "question", "assessment"])
def test_map_question_and_assessment_recover_after_course_save_failure(
    session, monkeypatch, operation
):
    client, store, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    base = f"/api/courses/{cid}"
    if operation == "map":
        path = f"{base}/generate"
        model.reply = _valid_map_reply(course["materials"][0])
    elif operation == "question":
        path = f"{base}/nodes/{node_id}/question"
        model.reply = json.dumps({
            "prompt": "Explain the concept and give an example.", "kind": "解释",
            "rubric": "Checks the concept and a valid example.",
        })
    else:
        path = f"{base}/nodes/{node_id}/attempts"
        model.reply = json.dumps({
            "outcome": "passed", "reasoning": "The answer uses the concept correctly.",
            "blockers": [], "next_step": "Try a harder example.",
        })

    save_course = store.save_course
    fail_once = True

    def fail_first_save(updated, connection):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            raise OSError("simulated course save failure")
        return save_course(updated, connection)

    monkeypatch.setattr(store, "save_course", fail_first_save)
    unavailable = TestClient(client.app, raise_server_exceptions=False,
                             headers={"X-Learning-Map": "1"})
    if operation == "assessment":
        failed = unavailable.post(
            path, data={"answer": "The concept is correctly applied."},
            headers={"X-AI-Request-ID": "assessment-recovery-request-01"},
        )
    else:
        failed = unavailable.post(path)
    assert failed.status_code == 500
    task = client.get(f"{base}/ai-tasks").json()[0]
    assert task["kind"] == operation
    task_id = task["id"]
    assert client.get(f"{base}/ai-tasks/{task_id}").json()["raw_reply"]["text"]

    monkeypatch.setattr(store, "save_course", save_course)
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    recovered = restarted.post(f"{base}/ai-tasks/{task_id}/recover")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    assert model.ask_count == 1
    if operation == "map":
        assert any(node["title"] == "Recovery Topic" for node in recovered.json()["course"]["nodes"])
    elif operation == "question":
        assert recovered.json()["course"]["nodes"][0]["question"]["prompt"] == (
            "Explain the concept and give an example."
        )
    else:
        assert recovered.json()["course"]["nodes"][0]["attempts"][-1]["judgment"]["outcome"] == "passed"

