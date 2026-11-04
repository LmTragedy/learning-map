"""Node-scoped AI task context validation and merged writes."""

import copy
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.node_task_context import validate_node_task
from backend.store import Conflict


class Model:
    def __init__(self):
        self.reply = {"text": "AI 回复", "thread_id": "node-task-thread"}
        self.before_reply = None

    def ask(self, _prompt, **_options):
        if self.before_reply:
            callback, self.before_reply = self.before_reply, None
            callback()
        return self.reply


@pytest.fixture
def session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def test_chat_write_preserves_concurrent_progress_and_unrelated_node_changes(session):
    client, store, model, course = session
    course_id = course["id"]
    node_id = course["nodes"][0]["id"]
    unrelated_id = course["nodes"][-1]["id"]

    def save_progress():
        with store.edit(course_id) as (current, _):
            current["nodes"][0]["status"] = "mastered"
            current["nodes"][0]["personal_note"] = "并行写入的个人笔记"
            unrelated = next(node for node in current["nodes"] if node["id"] == unrelated_id)
            unrelated["status"] = "studied"
            unrelated["personal_note"] = "其他知识点的笔记"

    model.before_reply = save_progress
    response = client.post(
        f"/api/courses/{course_id}/nodes/{node_id}/chat",
        json={"message": "解释当前知识点", "request_id": "node-chat-merge-0001"},
    )

    assert response.status_code == 200, response.text
    saved_node = response.json()["nodes"][0]
    assert saved_node["status"] == "mastered"
    assert saved_node["personal_note"] == "并行写入的个人笔记"
    assert saved_node["chats"][-2]["content"] == "解释当前知识点"
    assert saved_node["chats"][-1]["content"] == "AI 回复"
    saved_unrelated = next(node for node in response.json()["nodes"] if node["id"] == unrelated_id)
    assert saved_unrelated["status"] == "studied"
    assert saved_unrelated["personal_note"] == "其他知识点的笔记"


def test_chat_write_rejects_a_concurrent_change_to_prompt_conversations(session):
    client, store, model, course = session
    course_id = course["id"]
    node_id = course["nodes"][0]["id"]

    def add_relevant_chat():
        with store.edit(course_id) as (current, _):
            current["nodes"][0]["chats"].append({
                "id": "concurrent-chat", "role": "user", "content": "新增的相关对话",
                "created_at": "2026-11-04T00:00:00+00:00",
            })

    model.before_reply = add_relevant_chat
    response = client.post(
        f"/api/courses/{course_id}/nodes/{node_id}/chat",
        json={"message": "解释当前知识点", "request_id": "node-chat-conflict-0001"},
    )

    assert response.status_code == 409
    saved = store.course(course_id)["nodes"][0]
    assert [chat["content"] for chat in saved["chats"]] == ["新增的相关对话"]


def test_chat_allows_related_node_progress_but_rejects_relationship_context_changes(session):
    _, _, _, course = session
    before = copy.deepcopy(course)
    node_id, related = before["nodes"][0], before["nodes"][1]
    before["edges"].append({
        "id": "context-edge", "source": node_id["id"], "target": related["id"],
        "relation": "帮助理解", "explanation": "用于解释当前知识点", "when_to_use": "学习时",
        "basis": "材料概念相连", "bridges": [], "sources": [],
    })
    current = copy.deepcopy(before)
    current["nodes"][1]["status"] = "mastered"
    task = {"kind": "chat", "target": node_id["id"], "before": before}

    validate_node_task(task, current)

    current["nodes"][1]["title"] = "更新后的相关知识点"
    with pytest.raises(Conflict, match="上下文"):
        validate_node_task(task, current)


def test_question_write_rejects_a_concurrent_change_to_the_question_destination(session):
    client, store, model, course = session
    course_id = course["id"]

    def replace_question():
        with store.edit(course_id) as (current, _):
            current["nodes"][0]["question"] = {
                "prompt": "用户更新后的题目", "kind": "解释", "rubric": "更新后的评分标准",
            }

    model.reply = {"text": json.dumps({
        "prompt": "AI 新题", "kind": "案例", "rubric": "案例推理正确",
    }, ensure_ascii=False), "thread_id": "question-thread"}
    model.before_reply = replace_question
    node_id = course["nodes"][0]["id"]
    response = client.post(
        f"/api/courses/{course_id}/nodes/{node_id}/question",
    )

    assert response.status_code == 409
    assert store.course(course_id)["nodes"][0]["question"]["prompt"] == "用户更新后的题目"


def test_lesson_read_marker_is_not_part_of_lesson_generation_context(session):
    _, _, _, course = session
    before = copy.deepcopy(course)
    node_id = before["nodes"][0]["id"]
    before["nodes"][0]["lessons"] = [{
        "id": "lesson-1", "title": "旧课", "goal": "旧目标", "recap": "复习要点",
        "focus": "", "check_question": "问题", "check_answer": "答案", "read_at": None,
    }]
    current = copy.deepcopy(before)
    current["nodes"][0]["lessons"][0]["read_at"] = "2026-11-04T00:00:00+00:00"
    task = {
        "kind": "lesson", "target": node_id, "before": before,
        "inputs": {"kind": "supplement", "focus": "补充例子", "request_id": "lesson-context-0001"},
    }

    validate_node_task(task, current)


def test_recall_child_rejects_changed_active_history_and_targets_one_node(session):
    _, _, _, course = session
    before = copy.deepcopy(course)
    before["nodes"][0]["chats"] = [{
        "id": "chat-1", "role": "user", "content": "原始问题", "created_at": "2026-11-04T00:00:00+00:00",
    }]
    current = copy.deepcopy(before)
    current["nodes"][0]["chats"].append({
        "id": "chat-2", "role": "assistant", "content": "新的相关回答", "created_at": "2026-11-04T00:00:01+00:00",
    })
    task = {
        "kind": "child", "role": "recall_summary", "target": "legacy-child-target",
        "before": before,
        "inputs": {"node_title": before["nodes"][0]["title"], "history": before["nodes"][0]["chats"],
                   "scope": "course", "prompt": "冻结的Recall prompt"},
    }

    with pytest.raises(Conflict, match="Recall"):
        validate_node_task(task, current)
