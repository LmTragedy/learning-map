"""End-to-end coverage for generated lesson visuals and durable legacy receipts."""

import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.learning import _strict_output_schema
from backend.lesson_html import LESSON_CSP
from backend.lessons import LessonDraft


def legacy_lesson_draft():
    return {
        "title": "关系中的一行",
        "goal": "用选课记录理解关系中的一行。",
        "html": (
            "<h2>看一个例子</h2><p>Enrollment 的每一行表示一次选课。</p>"
            "<script>alert('blocked')</script>"
        ),
        "check_question": "两行选课记录是否一定来自两个学生？",
        "check_answer": "不一定，同一学生可以选多门课。",
        "recap": "一行表示一条记录。",
    }


class VisualLessonModel:
    def __init__(self):
        self.replies = []
        self.calls = []

    def ask(self, prompt, **options):
        images = options.get("images", [])
        assert all(path.exists() for path in images)
        self.calls.append((prompt, options))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(prompt, options)
        return {"text": json.dumps(reply, ensure_ascii=False), "thread_id": "visual-lesson-thread"}


@pytest.fixture
def visual_lesson_session(tmp_path):
    model = VisualLessonModel()
    app = create_app(tmp_path / "data", lambda _settings: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app, app.state.store, model, course


def _lesson_path(course, node_id=None):
    node_id = node_id or course["nodes"][0]["id"]
    return f"/api/courses/{course['id']}/nodes/{node_id}/lessons"


def _page(course, page_number):
    material = course["materials"][0]
    return material, material["pages"][page_number - 1]


def _box_diagram(text):
    return {
        "width": 320,
        "height": 160,
        "elements": [
            {"id": "record", "type": "box", "x": 20, "y": 20, "width": 280, "height": 100, "text": text}
        ],
    }


def visual_lesson_draft(course):
    material, page_one = _page(course, 1)
    _, page_two = _page(course, 2)
    quote_one = page_one["text"].splitlines()[0]
    quote_two = page_two["text"].splitlines()[0]
    return legacy_lesson_draft() | {
        "visuals": [
            {
                "title": "原文例子",
                "kind": "example",
                "provenance": "source",
                "source": {"material_id": material["id"], "page": 1, "quote": quote_one},
                "body": "模型不能替换核对后的原文。",
            },
            {
                "title": "重绘选课关系示意一",
                "kind": "example",
                "provenance": "redraw",
                "source": {"material_id": material["id"], "page": 1, "quote": quote_one},
                "body": "学生和课程通过选课记录关联。",
                "diagram": _box_diagram("学生 → 选课 → 课程"),
            },
            {
                "title": "重绘选课关系示意二",
                "kind": "example",
                "provenance": "redraw",
                "source": {"material_id": material["id"], "page": 1, "quote": quote_one},
                "body": "同一条选课记录引用学生和课程。",
                "diagram": _box_diagram("student_id · course_id"),
            },
            {
                "title": "按两页重绘过程",
                "kind": "process",
                "provenance": "redraw",
                "source": {"material_id": material["id"], "page": 1, "quote": quote_one},
                "steps": [
                    {
                        "title": "先看关系定义",
                        "changes": ["从关系中找出一条记录"],
                        "reason": "原页给出关系的定义。",
                        "page": 1,
                        "quote": quote_one,
                        "diagram": _box_diagram("关系"),
                    },
                    {
                        "title": "再看关系中的键",
                        "changes": ["补充记录如何唯一识别"],
                        "reason": "第二页解释主键。",
                        "page": 2,
                        "quote": quote_two,
                        "diagram": _box_diagram("主键"),
                    }
                ],
            },
            {
                "title": "重绘原页图形",
                "kind": "figure",
                "provenance": "redraw",
                "source": {"material_id": material["id"], "page": 1, "quote": quote_one},
                "diagram": _box_diagram("关系图"),
            },
            {
                "title": "虚构练习例子",
                "kind": "example",
                "provenance": "invented",
                "source": None,
                "body": "虚构一个学生选两门课的练习情境。",
            },
            {
                "title": "另一个虚构练习例子",
                "kind": "example",
                "provenance": "invented",
                "source": None,
                "body": "虚构一个课程包含多名学生的情境。",
            },
        ],
    }


def test_generated_visual_provenance_persists_source_images_and_safe_html(visual_lesson_session):
    client, app, store, model, course = visual_lesson_session
    node_id = course["nodes"][0]["id"]
    material = course["materials"][0]
    with store.edit(course["id"]) as (current, _):
        current_node = next(node for node in current["nodes"] if node["id"] == node_id)
        current_node["sources"].append({"material_id": material["id"], "page": 2, "quote": ""})
    course = store.course(course["id"])
    model.replies.append(visual_lesson_draft(course))

    response = client.post(_lesson_path(course), json={
        "request_id": "visual-generation-request-01", "kind": "initial", "focus": "",
    })

    assert response.status_code == 200, response.text
    lesson = response.json()["nodes"][0]["lessons"][0]
    visuals = lesson["visuals"]
    source_example = next(item for item in visuals if item["kind"] == "example" and item["provenance"] == "source")
    redraw_examples = [item for item in visuals if item["kind"] == "example" and item["provenance"] == "redraw"]
    redraw_process = next(item for item in visuals if item["kind"] == "process" and item["provenance"] == "redraw")
    redraw_figure = next(item for item in visuals if item["kind"] == "figure" and item["provenance"] == "redraw")
    invented_examples = [item for item in visuals if item["kind"] == "example" and item["provenance"] == "invented"]
    assert source_example["source"]["matched"] is True
    assert source_example["body"] == source_example["source"]["quote"]
    assert len(redraw_examples) == 2
    assert redraw_examples[0]["source"] == redraw_examples[1]["source"]
    assert redraw_examples[0]["diagram"] != redraw_examples[1]["diagram"]
    assert [step["page"] for step in redraw_process["steps"]] == [1, 2]
    assert all(step["matched"] is True for step in redraw_process["steps"])
    assert redraw_figure["diagram"]["elements"]
    assert len(invented_examples) == 2
    assert all(item.get("source") is None for item in invented_examples)
    assert all(item["id"] and item["number"] > 0 for item in visuals)
    assert {image.resolve() for image in model.calls[-1][1]["images"]}
    assert all(image.is_file() for image in model.calls[-1][1]["images"])

    lesson_url = _lesson_path(course, node_id) + f"/{lesson['id']}/html"
    html = client.get(lesson_url)
    assert html.headers["content-security-policy"] == LESSON_CSP
    assert "<script" not in html.text.lower()
    assert "Enrollment" in html.text

    task = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]
    result = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}/result").json()
    assert result["result_ref"]["available"] is True
    assert result["object"]["visuals"] == visuals

    restarted = TestClient(create_app(store.root, lambda _settings: model), headers={"X-Learning-Map": "1"})
    reopened = restarted.get(f"/api/courses/{course['id']}").json()["nodes"][0]["lessons"][0]
    assert reopened["visuals"] == visuals
    page_image = restarted.get(
        f"/api/courses/{course['id']}/materials/{material['id']}/pages/1"
    )
    assert page_image.status_code == 200
    assert page_image.headers["content-type"].startswith("image/png")
    assert page_image.content.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(model.calls) == 1


