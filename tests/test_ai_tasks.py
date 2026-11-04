"""Durable AI receipts, safe recovery, and relationship-scoped bridge batches."""

import json
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


class BoundaryModel:
    def __init__(self):
        self.replies = []
        self.prompts = []
        self.ask_count = 0

    def available(self):
        return {"available": True, "test_boundary": True}

    def ask(self, prompt, **options):
        self.ask_count += 1
        self.prompts.append(prompt)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(prompt)
        return {"text": json.dumps(reply, ensure_ascii=False) if isinstance(reply, dict) else reply,
                "thread_id": "boundary-thread", "turn_id": "boundary-turn"}


@pytest.fixture
def session(tmp_path):
    model = BoundaryModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def test_chat_receipt_survives_restart_and_explicit_request_replay_is_idempotent(session):
    client, store, model, course = session
    node_id = course["nodes"][0]["id"]
    path = f"/api/courses/{course['id']}"
    request = {"message": "请解释主键的作用。", "request_id": "chat-request-000001"}
    model.replies.append("主键用于唯一标识一行记录。")

    first = client.post(f"{path}/nodes/{node_id}/chat", json=request)
    assert first.status_code == 200, first.text
    tasks = client.get(f"{path}/ai-tasks").json()
    assert len(tasks) == 1 and tasks[0]["state"] == "applied"
    task_id = tasks[0]["id"]
    assert not {"raw_reply", "request", "inputs", "input_context", "before"} & tasks[0].keys()

    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    detail = restarted.get(f"{path}/ai-tasks/{task_id}").json()
    assert detail["raw_reply"]["text"] == "主键用于唯一标识一行记录。"
    assert detail["inputs"]["message"] == request["message"]
    replay = restarted.post(f"{path}/nodes/{node_id}/chat", json=request)
    assert replay.status_code == 200, replay.text
    assert model.ask_count == 1
    assert len(replay.json()["nodes"][0]["chats"]) == 2


def test_recover_reads_provider_turn_once_and_replays_without_asking_again(session):
    client, store, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    path = f"/api/courses/{cid}"
    model.replies.append(RuntimeError("connection closed after dispatch"))
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    failed = boundary.post(f"{path}/nodes/{node_id}/chat", json={"message": "解释外键。"})
    assert failed.status_code == 500
    task = client.get(f"{path}/ai-tasks").json()[0]
    task_id = task["id"]
    assert task["state"] == "unknown"

    # The scripted boundary can report transport identity after a simulated disconnect.
    manager = client.app.state.learning.tasks
    manager.update(task_id, state="unknown", thread_id="boundary-thread", turn_id="boundary-turn")

    class ReadOnlyProvider:
        def __init__(self):
            self.read_calls = []
            self.ask_calls = 0

        def read_turn(self, thread_id, turn_id, *, prompt=None):
            self.read_calls.append((thread_id, turn_id, prompt))
            return {"status": "completed", "text": "外键引用另一张表中的候选键。",
                    "thread_id": thread_id, "turn_id": turn_id}

        def ask(self, *_args, **_kwargs):
            self.ask_calls += 1
            raise AssertionError("recovery must not start another model turn")

    reader = ReadOnlyProvider()
    restarted = TestClient(create_app(store.root, lambda _: reader), headers={"X-Learning-Map": "1"})
    recovered = restarted.post(f"{path}/ai-tasks/{task_id}/recover")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    assert recovered.json()["course"]["nodes"][0]["chats"][-1]["content"] == "外键引用另一张表中的候选键。"
    assert len(reader.read_calls) == 1 and reader.ask_calls == 0
    assert reader.read_calls[0][:2] == ("boundary-thread", "boundary-turn")
    assert model.ask_count == 1


def _bridge_draft():
    return {
        "piece": {"kind": "性质", "title": "传递性", "detail": "由前一步性质得到结论。", "sources": []},
        "step": "应用传递性", "how": "利用前一步的性质推出结论。",
        "if_missing": "无法连接前后两步。", "strength": "required",
        "check_question": "由 x≿y、y≿z 可得什么？", "check_answer": "x≿z",
        "sources": [], "uncertain": True,
    }


