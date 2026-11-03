import copy
import json
from pathlib import Path

import pytest

from backend.ai_legacy_history import scan_legacy_history
from backend.domain import make_node
from backend.learning import course_material_context, node_context
from backend.note_review import _review_prompt

COURSE_ID = "course-1"
NODE_ID = "node-1"
MATERIAL_ID = "material-1"


def course_fixture(course_id=COURSE_ID):
    course = {
        "id": course_id,
        "title": "Course",
        "revision": 1,
        "materials": [{
            "id": MATERIAL_ID,
            "name": "Notes",
            "week": "1",
            "pages": [{
                "number": 1, "text": "Evidence text", "method": "manual",
                "uncertain": False, "warnings": [],
            }],
        }],
        "nodes": [],
        "edges": [],
        "preferences": {"pace": "steady", "difficulty": "medium"},
        "review_scope": {"enabled": False, "material_ids": [], "ai_scope": "selected"},
    }
    course["nodes"].append(make_node({
        "title": "Before", "summary": "Source topic", "week": "1",
        "sources": [{"material_id": MATERIAL_ID, "page": 1, "quote": "Evidence text"}],
        "uncertain": False,
    }))
    course["nodes"][0]["id"] = NODE_ID
    return course


def write_rollout(root: Path, cwd: Path, turns, *, session_id="thread-1"):
    path = root / "2026" / "11" / "03" / "rollout.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [{"type": "session_meta", "payload": {"session_id": session_id, "cwd": str(cwd)}}]
    for turn in turns:
        rows.append({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn["id"]}})
        for prompt in turn["prompts"]:
            rows.append({"type": "response_item", "payload": {
                "type": "message", "role": "user", "content": [{"type": "text", "text": prompt}],
            }})
        if turn.get("tool"):
            rows.append({"type": "response_item", "payload": {"type": "function_call"}})
        reply = turn.get("reply")
        if reply is not None:
            rows.append({"type": "response_item", "payload": {
                "type": "message", "role": "assistant", "phase": "final_answer",
                "content": [{"type": "text", "text": reply}],
            }})
        if turn.get("complete"):
            rows.append({"type": "event_msg", "payload": {
                "type": "task_complete", "turn_id": turn["id"],
                "last_agent_message": turn.get("last_message", reply),
            }})
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows), encoding="utf-8")
    return path


def request_cases(course):
    node = course["nodes"][0]
    context = node_context(course, node)
    materials = course_material_context(course)
    question = {"prompt": "Explain the concept.", "kind": "解释", "rubric": "Correct reasoning."}
    lesson_context = {
        "mission": {"course": course["title"], "node_goal": node["summary"]},
        "node": json.loads(context),
        "request": {"kind": "initial", "focus": ""},
    }
    assessment = (
        "先独立分析题目与所需知识/解法。\n节点：" + context
        + "\n进站知识桥：[]\n题目：" + json.dumps(question, ensure_ascii=False)
        + "\n作答/参考答案/附件提取："
        + json.dumps({"answer": "My answer", "reference": "", "attachments": []}, ensure_ascii=False)
    )
    return [
        ("note_review", _review_prompt(json.loads(context), "A learner note."), {"suggestions": []}),
        ("lesson", "Teach integration.\n学习上下文：\n" + json.dumps(lesson_context, ensure_ascii=False), {
            "title": "A short lesson", "goal": "Explain the idea.", "html": "<p>Example and explanation.</p>",
            "check_question": "What changes?", "check_answer": "The value changes.", "recap": "Review the example.",
        }),
        ("question", "按该节点内容设计一个合适的解释/案例。\n" + context, question),
        ("assessment", assessment, {
            "outcome": "uncertain", "reasoning": "Needs another example.", "blockers": [],
            "next_step": "Try one more example.", "missing_bridges": [],
        }),
        ("map", "合并分析这门学科。已有标题：[]\n材料：" + materials, {"nodes": [{
            "key": "before", "title": "Before", "summary": "Source topic", "week": "1",
            "sources": [{"material_id": MATERIAL_ID, "page": 1, "quote": "Evidence text"}],
            "prerequisites": [], "uncertain": False,
        }], "relations": []}),
        ("goals", "从课程材料提取可实现、可检查的学习目标。已有知识点："
         + json.dumps([{"id": NODE_ID, "title": "Before"}], ensure_ascii=False)
         + "\n材料：" + materials, {"goals": []}),
        ("chat", "System\n当前节点/来源：" + context + "\n用户：Explain with an example.",
         "Here is a simple example."),
    ]


def test_each_supported_contract_binds_to_its_unique_current_context(tmp_path):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    turns = [
        {
            "id": f"turn-{kind}", "prompts": [prompt],
            "reply": output if kind == "chat" else json.dumps(output, ensure_ascii=False),
            "complete": True,
        }
        for kind, prompt, output in request_cases(course)
    ]
    write_rollout(tmp_path / "sessions", cwd, turns)

    candidates = scan_legacy_history(tmp_path / "sessions", cwd, [course])

    by_kind = {candidate["kind"]: candidate for candidate in candidates}
    assert set(by_kind) == {case[0] for case in request_cases(course)}
    assert all(candidate["status"] == "completed" for candidate in candidates)
    assert all(candidate["contract_valid"] for candidate in candidates)
    assert {kind: candidate["course_ids"] for kind, candidate in by_kind.items()} == {
        kind: [COURSE_ID] for kind, _, _ in request_cases(course)
    }
    assert by_kind["question"]["target"] == NODE_ID
    assert by_kind["map"]["target"] == "course"
    assert by_kind["chat"]["parsed_output"]["text"] == "Here is a simple example."


