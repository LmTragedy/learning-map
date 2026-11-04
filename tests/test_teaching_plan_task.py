"""Preparing a plan: saved atomically, references checked, pieces never dropped, stale inputs refused."""

import json

from backend.domain import find_node
from backend.teaching_plans.scope import plan_for
from tests.plan_fixtures import plan_path, plan_reply, plan_session_fixture  # noqa: F401  (fixture)


def _prepare(client, course, request_id="plan-request-000001", index=0):
    return client.post(plan_path(course, index), json={"request_id": request_id})


def test_plan_is_saved_projected_and_only_coordinated_with_related_nodes(plan_session):
    client, store, model, course = plan_session
    first, second, _, last = course["nodes"]
    model.replies.append(plan_reply(course, borrows=[dict(node_id=last["id"], what="无关", use="")]))
    response = _prepare(client, course)
    assert response.status_code == 200, response.text

    prompt = model.prompts[0]
    inputs = json.loads(prompt.split("分工输入：\n", 1)[1])
    assert [entry["id"] for entry in inputs["neighbours"]] == [second["id"]]
    assert inputs["neighbours"][0]["reasons"] == ["same_page", "later"]

    view = find_node(response.json(), first["id"])["teaching_plan"]
    assert view["status"] == "current" and view["version"] == 1
    assert view["defers"][0]["title"] == second["title"]
    assert view["borrows"] == []  # The unrelated node was dropped ...
    saved = plan_for(store.course(course["id"]), first["id"])
    assert saved["dropped_refs"] == [f"borrows:{last['id']}"]  # ... and recorded.
    assert "teaching_plans" not in response.json()
    assert any(version["reason"] == "准备教学分工前自动备份" for version in store.versions(course["id"]))


def test_left_out_or_deferred_pieces_stay_and_become_conflicts(plan_session):
    client, store, model, course = plan_session
    second = course["nodes"][1]
    model.replies.append(plan_reply(
        course,
        owns=[dict(piece="完备性", point="完备性", depth="讲透"), dict(piece="不存在的块", point="别的", depth="简述")],
        defers=[dict(node_id=second["id"], what="传递性")]))
    response = _prepare(client, course)
    assert response.status_code == 200, response.text
    plan = plan_for(store.course(course["id"]), course["nodes"][0]["id"])
    assert {point["piece"] for point in plan["owns"]} == {"完备性", "", "传递性"}
    issues = " ".join(conflict["issue"] for conflict in plan["conflicts"])
    assert "「传递性」没有分配" in issues and "「传递性」被列为由其他节点深入" in issues
    assert plan["uncertain"] is True and "owns.piece:不存在的块" in plan["dropped_refs"]


def test_node_without_pieces_gets_a_candidate_plan(plan_session):
    client, store, model, course = plan_session
    model.replies.append(plan_reply(course, owns=[dict(piece="", point="解释事务", depth="讲透")], defers=[],
                                    distinctions=[]))
    assert _prepare(client, course, index=3).status_code == 200
    plan = plan_for(store.course(course["id"]), course["nodes"][3]["id"])
    assert plan["candidate"] is True and plan["uncertain"] is True and plan["conflicts"] == []


def test_input_change_during_planning_keeps_the_raw_reply_and_writes_nothing(plan_session):
    client, store, model, course = plan_session

    def change_neighbour():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][1]["pieces"].append(dict(id="x", kind="方法", title="新块", detail="", sources=[]))

    model.before_reply = change_neighbour
    model.replies.append(plan_reply(course))
    response = _prepare(client, course)
    assert response.status_code == 409, response.text
    assert plan_for(store.course(course["id"]), course["nodes"][0]["id"]) is None
    task = next(task for task in client.get(f"/api/courses/{course['id']}/ai-tasks").json()
                if task["kind"] == "teaching_plan")
    assert task["has_raw_reply"] is True and task["state"] != "applied"


def test_unrelated_note_during_planning_does_not_void_it(plan_session):
    client, store, model, course = plan_session

    def write_note():
        with store.edit(course["id"]) as (current, _):
            current["nodes"][0]["personal_note"] = "边想边记"

    model.before_reply = write_note
    model.replies.append(plan_reply(course))
    assert _prepare(client, course).status_code == 200