def _map_draft(course):
    material = course["materials"][0]
    return {
        "nodes": [{
            "key": "recovery-node",
            "title": course["nodes"][0]["title"],
            "summary": course["nodes"][0]["summary"],
            "week": course["nodes"][0]["week"],
            "sources": [{"material_id": material["id"], "page": 1,
                         "quote": material["pages"][0]["text"].splitlines()[0]}],
            "prerequisites": [], "uncertain": True,
        }],
        "relations": [],
    }


def _fail_next_course_save(monkeypatch, store):
    save = store.save_course
    failed = False

    def fail_once(course, connection):
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("simulated course save failure")
        return save(course, connection)

    monkeypatch.setattr(store, "save_course", fail_once)
    return save


def test_map_receipt_replays_after_unrelated_note_and_progress_changes(session, monkeypatch):
    client, store, model, course = session
    cid = course["id"]
    model.replies.append(_map_draft(course))
    save = _fail_next_course_save(monkeypatch, store)
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    assert boundary.post(f"/api/courses/{cid}/generate",
                         headers={"X-AI-Request-ID": "map-receipt-noise-0001"}).status_code == 500
    task = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]

    with store.edit(cid) as (current, _):
        current["nodes"][0]["status"] = "studied"
        current["nodes"][0]["personal_note"] = "并发保存的笔记"
    monkeypatch.setattr(store, "save_course", save)

    recovered = client.post(f"/api/courses/{cid}/ai-tasks/{task['id']}/recover")
    assert recovered.status_code == 200, recovered.text
    node = recovered.json()["course"]["nodes"][0]
    assert node["status"] == "studied"
    assert node["personal_note"] == "并发保存的笔记"
    assert recovered.json()["task"]["state"] == "applied"


