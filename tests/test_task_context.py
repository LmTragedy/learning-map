"""Shared guards for AI receipts and their course-specific input contracts."""

import json
from copy import deepcopy

import pytest

from backend.ai_tasks import TaskManager, current_task_id, save_task_result
from backend.store import Conflict, Store, identity, timestamp
from backend.task_context import validate_task_context


def _course():
    return {
        "id": "course-1", "revision": 7, "ai_epoch": "epoch-1", "review_scope": None,
        "preferences": {"pace": "steady"}, "materials": [], "edges": [],
        "nodes": [{
            "id": "node-1", "title": "概念", "summary": "定义和用途", "sources": [],
            "prerequisites": [], "pieces": [], "steps": [], "status": "new", "personal_note": "",
        }],
    }


def _map_task(course, **extra):
    return {"course_id": course["id"], "kind": "map", "target": "course", "inputs": {},
            "before": deepcopy(course), **extra}


def test_map_context_ignores_revision_and_unprompted_learning_progress():
    before = _course()
    current = deepcopy(before)
    current["revision"] += 1
    current["nodes"][0]["status"] = "studied"
    current["nodes"][0]["personal_note"] = "并行保存的笔记"

    validate_task_context(_map_task(before), current)


@pytest.mark.parametrize(("field", "changed"), [
    ("ai_epoch", "epoch-2"),
    ("review_scope", {"enabled": True, "material_ids": ["m1"]}),
    ("preferences", {"pace": "slow"}),
])
def test_shared_context_rejects_restore_scope_or_preference_changes(field, changed):
    before = _course()
    current = deepcopy(before)
    current[field] = changed

    with pytest.raises(Conflict):
        validate_task_context(_map_task(before), current)


@pytest.mark.parametrize("change", ["material_text", "edge_structure"])
def test_map_context_rejects_material_content_and_relationship_changes(change):
    before = _course()
    before["materials"] = [{"id": "m1", "pages": [{"number": 1, "text": "原文"}]}]
    before["edges"] = [{"id": "edge-1", "source": "node-1", "target": "node-1",
                        "relation": "帮助理解"}]
    task = _map_task(before)
    current = deepcopy(before)
    if change == "material_text":
        current["materials"][0]["pages"][0]["text"] = "更新原文"
    else:
        current["edges"][0]["relation"] = "用户编辑的关系"
    with pytest.raises(Conflict):
        validate_task_context(task, current)


@pytest.mark.parametrize("task", [
    {"course_id": "course-1", "kind": "unknown", "before": _course()},
    {"course_id": "course-1", "kind": "child", "role": "unknown", "before": _course()},
    {"course_id": "course-1", "kind": "map", "contract_version": 2, "before": _course()},
])
def test_unknown_task_contracts_fail_closed(task):
    with pytest.raises(Conflict):
        validate_task_context(task, _course())


def test_context_rejects_a_task_from_another_course():
    task = _map_task(_course())
    task["course_id"] = "course-2"

    with pytest.raises(Conflict):
        validate_task_context(task, _course())


def test_new_action_does_not_supersede_receipt_with_unknown_context_contract(tmp_path):
    store = Store(tmp_path / "data")
    course = store.create("Unknown contract test")
    before = store.course(course["id"])
    task_id = _store_task(store, before)
    with store.connect() as connection:
        body = json.loads(connection.execute("SELECT body FROM ai_tasks WHERE id=?", (task_id,)).fetchone()[0])
        body.update(contract_version=2, raw_reply={"text": "saved"})
        connection.execute("UPDATE ai_tasks SET body=?,state='conflict' WHERE id=?",
                           (json.dumps(body, ensure_ascii=False), task_id))

    manager = TaskManager(store, lambda _: None)
    with pytest.raises(Conflict, match="契约版本不受支持"):
        manager.run(course["id"], "map", "course", {}, lambda: pytest.fail("must not run"),
                    request_id="unknown-contract-new-action-01")
    assert manager.get(task_id)["state"] == "conflict"


def _store_task(store, course):
    task_id, request_id = identity(), identity()
    body = {"before": deepcopy(course), "inputs": {}, "input_context": {},
            "contract_version": 1, "request_id": request_id}
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT INTO ai_tasks VALUES(?,?,?,?,?,?,?,?)",
                           (task_id, course["id"], request_id, "map", "course", "received",
                            json.dumps(body, ensure_ascii=False), timestamp()))
    return task_id


def test_store_checks_context_before_yielding_and_preserves_same_transaction_result(tmp_path):
    store = Store(tmp_path / "data")
    course = store.create("Task context test")
    with store.edit(course["id"]) as (current, _):
        current["nodes"].append({
            "id": "node-1", "title": "概念", "summary": "原摘要", "sources": [],
            "prerequisites": [], "pieces": [], "steps": [], "status": "new", "personal_note": "",
        })
    before = store.course(course["id"])
    task_id = _store_task(store, before)
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["summary"] = "并发更改的摘要"

    entered = False
    with pytest.raises(Conflict):
        with store.edit(course["id"], task_id=task_id) as (current, _):
            entered = True
            current["nodes"][0]["personal_note"] = "不可写入"
    assert entered is False
    assert store.course(course["id"])["nodes"][0]["personal_note"] == ""

    result_course = store.create("Task result context test")
    manager = TaskManager(store, lambda _: None)

    def save_result_in_course_transaction():
        task_id = current_task_id()
        manager.update(task_id, state="received")
        with store.edit(result_course["id"], task_id=task_id) as (updated, connection):
            updated["notes"] = [{"id": "note-1", "content": "applied"}]
            save_task_result(connection, {"saved": "inside same transaction"})
        return store.course(result_course["id"])

    manager.run(result_course["id"], "map", "course", {}, save_result_in_course_transaction,
                request_id="task-result-transaction-0001")
    with store.connect() as connection:
        saved = json.loads(connection.execute(
            "SELECT body FROM ai_tasks WHERE request_key=?", ("task-result-transaction-0001",)
        ).fetchone()[0])
    assert saved["result"] == {"saved": "inside same transaction"}
    assert saved["result_type"] == "value"
