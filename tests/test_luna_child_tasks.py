import json

from fastapi.testclient import TestClient

from backend import material_indexing
from backend.ai_tasks import current_task_id
from backend.app import create_app
from backend.learning import Learning
from backend.store import Conflict, Store


class Model:
    def __init__(self):
        self.calls = []

    def ask(self, prompt, **options):
        self.calls.append((prompt, options))
        return {"text": "child answer", "thread_id": "child-thread", "turn_id": "child-turn"}


class UncertainModel(Model):
    def ask(self, prompt, **options):
        self.calls.append((prompt, options))
        raise RuntimeError("turn outcome is uncertain")


def _add_material_page(store, course_id):
    with store.edit(course_id) as (current, _):
        current["materials"] = [{
            "id": "m1", "name": "source.pdf", "kind": "pdf",
            "pages": [{"text": "source"}],
        }]


def test_child_task_has_own_receipt_and_parent_applies_without_parent_model_call(tmp_path):
    store = Store(tmp_path / "data")
    course = store.create("Luna child test")
    _add_material_page(store, course["id"])
    store.save_settings(store.settings() | {"ai_enabled": True})
    model = Model()
    settings_seen = []

    def factory(settings):
        settings_seen.append(dict(settings))
        return model

    learning = Learning(store, factory)

    parent_attempts = 0

    def parent_action():
        nonlocal parent_attempts
        parent_attempts += 1
        child_result = learning.tasks.run_child(
            course["id"], "material_page_index",
            {"prompt": "summarize page", "pages": [{"material_id": "m1", "name": "source.pdf",
                                                          "page": 1, "text": "source"}]},
            lambda: {"text": learning.ai(model="gpt-6-luna", effort="medium").ask("summarize page")["text"]},
        )
        if parent_attempts == 1:
            raise RuntimeError("parent application did not finish")
        with store.edit(course["id"], task_id=current_task_id()) as (current, _):
            current["preferences"]["child_summary"] = child_result["text"]
        return store.course(course["id"])

    try:
        learning.tasks.run(course["id"], "material_index", "course", {"indexed": 0},
                           parent_action, request_id="parent-child-request-0001")
    except RuntimeError:
        pass
    else:
        raise AssertionError("parent application failure should leave a recoverable receipt")
    pending_parent = next(task for task in learning.tasks.list(course["id"])
                          if task["kind"] == "material_index")
    assert learning.tasks.public(learning.tasks.get(pending_parent["id"]))["can_recover"]
    result = learning.tasks.run(course["id"], "material_index", "course", {"indexed": 0},
                                parent_action, request_id="parent-child-request-0001")

    tasks = learning.tasks.list(course["id"])
    parent = next(task for task in tasks if task["kind"] == "material_index")
    child = next(task for task in tasks if task["kind"] == "child")
    parent_detail, child_detail = learning.tasks.get(parent["id"]), learning.tasks.get(child["id"])
    assert result["preferences"]["child_summary"] == "child answer"
    assert parent_detail["state"] == child_detail["state"] == "applied"
    assert parent_detail.get("raw_reply") is None
    assert child_detail["raw_reply"]["text"] == "child answer"
    assert child_detail["parent_task_id"] == parent["id"]
    assert child_detail["role"] == "material_page_index"
    assert child_detail["model"] == "gpt-6-luna" and child_detail["effort"] == "medium"
    assert settings_seen[-1]["model"] == "gpt-6-luna"
    assert settings_seen[-1]["reasoning_effort"] == "medium"
    assert learning.tasks.public(parent_detail)["children"][0]["id"] == child["id"]
    assert not learning.tasks.public(parent_detail)["can_recover"]

    learning.tasks.run(course["id"], "material_index", "course", {"indexed": 0},
                       parent_action, request_id="parent-child-request-0001")
    assert len(model.calls) == 1


def test_changed_parent_scope_rejects_reuse_of_saved_child(tmp_path):
    store = Store(tmp_path / "data")
    course = store.create("Luna changed scope test")
    _add_material_page(store, course["id"])
    store.save_settings(store.settings() | {"ai_enabled": True})

    model = Model()
    learning = Learning(store, lambda _: model)

    def parent_action():
        learning.tasks.run_child(
            course["id"], "material_page_index",
            {"prompt": "summarize page", "pages": [{"material_id": "m1", "name": "source.pdf",
                                                       "page": 1, "text": "source"}]},
            lambda: {"text": learning.ai(model="gpt-6-luna", effort="medium").ask("summarize page")["text"]},
        )
        raise RuntimeError("stop before parent application")

    try:
        learning.tasks.run(course["id"], "material_index", "course", {"indexed": 0},
                           parent_action, request_id="parent-scope-request-0001")
    except RuntimeError:
        pass
    with store.edit(course["id"]) as (current, _):
        current["preferences"]["scope_change"] = True

    try:
        learning.tasks.run(course["id"], "material_index", "course", {"indexed": 0},
                           parent_action, request_id="parent-scope-request-0001")
    except Conflict:
        pass
    else:
        raise AssertionError("changed parent context must block saved-child reuse")
    assert len(model.calls) == 1


