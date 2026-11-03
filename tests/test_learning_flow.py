import copy
import hashlib
import io
import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.domain import append_chat, find_node
from backend.store import Conflict


class ModelBoundary:
    """Scripted external AI boundary; these tests do not evaluate a real model."""

    def __init__(self):
        self.replies = []

    def available(self):
        return {"available": True, "test_boundary": True}

    def ask(self, prompt, **options):
        if not self.replies:
            raise RuntimeError("No scripted AI response")
        reply = self.replies.pop(0)
        return {
            "text": json.dumps(reply, ensure_ascii=False) if isinstance(reply, dict) else reply,
            "thread_id": options.get("thread_id") or "boundary-thread",
        }


@pytest.fixture
def session(tmp_path):
    model = ModelBoundary()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    sample = client.post("/api/sample").json()
    return client, app.state.store, model, sample


def node_path(course, index=0):
    return f"/api/courses/{course['id']}/nodes/{course['nodes'][index]['id']}"


def submit(client, path):
    response = client.post(path + "/attempts", data={"answer": "Here is my explanation."})
    assert response.status_code == 200, response.text
    return response.json()


def test_self_marks_and_direct_entry_keep_evidence_and_fog_distinct(session):
    client, _, _, course = session
    first, last = node_path(course), node_path(course, 3)
    assert course["nodes"][0]["unlocked"] and not course["nodes"][1]["unlocked"]
    visited = client.get(f"/api/courses/{course['id']}").json()
    assert not visited["nodes"][3]["unlocked"]
    assert client.get(last + "/recall").status_code == 200
    studied = client.post(first + "/mark", json={"status": "studied"}).json()
    assert studied["nodes"][0]["status"] == "studied"
    assert not studied["nodes"][1]["unlocked"]
    mastered = client.post(first + "/mark", json={"status": "mastered"}).json()
    assert mastered["nodes"][0]["verification"] == "none"
    assert mastered["nodes"][1]["unlocked"] and not mastered["nodes"][2]["unlocked"]


@pytest.mark.parametrize(
    "decision,verification", [("pass", "user_passed"), ("review", "review"), ("supplement", "none")]
)
def test_uncertain_judgment_requires_explicit_resolution(session, decision, verification):
    client, _, _, course = session
    path = node_path(course)
    submitted = submit(client, path)
    attempt = submitted["nodes"][0]["attempts"][-1]
    assert attempt["judgment"]["outcome"] == "uncertain"
    assert submitted["nodes"][0]["status"] == "new"
    resolved = client.post(path + f"/attempts/{attempt['id']}/resolve", json={"decision": decision}).json()
    assert resolved["nodes"][0]["verification"] == verification
    assert resolved["nodes"][1]["unlocked"] == (decision != "supplement")


def test_ten_actual_partial_ratings_skip_and_explicit_advice_acceptance(session):
    client, store, _, course = session
    path = node_path(course)
    first = submit(client, path)["nodes"][0]["attempts"][-1]
    assert client.post(path + f"/attempts/{first['id']}/rating", json={"skip": True}).status_code == 200
    for index in range(10):
        attempt = submit(client, path)["nodes"][0]["attempts"][-1]
        rating = {"problem": 0} if index % 2 == 0 else {"mastery": 4}
        response = client.post(path + f"/attempts/{attempt['id']}/rating", json=rating)
        assert response.status_code == 200, response.text
        profile = client.get("/api/profile").json()
        assert len(profile["stages"]) == (1 if index == 9 else 0)
    stage = profile["stages"][0]
    assert profile["ratings_count"] == 10
    assert stage["problem_average"] == 0 and stage["mastery_average"] == 4
    assert not stage["accepted"]
    assert store.course(course["id"])["preferences"]["pace"] == "按内容决定"
    accepted = client.post(f"/api/profile/stages/{stage['id']}/accept").json()
    assert accepted["stages"][0]["accepted"]
    assert store.course(course["id"])["preferences"]["pace"] == stage["advice"]
    duplicate = client.post(path + f"/attempts/{attempt['id']}/rating", json={"problem": 2})
    assert duplicate.status_code == 400
    assert client.get("/api/profile").json()["ratings_count"] == 10


