"""Synthetic data and captured model calls; no real AI or private course content."""

import copy
import hashlib
import io
import json

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfgen.canvas import Canvas

from backend.app import create_app
from backend.review_scope import scope_key
from backend.store import Store


class CapturedModel:
    def __init__(self):
        self.calls = []
        self.replies = []
        self.before_reply = None

    def ask(self, prompt, **options):
        self.calls.append((prompt, options))
        if self.before_reply:
            self.before_reply()
        reply = self.replies.pop(0)
        return {
            "text": json.dumps(reply) if isinstance(reply, dict) else reply,
            "thread_id": options.get("thread_id") or f"thread-{len(self.calls)}",
        }


@pytest.fixture
def review(tmp_path):
    model = CapturedModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    # Import a second real generated text PDF through the existing copy/parser pipeline.
    buffer = io.BytesIO()
    pdf = Canvas(buffer)
    pdf.drawString(40, 700, "EXCLUDED_PDF_SENTINEL")
    pdf.save()
    original = buffer.getvalue()
    response = client.post(
        f"/api/courses/{course['id']}/materials",
        files={"files": ("second.pdf", original, "application/pdf")},
    )
    assert response.status_code == 200
    store = app.state.store
    with store.edit(course["id"]) as (current, _):
        first, second = current["materials"]
        node = current["nodes"][0]
        node["sources"].append(dict(material_id=second["id"], page=1, quote="EXCLUDED_PDF_SENTINEL"))
        node["summary"] = "EXCLUDED_SUMMARY_SENTINEL"
        node["thread_id"] = "original-course-thread"
        node["chats"].append(dict(id="legacy", role="user", content="EXCLUDED_CHAT_SENTINEL", created_at="old"))
        node["question"] = dict(prompt="EXCLUDED_QUESTION_SENTINEL", kind="解释", rubric="old")
        # A node linked only to PDF 2, and a node with no source should not match PDF 1.
        current["nodes"][2]["sources"] = [dict(material_id=second["id"], page=1, quote="EXCLUDED_PDF_SENTINEL")]
        current["nodes"][3]["sources"] = []
    course = store.course(course["id"])
    base = f"/api/courses/{course['id']}"
    node_url = base + f"/nodes/{course['nodes'][0]['id']}"
    return client, store, model, course, base, node_url, original


def select(review, ids=None, *, enabled=True, ai_scope="selected"):
    client, _, _, course, base, _, _ = review
    return client.post(base + "/review-scope", json=dict(
        enabled=enabled,
        material_ids=ids if ids is not None else [course["materials"][0]["id"]],
        ai_scope=ai_scope,
    ))


def test_selection_filters_projection_without_changing_progress_sources_or_files(review):
    client, store, _, before, base, _, original = review
    assert select(review).status_code == 200
    projected = client.get(base).json()
    assert projected["review_scope"]["node_ids"] == [n["id"] for n in before["nodes"][:2]]
    assert not projected["nodes"][1]["unlocked"]  # Still locked; UI grants temporary review entry.
    assert projected["nodes"][0]["chats"] == []
    assert "question" not in projected["nodes"][0]
    assert projected["nodes"][0]["review_archived"]["chats"] == 1
    raw = store.course(before["id"])
    for key in ("nodes", "materials", "edges", "ratings", "preferences"):
        assert raw[key] == before[key]
    assert Store(store.root).course(before["id"])["review_scope"]["enabled"]
    restored_view = TestClient(create_app(store.root), headers={"X-Learning-Map": "1"}).get(base).json()
    assert restored_view["review_scope"] == projected["review_scope"]
    material = before["materials"][1]
    copied = store.root / "courses" / before["id"] / "materials" / material["id"] / "original.pdf"
    assert copied.read_bytes() == original
    assert hashlib.sha256(copied.read_bytes()).hexdigest() == material["sha256"]
    assert select(review, enabled=False).json()["nodes"][0]["chats"] == before["nodes"][0]["chats"]


@pytest.mark.parametrize("ids", [[], ["other-course-pdf"], ["duplicate", "duplicate"]])
def test_invalid_selection_is_atomic(review, ids):
    _, store, _, before, _, _, _ = review
    assert select(review, ids).status_code == 400
    assert store.course(before["id"]) == before