def test_legacy_recall_child_reuses_saved_reply_when_json_prompt_key_order_changes(tmp_path):
    store = Store(tmp_path / "data")
    course = store.create("Legacy Recall child test")
    history = [{"id": "chat-1", "role": "user", "content": "我的问题",
                "created_at": "2026-11-04T00:00:00+00:00"}]
    with store.edit(course["id"]) as (current, _):
        current["nodes"].append({
            "id": "node-1", "title": "概念", "summary": "", "sources": [],
            "prerequisites": [], "pieces": [], "steps": [], "status": "new",
            "personal_note": "", "chats": history,
        })
    store.save_settings(store.settings() | {"ai_enabled": True})

    class NoResendModel(Model):
        def ask(self, prompt, **options):
            if self.calls:
                raise AssertionError("a saved child reply must not start another provider turn")
            return super().ask(prompt, **options)

    model = NoResendModel()
    learning = Learning(store, lambda _: model)
    frozen_course = store.course(course["id"])
    from backend.review_scope import scope_key

    scope = scope_key(frozen_course)
    attempts = 0

    def parent_action():
        nonlocal attempts
        attempts += 1
        encoded = json.dumps(history, ensure_ascii=False, sort_keys=attempts > 1)
        prompt = "summarize saved history: " + encoded

        def child_action():
            answer = learning.ai(model="gpt-6-luna", effort="medium").ask(prompt)
            if attempts == 1:
                raise RuntimeError("parent failed after child reply was saved")
            return answer

        return learning.tasks.run_child(
            course["id"], "recall_summary",
            {"prompt": prompt, "history": history, "node_title": "概念", "scope": scope},
            child_action,
        )

    try:
        learning.tasks.run(course["id"], "recall", "node-1", {}, parent_action,
                           request_id="legacy-recall-child-parent-01")
    except RuntimeError:
        pass
    else:
        raise AssertionError("the first parent attempt must leave a recoverable child receipt")
    original_child_row = next(task for task in learning.tasks.list(course["id"]) if task["kind"] == "child")
    original_child = learning.tasks.get(original_child_row["id"])
    assert original_child["raw_reply"]["text"] == "child answer"

    result = learning.tasks.run(course["id"], "recall", "node-1", {}, parent_action,
                                request_id="legacy-recall-child-parent-01")
    replayed_child = learning.tasks.get(original_child["id"])
    assert result["text"] == "child answer"
    assert replayed_child["id"] == original_child["id"]
    assert replayed_child["request_id"] == original_child["request_id"]
    assert replayed_child["state"] == "applied"


class IndexModel:
    def __init__(self):
        self.ask_count = 0
        self.last_text = ""

    def ask(self, prompt, **_options):
        self.ask_count += 1
        pages = json.loads(prompt.split("材料页：", 1)[1])
        self.last_text = json.dumps({"pages": [
            {"material_id": page["material_id"], "page": page["page"],
             "summary": f"page {page['page']}", "terms": [], "key_quotes": []}
            for page in pages
        ]}, ensure_ascii=False)
        return {"text": self.last_text, "thread_id": "luna-thread", "turn_id": "luna-turn"}


def _fail_parent_application(*_args):
    raise RuntimeError("simulated parent application failure")


def _failed_index_parent(tmp_path, monkeypatch):
    model = IndexModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, raise_server_exceptions=False, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    original_apply = material_indexing._apply
    monkeypatch.setattr(material_indexing, "_apply", _fail_parent_application)
    failed = client.post(f"/api/courses/{course['id']}/material-index", json={"indexed": 0})
    assert failed.status_code == 500
    monkeypatch.setattr(material_indexing, "_apply", original_apply)
    tasks = app.state.learning.tasks.list(course["id"])
    parent = next(task for task in tasks if task["kind"] == "material_index")
    child = next(task for task in tasks if task["kind"] == "child")
    return client, app.state.store, model, course, parent, child


def _make_child_unknown(store, child_id):
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT body FROM ai_tasks WHERE id=?", (child_id,)).fetchone()
        body = json.loads(row[0])
        body.pop("raw_reply", None)
        body.pop("result", None)
        body.pop("result_type", None)
        body["error"] = "simulated lost receipt before parent application"
        connection.execute("UPDATE ai_tasks SET state='unknown',body=? WHERE id=?",
                           (json.dumps(body, ensure_ascii=False), child_id))