def test_ai_chat_recall_node_isolation_and_restart_persist(session):
    client, store, model, course = session
    client.post("/api/settings", json={"ai_enabled": True})
    model.replies.append("先用转账例子来理解事务。")
    chatted = client.post(node_path(course) + "/chat", json={"message": "我想知道事务为什么要回滚"}).json()
    assert len(chatted["nodes"][0]["chats"]) == 2
    restarted = TestClient(create_app(store.root, lambda _: model), headers={"X-Learning-Map": "1"})
    recall = restarted.get(node_path(course) + "/recall").json()
    assert recall["messages"][0]["content"] == "我想知道事务为什么要回滚"
    assert restarted.get(node_path(course, 1) + "/recall").json()["messages"] == []
    remembered = restarted.post(node_path(course) + "/chat", json={"message": "我忘了，帮我找回思路"}).json()
    assert "我想知道事务为什么要回滚" in remembered["nodes"][0]["chats"][-1]["content"]


def test_restore_keeps_full_course_consistent_and_preserves_rollback_version(session):
    client, store, _, course = session
    cid, nid = course["id"], course["nodes"][0]["id"]
    client.post(node_path(course) + "/mark", json={"status": "mastered"})
    client.post(f"/api/courses/{cid}/snapshot")
    version = client.get(f"/api/courses/{cid}/versions").json()[0]
    with store.edit(cid) as (current, _):
        append_chat(find_node(current, nid), "user", "恢复后不能看到这条新历史")
        find_node(current, nid)["thread_id"] = "newer-hidden-thread"
    attempt = submit(client, node_path(course))["nodes"][0]["attempts"][-1]
    client.post(node_path(course) + f"/attempts/{attempt['id']}/rating", json={"mastery": 1})
    preview = client.post(f"/api/courses/{cid}/restore-preview", json={"version_id": version["id"]}).json()
    restored = client.post(f"/api/courses/{cid}/restore", json={"token": preview["token"]}).json()
    assert restored["nodes"][0]["chats"] == [] and restored["ratings"] == []
    assert restored["nodes"][0]["status"] == "mastered"
    assert restored["nodes"][0]["thread_id"] is None
    rollback = client.get(f"/api/courses/{cid}/versions").json()[0]
    assert rollback["reason"] == "恢复前自动备份"
    preview = client.post(f"/api/courses/{cid}/restore-preview", json={"version_id": rollback["id"]}).json()
    reverted = client.post(f"/api/courses/{cid}/restore", json={"token": preview["token"]}).json()
    assert len(reverted["nodes"][0]["chats"]) == 1 and len(reverted["ratings"]) == 1


def test_confirmations_bind_revision_and_delete_preserves_original_material(session):
    client, store, _, course = session
    cid = course["id"]
    original = next((store.root / "courses" / cid).rglob("original.pdf"))
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    preview = client.post(f"/api/courses/{cid}/delete-preview").json()
    client.post(node_path(course) + "/mark", json={"status": "studied"})
    assert client.post(f"/api/courses/{cid}/delete", json={"token": preview["token"]}).status_code == 409
    preview = client.post(f"/api/courses/{cid}/delete-preview").json()
    assert len(preview["contents"]) >= 4
    assert client.post(f"/api/courses/{cid}/delete", json={"token": preview["token"]}).status_code == 200
    assert client.get("/api/courses").json() == []
    assert hashlib.sha256(original.read_bytes()).hexdigest() == before


def test_obsidian_preview_confirms_exact_target_and_rejects_overwrite_or_traversal(session, tmp_path):
    client, _, _, _ = session
    vault = tmp_path / "vault"
    vault.mkdir()
    client.post("/api/settings", json={"obsidian_vault": str(vault)})
    preview = client.post(
        "/api/obsidian/preview", json={"path": "学习.md", "content": "# 实际学习记录"}
    ).json()
    assert not (vault / "学习.md").exists()
    assert preview["content"] == "# 实际学习记录"
    written = client.post("/api/obsidian/write", json={"token": preview["token"]})
    assert (
        written.status_code == 200 and (vault / "学习.md").read_text(encoding="utf-8") == preview["content"]
    )
    assert (
        client.post("/api/obsidian/preview", json={"path": "学习.md", "content": "覆盖"}).status_code == 409
    )
    assert (
        client.post("/api/obsidian/preview", json={"path": "../escape.md", "content": "越界"}).status_code
        == 400
    )
    assert client.get("/api/obsidian/notes?q=实际").json()[0]["path"] == "学习.md"