def test_strict_chat_threads_history_and_recall_are_separate_and_reusable(review):
    client, store, model, course, base, node_url, _ = review
    select(review)
    model.replies.append("所选材料的讲解")
    reply = client.post(node_url + "/chat", json={"message": "复习这个知识点"})
    assert reply.status_code == 200, reply.text
    prompt, options = model.calls[-1]
    assert "A relation stores tuples" in prompt
    assert all(s not in prompt for s in ("EXCLUDED_PDF_SENTINEL", "EXCLUDED_CHAT_SENTINEL", "EXCLUDED_SUMMARY_SENTINEL"))
    assert options.get("thread_id") is None
    assert "PDF复习" in options["conversation"].title
    model.replies.append("继续这个范围")
    client.post(node_url + "/chat", json={"message": "再举个例子"})
    assert model.calls[-1][1]["thread_id"] == "thread-1"
    select(review, [m["id"] for m in course["materials"]])
    model.replies.append("新组合")
    client.post(node_url + "/chat", json={"message": "复习组合"})
    assert model.calls[-1][1].get("thread_id") is None
    select(review)
    model.replies.append("原范围继续")
    client.post(node_url + "/chat", json={"message": "继续"})
    assert model.calls[-1][1]["thread_id"] == "thread-1"
    messages = client.get(node_url + "/recall").json()["messages"]
    assert messages[0]["content"] == "EXCLUDED_CHAT_SENTINEL"
    scoped = client.get(base).json()["nodes"][0]["chats"]
    model.replies.append(dict(title="复习回顾", items=[dict(
        category="用户想法", content="用户希望复习。", evidence_ids=[scoped[0]["id"]],
    )], uncertainties=[]))
    result = client.post(node_url + "/recall-summary")
    assert result.status_code == 200, result.text
    assert "EXCLUDED_CHAT_SENTINEL" not in model.calls[-1][0]
    assert len(result.json()["messages"]) == len(scoped)
    select(review, ai_scope="course")
    model.replies.append("全课程")
    client.post(node_url + "/chat", json={"message": "全课程继续"})
    prompt, options = model.calls[-1]
    # The resumed thread already holds earlier turns; only the changed sources are resent.
    assert "EXCLUDED_CHAT_SENTINEL" not in prompt and "EXCLUDED_PDF_SENTINEL" in prompt
    assert options["thread_id"] == "original-course-thread"
    raw = store.course(course["id"])
    assert raw["nodes"][0]["thread_id"] == "original-course-thread"


def test_strict_assessment_requires_scoped_question_and_preserves_self_mark_and_rating(review):
    client, store, model, course, base, node_url, _ = review
    client.post(node_url + "/mark", json={"status": "mastered"})
    select(review)
    assert client.post(node_url + "/attempts", data={"answer": "解释"}).status_code == 400
    question = dict(prompt="解释关系中的行", kind="解释", rubric="按逻辑判断")
    model.replies.append(question)
    assert client.post(node_url + "/question").status_code == 200
    model.replies.append(dict(outcome="uncertain", reasoning="解释有歧义", blockers=["需澄清"], next_step="补充例子"))
    response = client.post(node_url + "/attempts", data={"answer": "一行是一个记录"})
    assert response.status_code == 200, response.text
    node = response.json()["nodes"][0]
    assert node["status"] == "mastered"  # Review did not erase the user's prior self-mark.
    attempt = node["attempts"][0]
    assert attempt["question"] == question
    assert "EXCLUDED_QUESTION_SENTINEL" not in model.calls[-1][0]
    client.post(node_url + f"/attempts/{attempt['id']}/rating", json={"skip": True})
    client.post(node_url + f"/attempts/{attempt['id']}/resolve", json={"decision": "review"})
    raw = store.course(course["id"])["nodes"][0]
    assert raw["question"]["prompt"] == "EXCLUDED_QUESTION_SENTINEL"
    assert raw["verification"] == "none"
    assert raw["review_progress"][scope_key(store.course(course["id"]))]["verification"] == "review"
    assert raw["attempts"][0]["rating_state"] == "skipped"
    assert raw["review_questions"][scope_key(store.course(course["id"]))] == question
    # Excluded nodes cannot silently call the AI in strict mode.
    excluded_url = base + f"/nodes/{course['nodes'][2]['id']}"
    assert client.post(excluded_url + "/chat", json={"message": "你好"}).status_code == 400


