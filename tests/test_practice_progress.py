import json

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.learning import context_digest
from backend.practice_progress import practice_evidence, question_key
from backend.review_scope import question_for


class Model:
    def __init__(self):
        self.replies = []
        self.prompts = []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        reply = self.replies.pop(0)
        return {"text": json.dumps(reply, ensure_ascii=False), "thread_id": "practice-thread"}


def practice_session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    node = course["nodes"][0]
    base = f"/api/courses/{course['id']}/nodes/{node['id']}"
    model.replies.append({"prompt": "解释关键关系", "kind": "解释", "rubric": "说明原因"})
    assert client.post(base + "/question").status_code == 200
    current = app.state.store.course(course["id"])
    key = question_key(question_for(current, current["nodes"][0]))
    return client, app.state.store, model, base, key


def judgment(**fields):
    return {
        "outcome": "failed", "reasoning": "尚有卡点。", "blockers": ["解释原因"],
        "next_step": "请补充解释。", **fields,
    }


def test_same_question_supplement_keeps_original_evidence_and_confirmed_point(tmp_path):
    client, store, model, node_url, key = practice_session(tmp_path)
    model.replies.append(judgment(confirmed_points=[{
        "id": "point-1", "point": "说明了记录的定义", "attempt_id": "first-answer-0001",
        "quote": "我是用户原话",
    }]))
    first = client.post(node_url + "/attempts", data={
        "answer": "我是用户原话", "question_key": key,
    }, headers={"X-AI-Request-ID": "first-answer-0001"})
    assert first.status_code == 200, first.text
    node = store.course(first.json()["id"])["nodes"][0]
    assert practice_evidence(store.course(first.json()["id"]), node, "first-answer-0001")[0]["answer"] == "我是用户原话"

    model.replies.append(judgment(blockers=["需要说明使用场景"]))
    second = client.post(node_url + "/attempts", data={
        "answer": "补充使用场景", "base_attempt_id": "first-answer-0001", "question_key": key,
    }, headers={"X-AI-Request-ID": "second-answer-0001"})
    assert second.status_code == 200, second.text
    projected = second.json()["nodes"][0]["practice_progress"]
    assert projected["attempt_ids"] == ["first-answer-0001", "second-answer-0001"]
    assert projected["confirmed_points"] == [{
        "id": "point-1", "point": "说明了记录的定义", "attempt_id": "first-answer-0001",
        "quote": "我是用户原话",
    }]
    markdown = client.get(node_url + "/progress.md")
    assert markdown.status_code == 200
    assert markdown.headers["content-type"].startswith("text/markdown")
    assert "我是用户原话" in markdown.text
    assert "说明了记录的定义" in markdown.text
    assert len(store.course(first.json()["id"])["nodes"][0]["attempts"]) == 2

    model.replies.append(judgment(outcome="passed", blockers=[], confirmed_points=[{
        "id": "point-1", "point": "已解释记录是什么", "attempt_id": "first-answer-0001",
        "quote": "我是用户原话",
    }]))
    third = client.post(node_url + "/attempts", data={
        "answer": "第三轮只澄清了其他问题", "base_attempt_id": "second-answer-0001", "question_key": key,
    }, headers={"X-AI-Request-ID": "third-answer-0001"})
    assert third.status_code == 200, third.text
    progress = third.json()["nodes"][0]["practice_progress"]
    assert progress["attempt_ids"] == [
        "first-answer-0001", "second-answer-0001", "third-answer-0001",
    ]
    assert progress["confirmed_points"][0]["point"] == "说明了记录的定义"
    assert progress["blockers"] == []
    assert third.json()["nodes"][0]["attempts"][-1]["judgment"]["outcome"] == "passed"


def test_unverified_claim_cannot_apply_a_passed_judgment(tmp_path):
    client, _, model, node_url, key = practice_session(tmp_path)
    model.replies.append(judgment(outcome="passed", blockers=[], confirmed_points=[{
        "id": "fabricated-point", "point": "伪造替代", "attempt_id": "unverified-claim-0001",
        "quote": "不存在于用户作答中的话",
    }]))
    response = client.post(node_url + "/attempts", data={
        "answer": "实际作答", "question_key": key,
    }, headers={"X-AI-Request-ID": "unverified-claim-0001"})
    assert response.status_code == 200, response.text
    node = response.json()["nodes"][0]
    assert node["attempts"][-1]["judgment"]["outcome"] == "uncertain"
    assert "AI 提供的确认/撤回依据无法核验，需人工复核" in node["attempts"][-1]["judgment"]["blockers"]
    assert node["verification"] != "ai_passed"