def test_existing_lesson_initial_request_returns_unchanged_without_external_work(visual_lesson_session):
    client, _app, store, model, course = visual_lesson_session
    saved = legacy_lesson_draft() | {
        "id": "old-lesson-record",
        "created_at": "2026-10-20T00:00:00+00:00",
        "read_at": "2026-10-21T00:00:00+00:00",
        "kind": "initial",
        "focus": "",
        "request_id": "old-lesson-request-0001",
        "sources": [],
        "visuals": [{"id": "legacy-visual", "number": 1, "kind": "example", "provenance": "invented"}],
    }
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0].setdefault("lessons", []).append(copy.deepcopy(saved))
    before = store.course(course["id"])

    response = client.post(_lesson_path(course), json={
        "request_id": "initial-after-old-lesson-01", "kind": "initial", "focus": "",
    })

    assert response.status_code == 200, response.text
    after = store.course(course["id"])
    assert after == before
    returned = response.json()["nodes"][0]["lessons"]
    assert len(returned) == 1 and returned[0]["id"] == saved["id"]
    assert returned[0]["visuals"] == saved["visuals"]
    assert model.calls == []


def test_old_pending_lesson_receipt_recovers_with_saved_legacy_contract(visual_lesson_session, monkeypatch):
    client, _app, store, model, course = visual_lesson_session
    model.replies.append(legacy_lesson_draft())
    save = store.save_course
    first_save = True

    def fail_first_course_save(current, connection):
        nonlocal first_save
        if first_save:
            first_save = False
            raise OSError("simulated course persistence failure")
        return save(current, connection)

    monkeypatch.setattr(store, "save_course", fail_first_course_save)
    failed_client = TestClient(_app, raise_server_exceptions=False, headers={"X-Learning-Map": "1"})
    failed = failed_client.post(_lesson_path(course), json={
        "request_id": "legacy-recovery-request-01", "kind": "initial", "focus": "",
    })
    assert failed.status_code == 500
    task = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]
    task_id = task["id"]
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()
    assert detail["raw_reply"]["text"]
    calls_before_recovery = len(model.calls)

    # Emulate a durable receipt created before `visuals` was added to LessonDraft.
    with store.connect() as connection:
        row = connection.execute("SELECT body FROM ai_tasks WHERE id=?", (task_id,)).fetchone()
        body = json.loads(row["body"])
        body["request"]["prompt"] = "saved legacy lesson prompt"
        body["request"]["schema"] = _strict_output_schema(LessonDraft.model_json_schema())
        body["raw_reply"]["text"] = json.dumps(legacy_lesson_draft(), ensure_ascii=False)
        connection.execute("UPDATE ai_tasks SET body=? WHERE id=?", (json.dumps(body, ensure_ascii=False), task_id))

    monkeypatch.setattr(store, "save_course", save)
    restarted = TestClient(create_app(store.root, lambda _settings: model), headers={"X-Learning-Map": "1"})
    recovered = restarted.post(f"/api/courses/{course['id']}/ai-tasks/{task_id}/recover")

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    lesson = recovered.json()["course"]["nodes"][0]["lessons"][0]
    assert lesson["title"] == legacy_lesson_draft()["title"]
    assert "visuals" not in lesson
    assert len(model.calls) == calls_before_recovery
    final_receipt = restarted.get(f"/api/courses/{course['id']}/ai-tasks/{task_id}").json()
    assert final_receipt["request"]["prompt"] == "saved legacy lesson prompt"
    assert final_receipt["request"]["schema"] == _strict_output_schema(LessonDraft.model_json_schema())


