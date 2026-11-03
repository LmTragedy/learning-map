import json
from pathlib import Path

import pytest

from backend.ai_history import scan_bridge_history
from backend.learning import course_material_context

COURSE_ID = "course-1"
SOURCE_ID = "node-before"
TARGET_ID = "node-after"
RELATION_ID = "relation-1"


def course_fixture():
    return {
        "id": COURSE_ID,
        "nodes": [
            {"id": SOURCE_ID, "title": "Before", "summary": "Source topic", "pieces": [], "steps": []},
            {"id": TARGET_ID, "title": "After", "summary": "Target topic", "pieces": [], "steps": []},
        ],
        "edges": [{
            "id": RELATION_ID, "source": SOURCE_ID, "target": TARGET_ID,
            "relation": "前置（AI 推断）", "explanation": "reason",
        }],
        "materials": [{
            "id": "material-1", "name": "Notes", "week": "1",
            "pages": [{"page": 1, "text": "Evidence text"}],
        }],
    }


def prompt_fixture(course, *, relation_id=RELATION_ID, before=SOURCE_ID, material_text=None):
    nodes = [
        {"id": SOURCE_ID, "title": "Before", "summary": "Source topic", "pieces": [], "steps": []},
        {"id": TARGET_ID, "title": "After", "summary": "Target topic", "pieces": [], "steps": []},
    ]
    relations = [{
        "id": relation_id, "before": before, "after": TARGET_ID,
        "relation": "前置（AI 推断）", "note": "reason",
    }]
    materials = material_text if material_text is not None else course_material_context(course)
    return (
        "请处理知识联系。下面每一项是课程中的待补内容。请为每项写 1–3 座知识桥。"
        "\n知识点：" + json.dumps(nodes, ensure_ascii=False)
        + "\n联系：" + json.dumps(relations, ensure_ascii=False)
        + "\n材料：" + materials
    )


def reply_fixture():
    return json.dumps({
        "nodes": [],
        "relations": [{
            "id": RELATION_ID,
            "bridges": [{
                "piece": {"kind": "定义", "title": "Key", "detail": "Meaning", "sources": []},
                "step": "Apply the key", "how": "Use it to explain the next topic.",
                "if_missing": "The learner may not know the prerequisite.",
                "strength": "required", "check_question": "What is the key?",
                "check_answer": "A definition.", "sources": [], "uncertain": True,
            }],
        }],
    }, ensure_ascii=False)


def write_rollout(root: Path, *, cwd: Path, turns):
    path = root / "2026" / "11" / "03" / "rollout-example.jsonl"
    path.parent.mkdir(parents=True)
    rows = [{"type": "session_meta", "payload": {"session_id": "thread-1", "cwd": str(cwd)}}]
    for turn in turns:
        rows.append({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn["id"]}})
        rows.extend({"type": "response_item", "payload": {"type": response_type}}
                    for response_type in ("additional_tools", "configuration_update"))
        if turn.get("event_activity"):
            rows.append({"type": "event_msg", "payload": {
                "type": turn["event_activity"], "turn_id": turn["id"],
            }})
        rows.append({"type": "response_item", "payload": {
            "type": "message", "role": "user", "id": "user-message",
            "content": [{"type": "text", "text": turn["prompt"]}],
        }})
        if turn.get("tool"):
            rows.append({"type": "event_msg", "payload": {
                "type": "item_completed", "turn_id": turn["id"],
                "item": {"type": "CommandExecution"},
            }})
        if turn.get("response_tool"):
            rows.append({"type": "response_item", "payload": {"type": turn["response_tool"]}})
        for reply in turn.get("replies", [turn.get("reply")]):
            if reply is None:
                continue
            rows.append({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "final_answer",
                "id": "assistant-message", "content": [{"type": "text", "text": reply}],
            }})
        if turn.get("complete"):
            completion = {
                "type": "task_complete", "turn_id": turn["id"],
                "last_agent_message": turn.get("last_message", turn.get("reply")),
            }
            if "root_turn_id" in turn:
                completion["root_turn_id"] = turn["root_turn_id"]
            rows.append({"type": "event_msg", "payload": completion})
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")
    return path


def test_scanner_keeps_each_completed_turn_and_matches_exact_contract(tmp_path: Path):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    prompt = prompt_fixture(course)
    reply = reply_fixture()
    write_rollout(tmp_path / "sessions", cwd=cwd, turns=[
        {"id": "turn-one", "prompt": prompt, "reply": reply, "complete": True},
        {"id": "turn-two", "prompt": prompt, "reply": reply, "complete": True},
    ])

    candidates = scan_bridge_history(tmp_path / "sessions", cwd, course)

    assert [candidate["turn_id"] for candidate in candidates] == ["turn-one", "turn-two"]
    assert all(candidate["thread_id"] == "thread-1" for candidate in candidates)
    assert all(candidate["status"] == "completed" for candidate in candidates)
    assert all(candidate["relation_ids"] == [RELATION_ID] for candidate in candidates)
    assert all(candidate["raw_reply"] == reply for candidate in candidates)
    assert all(candidate["matched"] and candidate["match_error"] is None for candidate in candidates)