def test_adding_material_and_regeneration_preserve_progress_and_validate_sources(session):
    client, store, model, course = session
    cid = course["id"]
    client.post(node_path(course) + "/mark", json={"status": "mastered"})
    imported = client.post(
        f"/api/courses/{cid}/materials", files=[("files", ("extra.txt", io.BytesIO(b"Extra fact.")))]
    )
    assert imported.status_code == 200, imported.text
    current = imported.json()
    assert current["nodes"][0]["status"] == "mastered"
    client.post("/api/settings", json={"ai_enabled": True})
    model.replies.append(
        {
            "nodes": [
                {
                    "key": "extra",
                    "title": "新知识",
                    "summary": "新增来源知识",
                    "week": "2",
                    "sources": [
                        {
                            "material_id": current["materials"][-1]["id"],
                            "page": 1,
                            "quote": "fabricated quote",
                        }
                    ],
                    "prerequisites": [],
                    "uncertain": False,
                }
            ]
        }
    )
    generated = client.post(f"/api/courses/{cid}/generate")
    assert generated.status_code == 200, generated.text
    updated = generated.json()
    assert updated["nodes"][0]["id"] == current["nodes"][0]["id"]
    assert updated["nodes"][0]["status"] == "mastered"
    assert updated["nodes"][-1]["sources"][0]["quote"] == "" and updated["nodes"][-1]["uncertain"]
    assert store.versions(cid)[0]["reason"] == "生成地图前自动备份"


def test_concurrent_edit_rejects_stale_ai_result_instead_of_losing_progress(session):
    _, store, _, course = session
    with store.edit(course["id"]) as (current, _):
        current["preferences"]["pace"] = "已修改"
    before = copy.deepcopy(store.course(course["id"]))
    with pytest.raises(Conflict), store.edit(course["id"], expected=course["revision"]) as (current, _):
        current["nodes"] = []
    assert store.course(course["id"]) == before


def test_selected_model_and_high_effort_survive_application_restart(session):
    client, store, _, _ = session
    settings = client.get("/api/settings").json()
    settings.update(model="gpt-6.1-terra", reasoning_effort="high")
    updated = client.post("/api/settings", json=settings)
    assert updated.status_code == 200, updated.text
    restarted = TestClient(create_app(store.root))
    saved = restarted.get("/api/settings").json()
    assert saved["model"] == "gpt-6.1-terra"
    assert saved["reasoning_effort"] == "high"


def _recall_history(store, course):
    with store.edit(course["id"]) as (current, _):
        append_chat(current["nodes"][0], "user", "我知道主键不能重复，但还不确定外键的作用。")
        append_chat(current["nodes"][0], "assistant", "外键用于引用相关表中的候选键，关联记录需要核对。")
        append_chat(current["nodes"][1], "user", "这条属于另一个节点。")
    return store.course(course["id"])


def _recall_payload(history):
    return {
        "title": "主键与外键的学习脉络",
        "items": [
            {
                "category": "用户想法",
                "content": "用户表示知道主键不能重复，对外键仍有疑问。",
                "evidence_ids": [history[0]["id"]],
            },
            {
                "category": "知识连接",
                "content": "AI解释将外键与相关表中的候选键联系起来。",
                "evidence_ids": [history[1]["id"]],
            },
        ],
        "uncertainties": ["现有记录不足以判断是否已能独立运用外键。"],
    }


def test_recall_summary_uses_actual_evidence_and_preserves_chat_and_progress(session):
    client, store, model, course = session
    before = _recall_history(store, course)
    client.post("/api/settings", json={"ai_enabled": True})
    model.replies.append(_recall_payload(before["nodes"][0]["chats"]))
    response = client.post(node_path(course) + "/recall-summary", json={})
    assert response.status_code == 200, response.text
    summary = response.json()
    assert summary["messages"] == before["nodes"][0]["chats"]
    assert summary["history_revision"] == before["revision"]
    after = store.course(course["id"])
    assert after["nodes"] == before["nodes"] and after["ratings"] == before["ratings"]
    assert after["codex_threads"][0]["title"] == course["title"] + "｜关系与键｜Recall整理"
    assert after["codex_threads"][0]["group"] == "学习 · " + course["title"]