def test_subset_pass_and_later_resolution_do_not_unlock_full_course(review):
    client, store, model, course, _, node_url, _ = review
    select(review)
    model.replies.append(dict(prompt="解释一行", kind="解释", rubric="解释含义"))
    client.post(node_url + "/question")
    model.replies.append(dict(outcome="passed", reasoning="解释正确", blockers=[], next_step="继续复习"))
    response = client.post(node_url + "/attempts", data={"answer": "一行是一个记录"})
    assert response.status_code == 200, response.text
    projected = response.json()
    assert projected["nodes"][0]["review_verification"] == "ai_passed"
    assert projected["nodes"][0]["status"] == "new"
    assert not projected["nodes"][1]["unlocked"]
    select(review, enabled=False)
    raw = store.course(course["id"])
    assert raw["nodes"][0]["verification"] == "none"
    assert raw["nodes"][0]["attempts"][-1]["judgment"]["outcome"] == "passed"


def test_stale_record_actions_require_original_scope(review):
    client, store, _, course, _, node_url, _ = review
    with store.edit(course["id"]) as (current, _):
        node = current["nodes"][0]
        node["attempts"].append(dict(
            id="legacy-attempt", judgment={"outcome": "uncertain"}, rating_state="pending",
        ))
        node["lessons"] = [dict(id="legacy-lesson", read_at=None, html="<p>历史小课</p>")]
    select(review)
    before = store.course(course["id"])
    assert client.post(node_url + "/attempts/legacy-attempt/resolve", json={"decision": "pass"}).status_code == 400
    assert client.post(node_url + "/attempts/legacy-attempt/rating", json={"skip": True}).status_code == 400
    assert client.post(node_url + "/lessons/legacy-lesson/read").status_code == 400
    assert client.get(node_url + "/lessons/legacy-lesson/html").status_code == 400
    assert store.course(course["id"]) == before
    select(review, enabled=False)
    assert client.get(node_url + "/lessons/legacy-lesson/html").status_code == 200
    assert client.post(node_url + "/lessons/legacy-lesson/read").status_code == 200


def test_streaks_keep_scope_evidence_separate_but_actual_ratings_still_count(review):
    client, store, model, course, base, node_url, _ = review
    first = course["materials"][0]["id"]
    second = course["materials"][1]["id"]
    for ids in ([first], [second], [first]):
        select(review, list(ids))
        model.replies.append(dict(prompt="解释节点", kind="解释", rubric="判断逻辑"))
        client.post(node_url + "/question")
        model.replies.append(dict(outcome="passed", reasoning="合理", blockers=[], next_step="复习"))
        response = client.post(node_url + "/attempts", data={"answer": "解释"})
        assert response.status_code == 200, response.text
        attempt = response.json()["nodes"][0]["attempts"][-1]
        assert client.post(node_url + f"/attempts/{attempt['id']}/rating", json={"problem": 3}).status_code == 200
        saved = store.course(course["id"])
        if len(saved["ratings"]) == 2:
            assert not saved["suggestions"]  # Different selections cannot form a streak.
    saved = store.course(course["id"])
    assert len(saved["suggestions"]) == 1
    assert saved["suggestions"][0]["review_scope_key"] == scope_key(saved)
    assert len(saved["ratings"]) == 3
    assert len({rating["review_scope_key"] for rating in saved["ratings"]}) == 2
    assert client.get("/api/profile").json()["ratings_count"] == 3
    select(review, [second])
    assert not client.get(base).json()["suggestions"]


def test_scope_change_during_ai_rejects_stale_result_and_restore_clears_scoped_threads(review):
    client, store, model, course, base, node_url, _ = review
    select(review)
    model.replies.append("已保存")
    client.post(node_url + "/chat", json={"message": "范围内对话"})
    client.post(base + "/snapshot")
    version = client.get(base + "/versions").json()[0]["id"]
    saved = copy.deepcopy(store.course(course["id"]))
    model.before_reply = lambda: select(review, ai_scope="course")
    model.replies.append("不应覆盖")
    assert client.post(node_url + "/chat", json={"message": "并发测试"}).status_code == 409
    assert store.course(course["id"])["nodes"] == saved["nodes"]
    model.before_reply = None
    token = client.post(base + "/restore-preview", json={"version_id": version}).json()["token"]
    restored = client.post(base + "/restore", json={"token": token})
    assert restored.status_code == 200, restored.text
    raw = Store(store.root).course(course["id"])
    assert raw["review_scope"]["ai_scope"] == "selected"
    assert raw["nodes"][0]["review_threads"] == {}
    assert raw["nodes"][0]["chats"] == saved["nodes"][0]["chats"]
