import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.ai import AIError
from backend.app import create_app
from backend.domain import record_attempt


class GoalModel:
    def __init__(self):
        self.reply = {}
        self.before_reply = None

    def ask(self, prompt, **options):
        if self.before_reply:
            self.before_reply()
        if isinstance(self.reply, Exception):
            raise self.reply
        return {"text": json.dumps(self.reply), "thread_id": "goal-test-thread"}


@pytest.fixture
def session(tmp_path):
    model = GoalModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    material = course["materials"][0]
    model.reply = {"goals": [{
        "title": "解释关系与键", "description": "用选课表说明键的作用。",
        "node_ids": [course["nodes"][0]["id"]], "subtasks": ["区分行和列", "找出主键"],
        "sources": [{"material_id": material["id"], "page": 1,
                     "quote": "A primary key uniquely identifies a row and cannot be null."}],
    }]}
    return client, app.state.store, model, course, f'/api/courses/{course["id"]}'


def test_goal_tracks_learning_evidence_but_only_user_changes_completion(session):
    client, store, _, course, base = session
    ids = [node["id"] for node in course["nodes"]]
    fields = dict(title="独立解释事务", kind="personal", node_ids=ids + ids[:1],
                  subtasks=[dict(title="阅读例子"), dict(title="解释失败情形")])
    created = client.post(base + "/goals", json=fields).json()
    goal = created["goals"][0]
    assert goal["node_ids"] == ids
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["status"] = "studied"
        current["nodes"][1]["status"] = "mastered"
        current["nodes"][2].update(status="passed", verification="user_passed")
        current["nodes"][3].update(status="passed", verification="review")
    latest = client.get(base).json()
    assert latest["goals"][0]["status"] == "todo"
    assert latest["goals"][0]["progress"] == dict(
        linked=4, studied=1, mastered=1, verified=1, review=1, subtasks_done=0, subtasks_total=2,
    )
    subtasks = [task | {"done": True} for task in goal["subtasks"]]
    fields.update(subtasks=subtasks, revision=latest["revision"], status="doing")
    updated = client.put(base + f'/goals/{goal["id"]}', json=fields).json()
    assert updated["goals"][0]["status"] == "doing"
    assert updated["goals"][0]["progress"]["subtasks_done"] == 2
    fields.update(revision=updated["revision"], status="done", title="我已确认目标达成")
    confirmed = client.put(base + f'/goals/{goal["id"]}', json=fields)
    assert confirmed.status_code == 200
    assert confirmed.json()["goals"][0]["status"] == "done"
    stale = client.put(base + f'/goals/{goal["id"]}', json=fields | {"title": "不能覆盖"})
    assert stale.status_code == 409
    assert client.get(base).json()["goals"][0]["title"] == "我已确认目标达成"


def test_preview_requires_explicit_selection_and_is_consumed_once(session):
    client, store, model, course, base = session
    model.reply["goals"].append(copy.deepcopy(model.reply["goals"][0]) | {"title": "第二个候选"})
    before = store.course(course["id"])
    preview = client.post(base + "/goal-candidates").json()
    assert store.course(course["id"]) == before
    request = dict(token=preview["token"], indices=[1])
    accepted = client.post(base + "/goals/accept", json=request)
    assert accepted.status_code == 200
    goal = accepted.json()["goals"][0]
    assert goal["title"] == "第二个候选"
    assert goal["status"] == "todo"
    assert not any(task["done"] for task in goal["subtasks"])
    assert goal["sources"] == model.reply["goals"][1]["sources"]
    assert store.course(course["id"])["nodes"] == before["nodes"]
    assert client.post(base + "/goals/accept", json=request).status_code == 400
    assert len(client.get(base).json()["goals"]) == 1


@pytest.mark.parametrize(("failure", "expected_status"), [
    ("quote", 400), ("page", 400), ("node", 404), ("model", 503), ("blank", 400),
])
def test_invalid_or_failed_extraction_never_writes_goals(session, failure, expected_status):
    client, store, model, course, base = session
    if failure == "quote":
        model.reply["goals"][0]["sources"][0]["quote"] = "invented evidence"
    elif failure == "page":
        model.reply["goals"][0]["sources"][0]["page"] = 99
    elif failure == "node":
        model.reply["goals"][0]["node_ids"] = ["foreign-node"]
    elif failure == "blank":
        model.reply["goals"][0]["title"] = "   "
    else:
        model.reply = AIError("provider unavailable")
    before = store.course(course["id"])
    response = client.post(base + "/goal-candidates")
    assert response.status_code == expected_status
    assert store.course(course["id"]) == before


