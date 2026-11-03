"""The lessons just before and after a node: order like the side list, transitions, and lesson hand-off."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.handoff import neighbours
from tests.test_lessons import LessonModel, lesson_draft
from tests.test_node_links import draft, link


@pytest.fixture
def session(tmp_path):
    model = LessonModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    model.prompts = []
    ask = model.ask
    model.ask = lambda prompt, **options: (model.prompts.append(prompt), ask(prompt, **options))[1]
    return client, app.state.store, model, course


def test_neighbours_follow_the_route_then_the_line_and_off_line_nodes_keep_course_order():
    nodes = [dict(id=key, prerequisites=[], status="new") for key in "abcd"]
    nodes[1]["prerequisites"], nodes[2]["prerequisites"] = ["a"], ["b"]
    course = dict(nodes=nodes, lines=[])
    # Route order: roots first (a, d), then b, c — the same order the side list shows.
    assert neighbours(course, "b") == dict(line_name="", prev="d", next="c")
    course["lines"] = [dict(id="l", name="主线", node_ids=["c", "a", "gone"])]
    assert neighbours(course, "a") == dict(line_name="主线", prev="c", next=None)
    assert neighbours(course, "b") == dict(line_name="", prev=None, next="d")


def test_links_write_concrete_transitions_that_hide_when_the_order_changes(session):
    client, store, model, course = session
    first, focus, third, _ = (node["id"] for node in course["nodes"])
    model.replies.append(draft([link(first, "before", "主键", "说明原子性")]) | dict(
        prev_transition="上一课的主键让每笔转账能对上账户，这一课第 1 步用它说明原子性。",
        next_transition="下一课换成中途失败的转账，用这一课的原子性决定回滚。"))
    response = client.post(f"/api/courses/{course['id']}/nodes/{focus}/links", json={"revision": course["revision"]})
    assert response.status_code == 200, response.text
    prompt = model.prompts[-1]
    assert "学习顺序" in prompt and "prev_transition" in prompt
    order = json.loads(prompt.split("\n学习顺序：", 1)[1].split("\n", 1)[0])
    assert order["previous"]["id"] == first and order["next"]["id"] == third
    node = next(item for item in response.json()["nodes"] if item["id"] == focus)
    assert node["handoff"]["prev"] == first and node["handoff"]["prev_text"].startswith("上一课的主键")
    assert node["handoff"]["next"] == third and node["handoff"]["next_text"].startswith("下一课")

    with store.edit(course["id"]) as (current, _):
        current["lines"] = [dict(id="l", name="新主线", goal="", node_ids=[third, focus], endpoint="", story=[], origin="user")]
    moved = next(item for item in client.get(f"/api/courses/{course['id']}").json()["nodes"] if item["id"] == focus)
    assert moved["handoff"] | {} == dict(line_name="新主线", prev=third, next=None, prev_text="", next_text="")


def test_lessons_get_the_neighbours_and_render_recap_and_preview(session):
    client, _, model, course = session
    node_id = course["nodes"][1]["id"]
    model.replies.append(lesson_draft() | dict(previous_recap="上节课的主键让每行可区分。", next_preview="下节课看转账中途失败。"))
    response = client.post(f"/api/courses/{course['id']}/nodes/{node_id}/lessons",
                           json=dict(request_id="handoff-request-0001", kind="initial", focus=""))
    assert response.status_code == 200, response.text
    context = json.loads(model.prompts[-1].split("学习上下文：\n", 1)[1])
    assert context["handoff"]["previous"]["title"] == course["nodes"][0]["title"]
    assert context["handoff"]["next"]["title"] == course["nodes"][2]["title"]
    lesson = next(item for item in response.json()["nodes"] if item["id"] == node_id)["lessons"][0]
    html = client.get(f"/api/courses/{course['id']}/nodes/{node_id}/lessons/{lesson['id']}/html").text
    assert html.index("上节课回顾") < html.index("看一个例子") < html.index("随手复习") < html.index("下节课预告")
    assert "上节课的主键让每行可区分。" in html


def test_lessons_without_hand_off_text_render_no_empty_boxes(session):
    client, _, model, course = session
    model.replies.append(lesson_draft())
    node_id = course["nodes"][0]["id"]
    response = client.post(f"/api/courses/{course['id']}/nodes/{node_id}/lessons",
                           json=dict(request_id="handoff-request-0002", kind="initial", focus=""))
    lesson = next(item for item in response.json()["nodes"] if item["id"] == node_id)["lessons"][0]
    html = client.get(f"/api/courses/{course['id']}/nodes/{node_id}/lessons/{lesson['id']}/html").text
    assert "上节课回顾" not in html and "下节课预告" not in html
