import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app


@pytest.fixture
def note_session(tmp_path):
    app = create_app(tmp_path / "data")
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    base = f"/api/courses/{course['id']}"
    return app, client, course, base


def test_simultaneous_note_saves_keep_one_winner_without_partial_conflict_writes(note_session):
    app, client, course, base = note_session
    barrier = Barrier(2)
    url = f"{base}/nodes/{course['nodes'][0]['id']}/personal-note"
    versions_before = len(client.get(base + "/versions").json())

    def save(content):
        with TestClient(app, headers={"X-Learning-Map": "1"}) as window:
            barrier.wait(timeout=10)
            return window.put(url, json={"content": content, "expected": ""})

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(save, ["window A", "window B"]))
    assert sorted(response.status_code for response in responses) == [200, 409]
    winner = next(response.json() for response in responses if response.status_code == 200)
    loaded = client.get(base).json()
    assert loaded["revision"] == course["revision"] + 1
    assert loaded["nodes"][0]["personal_note"] == winner["nodes"][0]["personal_note"]
    assert len(client.get(base + "/versions").json()) == versions_before + 1


def test_note_edit_and_clear_preserve_other_state_and_restore_with_backup(note_session, tmp_path):
    app, client, course, base = note_session
    vault = tmp_path / "vault"
    vault.mkdir()
    original = vault / "original.md"
    original.write_text("untouched original", encoding="utf-8")
    client.post("/api/settings", json={"obsidian_vault": str(vault)})
    url = f"{base}/nodes/{course['nodes'][0]['id']}/personal-note"
    before = copy.deepcopy(app.state.store.course(course["id"]))
    assert client.put(url, json={"content": "我的理解\n保留原话", "expected": ""}).status_code == 200
    current = app.state.store.course(course["id"])
    current["nodes"][0].pop("personal_note")
    current["revision"] = before["revision"]
    assert current == before

    client.post(base + "/snapshot", json={})
    manual = next(version for version in client.get(base + "/versions").json() if version["reason"] == "手动保存")
    assert client.put(url, json={"content": "", "expected": "我的理解\n保留原话"}).status_code == 200
    restarted = TestClient(create_app(app.state.store.root), headers={"X-Learning-Map": "1"})
    assert restarted.get(base).json()["nodes"][0]["personal_note"] == ""
    preview = restarted.post(base + "/restore-preview", json={"version_id": manual["id"]}).json()
    restored = restarted.post(base + "/restore", json={"token": preview["token"]})
    assert restored.status_code == 200
    assert restored.json()["nodes"][0]["personal_note"] == "我的理解\n保留原话"
    backups = restarted.get(base + "/versions").json()
    backup = next(version for version in backups if version["reason"] == "恢复前自动备份")
    with app.state.store.connect() as connection:
        assert app.state.store.version(course["id"], backup["id"], connection)["nodes"][0]["personal_note"] == ""
    assert list(vault.iterdir()) == [original]
    assert original.read_text(encoding="utf-8") == "untouched original"


def test_note_writes_are_scoped_to_course_and_node(note_session):
    _, client, course, base = note_session
    first, second = course["nodes"][:2]
    other = client.post("/api/courses", json={"title": "另一课程"}).json()
    first_url = f"{base}/nodes/{first['id']}/personal-note"
    second_url = f"{base}/nodes/{second['id']}/personal-note"
    client.put(first_url, json={"content": "first", "expected": ""}).raise_for_status()
    client.put(second_url, json={"content": "second", "expected": ""}).raise_for_status()
    assert client.put(f"/api/courses/{other['id']}/nodes/{first['id']}/personal-note", json={"content": "wrong course", "expected": "first"}).status_code == 404
    loaded = client.get(base).json()
    assert [node["personal_note"] for node in loaded["nodes"][:2]] == ["first", "second"]
    assert not client.get(f"/api/courses/{other['id']}").json()["nodes"]


def test_ai_suggestions_remain_chat_text_until_user_explicitly_saves(tmp_path):
    class SuggestionModel:
        def ask(self, prompt, **options):
            return {"text": "建议：把理解整理为定义、例子与疑问。", "thread_id": "note-suggestion"}

    app = create_app(tmp_path / "data", lambda _: SuggestionModel())
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    base = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}"
    client.put(base + "/personal-note", json={"content": "用户原话", "expected": ""}).raise_for_status()
    client.post("/api/settings", json={"ai_enabled": True}).raise_for_status()
    response = client.post(base + "/chat", json={"message": "请建议如何整理我的笔记"})
    assert response.status_code == 200
    node = response.json()["nodes"][0]
    assert node["chats"][-1]["content"] == "建议：把理解整理为定义、例子与疑问。"
    assert node["personal_note"] == "用户原话"
    assert node["status"] == "new"
