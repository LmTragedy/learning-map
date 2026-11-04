"""Validate the course inputs and write targets for course-wide AI tasks."""

import json

from .store import Conflict


def _require_same(label, before, current):
    if before != current:
        raise Conflict(f"{label}在 AI 处理期间发生变化，原始结果已保留；请刷新后重试")


def _validate_lines(task, current):
    from .lines_ai import _generation_prompt

    _require_same("主线输入", _generation_prompt(task["before"]), _generation_prompt(current))


def _validate_retell(task, current):
    from .lines import find_line
    from .lines_ai import _retell_prompt

    before_line = find_line(task["before"], task["target"])
    try:
        current_line = find_line(current, task["target"])
    except KeyError as error:
        raise Conflict("串讲主线已删除，原始结果已保留") from error
    text = task["inputs"]["text"]
    _require_same("主线串讲输入", _retell_prompt(task["before"], before_line, text),
                  _retell_prompt(current, current_line, text))


def _validate_goals(task, current):
    from .goal_routes import _goal_candidate_prompt

    try:
        before_prompt = _goal_candidate_prompt(task["before"])
        current_prompt = _goal_candidate_prompt(current)
    except (KeyError, ValueError) as error:
        raise Conflict("目标提取材料或知识点已变化，原始结果已保留") from error
    _require_same("目标提取输入", before_prompt, current_prompt)


def _validate_problem_unit(task, current):
    from .problem_bank import UnitRequest, _unit_benchmark, _unit_material_context, _unit_prompt

    request = UnitRequest(**task["inputs"])
    before = task["before"]
    try:
        before_benchmark, before_refs = _unit_benchmark(before, request.problem_set_ids)
        current_benchmark, current_refs = _unit_benchmark(current, request.problem_set_ids)
        before_prompt = _unit_prompt(before, request, _unit_material_context(before, request.material_ids), before_benchmark)
        current_prompt = _unit_prompt(current, request, _unit_material_context(current, request.material_ids), current_benchmark)
    except (KeyError, ValueError) as error:
        raise Conflict("单元出题材料、真题或知识点已变化，原始结果已保留") from error
    _require_same("单元出题材料和真题", (before_prompt, before_refs), (current_prompt, current_refs))


def _validate_problem_link(task, current):
    from .problem_bank import _link_prompt, find_set

    before_refs, current_refs = [], []
    try:
        before_prompt = _link_prompt(task["before"], find_set(task["before"], task["target"]), before_refs)
        current_prompt = _link_prompt(current, find_set(current, task["target"]), current_refs)
    except (KeyError, ValueError) as error:
        raise Conflict("真题关联对象已删除或变化，原始结果已保留") from error
    _require_same("真题关联输入", (before_prompt, before_refs), (current_prompt, current_refs))


def _validate_material_index(task, current):
    from .material_indexing import _next_batch, _prompt

    before = task["before"]
    pages = task.get("input_context", {}).get("pages") or _next_batch(before)
    _require_same("材料索引输入", _prompt(before, pages), _prompt(current, pages))
    _validate_index_pages(current, pages, "材料索引")


def _validate_index_pages(current, pages, label):
    from .page_index import is_indexed

    materials = {material["id"]: material for material in current["materials"]}
    for indexed_page in pages:
        material = materials.get(indexed_page["material_id"])
        if material is None:
            raise Conflict(f"{label}来源已删除，原始结果已保留")
        if material["name"] != indexed_page["name"]:
            raise Conflict(f"{label}名称已变化，原始结果已保留")
        page_number = indexed_page["page"]
        page = material["pages"][page_number - 1] if 1 <= page_number <= len(material["pages"]) else None
        if page is None or page["text"] != indexed_page["text"]:
            raise Conflict(f"{label}来源已变化，原始结果已保留")
        if is_indexed(current, material, page_number, page):
            raise Conflict("材料页已建立索引，原始结果未覆盖现有索引")


def _validate_material_index_child(task, current):
    from .material_indexing import _prompt

    pages = task["inputs"]["pages"]
    _require_same("材料页索引输入", _prompt(task["before"], pages), _prompt(current, pages))
    _validate_index_pages(current, pages, "材料页索引")


def validate_course_task(task, current):
    """Reject a result only when its prompt inputs or write target changed."""
    task = task | {"before": json.loads(json.dumps(task["before"], ensure_ascii=False, sort_keys=True))}
    current = json.loads(json.dumps(current, ensure_ascii=False, sort_keys=True))
    kind = task["kind"]
    if kind == "lines":
        _validate_lines(task, current)
    elif kind == "retell":
        _validate_retell(task, current)
    elif kind == "goals":
        _validate_goals(task, current)
    elif kind == "problem_unit":
        _validate_problem_unit(task, current)
    elif kind == "problem_link":
        _validate_problem_link(task, current)
    elif kind == "material_index":
        _validate_material_index(task, current)
    elif kind == "child":
        if task.get("role") == "material_page_index":
            _validate_material_index_child(task, current)
        else:
            raise Conflict(f"课程子任务角色没有上下文校验契约：{task.get('role') or '未知'}")
    else:
        raise Conflict(f"AI 任务类型没有课程上下文校验契约：{kind or '未知'}")