def test_same_prompt_turns_are_kept_separate_and_ambiguous_course_identity_is_reported(tmp_path):
    course = course_fixture()
    duplicate = copy.deepcopy(course)
    duplicate["id"] = "course-2"
    prompt, reply = request_cases(course)[-2][1:]
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [
        {"id": "turn-one", "prompts": [prompt], "reply": json.dumps(reply), "complete": True},
        {"id": "turn-two", "prompts": [prompt], "reply": json.dumps(reply), "complete": True},
    ])

    candidates = scan_legacy_history(tmp_path / "sessions", cwd, [course, duplicate])

    assert [candidate["turn_id"] for candidate in candidates] == ["turn-one", "turn-two"]
    assert all(candidate["course_ids"] == ["course-1", "course-2"] for candidate in candidates)
    assert all("ambiguous" in candidate["match_error"] for candidate in candidates)


@pytest.mark.parametrize("turn", [
    pytest.param({"id": "incomplete", "prompts": [], "reply": "{}", "complete": False}, id="incomplete"),
    pytest.param({"id": "unsafe", "prompts": [], "reply": "{}", "complete": True, "tool": True}, id="tool"),
])
def test_nonterminal_or_tool_turns_never_validate(tmp_path, turn):
    course = course_fixture()
    prompt = request_cases(course)[-1][1]
    turn["prompts"] = [prompt]
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [turn])

    candidate = scan_legacy_history(tmp_path / "sessions", cwd, [course])[0]

    assert candidate["status"] in {"incomplete", "unsafe"}
    assert not candidate["contract_valid"]
    assert "status" in candidate["match_error"]


def test_material_identity_mismatch_does_not_bind_course(tmp_path):
    course = course_fixture()
    prompt = request_cases(course)[-2][1].replace("Evidence text", "Different page text")
    reply = json.dumps(request_cases(course)[-2][2])
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [{
        "id": "stale-material", "prompts": [prompt], "reply": reply, "complete": True,
    }])

    candidate = scan_legacy_history(tmp_path / "sessions", cwd, [course])[0]

    assert candidate["course_ids"] == []
    assert "cannot be bound" in candidate["match_error"]


@pytest.mark.parametrize(("kind", "prompt"), [
    ("recall", "实际历史：[]\n整理节点「Before」"),
    ("lines", "把下面的知识点按知识桥分成主线\n知识点：[]\n知识桥：[]\n需要保留的主线：[]"),
    ("retell", "学习者不看提示，用自己的话把一条主线串起来讲了一遍\n主线：{}\n知识桥：[]\n学习者的讲述：Example"),
])
def test_unreliable_legacy_contexts_stay_unbound_and_explicitly_excluded(tmp_path, kind, prompt):
    course = course_fixture()
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [{
        "id": f"excluded-{kind}", "prompts": [prompt], "reply": "{}", "complete": True,
    }])

    candidate = scan_legacy_history(tmp_path / "sessions", cwd, [course])[0]

    assert candidate["kind"] == kind
    assert candidate["course_ids"] == []
    assert "unsupported legacy evidence" in candidate["match_error"]


def test_generic_scanner_keeps_the_existing_bridge_contract(tmp_path):
    course = course_fixture()
    second = make_node({
        "title": "After", "summary": "Next topic", "week": "1",
        "sources": [{"material_id": MATERIAL_ID, "page": 1, "quote": "Evidence text"}],
        "uncertain": False,
    })
    second["id"] = "node-2"
    course["nodes"].append(second)
    course["edges"] = [{"id": "edge-1", "source": NODE_ID, "target": "node-2", "relation": "前置"}]
    prompt = (
        "补充关系。下面每一项是课程中的联系。请为每项写 1–3 座知识桥。\n知识点："
        + json.dumps([{"id": NODE_ID, "title": "Before"}, {"id": "node-2", "title": "After"}], ensure_ascii=False)
        + "\n联系："
        + json.dumps([{"id": "edge-1", "before": NODE_ID, "after": "node-2", "relation": "前置"}], ensure_ascii=False)
        + "\n材料：" + course_material_context(course)
    )
    reply = json.dumps({"nodes": [], "relations": [{"id": "edge-1", "bridges": [{
        "piece": {"kind": "定义", "title": "Key", "detail": "Meaning", "sources": []},
        "step": "Use the idea", "how": "Connect it to the next topic.",
        "if_missing": "The connection may be unclear.", "strength": "required",
        "check_question": "What connects them?", "check_answer": "The shared idea.",
        "sources": [], "uncertain": True,
    }]}]}, ensure_ascii=False)
    cwd = tmp_path / "ai-workspace"
    cwd.mkdir()
    write_rollout(tmp_path / "sessions", cwd, [{
        "id": "bridge-turn", "prompts": [prompt], "reply": reply, "complete": True,
    }])

    candidate = scan_legacy_history(tmp_path / "sessions", cwd, [course])[0]

    assert candidate["kind"] == "bridge_backfill"
    assert candidate["course_ids"] == [COURSE_ID]
    assert candidate["contract_valid"]
