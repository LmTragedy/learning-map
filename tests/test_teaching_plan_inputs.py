"""Who a plan is coordinated with, when it goes stale, and how review scopes keep plans apart."""

from backend.domain import find_node
from backend.teaching_plans.inputs import input_sha256, plan_status, planning_inputs
from backend.teaching_plans.neighbours import coordination_neighbours
from backend.teaching_plans.scope import plan_book, writable_book
from tests.plan_fixtures import plan_session_fixture  # noqa: F401  (fixture)


def _reasons(course, node):
    return {entry["node"]["title"]: entry["reasons"] for entry in coordination_neighbours(course, node)}


def test_same_page_and_dependencies_are_coordinated(plan_session):
    _, _, _, course = plan_session
    first, second, third, _ = course["nodes"]
    found = _reasons(course, second)
    assert found[first["title"]] == ["same_page", "earlier"]
    assert found[third["title"]] == ["later"]
    # Same page comes first, so it survives the cap.
    assert coordination_neighbours(course, second)[0]["node"]["id"] == first["id"]


def test_plan_references_add_neighbours_but_not_to_staleness(plan_session):
    _, store, _, course = plan_session
    first, last = course["nodes"][0], course["nodes"][3]
    before = input_sha256(course, first)
    with store.edit(course["id"]) as (current, _):
        writable_book(current)[first["id"]] = dict(version=1, goal="g", owns=[], borrows=[],
                                                   defers=[dict(node_id=last["id"], what="x")], distinctions=[])
    course = store.course(course["id"])
    assert "plan_ref" in _reasons(course, find_node(course, first["id"]))[last["title"]]
    assert input_sha256(course, find_node(course, first["id"])) == before


def test_notes_marks_and_chats_do_not_make_a_plan_stale_but_pieces_do(plan_session):
    _, store, _, course = plan_session
    first = course["nodes"][0]
    plan = dict(input_sha256=input_sha256(course, first))
    with store.edit(course["id"]) as (current, _):
        node = find_node(current, first["id"])
        node["personal_note"] = "我的笔记"
        node["user_mark"] = "studied"
        node["chats"].append(dict(id="c", role="user", content="问", created_at="t"))
    course = store.course(course["id"])
    assert plan_status(course, find_node(course, first["id"]), plan) == "current"
    with store.edit(course["id"]) as (current, _):
        current["nodes"][1]["pieces"].append(dict(id="n", kind="方法", title="新块", detail="", sources=[]))
    course = store.course(course["id"])
    assert plan_status(course, find_node(course, first["id"]), plan) == "stale"


def test_unrelated_node_change_keeps_the_plan_current(plan_session):
    _, store, _, course = plan_session
    first = course["nodes"][0]
    plan = dict(input_sha256=input_sha256(course, first))
    with store.edit(course["id"]) as (current, _):
        current["nodes"][3]["pieces"] = [dict(id="z", kind="定义", title="无关", detail="", sources=[])]
    course = store.course(course["id"])
    assert plan_status(course, find_node(course, first["id"]), plan) == "current"


def test_strict_review_reads_only_its_own_plans_and_selected_sources(plan_session):
    _, store, _, course = plan_session
    first = course["nodes"][0]
    with store.edit(course["id"]) as (current, _):
        writable_book(current)[first["id"]] = dict(version=1, goal="课程计划")
        current["review_scope"] = dict(enabled=True, material_ids=[current["materials"][0]["id"]], ai_scope="selected")
    course = store.course(course["id"])
    assert plan_book(course) == {}
    inputs = planning_inputs(course, find_node(course, first["id"]))
    assert inputs["current_plan"] is None and inputs["scope"].startswith("pdf:")
    assert "summary" not in inputs["target"] and inputs["target"]["goal"].startswith("仅依据所选资料")


def test_lesson_history_is_planning_input_but_not_staleness(plan_session):
    _, store, _, course = plan_session
    first = course["nodes"][0]
    before = input_sha256(course, first)
    with store.edit(course["id"]) as (current, _):
        find_node(current, first["id"]).setdefault("lessons", []).append(dict(title="旧课", recap="讲过加糖"))
    course = store.course(course["id"])
    node = find_node(course, first["id"])
    assert planning_inputs(course, node)["lesson_history"] == [dict(title="旧课", recap="讲过加糖")]
    assert input_sha256(course, node) == before


def test_strict_review_sends_only_steps_backed_by_selected_sources(plan_session):
    _, store, _, course = plan_session
    first, second = course["nodes"][0], course["nodes"][1]
    with store.edit(course["id"]) as (current, _):
        material = current["materials"][0]["id"]
        find_node(current, second["id"])["steps"] = [
            dict(id="a", title="无来源的步骤"),
            dict(id="b", title="有来源的步骤", sources=[dict(material_id=material, page=1, quote="")]),
            dict(id="c", title="其他资料的步骤", sources=[dict(material_id="other", page=1, quote="")]),
        ]
        current["review_scope"] = dict(enabled=True, material_ids=[material], ai_scope="selected")
    course = store.course(course["id"])
    inputs = planning_inputs(course, find_node(course, first["id"]))
    assert inputs["target"]["steps"] == []  # "检查完备性" has no source to confirm it.
    neighbour = next(entry for entry in inputs["neighbours"] if entry["id"] == second["id"])
    assert neighbour["steps"] == ["有来源的步骤"]


def test_whole_course_planning_keeps_every_step(plan_session):
    _, _, _, course = plan_session
    assert planning_inputs(course, course["nodes"][0])["target"]["steps"] == ["检查完备性"]
