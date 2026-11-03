import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.domain import find_node
from backend.learning import node_context
from backend.review_scope import scope_key


class CapturedModel:
    """Scripted model boundary; the tests inspect data flow, not teaching quality."""

    def __init__(self):
        self.calls = []
        self.replies = []

    def ask(self, prompt, **options):
        self.calls.append((prompt, options))
        reply = self.replies.pop(0)
        return {
            "text": json.dumps(reply, ensure_ascii=False) if isinstance(reply, dict) else reply,
            "thread_id": options.get("thread_id") or "language-support-thread",
        }


@pytest.fixture
def learning_session(tmp_path):
    model = CapturedModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    base = f"/api/courses/{course['id']}"
    node_url = base + f"/nodes/{course['nodes'][0]['id']}"
    return client, app.state.store, model, course, base, node_url


def _seed_scoped_context(store, course, client):
    selected_material = course["materials"][0]
    response = client.post(
        f"/api/courses/{course['id']}/review-scope",
        json={"enabled": True, "material_ids": [selected_material["id"]], "ai_scope": "selected"},
    )
    assert response.status_code == 200, response.text
    current_key = scope_key(store.course(course["id"]))
    with store.edit(course["id"]) as (current, _):
        current["preferences"]["pace"] = "PREFERENCE_SENTINEL"
        node, other_node = current["nodes"][:2]
        node["chats"].extend([
            {"id": "scope-chat", "role": "user", "content": "CURRENT_SCOPE_CHAT_SENTINEL", "created_at": "now", "review_scope_key": current_key},
            {"id": "old-scope-chat", "role": "user", "content": "OTHER_SCOPE_CHAT_SENTINEL", "created_at": "then", "review_scope_key": "pdf:old"},
        ])
        node["attempts"].extend([
            {
                "id": "scope-attempt", "created_at": "2026-11-03T00:00:00Z",
                "review_scope_key": current_key,
                "answer": "CURRENT_SCOPE_ANSWER_SENTINEL",
                "reference": "", "attachments": [{"extracted_text": "CURRENT_ATTACHMENT_BODY_SENTINEL"}],
                "question": {"prompt": "CURRENT_SCOPE_QUESTION_SENTINEL", "kind": "解释", "rubric": "CURRENT_SCOPE_RUBRIC_SENTINEL"},
                "judgment": {
                    "outcome": "uncertain", "reasoning": "CURRENT_SCOPE_JUDGMENT_SENTINEL",
                    "blockers": ["Needs clarification"], "next_step": "Clarify the idea.",
                },
                "resolution": None,
                "rating_state": "pending",
            },
            {
                "id": "old-scope-attempt", "created_at": "2026-11-02T00:00:00Z",
                "review_scope_key": "pdf:old",
                "answer": "OTHER_SCOPE_ANSWER_SENTINEL",
                "reference": "", "attachments": [{"extracted_text": "ATTACHMENT_BODY_SENTINEL"}],
                "question": {"prompt": "OTHER_SCOPE_QUESTION_SENTINEL", "kind": "解释", "rubric": "Other"},
                "judgment": {
                    "outcome": "failed", "reasoning": "OTHER_SCOPE_JUDGMENT_SENTINEL",
                    "blockers": ["Other"], "next_step": "Other.",
                },
                "resolution": None, "rating_state": "pending",
            },
        ])
        other_node["chats"].append({
            "id": "other-node-chat", "role": "user", "content": "OTHER_NODE_CHAT_SENTINEL",
            "created_at": "now", "review_scope_key": current_key,
        })
        node.setdefault("review_questions", {})[current_key] = {
            "prompt": "CURRENT_SCOPE_QUESTION_SENTINEL", "kind": "解释", "rubric": "CURRENT_SCOPE_RUBRIC_SENTINEL",
        }
    return current_key


def _lesson_reply():
    return {
        "title": "短课",
        "goal": "理解一个概念",
        "html": "<h2>例子</h2><p>用一个具体例子解释概念，并观察每一步怎样连接到需要理解的关键含义。</p>",
        "check_question": "请解释例子中的关键关系。",
        "check_answer": "参考解释。",
        "recap": "简短复习卡。",
    }