def test_regenerate_bumps_the_version_and_delete_removes_it(plan_session):
    client, store, model, course = plan_session
    model.replies.extend([plan_reply(course), plan_reply(course, goal="第二版目标")])
    assert _prepare(client, course).status_code == 200
    task = next(task for task in client.get(f"/api/courses/{course['id']}/ai-tasks").json()
                if task["kind"] == "teaching_plan")
    regenerated = client.post(f"/api/courses/{course['id']}/ai-tasks/{task['id']}/regenerate",
                              json={"request_id": "plan-request-000002"})
    assert regenerated.status_code == 200, regenerated.text
    plan = plan_for(store.course(course["id"]), course["nodes"][0]["id"])
    assert plan["version"] == 2 and plan["goal"] == "第二版目标"

    revision = store.course(course["id"])["revision"]
    deleted = client.post(plan_path(course) + "/delete", json={"revision": revision})
    assert deleted.status_code == 200
    assert find_node(deleted.json(), course["nodes"][0]["id"])["teaching_plan"] is None


def test_applied_task_result_points_at_the_saved_plan(plan_session):
    client, _, model, course = plan_session
    model.replies.append(plan_reply(course))
    _prepare(client, course)
    task = next(task for task in client.get(f"/api/courses/{course['id']}/ai-tasks").json()
                if task["kind"] == "teaching_plan")
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    assert detail["result_ref"]["available"] is True
    assert detail["result_object"]["goal"] == "能判断一个偏好关系是否理性"


def test_uncertain_plan_records_why(plan_session):
    client, store, model, course = plan_session
    material = course["materials"][0]["id"]
    model.replies.append(plan_reply(course, sources=[dict(material_id=material, page=1, quote="材料里没有这句话"),
                                                     dict(material_id=material, page=3, quote="")]))
    response = _prepare(client, course)
    assert response.status_code == 200, response.text
    plan = find_node(response.json(), course["nodes"][0]["id"])["teaching_plan"]
    assert plan["uncertain"] is True
    assert plan["uncertain_reasons"] == ["第 1 页的引文在原文中找不到，已清空", "引用的第 3 页不是本节点的来源，已移除"]
    assert plan["sources"] == [dict(material_id=material, page=1, quote="")]


def test_clean_plan_is_not_uncertain(plan_session):
    client, _, model, course = plan_session
    model.replies.append(plan_reply(course))
    plan = find_node(_prepare(client, course).json(), course["nodes"][0]["id"])["teaching_plan"]
    assert plan["uncertain"] is False and plan["uncertain_reasons"] == []


def test_repeated_page_reasons_are_listed_once(plan_session):
    client, store, model, course = plan_session
    material = course["materials"][0]["id"]
    with store.edit(course["id"]) as (current, _):
        current["materials"][0]["pages"][0]["uncertain"] = True
    model.replies.append(plan_reply(course, sources=[dict(material_id=material, page=1, quote=""),
                                                     dict(material_id=material, page=1, quote="")]))
    plan = find_node(_prepare(client, course).json(), course["nodes"][0]["id"])["teaching_plan"]
    assert plan["uncertain_reasons"] == ["第 1 页的提取文字本身存疑"]


def test_plans_saved_with_repeated_reasons_are_shown_once(plan_session):
    client, store, model, course = plan_session
    model.replies.append(plan_reply(course))
    _prepare(client, course)
    with store.edit(course["id"]) as (current, _):
        plan = current["teaching_plans"]["course"][course["nodes"][0]["id"]]
        plan["uncertain"], plan["uncertain_reasons"] = True, ["甲", "甲", "乙"]
    view = find_node(client.get(f"/api/courses/{course['id']}").json(), course["nodes"][0]["id"])["teaching_plan"]
    assert view["uncertain_reasons"] == ["甲", "乙"]


def test_defer_to_an_earlier_node_is_recorded_as_borrowed(plan_session):
    client, store, model, course = plan_session
    first, second, third = (node["id"] for node in course["nodes"][:3])
    # The second node comes after the first (and shares its page) and before the third.
    model.replies.append(plan_reply(course, owns=[dict(piece="加糖例子", point="加糖论证", depth="讲透")],
                                    defers=[dict(node_id=first, what="完备性的一般检验"),
                                            dict(node_id=third, what="后面的应用")],
                                    distinctions=[]))
    assert _prepare(client, course, index=1).status_code == 200
    plan = plan_for(store.course(course["id"]), second)
    assert [(entry["node_id"], entry["what"]) for entry in plan["borrows"]] == [(first, "完备性的一般检验")]
    assert [entry["node_id"] for entry in plan["defers"]] == [third]
    assert plan["moved_refs"] == [f"defers→borrows:{first}"]
    assert plan["uncertain"] is False
