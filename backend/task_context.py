"""Validate frozen AI inputs against the latest course without pinning unrelated revision changes."""

import json

from .store import Conflict

_NODE_TASK_KINDS = {"chat", "question", "assessment", "lesson", "recall", "teaching_plan"}
_COURSE_TASK_KINDS = {
    "lines", "retell", "goals", "problem_unit", "problem_link", "material_index",
}


def validate_task_context(task, current):
    if task.get("contract_version", 1) != 1:
        raise Conflict("AI 任务上下文契约版本不受支持，原始结果已保留")
    before = task.get("before") or {}
    if task.get("course_id") != current.get("id") or before.get("id") != current.get("id"):
        raise Conflict("AI 任务课程与当前课程不匹配，原始结果已保留")
    for field, label in (("ai_epoch", "课程恢复状态"), ("review_scope", "复习范围"),
                         ("preferences", "课程偏好")):
        if before.get(field) != current.get(field):
            raise Conflict(f"{label}在 AI 处理期间发生变化，原始结果已保留")

    kind = task.get("kind")
    if kind == "note_review":
        return
    if kind in _NODE_TASK_KINDS or (kind == "child" and task.get("role") == "recall_summary"):
        from .node_task_context import validate_node_task

        validate_node_task(task, current)
        return
    if kind == "child" and task.get("role") == "material_page_index":
        from .course_task_context import validate_course_task

        validate_course_task(task, current)
        return
    if kind == "map":
        _validate_map(task, current)
        return
    if kind in {"bridge", "bridge_history"}:
        _validate_bridges(task, current)
        return
    if kind == "links":
        _validate_links(task, current)
        return
    if kind in _COURSE_TASK_KINDS:
        from .course_task_context import validate_course_task

        validate_course_task(task, current)
        return
    raise Conflict(f"AI 任务类型或子任务角色没有上下文校验契约：{kind or '未知'}")


def _validate_map(task, current):
    before = task["before"]
    if before["materials"] != current["materials"]:
        raise Conflict("地图生成期间材料已变化，原始结果已保留")
    from .learning import require_same_materials

    require_same_materials(before, current)


def _validate_bridges(task, current):
    from .bridge_backfill import BATCH, _require_same_inputs, pending_relations

    before = task["before"]
    relation_ids = task.get("input_context", {}).get("relation_ids")
    if relation_ids is None and task["kind"] == "bridge_history":
        relation_ids = task["inputs"].get("relation_ids", [])
    if relation_ids is None:
        batch = pending_relations(before)
        if task["target"] != "batch":
            batch = [edge for edge in batch if edge["id"] == task["target"]]
        batch = batch[:BATCH]
    else:
        edge_by_id = {edge["id"]: edge for edge in before.get("edges", [])}
        batch = [edge_by_id[edge_id] for edge_id in relation_ids if edge_id in edge_by_id]
        if len(batch) != len(relation_ids):
            raise Conflict("原始知识联系已不存在，原始结果已保留")
    if not batch:
        raise Conflict("原始知识桥输入已不存在，原始结果已保留")
    _require_same_inputs(before, current, batch)


def _validate_links(task, current):
    from .domain import find_node

    node_id = task["target"]
    before = json.loads(_canonical(task["before"]))
    latest_course = json.loads(_canonical(current))
    try:
        node = find_node(before, node_id)
        latest = find_node(latest_course, node_id)
    except KeyError as error:
        raise Conflict("重新找前后联系的目标知识点已不存在，原始结果已保留") from error
    original = _link_inputs(before, node)
    updated = _link_inputs(latest_course, latest)
    if _canonical(original) != _canonical(updated):
        raise Conflict("重新找前后联系期间相关知识或来源已变化，原始结果已保留")


def _link_inputs(course, node):
    from .node_links import _brief, _existing, _material, _order

    return (
        _brief(node), _existing(course, node), _order(course, node),
        [_brief(item) for item in course["nodes"] if item["id"] != node["id"]],
        _material(course, node),
    )


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
