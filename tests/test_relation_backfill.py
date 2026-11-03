"""Backfilling explanations for relationships saved before explanations existed."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.relation_backfill import PLACEHOLDER


class Model:
    def __init__(self):
        self.replies, self.prompts = [], []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        return {"text": json.dumps(self.replies.pop(0), ensure_ascii=False), "thread_id": "t"}


@pytest.fixture
def session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def filled(edge_id, **overrides):
    return {"id": edge_id, "explanation": "用到了什么：关系定义\n在哪一步用：写查询\n不会会怎样：看不懂",
            "when_to_use": "写查询前", "basis": "按定义推断", "evidence_kind": "ai_inference",
            "sources": [], "uncertain": True, **overrides}


def test_backfill_fills_placeholder_relations_and_keeps_progress(session):
    client, store, model, course = session
    legacy = [edge for edge in course["edges"] if edge["explanation"] == PLACEHOLDER]
    assert legacy
    model.replies.append({"relations": [filled(edge["id"]) for edge in legacy] + [filled("unknown")]})
    response = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"]})
    assert response.status_code == 200, response.text
    updated = response.json()
    for edge in updated["edges"]:
        if edge["id"] in {item["id"] for item in legacy}:
            assert edge["explanation"].startswith("用到了什么")
            assert edge["confirmed"] is False
    assert all(edge["id"] != "unknown" for edge in updated["edges"])
    assert [n["prerequisites"] for n in updated["nodes"]] == [n["prerequisites"] for n in course["nodes"]]
    assert legacy[0]["id"] in model.prompts[0]
    second = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": updated["revision"]})
    assert second.status_code == 400


def test_backfill_rejects_stale_revision_and_keeps_user_edit(session):
    client, store, model, course = session
    stale = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"] - 1})
    assert stale.status_code == 409
    edge = next(edge for edge in course["edges"] if edge["explanation"] == PLACEHOLDER)

    def user_edits_meanwhile(prompt, **options):
        with store.edit(course["id"]) as (current, _):
            next(e for e in current["edges"] if e["id"] == edge["id"])["explanation"] = "我自己写的"
        return {"text": json.dumps({"relations": [filled(edge["id"])]}, ensure_ascii=False), "thread_id": "t"}

    model.ask = user_edits_meanwhile
    response = client.post(f"/api/courses/{course['id']}/relations/backfill", json={"revision": course["revision"]})
    assert response.status_code == 200, response.text
    assert next(e for e in response.json()["edges"] if e["id"] == edge["id"])["explanation"] == "我自己写的"
