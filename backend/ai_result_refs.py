"""Saved business objects and conservative references into the current course."""

import copy
import hashlib
import json

from .conversation_sessions import NODE_CHANNELS, conversation_scope
from .review_scope import question_for, scope_key


def _node(course, target):
    return next((node for node in course["nodes"] if node["id"] == target), None)


def _reply(task):
    try:
        return json.loads(task.get("raw_reply", {}).get("text", ""))
    except (ValueError, TypeError):
        return None


def _unique(records):
    return records[0] if len(records) == 1 else None


def _chat(task, course):
    node = _node(course, task["target"])
    before = _node(task["before"], task["target"])
    previous = {chat["id"] for chat in (before or {}).get("chats", [])}
    return _unique([chat for chat in (node or {}).get("chats", []) if chat["id"] not in previous
                    and chat["role"] == "assistant" and chat["content"] == task.get("raw_reply", {}).get("text")])


def _lesson(task, course):
    node = _node(course, task["target"])
    return _unique([lesson for lesson in (node or {}).get("lessons", [])
                    if lesson["request_id"] == task["request_id"]])


def _assessment(task, course):
    node = _node(course, task["target"])
    attempt_id = task["inputs"].get("submission", {}).get("id", task["request_id"])
    return _unique([attempt for attempt in (node or {}).get("attempts", []) if attempt["id"] == attempt_id])


def _question(task, course):
    node = _node(course, task["target"])
    question = question_for(course, node) if node else None
    return question if question == _reply(task) else None


def _bridge(task, course):
    draft = _reply(task) or {}
    ids = {relation.get("id") for relation in draft.get("relations", [])}
    return [edge for edge in course["edges"] if edge["id"] in ids] or None


def _links(task, course):
    return [edge for edge in course["edges"] if task["target"] in (edge.get("source"), edge.get("target"))] or None


def _map(task, course):
    fields = ("id", "title", "summary", "prerequisites", "sources", "pieces", "steps")
    return dict(nodes=[{key: node[key] for key in fields if key in node} for node in course["nodes"]],
                edges=course["edges"])


def _lines(task, course):
    return dict(lines=course.get("lines", []), overview=course.get("overview"))


def _retell(task, course):
    line = next((line for line in course.get("lines", []) if line["id"] == task["target"]), {})
    return _unique([retell for retell in line.get("retells", [])
                    if retell["text"] == task["inputs"]["text"] and retell["review"] == _reply(task)])


def _teaching_plan(task, course):
    book = course.get("teaching_plans", {}).get(scope_key(task["before"]), {})
    plan = book.get(task["target"])
    return plan if plan and plan.get("task_id") == task["id"] else None


OBJECT_READERS = {"chat": _chat, "lesson": _lesson, "assessment": _assessment, "question": _question,
                  "map": _map, "bridge": _bridge, "bridge_history": _bridge, "links": _links, "lines": _lines, "retell": _retell,
                  "teaching_plan": _teaching_plan}


def _stable_object(kind, payload):
    if not isinstance(payload, dict):
        return payload
    ignored = {"read_at"} if kind == "lesson" else {"rating_state", "resolution", "ratings"}
    return {key: value for key, value in payload.items() if key not in ignored}


def _fingerprint(kind, payload):
    encoded = json.dumps(_stable_object(kind, payload), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def result_record(task, course):
    if task.get("result_type") == "value":
        payload = task.get("result")
    else:
        reader = OBJECT_READERS.get(task["kind"])
        payload = reader(task, course) if reader else None
    if payload is None:
        return {}
    reference = dict(kind=task["kind"], course_id=course["id"], node_id=task["target"],
                     object_id=payload.get("id") if isinstance(payload, dict) else None,
                     scope=conversation_scope(task), epoch=task["before"].get("ai_epoch"),
                     fingerprint=_fingerprint(task["kind"], payload))
    return dict(result_ref=reference, result_object=copy.deepcopy(payload))


def presented_result(task, course):
    recorded = {key: task[key] for key in ("result_ref", "result_object") if key in task}
    if not recorded and task["kind"] == "bridge_history":
        from .ai_history_import import bridge_disposition

        if bridge_disposition(task, course) == "already_applied":
            recorded = result_record(task, course)
    if (not recorded and task["state"] == "applied" and task.get("before")
            and (task["kind"] in {"chat", "lesson", "assessment", "question"} or task.get("result_type") == "value")):
        recorded = _legacy_result_record(task, course)
    if not recorded.get("result_ref"):
        return recorded
    reference = dict(recorded["result_ref"], available=False, checked_revision=course["revision"])
    same_epoch = reference.get("epoch") == course.get("ai_epoch")
    same_scope = reference.get("scope") == scope_key(course) if task["kind"] in NODE_CHANNELS else True
    if task.get("result_type") == "value":
        available = same_epoch and same_scope
    elif task["kind"] == "history":
        available = same_epoch and reference.get("scope", "course") == scope_key(course) and _historical_object_present(task, course, reference)
    elif task["kind"] in OBJECT_READERS:
        current = _referenced_object(task, course, reference)
        available = same_epoch and same_scope and current is not None and (
            _fingerprint(task["kind"], current) == reference.get("fingerprint"))
    else:
        available = False
    return recorded | dict(result_ref=reference | dict(available=available))


def _legacy_result_record(task, course):
    from .ai_history_import import _assessment_match, _lesson_match
    from .schemas import Judgment

    node = _node(course, task["target"]) or {}
    draft = _reply(task)
    if task["kind"] == "lesson":
        if not isinstance(draft, dict) or _lesson_match(dict(parsed_output=draft), node) is None:
            return {}
    elif task["kind"] == "assessment":
        try:
            draft = Judgment.model_validate(draft).model_dump()
        except ValueError:
            return {}
        before_node = _node(task["before"], task["target"])
        submission = task["inputs"].get("submission", {})
        candidate = dict(parsed_output=draft, parsed_input=dict(question=question_for(task["before"], before_node),
                         evidence={key: submission[key] for key in ("answer", "reference", "attachments") if key in submission}))
        if _assessment_match(candidate, node) is None:
            return {}
    return result_record(task, course)


def _historical_object_present(task, course, reference):
    kind = reference["kind"]
    node = _node(course, reference.get("node_id")) or {}
    collections = {"chat": "chats", "lesson": "lessons", "assessment": "attempts"}
    if kind in collections:
        current = next((entry for entry in node.get(collections[kind], [])
                        if entry["id"] == reference.get("object_id")), None)
    elif kind == "question":
        current = node.get("question")
    else:
        return False
    return current is not None and _fingerprint(kind, current) == _fingerprint(kind, task.get("result_object"))


def _referenced_object(task, course, reference):
    collections = {"chat": "chats", "lesson": "lessons", "assessment": "attempts"}
    collection = collections.get(task["kind"])
    if reference.get("object_id") and collection:
        node = _node(course, task["target"]) or {}
        return next((entry for entry in node.get(collection, []) if entry["id"] == reference["object_id"]), None)
    return OBJECT_READERS[task["kind"]](task, course)
