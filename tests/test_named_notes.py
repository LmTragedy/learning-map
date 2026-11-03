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