def test_legacy_client_retries_the_same_answer_without_a_question_key(tmp_path):
    client, _, model, node_url, _ = practice_session(tmp_path)
    model.replies.append(judgment())
    headers = {"X-AI-Request-ID": "legacy-client-retry-0001"}
    first = client.post(node_url + "/attempts", data={"answer": "旧客户端的作答"}, headers=headers)
    repeated = client.post(node_url + "/attempts", data={"answer": "旧客户端的作答"}, headers=headers)
    assert first.status_code == repeated.status_code == 200
    assert len(repeated.json()["nodes"][0]["attempts"]) == 1
    assert not model.replies


def test_independent_answers_and_branched_supplements_only_receive_their_own_chain(tmp_path):
    client, store, model, node_url, key = practice_session(tmp_path)
    model.replies.append(judgment(outcome="uncertain"))
    first = client.post(node_url + "/attempts", data={
        "answer": "PRIVATE_OLD_CHAIN_ANSWER", "question_key": key,
    }, headers={"X-AI-Request-ID": "independent-first-0001"})
    assert first.status_code == 200
    assert client.post(node_url + "/attempts/independent-first-0001/resolve", json={"decision": "pass"}).status_code == 200
    model.replies.append(judgment())
    second = client.post(node_url + "/attempts", data={
        "answer": "PRIVATE_INDEPENDENT_ANSWER", "question_key": key,
    }, headers={"X-AI-Request-ID": "independent-second-001"})
    assert second.status_code == 200
    assert second.json()["nodes"][0]["practice_progress"]["attempt_ids"] == ["independent-second-001"]
    assert "PRIVATE_OLD_CHAIN_ANSWER" not in model.prompts[-1]
    assert "independent-first-0001" not in model.prompts[-1]

    model.replies.append(judgment())
    branch = client.post(node_url + "/attempts", data={
        "answer": "继续补充原来的作答", "question_key": key, "base_attempt_id": "independent-first-0001",
    }, headers={"X-AI-Request-ID": "branched-supplement-001"})
    assert branch.status_code == 200, branch.text
    assert branch.json()["nodes"][0]["practice_progress"]["attempt_ids"] == [
        "independent-first-0001", "branched-supplement-001",
    ]
    assert "PRIVATE_OLD_CHAIN_ANSWER" in model.prompts[-1]
    assert "PRIVATE_INDEPENDENT_ANSWER" not in model.prompts[-1]


def test_progress_markdown_keeps_answer_evidence_and_resolution_updates_chat_context(tmp_path):
    client, store, _, node_url, key = practice_session(tmp_path)
    course_id = node_url.split("/courses/")[1].split("/nodes/")[0]
    with store.edit(course_id) as (course, _):
        node = course["nodes"][0]
        node["attempts"].append({
            "id": "resolved-attempt-001", "question_key": key, "question": node["question"],
            "review_scope_key": "course", "answer": "完整的旧作答",
            "attachments": [{"name": "scan.pdf", "pages": [
                {"number": 1, "text": "附件中的支持依据", "uncertain": True},
            ]}],
            "judgment": {"outcome": "uncertain", "reasoning": "AI认为还需核对。", "blockers": ["待核对"]},
            "resolution": None,
        })
    before = context_digest(store.course(course_id), store.course(course_id)["nodes"][0])
    with store.edit(course_id) as (course, _):
        course["nodes"][0]["attempts"][0]["resolution"] = "pass"
    after = context_digest(store.course(course_id), store.course(course_id)["nodes"][0])
    markdown = client.get(node_url + "/progress.md").text
    assert before != after
    assert "完整的旧作答" in markdown
    assert "附件中的支持依据" in markdown
    assert "需核对" in markdown
    assert "结果：uncertain" in markdown
    assert "pass" in markdown
    assert "暂无" in markdown


def test_course_progress_does_not_include_records_from_a_pdf_scope(tmp_path):
    client, store, _, node_url, key = practice_session(tmp_path)
    course_id = node_url.split("/courses/")[1].split("/nodes/")[0]
    with store.edit(course_id) as (course, _):
        node = course["nodes"][0]
        node["attempts"].append({
            "id": "archived-pdf-attempt", "question_key": key, "question": node["question"],
            "review_scope_key": "pdf:archived", "answer": "OTHER_SCOPE_ANSWER",
            "judgment": {"outcome": "passed", "blockers": []},
        })
    response = client.get(node_url + "/progress.md")
    assert response.status_code == 200
    assert "OTHER_SCOPE_ANSWER" not in response.text
    assert "没有与当前题目关联的作答" in response.text