def test_parent_recovery_collects_unknown_child_without_new_model_turn(tmp_path, monkeypatch):
    client, store, model, course, parent, child = _failed_index_parent(tmp_path, monkeypatch)
    _make_child_unknown(store, child["id"])
    class ReadOnlyProvider:
        def __init__(self):
            self.read_calls = []

        def read_turn(self, thread_id, turn_id, *, prompt=None):
            self.read_calls.append((thread_id, turn_id, prompt))
            return {"status": "completed", "text": model.last_text,
                    "thread_id": thread_id, "turn_id": turn_id}

        def ask(self, *_args, **_kwargs):
            raise AssertionError("recover must not send a new model turn")

    reader = ReadOnlyProvider()
    restarted = TestClient(create_app(store.root, lambda _: reader),
                           headers={"X-Learning-Map": "1"})
    recovered = restarted.post(
        f"/api/courses/{course['id']}/ai-tasks/{parent['id']}/recover")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    assert len(reader.read_calls) == 1
    assert reader.read_calls[0][:2] == ("luna-thread", "luna-turn")
    assert model.ask_count == 1


def test_restore_supersedes_child_parent_and_blocks_recovery(tmp_path, monkeypatch):
    client, store, model, course, parent, child = _failed_index_parent(tmp_path, monkeypatch)
    _make_child_unknown(store, child["id"])
    version_id = client.get(f"/api/courses/{course['id']}/versions").json()[0]["id"]
    preview = client.post(f"/api/courses/{course['id']}/restore-preview",
                          json={"version_id": version_id}).json()
    restored = client.post(f"/api/courses/{course['id']}/restore", json={"token": preview["token"]})
    assert restored.status_code == 200
    parent_task = client.get(f"/api/courses/{course['id']}/ai-tasks/{parent['id']}").json()
    child_task = client.get(f"/api/courses/{course['id']}/ai-tasks/{child['id']}").json()
    assert parent_task["state"] == child_task["state"] == "superseded"
    recovery = client.post(f"/api/courses/{course['id']}/ai-tasks/{parent['id']}/recover")
    assert recovery.status_code == 409
    assert model.ask_count == 1


def test_unknown_child_is_not_resent_when_parent_is_replayed(tmp_path):
    from backend.review_scope import scope_key

    model = UncertainModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    store = app.state.store
    learning = app.state.learning
    node_id = course["nodes"][0]["id"]
    history = [{"id": "chat-1", "role": "user", "content": "已保存的问题",
                "created_at": "2026-11-04T00:00:00+00:00"}]
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["chats"] = history
    prompt = "summarize saved history"

    def parent_action():
        return learning.tasks.run_child(
            course["id"], "recall_summary",
            {"prompt": prompt, "node_title": course["nodes"][0]["title"],
             "history": history, "scope": scope_key(store.course(course["id"]))},
            lambda: {"text": learning.ai(model="gpt-6-luna", effort="medium").ask(prompt)["text"]},
        )

    for _ in range(2):
        try:
            learning.tasks.run(course["id"], "recall", node_id, {},
                               parent_action, request_id="parent-uncertain-request-0001")
        except (RuntimeError, Conflict):
            pass
        else:
            raise AssertionError("uncertain child must not be reported as completed")

    child = next(task for task in learning.tasks.list(course["id"]) if task["kind"] == "child")
    assert child["state"] == "unknown"
    assert model.calls and len(model.calls) == 1


def test_child_reply_that_fails_validation_is_not_offered_for_recovery(tmp_path):
    from backend.learning import LearningError
    from backend.review_scope import scope_key

    model = Model()
    app = create_app(tmp_path / "data", lambda settings: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    store = app.state.store
    learning = app.state.learning
    node_id = course["nodes"][0]["id"]
    history = [{"id": "chat-1", "role": "user", "content": "已保存的问题",
                "created_at": "2026-11-04T00:00:00+00:00"}]
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["chats"] = history
    prompt = "summarize saved history"

    def child_action():
        learning.ai(model="gpt-6-luna", effort="medium").ask(prompt)
        raise LearningError("evidence check failed")

    def parent_action():
        return learning.tasks.run_child(
            course["id"], "recall_summary",
            {"prompt": prompt, "node_title": course["nodes"][0]["title"],
             "history": history, "scope": scope_key(store.course(course["id"]))},
            child_action,
        )

    try:
        learning.tasks.run(course["id"], "recall", node_id, {}, parent_action,
                           request_id="invalid-child-request-01")
    except LearningError:
        pass
    else:
        raise AssertionError("a reply that fails validation must not apply")
    tasks = {task["kind"]: learning.tasks.get(task["id"]) for task in learning.tasks.list(course["id"])}
    assert tasks["child"]["state"] == "invalid"
    assert tasks["child"]["raw_reply"]["text"] == "child answer"
    assert tasks["recall"]["state"] != "received"
    assert not learning.tasks.public(tasks["recall"])["can_recover"]
