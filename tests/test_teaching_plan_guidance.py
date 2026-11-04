"""Only a current plan may steer teaching; a stale one falls back to the node's current pieces."""

from backend.domain import find_node
from backend.teaching_plans.inputs import input_sha256, planning_inputs
from backend.teaching_plans.projection import chat_plan_payload, lesson_plan_context
from backend.teaching_plans.scope import writable_book
from tests.plan_fixtures import plan_session_fixture  # noqa: F401  (fixture)


def _save_plan(store, course, node_id, goal):
    with store.edit(course["id"]) as (current, _):
        node = find_node(current, node_id)
        writable_book(current)[node_id] = dict(
            id=goal, version=1, input_sha256=input_sha256(current, node), goal=goal,
            owns=[dict(piece="", point=goal, depth="讲透")], borrows=[], defers=[], distinctions=[],
            sources=[], conflicts=[], uncertain=False, candidate=False, note="")


def _grow_pieces(store, course, node_id):
    with store.edit(course["id"]) as (current, _):
        find_node(current, node_id)["pieces"].append(dict(id="new", kind="方法", title="新增的块", detail="", sources=[]))


def test_stale_neighbour_plan_no_longer_steers_the_lesson(plan_session):
    _, store, _, course = plan_session
    first, second = course["nodes"][0]["id"], course["nodes"][1]["id"]
    _save_plan(store, course, second, "旧职责")
    duty = lesson_plan_context(store.course(course["id"]), find_node(store.course(course["id"]), first))["related_duties"][0]
    assert duty["duty"]["goal"] == "旧职责" and duty["duty_stale"] is False
    assert duty["pieces"] == ["例子：加糖例子"]  # Pieces are sent even while the plan is current.

    _grow_pieces(store, course, second)
    latest = store.course(course["id"])
    duty = lesson_plan_context(latest, find_node(latest, first))["related_duties"][0]
    assert duty["duty"] is None and duty["duty_stale"] is True
    assert duty["pieces"] == ["例子：加糖例子", "方法：新增的块"]
    neighbour = next(entry for entry in planning_inputs(latest, find_node(latest, first))["neighbours"]
                     if entry["id"] == second)
    assert neighbour["plan"] is None and neighbour["plan_stale"] is True


def test_stale_own_plan_is_left_out_of_lesson_and_chat(plan_session):
    _, store, _, course = plan_session
    first = course["nodes"][0]["id"]
    _save_plan(store, course, first, "本节旧目标")
    latest = store.course(course["id"])
    assert lesson_plan_context(latest, find_node(latest, first))["teaching_plan"]["goal"] == "本节旧目标"
    assert chat_plan_payload(latest, find_node(latest, first)) is not None

    _grow_pieces(store, course, first)
    latest = store.course(course["id"])
    context = lesson_plan_context(latest, find_node(latest, first))
    assert context["teaching_plan"] is None and context["teaching_plan_stale"] is True
    assert chat_plan_payload(latest, find_node(latest, first)) is None
    # The planner still sees its own earlier plan, since that is what it is updating.
    assert planning_inputs(latest, find_node(latest, first))["current_plan"]["goal"] == "本节旧目标"
