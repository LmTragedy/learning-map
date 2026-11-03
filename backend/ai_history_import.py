"""Import exact legacy turns as read-only receipts, separate from business application."""

import copy
import hashlib
import json

from .bridges import apply_draft_bridges
from .lesson_html import render_lesson
from .schemas import Judgment
from .store import identity, timestamp


def _unique(records):
    return records[0] if len(records) == 1 else None


def _lesson_match(candidate, node):
    draft = candidate["parsed_output"]
    fields = ("title", "goal", "check_question", "check_answer", "recap")
    return _unique([lesson for lesson in node.get("lessons", [])
                    if all(lesson.get(key) == draft.get(key) for key in fields)
                    and lesson.get("html") == render_lesson(draft, lesson.get("sources", []))])


def _assessment_match(candidate, node):
    evidence = candidate["parsed_input"].get("evidence") or {}
    return _unique([attempt for attempt in node.get("attempts", [])
                    if _judgment(attempt.get("judgment")) == candidate["parsed_output"]
                    and attempt.get("question") == candidate["parsed_input"].get("question")
                    and all(attempt.get(key) == value for key, value in evidence.items())])


def _judgment(judgment):
    try:
        return Judgment.model_validate(judgment).model_dump()
    except ValueError:
        return None


def _question_match(candidate, node):
    return node.get("question") if node.get("question") == candidate["parsed_output"] else None


def _chat_match(candidate, node):
    chats = node.get("chats", [])
    context = candidate["parsed_input"].get("context") or {}
    history = context.get("actual_conversations", [])
    matches = []
    for index, chat in enumerate(chats):
        if index < 1 or chat["role"] != "assistant" or chat["content"] != candidate["raw_reply"]:
            continue
        user = chats[index - 1]
        previous = chats[max(0, index - 1 - len(history)):index - 1]
        if (user["role"] == "user" and user["content"] == candidate["parsed_input"].get("message")
                and previous == history):
            matches.append(chat)
    return _unique(matches)


MATCHERS = {"lesson": _lesson_match, "assessment": _assessment_match,
            "question": _question_match, "chat": _chat_match}


def matched_object(candidate, course):
    if not candidate["contract_valid"] or candidate["course_ids"] != [course["id"]]:
        return None
    node = next((node for node in course["nodes"] if node["id"] == candidate["target"]), {})
    matcher = MATCHERS.get(candidate["kind"])
    return matcher(candidate, node) if matcher else None


def import_legacy_receipt(tasks, course_id, candidate):
    course = tasks.store.course(course_id)
    payload = matched_object(candidate, course)
    unique = candidate["course_ids"] == [course_id]
    complete = candidate["status"] == "completed" and candidate["contract_valid"]
    disposition = "already_applied" if payload is not None else "recovered" if unique and complete else "unmatched"
    key = "legacy-" + hashlib.sha256(json.dumps([candidate["thread_id"], candidate["turn_id"]]).encode()).hexdigest()
    body = _receipt_body(candidate, course, key, disposition, payload)
    with tasks.store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        original = tasks.find_original(course_id, candidate["thread_id"], candidate["turn_id"], connection)
        if original:
            return original
        connection.execute("INSERT OR IGNORE INTO ai_tasks VALUES(?,?,?,?,?,?,?,?)",
                           (identity(), course_id, key, "history", candidate["target"] or "course",
                            "archived", json.dumps(body, ensure_ascii=False), timestamp()))
    return tasks.find_request(course_id, key)


def _receipt_body(candidate, course, key, disposition, payload):
    reason = candidate["binding_reason"] or "请求归属尚未确认"
    if candidate["match_error"]:
        reason += "; " + candidate["match_error"]
    body = dict(created_at=timestamp(), request_id=key, thread_id=candidate["thread_id"],
                turn_id=candidate["turn_id"], inputs={}, request=dict(prompt=candidate["prompt"]),
                history_only=True, history_kind=candidate["kind"], history_status=candidate["status"],
                history_disposition=disposition, history_match_reason=reason,
                history_evidence=dict(course_ids=candidate["course_ids"], contract_valid=candidate["contract_valid"]),
                historical_raw=candidate["raw_reply"], result_object=payload or candidate["parsed_output"])
    if candidate["status"] == "completed" and candidate.get("raw_reply"):
        body["raw_reply"] = dict(text=candidate["raw_reply"], thread_id=candidate["thread_id"], turn_id=candidate["turn_id"])
    if payload is not None:
        body["result_ref"] = dict(kind=candidate["kind"], course_id=course["id"], node_id=candidate["target"],
                                  object_id=payload.get("id"), epoch=course.get("ai_epoch"),
                                  scope=payload.get("review_scope_key", "course"),
                                  available=True, checked_revision=course["revision"])
    return body


def _semantic_bridges(bridges, source, target):
    pieces = {piece["id"]: piece["title"].strip().casefold() for piece in source.get("pieces", [])}
    steps = {step["id"]: step["title"].strip().casefold() for step in target.get("steps", [])}
    fields = ("how", "if_missing", "strength", "check", "sources", "uncertain")
    return [dict(piece=pieces.get(bridge["from_piece"]), step=steps.get(bridge["to_step"]),
                 **{key: bridge.get(key) for key in fields}) for bridge in bridges]


def bridge_disposition(task, course):
    raw = task.get("raw_reply", {}).get("text") or task.get("historical_raw")
    if not raw or task.get("history_matched") is not True:
        return "unmatched"
    draft = json.loads(raw)
    edges = {edge["id"]: edge for edge in course["edges"]}
    nodes = {node["id"]: node for node in course["nodes"]}
    existing = []
    for relation in draft["relations"]:
        edge = edges.get(relation["id"])
        if not edge or not edge.get("bridges"):
            return "recovered"
        source, target = copy.deepcopy(nodes[edge["source"]]), copy.deepcopy(nodes[edge["target"]])
        expected = apply_draft_bridges(source, target, relation["bridges"])
        existing.append(_semantic_bridges(expected, source, target) == _semantic_bridges(edge["bridges"], source, target))
    return "already_applied" if existing and all(existing) else "conflict"