def test_preview_rejects_other_course_stale_revision_and_invalid_selection(session):
    client, store, _, course, base = session
    preview = client.post(base + "/goal-candidates").json()
    other = client.post("/api/courses", json={"title": "另一课程"}).json()
    assert client.post(f'/api/courses/{other["id"]}/goals/accept', json={
        "token": preview["token"], "indices": [0],
    }).status_code == 409
    for indices in [[0, 0], [-1], [1]]:
        assert client.post(base + "/goals/accept", json={"token": preview["token"], "indices": indices}).status_code == 400
    client.post(base + "/goals", json={"title": "期间新增的目标"})
    assert client.post(base + "/goals/accept", json={"token": preview["token"], "indices": [0]}).status_code == 409
    assert len(store.course(course["id"])["goals"]) == 1


def test_concurrent_change_during_extraction_preserves_current_state(session):
    client, store, model, course, base = session

    def concurrent_edit():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][0]["personal_note"] = "并发保存的笔记"

    model.before_reply = concurrent_edit
    preview_response = client.post(base + "/goal-candidates")
    assert preview_response.status_code == 200, preview_response.text
    current = store.course(course["id"])
    assert current["nodes"][0]["personal_note"] == "并发保存的笔记"
    assert not current.get("goals")
    preview = preview_response.json()
    accepted = client.post(base + "/goals/accept", json={"token": preview["token"], "indices": [0]})
    assert accepted.status_code == 200, accepted.text
    assert len(store.course(course["id"])["goals"]) == 1


def test_material_change_during_goal_extraction_keeps_candidates_unapplied(session):
    client, store, model, course, base = session

    def concurrent_edit():
        with store.edit(course["id"]) as (current, _):
            current["materials"][0]["pages"][0]["text"] += " appended during extraction"

    model.before_reply = concurrent_edit
    response = client.post(base + "/goal-candidates")
    assert response.status_code == 409
    assert store.course(course["id"])["materials"][0]["pages"][0]["text"].endswith("appended during extraction")
    assert not store.course(course["id"]).get("goals")


def test_scoped_assessment_does_not_inflate_course_goal_progress(session):
    client, store, _, course, base = session
    node = course["nodes"][0]
    client.post(base + "/goals", json={"title": "整节点掌握", "node_ids": [node["id"]]})
    with store.edit(course["id"]) as (current, _):
        record_attempt(current["nodes"][0], dict(
            judgment={"outcome": "passed"}, review_scope_key="pdf:isolated",
        ))
    goal = client.get(base).json()["goals"][0]
    assert goal["progress"]["verified"] == 0
    assert goal["status"] == "todo"


def test_legacy_goals_edit_restore_and_restart_with_course_history(session):
    client, store, _, course, base = session
    legacy = dict(id="legacy-goal", title="旧目标", status="todo", node_ids=[], created_at="old")
    with store.edit(course["id"]) as (current, _):
        current["goals"] = [legacy]
        current["nodes"][0]["personal_note"] = "保留的笔记"
    client.post(base + "/snapshot")
    version = client.get(base + "/versions").json()[0]["id"]
    current = client.get(base).json()
    edited = client.put(base + "/goals/legacy-goal", json=dict(
        title="旧目标已编辑", revision=current["revision"], subtasks=[dict(title="新小目标")],
    ))
    assert edited.status_code == 200
    assert edited.json()["goals"][0]["subtasks"][0]["id"]
    token = client.post(base + "/restore-preview", json={"version_id": version}).json()["token"]
    restored = client.post(base + "/restore", json={"token": token})
    assert restored.status_code == 200
    restarted = TestClient(create_app(store.root), headers={"X-Learning-Map": "1"})
    loaded = restarted.get(base).json()
    assert loaded["goals"][0]["title"] == "旧目标"
    assert loaded["nodes"][0]["personal_note"] == "保留的笔记"


def test_manual_goal_edit_rejects_foreign_node_without_overwriting(session):
    client, store, _, course, base = session
    created = client.post(base + "/goals", json={"title": "保留这个目标"}).json()
    before = store.course(course["id"])
    response = client.put(base + f'/goals/{created["goals"][0]["id"]}', json={
        "title": "无效引用", "revision": created["revision"], "node_ids": ["foreign"],
    })
    assert response.status_code == 404
    assert store.course(course["id"]) == before