@pytest.mark.parametrize("operation", ["chat", "question", "grade", "lesson"])
def test_ai_operations_receive_current_scoped_history_evidence_and_sources(learning_session, operation):
    client, store, model, course, _, node_url = learning_session
    _seed_scoped_context(store, course, client)
    before = store.course(course["id"])

    if operation == "chat":
        model.replies.append("A short explanation.")
        response = client.post(node_url + "/chat", json={"message": "请用简单英文解释。"})
    elif operation == "question":
        model.replies.append({"prompt": "Explain the example.", "kind": "解释", "rubric": "Check the reasoning."})
        response = client.post(node_url + "/question")
    elif operation == "grade":
        model.replies.append({"outcome": "uncertain", "reasoning": "Need clearer evidence.", "blockers": ["uncertain"], "next_step": "Please clarify."})
        response = client.post(node_url + "/attempts", data={"answer": "CURRENT_REQUEST_ANSWER_SENTINEL"})
    else:
        model.replies.append(_lesson_reply())
        response = client.post(node_url + "/lessons", json={"kind": "initial", "focus": "", "request_id": "language-test-lesson-001"})

    assert response.status_code == 200, response.text
    prompt = model.calls[-1][0]
    for marker in (
        "CURRENT_SCOPE_CHAT_SENTINEL", "CURRENT_SCOPE_ANSWER_SENTINEL",
        "CURRENT_SCOPE_QUESTION_SENTINEL", "CURRENT_SCOPE_JUDGMENT_SENTINEL",
        "PREFERENCE_SENTINEL", "A relation stores tuples",
    ):
        assert marker in prompt
    for marker in (
        "OTHER_SCOPE_CHAT_SENTINEL", "OTHER_SCOPE_ANSWER_SENTINEL",
        "OTHER_SCOPE_QUESTION_SENTINEL", "OTHER_SCOPE_JUDGMENT_SENTINEL",
        "OTHER_NODE_CHAT_SENTINEL", "ATTACHMENT_BODY_SENTINEL", "CURRENT_ATTACHMENT_BODY_SENTINEL",
    ):
        assert marker not in prompt

    if operation in {"chat", "lesson"}:
        after = store.course(course["id"])
        assert after["ratings"] == before["ratings"]
        assert after["nodes"][0]["verification"] == before["nodes"][0]["verification"]
        assert after["nodes"][0]["status"] == before["nodes"][0]["status"]
        if operation == "lesson":
            lesson = response.json()["nodes"][0]["lessons"][-1]
            read = client.post(node_url + f"/lessons/{lesson['id']}/read")
            assert read.status_code == 200
            after_read = store.course(course["id"])
            assert after_read["ratings"] == before["ratings"]
            assert after_read["nodes"][0]["verification"] == before["nodes"][0]["verification"]
            assert after_read["nodes"][0]["status"] == before["nodes"][0]["status"]


def test_node_context_filters_scope_before_taking_recent_conversation_and_attempt_limits(learning_session):
    client, store, _, course, _, _ = learning_session
    current_key = _seed_scoped_context(store, course, client)
    with store.edit(course["id"]) as (current, _):
        node = current["nodes"][0]
        for index in range(35):
            node["chats"].append({
                "id": f"recent-chat-{index}", "role": "user",
                "content": f"CURRENT_CHAT_{index:02d}", "created_at": "now",
                "review_scope_key": current_key,
            })
        for index in range(5):
            node["chats"].append({
                "id": f"excluded-chat-{index}", "role": "user",
                "content": f"EXCLUDED_CHAT_{index:02d}", "created_at": "old",
                "review_scope_key": "pdf:old",
            })
        for index in range(4):
            node["attempts"].append({
                "id": f"recent-attempt-{index}", "created_at": "now",
                "review_scope_key": current_key, "answer": f"CURRENT_ATTEMPT_{index}",
                "reference": "", "attachments": [],
                "question": {"prompt": "Prompt", "kind": "解释", "rubric": "Rubric"},
                "judgment": {
                    "outcome": "uncertain", "reasoning": f"CURRENT_JUDGMENT_{index}",
                    "blockers": [], "next_step": "Clarify.",
                },
                "resolution": None, "rating_state": "pending",
            })
        for index in range(4):
            node["attempts"].append({
                "id": f"excluded-attempt-{index}", "created_at": "old",
                "review_scope_key": "pdf:old", "answer": f"EXCLUDED_ATTEMPT_{index}",
                "reference": "", "attachments": [],
                "question": {"prompt": "Excluded", "kind": "解释", "rubric": "Excluded"},
                "judgment": {
                    "outcome": "failed", "reasoning": f"EXCLUDED_JUDGMENT_{index}",
                    "blockers": [], "next_step": "Excluded.",
                },
                "resolution": None, "rating_state": "pending",
            })

    saved = store.course(course["id"])
    context = json.loads(node_context(saved, find_node(saved, course["nodes"][0]["id"])))
    assert len(context["actual_conversations"]) == 6
    assert context["actual_conversations"][0]["content"] == "CURRENT_CHAT_29"
    assert context["actual_conversations"][-1]["content"] == "CURRENT_CHAT_34"
    assert all("EXCLUDED_CHAT_" not in entry["content"] for entry in context["actual_conversations"])
    assert len(context["assessment_evidence"]) == 3
    assert [attempt["answer"] for attempt in context["assessment_evidence"]] == [
        "CURRENT_ATTEMPT_1", "CURRENT_ATTEMPT_2", "CURRENT_ATTEMPT_3",
    ]
    assert all("EXCLUDED_" not in json.dumps(attempt) for attempt in context["assessment_evidence"])


def test_question_rejects_oversized_recent_chat_without_changing_course_or_snapshots(learning_session):
    client, store, model, course, _, node_url = learning_session
    current_key = _seed_scoped_context(store, course, client)
    with store.edit(course["id"]) as (current, _):
        current["nodes"][0]["chats"].extend(
            {
                "id": f"long-chat-{index}", "role": "user", "content": "x" * 11000,
                "created_at": "now", "review_scope_key": current_key,
            }
            for index in range(6)
        )
    before = store.course(course["id"])
    versions = store.versions(course["id"])

    response = client.post(node_url + "/question")

    assert response.status_code == 400
    assert store.course(course["id"]) == before
    assert store.versions(course["id"]) == versions
    assert model.calls == []
