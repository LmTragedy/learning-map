"""Read completed legacy AI requests from local Codex rollout files."""

from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError

from .ai_history import (
    _prompt_sections,
    scan_rollout_turns,
)
from .ai_history import (
    _validate_prompt as _validate_bridge_prompt,
)
from .ai_history import (
    _validate_reply as _validate_bridge_reply,
)
from .goals import GoalDraft
from .learning import LearningError, course_material_context, node_context
from .lessons import LessonDraft
from .lines_ai import LinesDraft, RetellReview
from .note_review import ReviewDraft
from .schemas import Judgment, MapDraft, Question, RecallSummary

_MODELS = {
    "note_review": ReviewDraft,
    "lesson": LessonDraft,
    "question": Question,
    "assessment": Judgment,
    "map": MapDraft,
    "goals": GoalDraft,
    "recall": RecallSummary,
    "lines": LinesDraft,
    "retell": RetellReview,
}


def scan_legacy_history(root: str, cwd: str, courses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return read-only legacy output candidates; never creates or applies task receipts."""
    candidates = []
    for turn in scan_rollout_turns(root, cwd):
        prompt = "\n".join(turn["user_messages"])
        request = _parse_request(prompt)
        if request is None:
            continue
        candidate = _candidate(turn, prompt, request, courses)
        candidates.append(candidate)
    return candidates


def _candidate(turn, prompt, request, courses):
    raw_reply = turn["raw_reply"]
    kind = request["kind"]
    parsed_input = request["input"]
    course_matches, binding_reason = _bind_courses(kind, parsed_input, courses)
    course_ids = sorted({course_id for course_id, _, _ in course_matches})
    targets = {target for _, target, _ in course_matches if target is not None}
    target = next(iter(targets)) if len(targets) == 1 else ("course" if kind in {"map", "goals", "lines"} else None)
    parsed_output, contract_valid = _parse_output(kind, raw_reply, request, turn["status"])
    match_error = _match_error(turn, request, course_matches, contract_valid)
    details = dict(raw_reply=raw_reply, parsed_input=parsed_input, parsed_output=parsed_output,
                   contract_valid=contract_valid, course_ids=course_ids, binding_reason=binding_reason,
                   match_error=match_error, target=target)
    return _candidate_record(turn, prompt, request, details)


def _candidate_record(turn, prompt, request, details):
    return {
        "thread_id": turn["thread_id"],
        "turn_id": turn["turn_id"],
        "prompt": prompt,
        "raw_reply": details["raw_reply"],
        "status": turn["status"],
        "kind": request["kind"],
        "target": details["target"],
        "course_ids": details["course_ids"],
        "binding_reason": details["binding_reason"],
        "match_error": details["match_error"],
        "parsed_input": details["parsed_input"],
        "parsed_output": details["parsed_output"],
        "contract_valid": details["contract_valid"],
    }


def _parse_request(prompt):
    for marker, parser, extra_marker in _request_parsers():
        if marker in prompt and (extra_marker is None or extra_marker in prompt):
            return parser(prompt)
    return None


def _request_parsers():
    return (
        ("请为每项写 1–3 座知识桥", _parse_bridge, None),
        ("检查用户的整篇节点笔记", _parse_note_review, None),
        ("学习上下文：\n", _parse_lesson, None),
        ("先独立分析题目与所需知识/解法", _parse_assessment, None),
        ("按该节点内容设计一个合适的解释", _parse_question, None),
        ("已有标题：", _parse_map, "\n材料："),
        ("已有知识点：", _parse_goals, "\n材料："),
        ("当前节点/来源：", _parse_chat, "\n用户："),
        ("实际历史：", _parse_recall, "整理节点「"),
        ("把下面的知识点按知识桥分成", _parse_lines, None),
        ("学习者不看提示，用自己的话把一条主线串起来讲了一遍", _parse_retell, None),
    )


def _parse_bridge(prompt):
    try:
        nodes, relations, materials = _prompt_sections(prompt)
    except (ValueError, json.JSONDecodeError):
        return _request("bridge_backfill", {"prompt_parse_error": True})
    return _request("bridge_backfill", {"nodes": nodes, "relations": relations, "materials": materials})


def _parse_note_review(prompt):
    parsed = _decode_last_object(prompt)
    if not isinstance(parsed, dict) or not isinstance(parsed.get("context"), dict):
        return _request("note_review", {"prompt_parse_error": True})
    return _request("note_review", {"context": parsed["context"], "note": parsed.get("note")})


def _parse_lesson(prompt):
    parsed = _decode_after(prompt, "学习上下文：\n")
    if not isinstance(parsed, dict) or not isinstance(parsed.get("node"), dict):
        return _request("lesson", {"prompt_parse_error": True})
    return _request("lesson", parsed)


def _parse_question(prompt):
    return _request("question", {"context": _decode_last_object(prompt)})


def _parse_assessment(prompt):
    context = _decode_after(prompt, "\n节点：")
    bridges = _decode_after(prompt, "\n进站知识桥：")
    question = _decode_after(prompt, "\n题目：")
    evidence = _decode_after(prompt, "\n作答/参考答案/附件提取：")
    return _request("assessment", {
        "context": context, "incoming_bridges": bridges, "question": question, "evidence": evidence,
    })


def _parse_map(prompt):
    titles = _decode_after(prompt, "已有标题：")
    materials = _decode_after(prompt, "\n材料：")
    return _request("map", {"existing_titles": titles, "materials": materials})


def _parse_goals(prompt):
    nodes = _decode_after(prompt, "已有知识点：")
    materials = _decode_after(prompt, "\n材料：")
    return _request("goals", {"nodes": nodes, "materials": materials})


def _parse_chat(prompt):
    context = _decode_between(prompt, "当前节点/来源：", "\n用户：")
    message = prompt.rsplit("\n用户：", 1)[-1]
    return _request("chat", {"context": _decode_text(context), "message": message})


def _parse_recall(prompt):
    history = _decode_after(prompt, "实际历史：")
    return _request("recall", {"node_title": _between(prompt, "整理节点「", "」"), "history": history}, excluded=True)


def _parse_lines(prompt):
    return _request("lines", {
        "nodes": _decode_after(prompt, "\n知识点："),
        "bridges": _decode_after(prompt, "\n知识桥："),
        "kept_lines": _decode_after(prompt, "\n需要保留的主线："),
    }, excluded=True)


def _parse_retell(prompt):
    return _request("retell", {
        "line": _decode_after(prompt, "\n主线："),
        "bridges": _decode_after(prompt, "\n知识桥："),
        "text": _after(prompt, "\n学习者的讲述："),
    }, excluded=True)


def _request(kind, parsed_input, excluded=False):
    return {"kind": kind, "input": parsed_input, "excluded": excluded}


def _decode_after(prompt, marker):
    try:
        value = prompt[prompt.index(marker) + len(marker):].lstrip()
        return json.JSONDecoder().raw_decode(value)[0]
    except (ValueError, json.JSONDecodeError):
        return None


def _decode_last_object(prompt):
    start = prompt.rfind("\n{")
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(prompt[start + 1:])[0]
    except json.JSONDecodeError:
        return None


def _decode_between(prompt, start_marker, end_marker):
    try:
        start = prompt.index(start_marker) + len(start_marker)
        end = prompt.index(end_marker, start)
        return prompt[start:end].strip()
    except ValueError:
        return ""


def _decode_text(raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _between(prompt, start_marker, end_marker):
    try:
        start = prompt.index(start_marker) + len(start_marker)
        return prompt[start:prompt.index(end_marker, start)]
    except ValueError:
        return ""


def _after(prompt, marker):
    try:
        return prompt[prompt.index(marker) + len(marker):]
    except ValueError:
        return ""


def _bind_courses(kind, parsed_input, courses):
    if kind in {"note_review", "lesson", "question", "assessment", "chat"}:
        context = parsed_input.get("node") if kind == "lesson" else parsed_input.get("context")
        return _bind_node_context(context, courses)
    if kind == "bridge_backfill":
        return _bind_bridge(parsed_input, courses)
    if kind == "map":
        return _bind_materials(parsed_input.get("materials"), courses, "exact full course material context")
    if kind == "goals":
        node_records = parsed_input.get("nodes")
        matches = []
        for course in courses:
            material_match = _materials_match(parsed_input.get("materials"), course)
            current_nodes = [{"id": n["id"], "title": n["title"]} for n in course.get("nodes", [])]
            if material_match and node_records == current_nodes:
                matches.append((course["id"], "course", "exact material context and current node IDs/titles"))
        return matches, "exact material context and current node IDs/titles"
    return [], None


def _bind_node_context(context, courses):
    if not isinstance(context, dict):
        return [], None
    matches = []
    reasons = []
    for course in courses:
        course_matches = _bind_one_course_context(context, course)
        if course_matches:
            matches.extend(course_matches)
            reasons.extend(reason for _, _, reason in course_matches)
    return matches, "; ".join(dict.fromkeys(reasons)) or None


def _bind_one_course_context(context, course):
    try:
        current_contexts = [(node, json.loads(node_context(course, node))) for node in course.get("nodes", [])]
    except (LearningError, KeyError, TypeError, ValueError):
        return []
    exact = [(node, current) for node, current in current_contexts if current == context]
    if len(exact) == 1 and _source_fingerprints(context):
        node, _ = exact[0]
        return [(course["id"], node["id"], "unique exact node_context and source pages")]
    if not exact:
        return _bind_node_by_sources(context, course, current_contexts)
    return []


def _bind_node_by_sources(context, course, current_contexts):
    sources = _source_fingerprints(context)
    if not sources:
        return []
    title = context.get("node")
    title_nodes = [(node, current) for node, current in current_contexts if node.get("title") == title]
    if len(title_nodes) != 1:
        return []
    node, current = title_nodes[0]
    current_sources = _source_fingerprints(current)
    if sources.issubset(current_sources):
        return [(course["id"], node["id"], "unique node title plus exact material_id/page/extracted_text pages")]
    return []


def _source_fingerprints(context):
    sources = context.get("sources") if isinstance(context, dict) else None
    if not isinstance(sources, list) or not sources:
        return set()
    fingerprints = set()
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("material_id"), str):
            return set()
        if not isinstance(source.get("page"), int) or not isinstance(source.get("extracted_text"), str):
            return set()
        fingerprints.add((source["material_id"], source["page"], source["extracted_text"]))
    return fingerprints


def _bind_materials(materials, courses, reason):
    return [
        (course["id"], "course", reason)
        for course in courses
        if _materials_match(materials, course)
    ], reason


def _materials_match(materials, course):
    if not isinstance(materials, list) or not materials:
        return False
    if any(
        not isinstance(page, dict) or not page.get("material_id") or not isinstance(page.get("text"), str)
        for page in materials
    ):
        return False
    try:
        return materials == json.loads(course_material_context(course))
    except (LearningError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False


def _bind_bridge(parsed_input, courses):
    if "prompt_parse_error" in parsed_input:
        return [], None
    matches = []
    for course in courses:
        contract = _validate_bridge_prompt(_bridge_prompt(parsed_input), course)
        if not contract["errors"]:
            matches.append((course["id"], "course", "exact bridge relation and material contract"))
    return matches, "exact bridge relation and material contract" if matches else None


def _bridge_prompt(parsed_input):
    return "\n知识点：" + json.dumps(parsed_input["nodes"], ensure_ascii=False) + "\n联系：" + json.dumps(
        parsed_input["relations"], ensure_ascii=False
    ) + "\n材料：" + parsed_input["materials"]


def _parse_output(kind, raw_reply, request, status):
    if status != "completed" or not isinstance(raw_reply, str):
        return {}, False
    if kind == "bridge_backfill":
        parsed = _parse_json(raw_reply)
        if parsed is None:
            return {}, False
        valid = not _validate_bridge_reply(raw_reply, _relation_ids(request["input"]), _node_ids(request["input"]))
        return parsed, valid
    if kind == "chat":
        return {"text": raw_reply}, bool(request["input"].get("message"))
    model = _MODELS.get(kind)
    if model is None:
        return {}, False
    try:
        parsed = model.model_validate_json(raw_reply)
        return parsed.model_dump(), True
    except (ValidationError, ValueError, TypeError):
        return {}, False


def _parse_json(raw_reply):
    try:
        value = json.loads(raw_reply)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        return None


def _relation_ids(parsed_input):
    return [item["id"] for item in parsed_input.get("relations", []) if isinstance(item, dict) and "id" in item]


def _node_ids(parsed_input):
    return [item["id"] for item in parsed_input.get("nodes", []) if isinstance(item, dict) and "id" in item]


def _match_error(turn, request, course_matches, contract_valid):
    errors = []
    if turn["status"] != "completed":
        errors.append(f"rollout status: {turn['status']}")
    if turn.get("scan_error"):
        errors.append(turn["scan_error"])
    if request["excluded"]:
        errors.append(f"{request['kind']} is indexed as unsupported legacy evidence")
    if not course_matches:
        errors.append("request cannot be bound to a current course")
    elif len({course_id for course_id, _, _ in course_matches}) > 1:
        errors.append("request matches multiple courses; course identity is ambiguous")
    if turn["status"] == "completed" and not contract_valid:
        errors.append("terminal reply does not satisfy the task output contract")
    return "; ".join(errors) or None
