"""2026-11-03 regression: different actions share conversations without resending old turns."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.ai import AIUnavailable, CodexAI, _AIRequest
from backend.app import create_app


class ConversationModel:
    def __init__(self):
        self.sent = []
        self.entered, self.release = threading.Event(), threading.Event()
        self.block = False

    def available(self):
        return {"available": True}

    def ask(self, prompt, **options):
        thread_id = options.get("thread_id") or "thread-" + uuid4().hex
        self.sent.append(dict(options, actual_thread=thread_id))
        self.entered.set()
        if self.block and not self.release.wait(5):
            raise TimeoutError("test did not release model boundary")
        fields = options.get("schema", {}).get("properties", {})
        if "html" in fields:
            payload = dict(title="Synthetic lesson", goal="Identify a key", html="<p>A key identifies a row.</p>",
                           check_question="What identifies a row?", check_answer="A key.", recap="Keys identify rows.")
        elif "rubric" in fields:
            payload = dict(kind="解释", prompt="Explain a key.", rubric="Explain uniqueness.")
        else:
            payload = None
        return dict(text=json.dumps(payload) if payload else "A key identifies a row.",
                    thread_id=thread_id, turn_id="turn-" + uuid4().hex)


@pytest.fixture
def conversation_app(tmp_path):
    model = ConversationModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True, "model": "model-a"}).raise_for_status()
    return client, app.state.store, model, course


def send(client, course, operation="chat", **fields):
    path = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}"
    payload = dict(request_id=uuid4().hex, **fields)
    if operation == "chat":
        payload.setdefault("message", "Explain the key.")
    response = client.post(path + "/" + operation, json=payload)
    response.raise_for_status()
    return response.json()


@pytest.mark.parametrize("first", ["chat", "lessons"])
def test_main_learning_thread_is_shared_by_lessons_and_followups_after_restart(conversation_app, first):
    client, store, model, course = conversation_app
    course = send(client, course, first)
    original_thread = model.sent[-1]["actual_thread"]
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    course = send(restarted, course, "lessons" if first == "chat" else "chat")
    send(restarted, course, "lessons", kind="supplement", focus="Explain uniqueness.")
    assert [entry.get("thread_id") for entry in model.sent[1:]] == [original_thread, original_thread]
    tasks = restarted.get(f"/api/courses/{course['id']}/ai-tasks").json()
    assert len({task["id"] for task in tasks}) == 3
    assert len({task["turn_id"] for task in tasks}) == 3
    assert {task["thread_id"] for task in tasks} == {original_thread}
    assert all(task["result_ref"]["available"] for task in tasks)


def test_assessment_channel_and_model_changes_have_separate_persistent_identities(conversation_app):
    client, _, model, course = conversation_app
    course = send(client, course)
    learning_thread = model.sent[-1]["actual_thread"]
    course = send(client, course, "question")
    assert model.sent[-1]["actual_thread"] != learning_thread
    client.post("/api/settings", json={"model": "model-b"}).raise_for_status()
    course = send(client, course)
    assert "thread_id" not in model.sent[-1]
    client.post("/api/settings", json={"model": "model-a"}).raise_for_status()
    send(client, course)
    assert model.sent[-1]["thread_id"] == learning_thread


def test_scope_explicit_reset_and_restore_never_reuse_another_conversation(conversation_app):
    client, store, model, course = conversation_app
    base = f"/api/courses/{course['id']}"
    course = send(client, course)
    original_thread = model.sent[-1]["actual_thread"]
    selected = [course["materials"][0]["id"]]
    client.post(base + "/review-scope", json=dict(enabled=True, material_ids=selected, ai_scope="selected")).raise_for_status()
    course = send(client, course)
    scoped_thread = model.sent[-1]["actual_thread"]
    assert scoped_thread != original_thread
    client.post(base + "/review-scope", json=dict(enabled=False, material_ids=selected, ai_scope="selected")).raise_for_status()
    course = send(client, course)
    assert model.sent[-1]["thread_id"] == original_thread
    node_id = course["nodes"][0]["id"]
    before_chats = store.course(course["id"])["nodes"][0]["chats"]
    reset = client.post(base + f"/nodes/{node_id}/conversations/reset", json={"revision": course["revision"]})
    reset.raise_for_status()
    assert reset.json()["nodes"][0]["chats"] == before_chats
    course = send(client, reset.json())
    assert "thread_id" not in model.sent[-1]
    client.post(base + "/snapshot").raise_for_status()
    version = client.get(base + "/versions").json()[0]
    preview = client.post(base + "/restore-preview", json={"version_id": version["id"]}).json()
    client.post(base + "/restore", json={"token": preview["token"]}).raise_for_status()
    send(client, course)
    assert "thread_id" not in model.sent[-1]


def test_different_actions_cannot_send_concurrently_on_the_same_learning_thread(conversation_app):
    client, _, model, course = conversation_app
    model.block = True
    path = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/lessons"
    request = dict(request_id=uuid4().hex, kind="initial", focus="")
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(send, client, course)
        try:
            assert model.entered.wait(3)
            refused = client.post(path, json=request)
            assert refused.status_code == 409
            assert len(model.sent) == 1
        finally:
            model.release.set()
        first.result()
    model.block = False
    retried = client.post(path, json=request)
    retried.raise_for_status()
    assert model.sent[-1]["thread_id"] == model.sent[0]["actual_thread"]


def test_reset_during_an_inflight_reply_keeps_raw_output_and_rejects_old_application(conversation_app):
    client, store, model, course = conversation_app
    model.block = True
    base = f"/api/courses/{course['id']}"
    node_id = course["nodes"][0]["id"]
    request_id = uuid4().hex
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, base + f"/nodes/{node_id}/chat",
                            json=dict(message="Explain.", request_id=request_id))
        try:
            assert model.entered.wait(3)
            reset = client.post(base + f"/nodes/{node_id}/conversations/reset", json={"revision": course["revision"]})
            reset.raise_for_status()
        finally:
            model.release.set()
        assert first.result().status_code == 409
    task = next(task for task in client.get(base + "/ai-tasks").json() if task["request_id"] == request_id)
    detail = client.get(base + f"/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["text"] == "A key identifies a row."
    assert detail["state"] == "conflict"
    assert not store.course(course["id"])["nodes"][0]["chats"]
    assert client.post(base + f"/ai-tasks/{task['id']}/recover").status_code == 409
    assert len(model.sent) == 1


def test_restart_releases_a_claim_that_was_never_registered_for_sending(conversation_app):
    client, store, model, course = conversation_app
    client.post("/api/settings", json={"ai_enabled": False}).raise_for_status()
    base = f"/api/courses/{course['id']}"
    refused = client.post(base + f"/nodes/{course['nodes'][0]['id']}/chat", json=dict(message="Explain.", request_id=uuid4().hex))
    assert refused.status_code == 400
    tasks = client.app.state.learning.tasks
    task_id = client.get(base + "/ai-tasks").json()[0]["id"]
    tasks.update(task_id, state="prepared", model="model-a")
    tasks.conversations.claim(tasks.get(task_id), model)
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    restarted.post("/api/settings", json={"ai_enabled": True}).raise_for_status()
    send(restarted, course)
    assert tasks.get(task_id)["state"] == "rejected"
    with store.connect() as connection:
        assert connection.execute("SELECT owner_task FROM ai_conversations").fetchone()[0] is None


def test_legacy_applied_lesson_is_not_verified_from_an_edited_current_object(conversation_app):
    client, store, _, course = conversation_app
    course = send(client, course, "lessons")
    base = f"/api/courses/{course['id']}"
    task_id = client.get(base + "/ai-tasks").json()[0]["id"]
    with store.connect() as connection:
        body = json.loads(connection.execute("SELECT body FROM ai_tasks WHERE id=?", (task_id,)).fetchone()[0])
        body.pop("result_ref")
        body.pop("result_object")
        connection.execute("UPDATE ai_tasks SET body=? WHERE id=?", (json.dumps(body), task_id))
    assert client.get(base + f"/ai-tasks/{task_id}/result").json()["result_ref"]["available"]
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["lessons"][0]["goal"] = "A later edited goal."
    detail = client.get(base + f"/ai-tasks/{task_id}").json()
    assert detail["raw_reply"]["text"]
    assert client.get(base + f"/ai-tasks/{task_id}/result").json()["result_ref"] is None


def test_send_gate_contention_releases_an_unsent_claim_and_allows_same_action_retry(tmp_path):
    class Transport:
        def __init__(self):
            self.sent = []

        def send(self, packet):
            self.sent.append(packet)

        def collect_turn(self, request_id, observer, thread_id):
            return "Original answer.", "turn-1"

    class NativeBoundary(CodexAI):
        def ask(self, prompt, **options):
            observer = options["observer"]
            observer("thread/opened", dict(thread_id="thread-1"))
            request = _AIRequest(prompt, options.get("thread_id"), None, [], None, observer)
            text, turn_id = self._start_turn(transport, "thread-1", request)
            return dict(text=text, turn_id=turn_id, thread_id="thread-1")

    transport = Transport()
    app = create_app(tmp_path / "data", lambda _: NativeBoundary(tmp_path / "ai-workspace"))
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True}).raise_for_status()
    path = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/chat"
    request = dict(message="Explain.", request_id=uuid4().hex)
    with app.state.learning.tasks.conversations.send_guard():
        assert client.post(path, json=request).status_code == 409
    tasks = client.get(f"/api/courses/{course['id']}/ai-tasks").json()
    detail = app.state.learning.tasks.get(tasks[0]["id"])
    assert detail["state"] == "rejected" and not detail["request"] and detail["unsent_request"]
    assert transport.sent == []
    client.post(path, json=request).raise_for_status()
    assert [packet["method"] for packet in transport.sent] == ["turn/start"]


class LostCompletionModel(CodexAI):
    def __init__(self, root):
        super().__init__(root)

    def ask(self, prompt, *, observer=None, **options):
        observer("thread/opened", dict(thread_id="persisted-before-turn"))
        observer("turn/sending", dict(thread_id="persisted-before-turn", params={}))
        observer("turn/identified", dict(turn_id="original-turn"))
        raise AIUnavailable("completion notification lost")

    def read_turn(self, thread_id, turn_id, prompt=None):
        assert (thread_id, turn_id) == ("persisted-before-turn", "original-turn")
        return dict(status="completed", thread_id=thread_id, turn_id=turn_id, text="The original answer.")


def test_thread_is_durable_before_failure_and_collect_never_applies_or_sends_again(tmp_path):
    model = LostCompletionModel(tmp_path / "ai-workspace")
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True}).raise_for_status()
    original_course = app.state.store.course(course["id"])
    base = f"/api/courses/{course['id']}"
    failed = client.post(base + f"/nodes/{course['nodes'][0]['id']}/chat", json=dict(message="Explain.", request_id=uuid4().hex))
    assert failed.status_code == 503
    task = client.get(base + "/ai-tasks").json()[0]
    with app.state.store.connect() as connection:
        row = connection.execute("SELECT thread_id,owner_task FROM ai_conversations").fetchone()
        assert tuple(row) == ("persisted-before-turn", task["id"])
    restarted = TestClient(create_app(app.state.store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    collected = restarted.post(base + f"/ai-tasks/{task['id']}/collect")
    collected.raise_for_status()
    assert collected.json()["task"]["state"] == "received"
    assert app.state.store.course(course["id"]) == original_course

    recovered = restarted.post(base + f"/ai-tasks/{task['id']}/recover")
    recovered.raise_for_status()
    assert recovered.json()["task"]["state"] == "applied"
    assert recovered.json()["course"]["nodes"][0]["chats"][-1]["content"] == "The original answer."
