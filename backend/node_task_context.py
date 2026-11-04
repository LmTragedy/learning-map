"""Compare the prompt inputs and write targets for node-scoped AI tasks."""

import json

from .store import Conflict


def _normalize(value):
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True))


def _strip_related_progress(context):
    for relation in context["relations"]:
        relation.get("other_node", {}).pop("status", None)
    for related in (context.get("synthesis") or {}).get("related_nodes", []):
        related.pop("status", None)
        related.pop("verification", None)
    return context


def _node(course, node_id):
    from .domain import find_node

    try:
        return find_node(course, node_id)
    except KeyError as error:
        raise Conflict("AI 任务对应的知识点已删除，原始结果已保留") from error


def _context(course, node):
    from .learning import node_context

    return _strip_related_progress(_normalize(json.loads(node_context(course, node))))


def _recall_history(course, node):
    from .review_scope import active_records

    return _normalize(active_records(course, node.get("chats", [])))


def _validate_recall(before, current, node_id):
    from .review_scope import scope_key

    before_node, current_node = _node(before, node_id), _node(current, node_id)
    if (before_node["title"] != current_node["title"]
            or scope_key(before) != scope_key(current)
            or _recall_history(before, before_node) != _recall_history(current, current_node)):
        raise Conflict("Recall 对话或复习范围已变化，原始结果已保留")


def _validate_recall_child(task, before, current):
    from .review_scope import scope_key

    inputs = task["inputs"]
    node_id = inputs.get("node_id")
    if node_id is None:
        matches = [node for node in before["nodes"]
                   if node["title"] == inputs.get("node_title")
                   and _recall_history(before, node) == _normalize(inputs.get("history", []))]
        if len(matches) != 1:
            raise Conflict("无法唯一确定历史 Recall 对应的知识点，原始结果已保留")
        node_id = matches[0]["id"]

    before_node, current_node = _node(before, node_id), _node(current, node_id)
    if (inputs.get("node_title") != current_node["title"]
            or inputs.get("scope") != scope_key(current)
            or _normalize(inputs.get("history", [])) != _recall_history(current, current_node)):
        raise Conflict("Recall 对话、节点或复习范围已变化，原始结果已保留")
    if before_node["title"] != current_node["title"]:
        raise Conflict("Recall 对应的知识点已变化，原始结果已保留")


def _question_inputs(course, node):
    from .problem_bank import benchmark_prompt
    from .review_scope import question_for

    return dict(context=_context(course, node), benchmark=_normalize(benchmark_prompt(course, node)),
                current_question=_normalize(question_for(course, node)))


def _assessment_inputs(task, course, node):
    from .learning import node_context
    from .practice_progress import confirmed_points, practice_evidence
    from .relations import incoming_bridges
    from .review_scope import question_for

    submission = task["inputs"]["submission"]
    question = question_for(course, node)
    context = _strip_related_progress(json.loads(node_context(course, node)))
    context["assessment_evidence"] = []
    context["practice_progress"] = None
    context["practice_resolutions"] = []
    chain = (practice_evidence(course, node, submission["parent_attempt_id"])
             if submission.get("parent_attempt_id") else [])
    return _normalize(dict(
        context=context,
        question=question,
        incoming_bridges=incoming_bridges(course, node),
        chain=chain,
        confirmed_points=confirmed_points(chain),
        evidence={key: submission[key] for key in ("answer", "reference", "attachments")},
        submitted_question=submission.get("question"),
        question_key=submission.get("question_key"),
        image_paths=task["inputs"].get("image_paths", []),
    ))


def _lesson_inputs(task, course, node):
    from .lesson_plan_context import context_version, request_fields, without_reading_marks
    from .lessons import LessonRequest, _lesson_context, _visual_page_manifest

    request = LessonRequest.model_validate(request_fields(task["inputs"]))
    pages, image_refs = _visual_page_manifest(course, node)
    context = json.loads(_lesson_context(course, node, request, pages, context_version(task["inputs"])))
    _strip_related_progress(context["node"])
    without_reading_marks(context)
    return _normalize(dict(context=context, image_refs=image_refs))


def _chat_plan(course, node):
    from .teaching_plans.projection import chat_plan_payload

    return _normalize(chat_plan_payload(course, node))


def _plan_inputs(course, node):
    from .teaching_plans.inputs import planning_inputs

    return _normalize(planning_inputs(course, node))


def _require_equal(label, before, current):
    if before != current:
        raise Conflict(f"{label}在 AI 处理期间发生变化，原始结果已保留")


def validate_node_task(task, current):
    """Reject only when a node task's prompt inputs or destination changed."""
    before = task["before"]
    kind = task["kind"]
    if kind == "child" and task.get("role") == "recall_summary":
        _validate_recall_child(task, before, current)
        return

    node_id = task["target"]
    before_node, current_node = _node(before, node_id), _node(current, node_id)
    if kind == "recall":
        _validate_recall(before, current, node_id)
    elif kind == "chat":
        _require_equal("知识点上下文", _context(before, before_node), _context(current, current_node))
        if (task.get("inputs") or {}).get("context_version", 1) >= 2:
            _require_equal("教学分工", _chat_plan(before, before_node), _chat_plan(current, current_node))
    elif kind == "question":
        _require_equal("出题输入", _question_inputs(before, before_node),
                       _question_inputs(current, current_node))
    elif kind == "assessment":
        _require_equal("验收输入", _assessment_inputs(task, before, before_node),
                       _assessment_inputs(task, current, current_node))
    elif kind == "teaching_plan":
        _require_equal("教学分工输入", _plan_inputs(before, before_node), _plan_inputs(current, current_node))
    elif kind == "lesson":
        _require_equal("小课输入", _lesson_inputs(task, before, before_node),
                       _lesson_inputs(task, current, current_node))
