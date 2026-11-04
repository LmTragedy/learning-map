"""Course task guards track the inputs the AI saw and the output destination."""

import json
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.course_task_context import validate_course_task
from backend.store import Conflict


@pytest.fixture
def course(tmp_path):
    app = create_app(tmp_path / "data", lambda _: None)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    seeded = client.post("/api/sample").json()
    return app.state.store.course(seeded["id"])


def task_for(kind, course, target="course", inputs=None, **extra):
    return dict(kind=kind, target=target, inputs=inputs or {}, before=deepcopy(course),
                course_id=course["id"], **extra)


def _problem_set(set_id="exam", text="真题内容"):
    return dict(id=set_id, title="期末真题", instructions="", problems=[
        dict(id="question-1", number="1", text=text, answer="答案", images=[], answer_images=[]),
    ])


def test_line_generation_ignores_learning_progress_but_rejects_prompt_changes(course):
    task = task_for("lines", course)
    current = deepcopy(course)
    current["nodes"][0]["personal_note"] = "未发送给模型的笔记"
    current["nodes"][0]["status"] = "studied"
    validate_course_task(task, current)

    current["nodes"][0]["title"] += " changed"
    with pytest.raises(Conflict):
        validate_course_task(task, current)


def test_retell_checks_its_line_and_bridge_prompt_but_ignores_other_node_progress(course):
    node_ids = [node["id"] for node in course["nodes"][:2]]
    line = dict(id="line-a", name="测试主线", goal="完成课程任务", node_ids=node_ids)
    course["lines"] = [line]
    task = task_for("retell", course, "line-a", {"text": "用户的讲述"})
    current = deepcopy(course)
    current["nodes"][-1]["personal_note"] = "无关节点笔记"
    validate_course_task(task, current)

    current["lines"][0]["goal"] = "改过的目标"
    with pytest.raises(Conflict):
        validate_course_task(task, current)


def test_goal_extraction_ignores_unrelated_notes_but_rejects_material_changes(course):
    task = task_for("goals", course)
    current = deepcopy(course)
    current["nodes"][0]["personal_note"] = "用户笔记"
    validate_course_task(task, current)

    current["materials"][0]["pages"][0]["text"] += " changed"
    with pytest.raises(Conflict):
        validate_course_task(task, current)


def test_unit_generation_checks_selected_materials_and_benchmark_only(course):
    course["problem_sets"] = [_problem_set(), _problem_set("other", "其他题")]
    request = dict(material_ids=[course["materials"][0]["id"]], problem_set_ids=["exam"], count=2, focus="")
    task = task_for("problem_unit", course, inputs=request)
    current = deepcopy(course)
    current["problem_sets"][1]["problems"][0]["text"] = "未选题库变更"
    current["nodes"][0]["personal_note"] = "学习进度"
    validate_course_task(task, current)

    current["problem_sets"][0]["problems"][0]["text"] = "更新后的真题"
    with pytest.raises(Conflict):
        validate_course_task(task, current)


def test_problem_link_checks_target_set_and_all_node_prompt_inputs(course):
    course["problem_sets"] = [_problem_set(), _problem_set("other", "其他题")]
    task = task_for("problem_link", course, "exam")
    current = deepcopy(course)
    current["problem_sets"][1]["problems"][0]["text"] = "未选题库变更"
    validate_course_task(task, current)

    current["problem_sets"][0]["problems"][0]["text"] = "更新后的真题"
    with pytest.raises(Conflict):
        validate_course_task(task, current)


def test_material_index_rejects_changed_or_already_indexed_target_page(course):
    from backend.material_indexing import _next_batch
    from backend.page_index import set_page_index

    page_batch = _next_batch(course)[:1]
    task = task_for("material_index", course, inputs={"indexed": 0}, input_context={"pages": page_batch})
    current = deepcopy(course)
    current["nodes"][0]["personal_note"] = "无关学习数据"
    validate_course_task(task, current)

    page = page_batch[0]
    current["materials"][0]["pages"][page["page"] - 1]["text"] += " changed"
    with pytest.raises(Conflict):
        validate_course_task(task, current)

    indexed = deepcopy(course)
    selected = page_batch[0]
    material = next(item for item in indexed["materials"] if item["id"] == selected["material_id"])
    source_page = material["pages"][selected["page"] - 1]
    set_page_index(indexed, material["id"], selected["page"], source_page["text"], key_quotes=[])
    with pytest.raises(Conflict):
        validate_course_task(task, indexed)


def test_material_page_child_validates_frozen_pages_against_course(course):
    from backend.material_indexing import _next_batch, _prompt

    pages = _next_batch(course)[:1]
    child = task_for("child", course, inputs={"pages": pages, "prompt": _prompt(course, pages)},
                     role="material_page_index")
    current = deepcopy(course)
    current["materials"][0]["name"] = "改名"
    with pytest.raises(Conflict):
        validate_course_task(child, current)


def test_course_task_validation_normalizes_json_object_key_order(course):
    sorted_before = json.loads(json.dumps(course, sort_keys=True))
    validate_course_task(task_for("lines", sorted_before), course)


def test_course_task_validation_fails_closed_for_unregistered_task_kind(course):
    with pytest.raises(Conflict):
        validate_course_task(task_for("unknown", course), course)