def test_legacy_same_question_attempt_can_be_used_as_supplement_base(tmp_path):
    client, store, model, node_url, key = practice_session(tmp_path)
    course_id = node_url.split("/courses/")[1].split("/nodes/")[0]
    with store.edit(course_id) as (course, _):
        node = course["nodes"][0]
        node["attempts"].append({
            "id": "legacy-attempt-id", "review_scope_key": "course", "answer": "旧记录原话",
            "question": node["question"], "judgment": {"outcome": "failed", "blockers": ["旧卡点"]},
        })
    model.replies.append(judgment())
    response = client.post(node_url + "/attempts", data={
        "answer": "补充内容", "base_attempt_id": "legacy-attempt-id", "question_key": key,
    }, headers={"X-AI-Request-ID": "legacy-supplement-0001"})
    assert response.status_code == 200, response.text
    progress = response.json()["nodes"][0]["practice_progress"]
    assert progress["attempt_ids"] == ["legacy-attempt-id", "legacy-supplement-0001"]


def test_received_assessment_with_older_judgment_schema_recovers_without_resending(tmp_path, monkeypatch):
    client, store, model, node_url, key = practice_session(tmp_path)
    course_id = node_url.split("/courses/")[1].split("/nodes/")[0]
    model.replies.append(judgment(outcome="passed", blockers=[]))
    save_course = store.save_course
    fail_once = True

    def fail_apply(course, connection):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            raise OSError("test save failure")
        return save_course(course, connection)

    monkeypatch.setattr(store, "save_course", fail_apply)
    unavailable = TestClient(client.app, raise_server_exceptions=False, headers={"X-Learning-Map": "1"})
    response = unavailable.post(
        node_url + "/attempts", data={"answer": "独立解释", "question_key": key},
        headers={"X-AI-Request-ID": "legacy-schema-recovery-01"},
    )
    assert response.status_code == 500
    task = client.get(f"/api/courses/{course_id}/ai-tasks").json()[0]
    old_schema = {
        "type": "object",
        "properties": {
            "outcome": {"type": "string", "enum": ["passed", "failed", "uncertain"]},
            "reasoning": {"type": "string"}, "blockers": {"type": "array", "items": {"type": "string"}},
            "next_step": {"type": "string"}, "missing_bridges": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["outcome", "reasoning", "blockers", "next_step", "missing_bridges"],
        "additionalProperties": False,
    }
    with store.connect() as connection:
        row = connection.execute("SELECT body FROM ai_tasks WHERE id=?", (task["id"],)).fetchone()
        receipt = json.loads(row["body"])
        receipt["request"]["schema"] = old_schema
        connection.execute("UPDATE ai_tasks SET body=? WHERE id=?", (json.dumps(receipt), task["id"]))
    monkeypatch.setattr(store, "save_course", save_course)
    recovered = client.post(f"/api/courses/{course_id}/ai-tasks/{task['id']}/recover")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["course"]["nodes"][0]["attempts"][-1]["judgment"]["outcome"] == "passed"


def test_supplement_rejects_stale_question_or_attempt_from_another_node(tmp_path):
    client, app_store, model, node_url, key = practice_session(tmp_path)
    model.replies.append(judgment())
    first = client.post(node_url + "/attempts", data={
        "answer": "首次作答", "question_key": key,
    }, headers={"X-AI-Request-ID": "first-attempt-0001"})
    assert first.status_code == 200
    course_id = first.json()["id"]
    other_node_id = first.json()["nodes"][1]["id"]
    other_url = f"/api/courses/{course_id}/nodes/{other_node_id}"
    stale = client.post(node_url + "/attempts", data={
        "answer": "补充", "base_attempt_id": "first-attempt-0001", "question_key": "stale-key",
    })
    cross_node = client.post(other_url + "/attempts", data={
        "answer": "补充", "base_attempt_id": "first-attempt-0001", "question_key": key,
    })
    assert stale.status_code == 409
    assert 400 <= cross_node.status_code < 500
    assert len(model.prompts) == 2
    assert len(app_store.course(course_id)["nodes"][0]["attempts"]) == 1
