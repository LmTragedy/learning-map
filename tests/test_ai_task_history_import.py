"""Integration coverage for importing and replaying recovered bridge history."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


class ScriptedModel:
    def __init__(self):
        self.ask_count = 0
        self.read_count = 0
        self.prompts = []

    def available(self):
        return {"available": True}

    def ask(self, prompt, **_options):
        self.ask_count += 1
        self.prompts.append(prompt)
        relation_text = prompt.split("\n联系：", 1)[1].split("\n材料：", 1)[0]
        relation_ids = [relation["id"] for relation in json.loads(relation_text)]
        reply = {
            "nodes": [],
            "relations": [{"id": relation_id, "bridges": [{
                "piece": {
                    "kind": "性质", "title": "传递性", "detail": "由前一步性质推出结论。",
                    "sources": [],
                },
                "step": "应用传递性", "how": "利用传递性推出结论。",
                "if_missing": "无法连接前后两步。", "strength": "required",
                "check_question": "由 x≿y、y≿z 可得什么？", "check_answer": "x≿z",
                "sources": [], "uncertain": True,
            }]} for relation_id in relation_ids],
        }
        return {
            "text": json.dumps(reply, ensure_ascii=False),
            "thread_id": "generated-thread", "turn_id": "generated-turn",
        }

    def read_turn(self, *_args, **_kwargs):
        self.read_count += 1
        raise AssertionError("unmatched history must not query provider history")


@pytest.fixture
def history_session(tmp_path):
    model = ScriptedModel()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def _matched_candidate(prompt, raw_reply, relation_ids):
    return {
        "thread_id": "historical-thread", "turn_id": "historical-turn",
        "prompt": prompt, "raw_reply": raw_reply, "status": "completed",
        "relation_ids": relation_ids, "match_error": None, "matched": True,
    }


def test_imported_bridge_receipt_recovers_once_after_course_save_failure(history_session, monkeypatch):
    client, store, model, course = history_session
    course_id = course["id"]
    baseline = store.course(course_id)
    relation_id = baseline["edges"][0]["id"]
    save_course = store.save_course
    fail_once = True

    def fail_first_save(updated, connection):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            raise OSError("simulated course save failure")
        return save_course(updated, connection)

    monkeypatch.setattr(store, "save_course", fail_first_save)
    failed_client = TestClient(client.app, raise_server_exceptions=False,
                               headers={"X-Learning-Map": "1"})
    failed = failed_client.post(
        f"/api/courses/{course_id}/relations/backfill",
        json={"revision": baseline["revision"], "request_id": "first-generation-0001"},
    )

    assert failed.status_code == 500
    assert store.course(course_id) == baseline
    assert model.ask_count == 1
    original_task = client.get(f"/api/courses/{course_id}/ai-tasks").json()[0]
    assert original_task["state"] == "invalid"
    original_detail = client.get(
        f"/api/courses/{course_id}/ai-tasks/{original_task['id']}"
    ).json()
    prompt = original_detail["request"]["prompt"]
    raw_reply = original_detail["raw_reply"]["text"]
    relation_text = prompt.split("\n联系：", 1)[1].split("\n材料：", 1)[0]
    requested_ids = [relation["id"] for relation in json.loads(relation_text)]
    assert relation_id in requested_ids
    assert len(requested_ids) == len(set(requested_ids))
    assert model.prompts == [prompt]

    tasks = client.app.state.learning.tasks
    candidate = _matched_candidate(prompt, raw_reply, requested_ids)
    imported = tasks.import_bridge_history(course_id, candidate)
    repeated_import = tasks.import_bridge_history(course_id, candidate)
    assert repeated_import["id"] == imported["id"]
    assert imported["history_matched"] is True
    assert imported["raw_reply"]["text"] == raw_reply
    assert imported["historical_raw"] == raw_reply

    recovered = client.post(
        f"/api/courses/{course_id}/ai-tasks/{imported['id']}/recover"
    )
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["task"]["state"] == "applied"
    recovered_again = client.post(
        f"/api/courses/{course_id}/ai-tasks/{imported['id']}/recover"
    )
    assert recovered_again.status_code == 200, recovered_again.text
    assert recovered_again.json()["task"]["id"] == imported["id"]
    assert model.ask_count == 1
    assert model.read_count == 0
    saved = store.course(course_id)
    saved_relations = [edge for edge in saved["edges"] if edge["id"] in requested_ids]
    assert len(saved_relations) == len(requested_ids)
    assert all(len(edge["bridges"]) == 1 for edge in saved_relations)
    saved_relation = next(edge for edge in saved_relations if edge["id"] == relation_id)
    assert saved_relation["bridges"][0]["how"] == "利用传递性推出结论。"


def test_unmatched_import_keeps_historical_raw_without_provider_recovery(history_session):
    client, store, model, course = history_session
    course_id = course["id"]
    candidate = {
        "thread_id": "unmatched-thread", "turn_id": "unmatched-turn",
        "prompt": "不匹配的历史请求", "raw_reply": '{"unverified":true}',
        "status": "inconsistent", "relation_ids": [store.course(course_id)["edges"][0]["id"]],
        "match_error": "prompt context differs", "matched": False,
    }

    tasks = client.app.state.learning.tasks
    imported = tasks.import_bridge_history(course_id, candidate)
    repeated_import = tasks.import_bridge_history(course_id, candidate)
    assert repeated_import["id"] == imported["id"]
    assert imported["history_matched"] is False
    assert imported["historical_raw"] == candidate["raw_reply"]
    assert "raw_reply" not in imported

    recovered = client.post(
        f"/api/courses/{course_id}/ai-tasks/{imported['id']}/recover"
    )
    assert recovered.status_code == 202
    assert recovered.json()["task"]["id"] == imported["id"]
    detail = client.get(f"/api/courses/{course_id}/ai-tasks/{imported['id']}").json()
    assert detail["historical_raw"] == candidate["raw_reply"]
    assert "raw_reply" not in detail
    assert model.ask_count == 0
    assert model.read_count == 0
