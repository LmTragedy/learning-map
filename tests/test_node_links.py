"""Re-finding one node's links: strong earlier/later links, plain and formal wording, safe application."""

import json

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


class Model:
    def __init__(self):
        self.replies, self.prompts = [], []

    def ask(self, prompt, **options):
        self.prompts.append(prompt)
        reply = self.replies.pop(0)
        return {"text": reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False), "thread_id": "t"}


@pytest.fixture
def session(tmp_path):
    model = Model()
    app = create_app(tmp_path / "data", lambda _: model)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True})
    return client, app.state.store, model, course


def bridge(piece, step, strength="required"):
    return {"piece": {"kind": "定义", "title": piece, "detail": "", "sources": []}, "step": step,
            "how": f"用{piece}完成{step}", "if_missing": "", "strength": strength,
            "check_question": "问？", "check_answer": "答", "sources": [], "uncertain": True}


def link(node_id, direction, piece, step, at_step="", role="用到"):
    return {"node_id": node_id, "direction": direction, "role": role, "at_step": at_step, "bridge": bridge(piece, step)}


def draft(links, nodes=()):
    return {"plain": "要么全做完，要么当没做过", "formal": "事务 T 满足 A、C、I、D",
            "steps": [{"step": "说明原子性", "formal": "commit(T) ∨ abort(T)"}],
            "links": links, "nodes": list(nodes)}


def find(client, course):
    node = course["nodes"][1]
    return client.post(f"/api/courses/{course['id']}/nodes/{node['id']}/links", json={"revision": course["revision"]})


def test_links_fill_bridges_add_non_unlocking_edges_and_write_plain_and_formal(session):
    client, _, model, course = session
    first, focus, third, fourth = (node["id"] for node in course["nodes"])
    model.replies.append(draft([
        link(first, "before", "主键", "说明原子性"),
        link(fourth, "after", "原子性", "解释并发冲突", at_step="说明原子性"),
        link(focus, "before", "自己", "说明原子性"),
        link("unknown", "before", "未知", "说明原子性"),
    ], nodes=[{"id": first, "plain": "每行有唯一编号", "formal": "K → R"},
              {"id": third, "plain": "没有联系就不写", "formal": "x"}]))
    response = find(client, course)
    assert response.status_code == 200, response.text
    updated = response.json()
    nodes = {node["id"]: node for node in updated["nodes"]}
    edges = {(edge["source"], edge["target"]): edge for edge in updated["edges"]}

    old = edges[(first, focus)]
    assert not old["bridges"][0].get("legacy") and old["bridges"][0]["origin"] == "ai"
    assert old["confirmed"] is False and old["controls_unlock"] is True

    added = edges[(focus, fourth)]
    assert added["controls_unlock"] is False and added["kind"] == "用到"
    step = next(item for item in nodes[focus]["steps"] if item["title"] == "说明原子性")
    assert added["bridges"][0]["from_step"] == step["id"]
    assert step["formal"] == "commit(T) ∨ abort(T)"

    assert nodes[focus]["plain"] == "要么全做完，要么当没做过" and nodes[focus]["formal"].startswith("事务")
    assert nodes[first]["plain"] == "每行有唯一编号"
    assert "plain" not in nodes[third]
    assert [node["prerequisites"] for node in updated["nodes"]] == [node["prerequisites"] for node in course["nodes"]]
    assert (focus, focus) not in edges
    assert any(version["reason"] == "重新找前后联系前自动备份"
               for version in client.get(f"/api/courses/{course['id']}/versions").json())


def test_links_never_reverse_existing_order_make_cycles_or_replace_user_bridges(session):
    client, _, model, course = session
    first, focus, third, fourth = (node["id"] for node in course["nodes"])
    edge = next(item for item in course["edges"] if item["target"] == focus)
    user = [{"id": "", "from_piece": "", "to_step": "", "how": "我自己写的", "if_missing": "", "strength": "required",
             "check": {"question": "", "answer": ""}}]
    saved = client.put(f"/api/courses/{course['id']}/relations/{edge['id']}/bridges",
                       json={"revision": course["revision"], "bridges": user}).json()
    model.replies.append(draft([
        link(first, "before", "主键", "说明原子性"),
        link(third, "before", "回滚", "说明原子性"),
        link(fourth, "before", "隔离", "说明原子性"),
    ]))
    response = find(client, saved)
    assert response.status_code == 200, response.text
    updated = response.json()
    pairs = {(item["source"], item["target"]) for item in updated["edges"]}
    assert (third, focus) not in pairs and (fourth, focus) not in pairs
    kept = next(item for item in updated["edges"] if item["id"] == edge["id"])
    assert [item["how"] for item in kept["bridges"]] == ["我自己写的"]


def test_links_with_nothing_usable_or_a_stale_revision_change_nothing(session):
    client, store, model, course = session
    before = store.course(course["id"])
    model.replies.append(draft([link(course["nodes"][1]["id"], "before", "自己", "说明原子性")]))
    assert find(client, course).status_code == 400
    assert store.course(course["id"])["edges"] == before["edges"]
    stale = dict(course, revision=course["revision"] - 1)
    assert find(client, stale).status_code == 409


def test_step_formal_survives_edits_but_not_renames_and_removed_steps_clear_from_step(session):
    client, store, model, course = session
    first, focus, _, fourth = (node["id"] for node in course["nodes"])
    model.replies.append(draft([link(first, "before", "主键", "说明原子性"),
                                link(fourth, "after", "原子性", "解释并发冲突", at_step="说明原子性")]))
    updated = find(client, course).json()
    node = next(item for item in updated["nodes"] if item["id"] == focus)
    steps = [{"id": step["id"], "title": step["title"]} for step in node["steps"]]
    kept = client.put(f"/api/courses/{course['id']}/nodes/{focus}/pieces",
                      json={"revision": updated["revision"], "pieces": [], "steps": steps}).json()
    assert next(item for item in kept["nodes"] if item["id"] == focus)["steps"][0]["formal"] == "commit(T) ∨ abort(T)"
    renamed = client.put(f"/api/courses/{course['id']}/nodes/{focus}/pieces",
                         json={"revision": kept["revision"], "pieces": [],
                               "steps": [dict(steps[0], title="改了名字")]}).json()
    assert "formal" not in next(item for item in renamed["nodes"] if item["id"] == focus)["steps"][0]
    removed = client.put(f"/api/courses/{course['id']}/nodes/{focus}/pieces",
                         json={"revision": renamed["revision"], "pieces": [], "steps": []}).json()
    edge = next(item for item in removed["edges"] if item["source"] == focus and item["target"] == fourth)
    assert edge["bridges"][0]["from_step"] == ""