def test_scanner_requires_exact_cwd_and_material_context(tmp_path: Path):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    stale_materials = course_material_context(course).replace("Evidence text", "Changed evidence")
    write_rollout(tmp_path / "sessions", cwd=cwd / "other", turns=[
        {"id": "wrong-cwd", "prompt": prompt_fixture(course), "reply": reply_fixture(), "complete": True},
    ])
    write_rollout(tmp_path / "another", cwd=cwd, turns=[
        {"id": "stale-material", "prompt": prompt_fixture(course, material_text=stale_materials),
         "reply": reply_fixture(), "complete": True},
    ])

    candidates = scan_bridge_history(tmp_path, cwd, course)

    assert len(candidates) == 1
    assert candidates[0]["turn_id"] == "stale-material"
    assert not candidates[0]["matched"]
    assert "materials JSON differs" in candidates[0]["match_error"]


def test_scanner_checks_current_relation_and_node_ids(tmp_path: Path):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd=cwd, turns=[
        {"id": "stale-edge", "prompt": prompt_fixture(course, before="other-node"),
         "reply": reply_fixture(), "complete": True},
    ])

    candidate = scan_bridge_history(tmp_path / "sessions", cwd, course)[0]

    assert candidate["relation_ids"] == [RELATION_ID]
    assert not candidate["matched"]
    assert "relation endpoints or type changed" in candidate["match_error"]
    assert "knowledge-point IDs" in candidate["match_error"]


def test_scanner_rejects_completion_for_a_different_root_turn(tmp_path: Path):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd=cwd, turns=[
        {"id": "child-turn", "root_turn_id": "different-root", "prompt": prompt_fixture(course),
         "reply": reply_fixture(), "complete": True},
    ])

    candidate = scan_bridge_history(tmp_path / "sessions", cwd, course)[0]

    assert candidate["status"] == "inconsistent"
    assert not candidate["matched"]
    assert "root_turn_id" in candidate["match_error"]


@pytest.mark.parametrize("response_type", ["function_call", "unknown_future_activity"])
def test_scanner_rejects_incomplete_tool_and_mismatched_terminal_evidence(
    tmp_path: Path, response_type: str
):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    prompt = prompt_fixture(course)
    reply = reply_fixture()
    write_rollout(tmp_path / "sessions", cwd=cwd, turns=[
        {"id": "unfinished", "prompt": prompt, "reply": reply},
        {"id": "with-tool", "prompt": prompt, "reply": reply, "complete": True, "tool": True},
        {"id": "response-tool", "prompt": prompt, "reply": reply, "complete": True,
         "response_tool": response_type},
        {"id": "unknown-event", "prompt": prompt, "reply": reply, "complete": True,
         "event_activity": "unknown_future_activity"},
        {"id": "mismatch", "prompt": prompt, "replies": [reply, reply + " "],
         "complete": True, "last_message": "different"},
    ])

    candidates = scan_bridge_history(tmp_path / "sessions", cwd, course)
    by_turn = {candidate["turn_id"]: candidate for candidate in candidates}

    assert by_turn["unfinished"]["status"] == "incomplete"
    assert not by_turn["unfinished"]["matched"]
    assert by_turn["with-tool"]["status"] == "unsafe"
    assert not by_turn["with-tool"]["matched"]
    assert by_turn["response-tool"]["status"] == "unsafe"
    assert not by_turn["response-tool"]["matched"]
    assert by_turn["unknown-event"]["status"] == "unsafe"
    assert not by_turn["unknown-event"]["matched"]
    assert by_turn["mismatch"]["status"] == "inconsistent"
    assert by_turn["mismatch"]["raw_reply"] is None
    assert "last_agent_message" in by_turn["mismatch"]["match_error"]


def test_scanner_discards_rollout_with_an_oversized_record(tmp_path: Path):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    path = tmp_path / "sessions" / "oversized.jsonl"
    path.parent.mkdir()
    rows = [
        {"type": "session_meta", "payload": {"session_id": "thread-1", "cwd": str(cwd)}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn-1"}},
        {"type": "response_item", "payload": {
            "type": "message", "role": "user", "content": [{"type": "text", "text": prompt_fixture(course)}],
        }},
    ]
    with path.open("wb") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
        stream.write(b"x" * (5 * 1024 * 1024) + b"\n")

    candidates = scan_bridge_history(tmp_path / "sessions", cwd, course)

    assert len(candidates) == 1
    assert candidates[0]["turn_id"] == "turn-1"
    assert candidates[0]["status"] == "incomplete"
    assert not candidates[0]["matched"]
    assert "oversized record" in candidates[0]["match_error"]
