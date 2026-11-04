"""Lessons read the node's plan (version 2) and old lesson tasks keep their original contract (version 1)."""

import hashlib
import json

import backend.lessons as lessons
from backend.domain import find_node
from backend.lesson_method import LESSON_METHOD_V1, LESSON_METHOD_V2
from backend.teaching_plans.scope import writable_book
from tests.plan_fixtures import plan_path, plan_reply, plan_session_fixture  # noqa: F401  (fixture)


def lesson_draft():
    return dict(title="理性偏好", goal="检查理性偏好",
                html="<h3>完备性</h3><p>任意两个选项都能比较，这叫完备性；比较链条前后一致，这叫传递性。</p>",
                check_question="是否理性？", check_answer="检查两条性质。", recap="完备性、传递性。")


def _lesson(client, course, request_id="lesson-request-00001"):
    path = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/lessons"
    return client.post(path, json=dict(request_id=request_id, kind="initial", focus=""))


def _context(prompt):
    return json.loads(prompt.split("学习上下文：\n", 1)[1])


def _plan(client, model, course):
    model.replies.append(plan_reply(course))
    assert client.post(plan_path(course), json={"request_id": "plan-request-000001"}).status_code == 200


def test_lesson_reads_plan_related_duties_and_learning_state(plan_session):
    client, store, model, course = plan_session
    _plan(client, model, course)
    model.replies.append(lesson_draft())
    response = _lesson(client, course)
    assert response.status_code == 200, response.text

    prompt = model.prompts[-1]
    assert prompt.startswith(lessons.structured.__globals__["SYSTEM"] + "\n" + LESSON_METHOD_V2)
    context = _context(prompt)
    assert context["teaching_plan"]["goal"] == "能判断一个偏好关系是否理性"
    assert context["teaching_plan"]["status"] == "current"
    duty = context["related_duties"][0]
    assert duty["title"] == course["nodes"][1]["title"] and duty["reasons"] == ["same_page", "later", "plan_ref"]
    assert duty["duty"] is None and duty["pieces"] == ["例子：加糖例子"]
    assert set(context["learning_state"]) == {"lessons_taught", "marked_read", "independent_evidence"}

    lesson = find_node(store.course(course["id"]), course["nodes"][0]["id"])["lessons"][0]
    assert lesson["context_version"] == 2
    assert lesson["teaching_plan_ref"]["version"] == 1 and lesson["teaching_plan_ref"]["status"] == "current"
    assert lesson["teach_sha256"] == hashlib.sha256(LESSON_METHOD_V2.encode()).hexdigest()


def test_lesson_without_plan_still_gets_related_duties(plan_session):
    client, store, model, course = plan_session
    model.replies.append(lesson_draft())
    assert _lesson(client, course).status_code == 200
    context = _context(model.prompts[-1])
    assert context["teaching_plan"] is None and context["related_duties"]
    lesson = find_node(store.course(course["id"]), course["nodes"][0]["id"])["lessons"][0]
    assert lesson["teaching_plan_ref"] is None


def test_plan_saved_while_a_lesson_is_generated_voids_that_lesson(plan_session):
    client, store, model, course = plan_session

    def save_plan():
        with store.edit(course["id"]) as (current, _):
            writable_book(current)[current["nodes"][0]["id"]] = dict(
                id="p", version=1, input_sha256="x", goal="新分工", owns=[], borrows=[], defers=[],
                distinctions=[], sources=[], conflicts=[], uncertain=False, candidate=False, note="")

    model.before_reply = save_plan
    model.replies.append(lesson_draft())
    assert _lesson(client, course).status_code == 409
    assert not find_node(store.course(course["id"]), course["nodes"][0]["id"]).get("lessons")


def test_old_version_lesson_task_ignores_plans_and_keeps_its_method(plan_session, monkeypatch):
    client, store, model, course = plan_session
    monkeypatch.setattr(lessons, "LESSON_CONTEXT_VERSION", 1)

    def save_plan():
        with store.edit(course["id"]) as (current, _):
            writable_book(current)[current["nodes"][0]["id"]] = dict(
                id="p", version=1, input_sha256="x", goal="后来的分工", owns=[], borrows=[], defers=[],
                distinctions=[], sources=[], conflicts=[], uncertain=False, candidate=False, note="")

    model.before_reply = save_plan
    model.replies.append(lesson_draft())
    response = _lesson(client, course)
    assert response.status_code == 200, response.text
    assert "teaching_plan" not in _context(model.prompts[-1])
    lesson = find_node(store.course(course["id"]), course["nodes"][0]["id"])["lessons"][0]
    assert lesson["context_version"] == 1 and lesson["teaching_plan_ref"] is None
    assert lesson["teach_sha256"] == hashlib.sha256(LESSON_METHOD_V1.encode()).hexdigest()


def test_reading_another_lesson_during_generation_does_not_void_it(plan_session):
    client, store, model, course = plan_session
    model.replies.append(lesson_draft())
    assert _lesson(client, course).status_code == 200
    node_id = course["nodes"][0]["id"]
    lesson_id = find_node(store.course(course["id"]), node_id)["lessons"][0]["id"]

    def read_first():
        client.post(f"/api/courses/{course['id']}/nodes/{node_id}/lessons/{lesson_id}/read")

    model.before_reply = read_first
    model.replies.append(lesson_draft())
    response = client.post(f"/api/courses/{course['id']}/nodes/{node_id}/lessons",
                           json=dict(request_id="lesson-request-00002", kind="supplement", focus="再讲传递性"))
    assert response.status_code == 200, response.text
