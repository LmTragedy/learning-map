"""Main lines: user edits, derived transfer stations and per-line progress."""

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.lines import project_lines


@pytest.fixture
def session(tmp_path):
    app = create_app(tmp_path / "data", lambda _: None)
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    return client, client.post("/api/sample").json()


def test_lines_project_transfers_and_progress_and_keep_user_edits(session):
    client, course = session
    base = f"/api/courses/{course['id']}"
    ids = [node["id"] for node in course["nodes"]]
    client.post(f"{base}/nodes/{ids[0]}/mark", json={"status": "mastered"})
    invalid = client.post(f"{base}/lines", json={"name": "无效主线", "node_ids": [ids[0], "missing"]})
    assert invalid.status_code == 400
    first = client.post(f"{base}/lines", json={"name": "数据怎么存", "node_ids": [ids[0], ids[1]]}).json()
    second = client.post(f"{base}/lines", json={"name": "改动怎么安全", "node_ids": [ids[1], ids[2], ids[3]]}).json()
    lines = second["lines"]
    assert [line["node_ids"] for line in lines] == [[ids[0], ids[1]], [ids[1], ids[2], ids[3]]]
    assert second["transfers"] == [ids[1]]
    assert lines[0]["progress"]["done"] == 1
    assert lines[0]["progress"]["total"] == 2
    assert lines[0]["progress"]["ratio"] == 0.5
    assert second["progress"]["nodes"] == {"known": 1, "done": 1, "total": 4, "ratio": 0.25}
    assert second["nodes"][0]["progress"] == {"known": 1, "total": 1, "ratio": 1, "done": True}
    assert [line["color"] for line in lines] == [0, 1]
    edited = client.put(f"{base}/lines/{lines[0]['id']}", json={
        "revision": second["revision"], "name": "改过的名字", "goal": "一句话目标", "node_ids": [ids[0]],
        "endpoint": "", "story": [],
    })
    assert edited.status_code == 200, edited.text
    assert edited.json()["lines"][0]["origin"] == "user"
    assert edited.json()["transfers"] == []
    stale = client.put(f"{base}/lines/{lines[0]['id']}", json={"revision": second["revision"], "name": "x", "node_ids": [ids[0]]})
    assert stale.status_code == 409
    empty = client.post(f"{base}/lines", json={"name": "空", "node_ids": ["missing"]})
    assert empty.status_code == 400
    note = client.post(f"{base}/notes", json={
        "title": "主线笔记", "node_ids": [ids[0]], "anchor": {"kind": "line", "id": lines[1]["id"]},
    })
    assert note.status_code == 200
    blocked_delete = client.post(f"{base}/lines/{lines[1]['id']}/delete", json={"revision": note.json()["revision"]})
    assert blocked_delete.status_code == 400
    assert any(line["id"] == lines[1]["id"] for line in client.get(base).json()["lines"])
    unbound = client.delete(f"{base}/notes/{note.json()['notes'][-1]['id']}").json()
    removed = client.post(f"{base}/lines/{lines[1]['id']}/delete", json={"revision": unbound["revision"]}).json()
    assert [line["name"] for line in removed["lines"]] == ["改过的名字"]
    assert first["lines"][0]["name"] == "数据怎么存"


def test_passed_node_with_unchecked_pieces_counts_as_complete_without_marking_pieces_known(session):
    _, course = session
    node = course["nodes"][0]
    node["status"] = "passed"
    node["pieces"] = [
        {"id": "p1", "state": {"result": "unsure"}},
        {"id": "p2", "state": {"result": "unknown"}},
    ]

    projected = project_lines(course)

    assert projected["nodes"][0]["progress"] == {
        "known": 0, "total": 2, "ratio": 0, "done": True,
    }
    assert projected["progress"]["pieces"] == {"known": 0, "total": 2, "ratio": 0}
    assert projected["progress"]["nodes"] == {
        "known": 1, "done": 1, "total": 4, "ratio": 0.25,
    }