@pytest.mark.parametrize("bad_evidence", ["other_node", "assistant_as_user", "duplicate"])
def test_recall_summary_rejects_fabricated_or_misattributed_evidence(session, bad_evidence):
    client, store, model, course = session
    before = _recall_history(store, course)
    client.post("/api/settings", json={"ai_enabled": True})
    payload = _recall_payload(before["nodes"][0]["chats"])
    if bad_evidence == "other_node":
        payload["items"][0]["evidence_ids"] = [before["nodes"][1]["chats"][0]["id"]]
    elif bad_evidence == "assistant_as_user":
        payload["items"][0]["evidence_ids"] = [before["nodes"][0]["chats"][1]["id"]]
    else:
        payload["items"][0]["evidence_ids"] *= 2
    model.replies.append(payload)
    response = client.post(node_path(course) + "/recall-summary", json={})
    assert response.status_code == 400
    assert store.course(course["id"]) == before


def test_recall_summary_without_history_or_ai_is_explicitly_unavailable(session):
    client, store, _, course = session
    assert client.post(node_path(course) + "/recall-summary", json={}).status_code == 400
    _recall_history(store, course)
    unavailable = client.post(node_path(course) + "/recall-summary", json={})
    assert unavailable.status_code == 400
    assert "AI 尚未启用" in unavailable.json()["detail"]
    assert len(client.get(node_path(course) + "/recall").json()["messages"]) == 2


def test_recall_summary_rejects_stale_history_without_overwriting_new_messages(session, monkeypatch):
    client, store, model, course = session
    before = _recall_history(store, course)
    client.post("/api/settings", json={"ai_enabled": True})

    def external_reply_during_new_message(prompt, **options):
        with store.edit(course["id"]) as (current, _):
            append_chat(current["nodes"][0], "user", "我又补充了一个想法。")
        return {
            "text": json.dumps(_recall_payload(before["nodes"][0]["chats"]), ensure_ascii=False),
            "thread_id": "summary-thread",
        }

    monkeypatch.setattr(model, "ask", external_reply_during_new_message)
    response = client.post(node_path(course) + "/recall-summary", json={})
    assert response.status_code == 409
    assert store.course(course["id"])["nodes"][0]["chats"][-1]["content"] == "我又补充了一个想法。"


def test_node_chat_records_a_findable_course_and_node_conversation_name(session):
    client, store, model, course = session
    client.post("/api/settings", json={"ai_enabled": True})
    model.replies.append("我们先用一个关联表例子来说明。")
    response = client.post(node_path(course) + "/chat", json={"message": "外键如何关联？"})
    assert response.status_code == 200, response.text
    saved = store.course(course["id"])
    assert saved["codex_threads"] == [
        {
            "thread_id": "boundary-thread",
            "title": course["title"] + "｜关系与键",
            "group": "学习 · " + course["title"],
            "node_id": course["nodes"][0]["id"],
        }
    ]


@pytest.mark.parametrize("quote", ["", "   "])
def test_empty_ai_source_excerpt_cannot_be_shown_as_reliable(session, quote):
    client, store, model, course = session
    cid = course["id"]
    client.post("/api/settings", json={"ai_enabled": True})
    before = copy.deepcopy(store.course(cid))
    model.replies.append(
        {
            "nodes": [
                {
                    "key": "blank",
                    "title": "缺失引文测试",
                    "summary": "来源应不确定",
                    "week": "",
                    "sources": [{"material_id": course["materials"][0]["id"], "page": 1, "quote": quote}],
                    "prerequisites": [],
                    "uncertain": False,
                }
            ]
        }
    )
    response = client.post(f"/api/courses/{cid}/generate")
    if quote == "":
        assert response.status_code == 400
        assert store.course(cid) == before
    else:
        assert response.status_code == 200
        assert response.json()["nodes"][-1]["uncertain"]


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.example", "X-Learning-Map": "1"},
        {"Host": "attacker.example", "X-Learning-Map": "1"},
        {},
    ],
)
def test_foreign_page_cannot_mutate_local_courses(session, headers):
    _, store, _, _ = session
    client = TestClient(create_app(store.root))
    assert client.post("/api/courses", json={"title": "Unauthorized"}, headers=headers).status_code == 403
