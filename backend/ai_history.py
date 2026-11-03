"""Read bridge-backfill request and result evidence from local Codex rollouts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .bridge_backfill import BackfillDraft, backfill_sources
from .learning import LearningError, cited_material_context, course_material_context

_MAX_FILE_BYTES = 32 * 1024 * 1024
_MAX_LINE_BYTES = 4 * 1024 * 1024
_BRIDGE_MARKERS = ("下面每一项是课程中", "请为每项写 1–3 座知识桥")
_SAFE_ITEM_TYPES = {"AgentMessage", "Reasoning", "Plan", "UserMessage"}
_SAFE_RESPONSE_ITEM_TYPES = {"message", "reasoning", "additional_tools", "configuration_update"}
_SAFE_METADATA_EVENT_TYPES = {"thread_settings_applied", "token_count"}


def scan_bridge_history(root: str | Path, cwd: str | Path, course: dict[str, Any]) -> list[dict[str, Any]]:
    """Return exact-prompt rollout candidates, without changing course data."""
    return [
        _candidate(turn["thread_id"], turn["turn_id"], turn, course)
        for turn in scan_rollout_turns(root, cwd)
        if turn["prompts"]
    ]


def scan_rollout_turns(root: str | Path, cwd: str | Path) -> list[dict[str, Any]]:
    """Read complete and incomplete message-only turn evidence from matching rollouts."""
    expected_cwd = str(Path(cwd).resolve()).casefold()
    turns = []
    for path in Path(root).rglob("*.jsonl"):
        try:
            if path.is_file() and path.stat().st_size <= _MAX_FILE_BYTES:
                turns.extend(_read_rollout(path, expected_cwd))
        except OSError:
            continue
    return turns


def _read_rollout(path: Path, expected_cwd: str) -> list[dict[str, Any]]:
    turns: dict[str, dict[str, Any]] = {}
    metadata: dict[str, Any] = {}
    scan_error = None
    try:
        with path.open("rb") as stream:
            try:
                first = _read_record(stream)
            except (UnicodeError, json.JSONDecodeError, TypeError, ValueError):
                return []
            if first is None or first.get("type") != "session_meta":
                return []
            metadata = first.get("payload") or {}
            recorded_cwd = metadata.get("cwd") if isinstance(metadata, dict) else None
            if not isinstance(recorded_cwd, str) or str(Path(recorded_cwd).resolve()).casefold() != expected_cwd:
                return []
            active_turn_id: str | None = None
            while True:
                try:
                    line = _read_record(stream)
                    if stream.tell() > _MAX_FILE_BYTES:
                        raise ValueError("Codex rollout exceeded the size limit")
                except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
                    scan_error = "rollout contains a malformed or oversized record"
                    break
                if line is None:
                    break
                try:
                    _collect_record(line, turns, active_turn_id)
                except (AttributeError, TypeError, ValueError):
                    scan_error = "rollout contains an invalid record"
                    break
                if line.get("type") == "event_msg" and (line.get("payload") or {}).get("type") == "task_started":
                    active_turn_id = (line.get("payload") or {}).get("turn_id")
                elif line.get("type") == "event_msg" and (line.get("payload") or {}).get("type") == "task_complete":
                    active_turn_id = None
    except OSError:
        if not metadata:
            return []
        scan_error = "rollout could not be read completely"

    thread_id = metadata.get("session_id") or metadata.get("id")
    if not isinstance(thread_id, str):
        return []
    if scan_error:
        for turn in turns.values():
            turn["scan_error"] = scan_error
    results = []
    for turn_id, turn in turns.items():
        if not turn.get("user_messages"):
            continue
        status, raw_reply, _ = _terminal_evidence(turn, turn.get("scan_error"))
        results.append(dict(
            thread_id=thread_id, turn_id=turn_id, user_messages=turn["user_messages"],
            prompts=turn["prompts"], raw_reply=raw_reply, status=status,
            unsafe=turn["unsafe"], scan_error=turn.get("scan_error"),
            completion=turn["completion"], final_messages=turn["final_messages"],
            other_messages=turn["other_messages"], completion_mismatch=turn["completion_mismatch"],
        ))
    return results


def _read_record(stream) -> dict[str, Any] | None:
    raw = stream.readline(_MAX_LINE_BYTES + 1)
    if not raw:
        return None
    if len(raw) > _MAX_LINE_BYTES:
        raise ValueError("Codex rollout line exceeded the size limit")
    record = json.loads(raw)
    if not isinstance(record, dict):
        raise ValueError("Codex rollout record must be an object")
    return record


def _collect_record(record: dict[str, Any], turns: dict[str, dict[str, Any]], active_turn_id: str | None) -> None:
    kind = record.get("type")
    payload = record.get("payload") or {}
    if not isinstance(payload, dict):
        return
    if kind == "event_msg":
        event_type = payload.get("type")
        turn_id = payload.get("turn_id")
        if event_type == "task_started" and isinstance(turn_id, str):
            turns.setdefault(turn_id, _new_turn())
        elif isinstance(turn_id, str) and turn_id in turns:
            turn = turns[turn_id]
            if event_type in {"item_started", "item_completed"}:
                item = payload.get("item") or {}
                item_type = item.get("type") if isinstance(item, dict) else None
                if item_type not in _SAFE_ITEM_TYPES:
                    turn["unsafe"] = True
            elif event_type == "task_complete":
                root_turn_id = payload.get("root_turn_id")
                if root_turn_id is not None and root_turn_id != turn_id:
                    turn["completion_mismatch"] = True
                turn["completion"] = payload
            elif event_type not in _SAFE_METADATA_EVENT_TYPES:
                turn["unsafe"] = True
        elif active_turn_id in turns and event_type not in _SAFE_METADATA_EVENT_TYPES:
            turns[active_turn_id]["unsafe"] = True
    elif kind == "response_item" and active_turn_id in turns:
        response_type = payload.get("type")
        if response_type not in _SAFE_RESPONSE_ITEM_TYPES:
            turns[active_turn_id]["unsafe"] = True
        elif response_type == "message":
            _collect_message(payload, turns[active_turn_id])


def _new_turn() -> dict[str, Any]:
    return {
        "prompts": [], "user_messages": [], "final_messages": [], "other_messages": [],
        "completion": None, "completion_mismatch": False, "unsafe": False,
    }


def _collect_message(payload: dict[str, Any], turn: dict[str, Any]) -> None:
    if payload.get("type") != "message":
        return
    text = _message_text(payload.get("content"))
    if text is None:
        return
    if payload.get("role") == "user":
        turn["user_messages"].append(text)
        if any(marker in text for marker in _BRIDGE_MARKERS):
            turn["prompts"].append(text)
    elif payload.get("role") == "assistant":
        if payload.get("phase") == "final_answer":
            turn["final_messages"].append(text)
        elif payload.get("phase") is None:
            turn["other_messages"].append(text)


def _message_text(content: Any) -> str | None:
    if not isinstance(content, list):
        return None
    fragments = [part.get("text") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)]
    return "".join(fragments) if fragments else None


def _candidate(
    thread_id: str,
    turn_id: str,
    turn: dict[str, Any],
    course: dict[str, Any],
) -> dict[str, Any]:
    prompt = turn["prompts"][0] if len(set(turn["prompts"])) == 1 else None
    status, raw_reply, errors = _terminal_evidence(turn, turn.get("scan_error"))
    contract = _validate_prompt(prompt, course)
    errors.extend(contract["errors"])
    relation_ids = contract["relation_ids"]
    if len(turn["prompts"]) != 1:
        errors.append("turn must contain exactly one matching bridge prompt")
    if status == "completed":
        errors.extend(_validate_reply(raw_reply, relation_ids, contract["node_ids"]))
    return {
        "thread_id": thread_id,
        "turn_id": turn_id,
        "prompt": prompt,
        "raw_reply": raw_reply,
        "status": status,
        "relation_ids": relation_ids,
        "match_error": "; ".join(dict.fromkeys(errors)) or None,
        "matched": status == "completed" and not errors,
    }


def _terminal_evidence(turn: dict[str, Any], scan_error: str | None) -> tuple[str, str | None, list[str]]:
    completion = turn.get("completion")
    last_message = completion.get("last_agent_message") if isinstance(completion, dict) else None
    assistant_messages = turn["final_messages"] or turn["other_messages"]
    matching = [message for message in assistant_messages if isinstance(last_message, str) and message == last_message]
    raw_reply = matching[0] if len(matching) == 1 else None
    if completion is None and len(assistant_messages) == 1:
        raw_reply = assistant_messages[0]
    errors = [scan_error] if scan_error else []
    if turn.get("unsafe"):
        return "unsafe", raw_reply, [*errors, "turn contains tool or unrecognized activity"]
    if completion is None:
        return "incomplete", raw_reply, [*errors, "turn has no matching task_complete event"]
    if turn.get("completion_mismatch"):
        return "inconsistent", raw_reply, [*errors, "task_complete root_turn_id does not match turn_id"]
    if not isinstance(last_message, str) or len(matching) != 1:
        errors.append("final assistant message does not exactly match task_complete.last_agent_message")
        return "inconsistent", raw_reply, errors
    if scan_error:
        errors.append("rollout integrity is incomplete")
        return "inconsistent", raw_reply, errors
    return "completed", raw_reply, errors


def _validate_reply(raw_reply: str | None, relation_ids: list[str], node_ids: list[str]) -> list[str]:
    if not isinstance(raw_reply, str):
        return ["final assistant JSON is unavailable"]
    try:
        draft = BackfillDraft.model_validate_json(raw_reply)
    except (ValidationError, ValueError, TypeError):
        return ["final assistant message does not satisfy the BackfillDraft JSON contract"]
    output_ids = [relation.id for relation in draft.relations]
    errors = []
    if len(output_ids) != len(relation_ids) or set(output_ids) != set(relation_ids):
        errors.append("final JSON relation IDs do not exactly match the requested relation set")
    requested_nodes = set(node_ids)
    if len(draft.nodes) != len({node.id for node in draft.nodes}) or any(node.id not in requested_nodes for node in draft.nodes):
        errors.append("final JSON contains duplicate or unrequested node IDs")
    return errors


def _validate_prompt(prompt: str | None, course: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"errors": [], "relation_ids": [], "node_ids": []}
    if not isinstance(prompt, str):
        result["errors"].append("bridge prompt is ambiguous or missing")
        return result
    try:
        nodes, relations, materials = _prompt_sections(prompt)
    except (ValueError, json.JSONDecodeError):
        result["errors"].append("prompt sections are missing or invalid JSON")
        return result
    if not isinstance(nodes, list) or not isinstance(relations, list):
        result["errors"].append("knowledge-point and relation sections must be JSON arrays")
        return result
    node_map = {node["id"]: node for node in course.get("nodes", []) if isinstance(node, dict) and isinstance(node.get("id"), str)}
    edge_map = {edge["id"]: edge for edge in course.get("edges", []) if isinstance(edge, dict) and isinstance(edge.get("id"), str)}
    relation_ids, endpoints, relation_errors = _validate_relation_items(relations, edge_map)
    node_ids, node_errors = _validate_node_items(nodes, node_map, endpoints)
    result["relation_ids"], result["node_ids"] = relation_ids, node_ids
    result["errors"].extend(relation_errors + node_errors
                            + _validate_materials(materials, course, relation_ids, node_ids))
    return result


def _validate_relation_items(
    relations: list[Any], edge_map: dict[str, dict[str, Any]]
) -> tuple[list[str], set[str], list[str]]:
    errors: list[str] = []
    relation_ids = [item["id"] for item in relations if isinstance(item, dict) and isinstance(item.get("id"), str)]
    if len(relation_ids) != len(relations) or len(set(relation_ids)) != len(relation_ids):
        errors.append("relation entries contain missing or duplicate IDs")
    endpoints: set[str] = set()
    for relation in relations:
        if not isinstance(relation, dict):
            errors.append("relation entry is invalid")
            continue
        relation_id = relation.get("id")
        if not isinstance(relation_id, str):
            errors.append("relation entry has no valid ID")
            continue
        edge = edge_map.get(relation_id)
        if edge is None:
            errors.append(f"relation ID is absent from current course: {relation_id}")
            continue
        before, after = relation.get("before"), relation.get("after")
        if not isinstance(before, str) or not isinstance(after, str):
            errors.append(f"relation endpoints are invalid: {relation_id}")
            continue
        endpoints.update((before, after))
        if before != edge.get("source") or after != edge.get("target") or relation.get("relation") != edge.get("relation"):
            errors.append(f"relation endpoints or type changed: {relation_id}")
    return relation_ids, endpoints, errors


def _validate_node_items(
    nodes: list[Any], node_map: dict[str, dict[str, Any]], endpoints: set[str]
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    node_ids = [node.get("id") for node in nodes if isinstance(node, dict)]
    valid_ids = [node_id for node_id in node_ids if isinstance(node_id, str)]
    if len(node_ids) != len(valid_ids) or len(valid_ids) != len(set(valid_ids)) or set(valid_ids) != endpoints:
        errors.append("knowledge-point IDs do not exactly cover relation endpoints")
    for brief in nodes:
        node_id = brief.get("id") if isinstance(brief, dict) else None
        if not isinstance(node_id, str) or node_id not in node_map:
            errors.append("knowledge-point ID is absent from current course")
            continue
        current = node_map[node_id]
        if brief.get("title") != current.get("title"):
            errors.append(f"knowledge-point title changed: {node_id}")
    return valid_ids, errors


def _validate_materials(
    materials: str, course: dict[str, Any], relation_ids: list[str], node_ids: list[str]
) -> list[str]:
    try:
        # Earlier prompts carried the whole course; current ones carry only the cited pages.
        batch = [edge for edge in course.get("edges", []) if edge.get("id") in relation_ids]
        cited = cited_material_context(course, backfill_sources(course, batch, node_ids))
        if materials != cited and materials != course_material_context(course):
            return ["materials JSON differs from current course material context"]
    except (LearningError, KeyError, TypeError, ValueError):
        return ["current course material context could not be verified"]
    return []


def _prompt_sections(prompt: str) -> tuple[Any, Any, str]:
    node_marker, relation_marker, material_marker = "\n知识点：", "\n联系：", "\n材料："
    node_start = prompt.index(node_marker) + len(node_marker)
    relation_start = prompt.index(relation_marker, node_start)
    material_start = prompt.index(material_marker, relation_start)
    nodes = _decode_section(prompt[node_start:relation_start])
    relations = _decode_section(prompt[relation_start + len(relation_marker):material_start])
    materials = prompt[material_start + len(material_marker):]
    json.loads(materials)
    return nodes, relations, materials


def _decode_section(section: str) -> Any:
    value = section.strip()
    decoded, end = json.JSONDecoder().raw_decode(value)
    if value[end:].strip():
        raise ValueError("unexpected content after JSON section")
    return decoded
