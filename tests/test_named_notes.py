"""Named notes: a title on the node's main note and extra notes bound to several nodes."""

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


@pytest.fixture
def session(tmp_path):
    app = create_app(tmp_path / "data", lambda _: None)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    return client, client.post("/api/sample").json()


def test_main_note_title_is_saved_without_changing_content_rules(session):
    client, course = session
    url = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/personal-note"
    saved = client.put(url, json={"content": "正文", "expected": "", "title": " 推导总结 "}).json()
    assert saved["nodes"][0]["personal_note_title"] == "推导总结"
    renamed = client.put(url, json={"content": "正文", "expected": "正文", "title": "易错点"}).json()
    assert renamed["nodes"][0]["personal_note_title"] == "易错点"
    assert renamed["nodes"][0]["personal_note"] == "正文"


def test_extra_note_create_update_conflict_and_delete(session):
    client, course = session
    base = f"/api/courses/{course['id']}/notes"
    first, second = course["nodes"][0]["id"], course["nodes"][1]["id"]
    created = client.post(base, json={"title": "跨节点总结", "node_ids": [first, second, first], "content": "a"}).json()
    note = created["notes"][0]
    assert note["node_ids"] == [first, second]
    updated = client.put(f"{base}/{note['id']}", json={"title": "改名", "node_ids": [second], "content": "b", "expected": "a"})
    assert updated.status_code == 200
    assert updated.json()["notes"][0]["title"] == "改名"
    stale = client.put(f"{base}/{note['id']}", json={"title": "x", "node_ids": [second], "content": "c", "expected": "a"})
    assert stale.status_code == 409
    assert client.post(base, json={"title": "x", "node_ids": ["missing"]}).status_code == 404
    assert client.post(base, json={"title": "  ", "node_ids": [first]}).status_code == 400
    removed = client.delete(f"{base}/{note['id']}").json()
    assert removed["notes"] == []
    versions = client.get(f"/api/courses/{course['id']}/versions").json()
    assert any(version["reason"] == "删除笔记前自动备份" for version in versions)


@pytest.mark.parametrize("kind", ["bridge", "line"])
def test_note_anchor_survives_workbench_save_without_anchor_field(session, kind):
    client, course = session
    cid = course["id"]
    nodes = [node["id"] for node in course["nodes"][:2]]
    if kind == "line":
        response = client.post(f"/api/courses/{cid}/lines", json={"name": "事务线", "node_ids": nodes})
        assert response.status_code == 200
        anchor_id = response.json()["lines"][0]["id"]
    else:
        anchor_id = course["edges"][0]["id"]
    base = f"/api/courses/{cid}/notes"
    created = client.post(base, json={"title": "连接笔记", "node_ids": nodes, "anchor": {"kind": kind, "id": anchor_id}})
    assert created.status_code == 200
    note = created.json()["notes"][-1]
    saved = client.put(f"{base}/{note['id']}", json={"title": note["title"], "node_ids": nodes, "content": "补充理解", "expected": ""})
    assert saved.status_code == 200
    assert saved.json()["notes"][-1]["anchor"] == {"kind": kind, "id": anchor_id}
    assert saved.json()["notes"][-1]["content"] == "补充理解"