@pytest.mark.parametrize("failure", ["outside_source", "invented_source", "unsafe_svg", "too_many_elements"])
def test_invalid_generated_visuals_keep_raw_receipt_without_writing_lesson(visual_lesson_session, failure):
    client, _app, store, model, course = visual_lesson_session
    draft = legacy_lesson_draft() | {"visuals": []}
    material, page = _page(course, 1)
    quote = page["text"].splitlines()[0]
    if failure == "outside_source":
        other_material = course["materials"][1]["id"] if len(course["materials"]) > 1 else "outside-material"
        draft["visuals"] = [{
            "title": "越界原文", "kind": "example", "provenance": "source",
            "source": {"material_id": other_material, "page": 1, "quote": "foreign source"},
        }]
    elif failure == "invented_source":
        draft["visuals"] = [{
            "title": "伪造原文", "kind": "example", "provenance": "invented",
            "source": {"material_id": material["id"], "page": 1, "quote": quote}, "body": "伪装为原文。",
        }]
    elif failure == "unsafe_svg":
        diagram = _box_diagram("不安全") | {"svg": "<svg onload='alert(1)'/>"}
        draft["visuals"] = [{
            "title": "不安全图形", "kind": "example", "provenance": "invented", "source": None,
            "diagram": diagram,
        }]
    else:
        diagram = _box_diagram("超限")
        diagram["elements"] = [
            {"id": f"shape-{index}", "type": "point", "x": index, "y": index}
            for index in range(81)
        ]
        draft["visuals"] = [{
            "title": "超限图形", "kind": "example", "provenance": "invented", "source": None,
            "diagram": diagram,
        }]
    model.replies.append(draft)
    before = store.course(course["id"])

    response = client.post(_lesson_path(course), json={
        "request_id": f"invalid-visual-{failure.replace('_', '-')}-01", "kind": "initial", "focus": "",
    })

    assert response.status_code == 400, response.text
    assert store.course(course["id"]) == before
    task = client.get(f"/api/courses/{course['id']}/ai-tasks").json()[0]
    detail = client.get(f"/api/courses/{course['id']}/ai-tasks/{task['id']}").json()
    assert detail["raw_reply"]["text"]
    assert detail["state"] == "invalid"