@pytest.mark.parametrize("change", ["material_text", "edge_structure"])
def test_map_receipt_still_rejects_changed_material_or_edge_structure(session, monkeypatch, change):
    client, store, model, course = session
    cid = course["id"]
    model.replies.append(_map_draft(course))
    save = _fail_next_course_save(monkeypatch, store)
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    request_id = f"map-receipt-change-{change.replace('_', '-')}-01"
    assert boundary.post(f"/api/courses/{cid}/generate",
                         headers={"X-AI-Request-ID": request_id}).status_code == 500
    task = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    with store.edit(cid) as (current, _):
        if change == "material_text":
            current["materials"][0]["pages"][0]["text"] += "\nChanged source content."
        else:
            current["edges"][0]["relation"] = "用户编辑后的关系"
    monkeypatch.setattr(store, "save_course", save)

    refused = client.post(f"/api/courses/{cid}/ai-tasks/{task['id']}/recover")
    assert refused.status_code == 409
    detail = client.get(f"/api/courses/{cid}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["text"]


def test_map_update_supersedes_stale_receipt_but_same_context_remains_idempotent(session, monkeypatch):
    client, store, model, course = session
    cid = course["id"]
    original_id = "map-update-original-0001"
    model.replies.append(_map_draft(course))
    save = _fail_next_course_save(monkeypatch, store)
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    assert boundary.post(f"/api/courses/{cid}/generate",
                         headers={"X-AI-Request-ID": original_id}).status_code == 500
    old_task = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    with store.edit(cid) as (current, _):
        extra = deepcopy(current["materials"][0])
        extra["id"] = uuid4().hex
        extra["name"] = "new-material.pdf"
        extra["sha256"] = uuid4().hex
        extra["pages"][0]["text"] = "New material content for map generation."
        current["materials"].append(extra)
    monkeypatch.setattr(store, "save_course", save)
    updated_course = store.course(cid)
    expected_material_ids = {material["id"] for material in updated_course["materials"]}
    model.replies.append(_map_draft(updated_course))

    updated = client.post(f"/api/courses/{cid}/generate",
                          headers={"X-AI-Request-ID": "map-update-after-source-change-01"})
    assert updated.status_code == 200, updated.text
    tasks = client.get(f"/api/courses/{cid}/ai-tasks").json()
    old = next(item for item in tasks if item["id"] == old_task["id"])
    new = next(item for item in tasks if item["request_id"] == "map-update-after-source-change-01")
    old_detail = client.get(f"/api/courses/{cid}/ai-tasks/{old['id']}").json()
    assert old["state"] == "superseded"
    assert old_detail["raw_reply"]["text"]
    assert old["superseded_by"] == new["id"]
    assert {material["id"] for material in updated.json()["materials"]} == expected_material_ids
    repeated = client.post(f"/api/courses/{cid}/generate",
                           headers={"X-AI-Request-ID": "map-update-after-source-change-01"})
    assert repeated.status_code == 200, repeated.text


def test_same_context_map_receipt_blocks_new_task_and_replays_with_same_identity(session, monkeypatch):
    client, store, model, course = session
    cid = course["id"]
    original_id = "map-same-context-receipt-01"
    model.replies.append(_map_draft(course))
    save = _fail_next_course_save(monkeypatch, store)
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    assert boundary.post(f"/api/courses/{cid}/generate",
                         headers={"X-AI-Request-ID": original_id}).status_code == 500
    task = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    monkeypatch.setattr(store, "save_course", save)

    blocked = client.post(f"/api/courses/{cid}/generate",
                          headers={"X-AI-Request-ID": "map-same-context-new-task-01"})
    assert blocked.status_code == 409
    recovered = client.post(f"/api/courses/{cid}/ai-tasks/{task['id']}/recover")
    assert recovered.status_code == 200, recovered.text
    repeated = client.post(f"/api/courses/{cid}/generate",
                           headers={"X-AI-Request-ID": original_id})
    assert repeated.status_code == 200, repeated.text


def test_stale_map_receipt_does_not_hide_another_active_map_task(session, monkeypatch):
    from backend.ai_tasks import _Invocation

    client, store, model, course = session
    cid = course["id"]
    model.replies.append(_map_draft(course))
    save = _fail_next_course_save(monkeypatch, store)
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    assert boundary.post(f"/api/courses/{cid}/generate",
                         headers={"X-AI-Request-ID": "map-stale-with-active-001"}).status_code == 500
    stale = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    with store.edit(cid) as (current, _):
        current["materials"][0]["pages"][0]["text"] += "\nNew source revision."
    manager = client.app.state.learning.tasks
    current = store.course(cid)
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        active = manager._create(_Invocation("map", "course", {}, current, "active-map-task-0001"),
                                 connection)
        manager.update(active["id"], state="processing", connection=connection)
    monkeypatch.setattr(store, "save_course", save)

    blocked = client.post(f"/api/courses/{cid}/generate",
                          headers={"X-AI-Request-ID": "map-new-task-while-active-01"})
    assert blocked.status_code == 409
    tasks = client.get(f"/api/courses/{cid}/ai-tasks").json()
    assert next(item for item in tasks if item["id"] == stale["id"])["state"] == "invalid"
    assert next(item for item in tasks if item["id"] == active["id"])["state"] == "processing"


def test_bridge_receipt_replays_original_batch_and_keeps_new_progress_and_bridge(session, monkeypatch):
    client, store, model, course = session
    cid = course["id"]
    with store.edit(cid) as (current, _):
        template = current["edges"][0]
        for _ in range(12):
            edge = deepcopy(template)
            edge["id"] = uuid4().hex
            edge.pop("bridges", None)
            current["edges"].append(edge)
    before = store.course(cid)
    expected_batch = [edge["id"] for edge in before["edges"] if "bridges" not in edge][:12]

    model.replies.append({"nodes": [], "relations": [
        {"id": relation_id, "bridges": [_bridge_draft()]} for relation_id in expected_batch
    ]})
    save = _fail_next_course_save(monkeypatch, store)
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    failed = boundary.post(f"/api/courses/{cid}/relations/backfill",
                           json={"revision": before["revision"], "request_id": "bridge-receipt-oldrev-001"})
    assert failed.status_code == 500
    task = client.get(f"/api/courses/{cid}/ai-tasks").json()[0]
    first_edge_id = expected_batch[0]
    with store.edit(cid) as (current, _):
        current["nodes"][0]["status"] = "studied"
        current["nodes"][0]["personal_note"] = "新增笔记"
        next(edge for edge in current["edges"] if edge["id"] == first_edge_id)["bridges"] = []
    monkeypatch.setattr(store, "save_course", save)

    recovered = client.post(f"/api/courses/{cid}/ai-tasks/{task['id']}/recover")
    assert recovered.status_code == 200, recovered.text
    saved = store.course(cid)
    assert saved["nodes"][0]["status"] == "studied"
    assert saved["nodes"][0]["personal_note"] == "新增笔记"
    assert next(edge for edge in saved["edges"] if edge["id"] == first_edge_id)["bridges"] == []
    assert sum(bool(edge.get("bridges")) for edge in saved["edges"]) == 11


def test_bridge_backfill_processes_exactly_one_batch_then_the_remainder(session):
    client, store, model, course = session
    cid = course["id"]
    with store.edit(cid) as (current, _):
        template = current["edges"][0]
        for _ in range(10):
            edge = {**template, "id": uuid4().hex}
            edge.pop("bridges", None)
            current["edges"].append(edge)
    current = store.course(cid)
    expected_ids = [edge["id"] for edge in current["edges"]]

    def batch_reply(prompt):
        relation_text = prompt.split("\n联系：", 1)[1].split("\n材料：", 1)[0]
        ids = [relation["id"] for relation in json.loads(relation_text)]
        return {"nodes": [], "relations": [{"id": rid, "bridges": [_bridge_draft()]} for rid in ids]}

    model.replies.extend([batch_reply, batch_reply])
    first = client.post(f"/api/courses/{cid}/relations/backfill", json={"revision": current["revision"]})
    assert first.status_code == 200, first.text
    first_course = store.course(cid)
    assert sum(bool(edge.get("bridges")) for edge in first_course["edges"]) == 12
    assert [edge["id"] for edge in first_course["edges"] if not edge.get("bridges")] == expected_ids[12:]

    second = client.post(
        f"/api/courses/{cid}/relations/backfill", json={"revision": first_course["revision"]}
    )
    assert second.status_code == 200, second.text
    assert all(edge.get("bridges") for edge in store.course(cid)["edges"])
    assert [len(json.loads(prompt.split("\n联系：", 1)[1].split("\n材料：", 1)[0]))
            for prompt in model.prompts] == [12, 1]


def test_recover_rejects_task_owned_by_another_course(session):
    client, _, model, course = session
    node_id = course["nodes"][0]["id"]
    base = f"/api/courses/{course['id']}"
    model.replies.append("回复")
    client.post(f"{base}/nodes/{node_id}/chat", json={"message": "解释主键"})
    task_id = client.get(f"{base}/ai-tasks").json()[0]["id"]
    other = client.post("/api/sample").json()
    assert client.get(f"/api/courses/{other['id']}/ai-tasks/{task_id}").status_code == 404


def test_raw_reply_recovers_after_course_save_failure_and_process_restart(session, monkeypatch):
    client, store, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    path = f"/api/courses/{cid}"
    model.replies.append("事务把多条更新组成一个逻辑单元。")
    save = store.save_course
    failed_once = False

    def fail_first_save(current, connection):
        nonlocal failed_once
        if not failed_once:
            failed_once = True
            raise OSError("simulated disk write failure")
        return save(current, connection)

    monkeypatch.setattr(store, "save_course", fail_first_save)
    unavailable = TestClient(client.app, raise_server_exceptions=False,
                             headers={"X-Learning-Map": "1"})
    failed = unavailable.post(f"{path}/nodes/{node_id}/chat", json={"message": "解释事务。"})
    assert failed.status_code == 500
    task = client.get(f"{path}/ai-tasks").json()[0]
    assert task["state"] == "invalid"
    task_id = task["id"]
    assert client.get(f"{path}/ai-tasks/{task_id}").json()["raw_reply"]["text"] == (
        "事务把多条更新组成一个逻辑单元。"
    )

    monkeypatch.setattr(store, "save_course", save)
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    recovered = restarted.post(f"{path}/ai-tasks/{task_id}/recover")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    assert recovered.json()["course"]["nodes"][0]["chats"][-1]["content"] == (
        "事务把多条更新组成一个逻辑单元。"
    )
    assert model.ask_count == 1


def test_invalid_structured_reply_remains_inspectable_without_second_model_call(session):
    client, _, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    path = f"/api/courses/{cid}"
    model.replies.append({"not": "a lesson"})
    request = {"request_id": "invalid-lesson-0001", "kind": "initial", "focus": ""}
    failed = client.post(f"{path}/nodes/{node_id}/lessons", json=request)
    assert failed.status_code == 400
    task = client.get(f"{path}/ai-tasks").json()[0]
    assert task["state"] == "invalid"
    detail = client.get(f"{path}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["text"]
    assert "prompt" in detail["request"]
    assert "prompt" not in task
    again = client.post(f"{path}/ai-tasks/{task['id']}/recover")
    assert again.status_code == 400
    assert model.ask_count == 1


def test_course_restore_supersedes_unfinished_receipts(session):
    client, _, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    path = f"/api/courses/{cid}"
    client.post(f"{path}/snapshot")
    model.replies.append(RuntimeError("lost response"))
    boundary = TestClient(client.app, raise_server_exceptions=False,
                          headers={"X-Learning-Map": "1"})
    failed = boundary.post(f"{path}/nodes/{node_id}/chat", json={"message": "解释外键。"})
    assert failed.status_code == 500
    task = client.get(f"{path}/ai-tasks").json()[0]
    version = client.get(f"{path}/versions").json()[0]
    preview = client.post(f"{path}/restore-preview", json={"version_id": version["id"]}).json()
    assert client.post(f"{path}/restore", json={"token": preview["token"]}).status_code == 200
    assert client.get(f"{path}/ai-tasks/{task['id']}").json()["state"] == "superseded"
    assert client.post(f"{path}/ai-tasks/{task['id']}/recover").status_code == 409
    assert model.ask_count == 1


@pytest.mark.parametrize("mutation", ["material_text", "review_scope"])
def test_receipt_will_not_apply_after_material_or_scope_context_changes(session, monkeypatch, mutation):
    client, store, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    path = f"/api/courses/{cid}"
    request = {"message": "解释关系的含义。", "request_id": f"scope-change-{mutation.replace('_', '-')}-01"}
    model.replies.append("关系是由元组组成的数据集合。")
    save = store.save_course
    monkeypatch.setattr(store, "save_course", lambda *_args: (_ for _ in ()).throw(OSError("write failed")))
    unavailable = TestClient(client.app, raise_server_exceptions=False,
                             headers={"X-Learning-Map": "1"})
    assert unavailable.post(f"{path}/nodes/{node_id}/chat", json=request).status_code == 500
    monkeypatch.setattr(store, "save_course", save)
    task = client.get(f"{path}/ai-tasks").json()[0]
    with store.edit(cid) as (current, _):
        if mutation == "material_text":
            current["materials"][0]["pages"][0]["text"] += "\nChanged source content."
        else:
            current["review_scope"] = {
                "enabled": True,
                "material_ids": [current["materials"][0]["id"]],
                "ai_scope": "selected",
            }
    replay = client.post(f"{path}/nodes/{node_id}/chat", json=request)
    assert replay.status_code == 409
    detail = client.get(f"{path}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["text"] == "关系是由元组组成的数据集合。"
    assert model.ask_count == 1


def test_regeneration_request_id_deduplicates_explicit_retry(session):
    client, _, model, course = session
    cid, node_id = course["id"], course["nodes"][0]["id"]
    path = f"/api/courses/{cid}"
    model.replies.extend([{"not": "a lesson"}, {
        "title": "主键小课", "goal": "理解主键", "html": (
            "<p>主键能唯一标识一行记录，并且每行都不能使用相同的主键值。</p>"
            "<p>例如学生编号可以帮助我们找到唯一的一位学生。</p>"
        ),
        "check_question": "主键用于什么？", "check_answer": "唯一标识一行。", "recap": "主键标识记录。",
    }])
    initial = {"request_id": "regenerate-source-001", "kind": "initial", "focus": ""}
    assert client.post(f"{path}/nodes/{node_id}/lessons", json=initial).status_code == 400
    original_task = client.get(f"{path}/ai-tasks").json()[0]
    regen = {"request_id": "regenerate-action-0001"}
    first = client.post(f"{path}/ai-tasks/{original_task['id']}/regenerate", json=regen)
    assert first.status_code == 200, first.text
    second = client.post(f"{path}/ai-tasks/{original_task['id']}/regenerate", json=regen)
    assert second.status_code == 200, second.text
    assert model.ask_count == 2
    tasks = client.get(f"{path}/ai-tasks").json()
    assert len(tasks) == 2 and sum(task["state"] == "applied" for task in tasks) == 1

