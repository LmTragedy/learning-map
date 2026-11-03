import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.ai import AIError, AIUnavailable
from backend.app import create_app
from backend.deepseek_ai import DeepSeekAI, deepseek_status, provider_for


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def _reply(content, finish_reason="stop"):
    return httpx.Response(200, json={"id": "abc", "choices": [
        {"message": {"content": content}, "finish_reason": finish_reason}]})


def test_structured_request_uses_json_mode_and_carries_the_schema():
    sent = {}

    def handler(request):
        sent.update(json.loads(request.content), auth=request.headers["Authorization"])
        return _reply('{"ok": true}')

    ai = DeepSeekAI("deepseek-chat", api_key="k", client=_client(handler))
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    reply = ai.ask("检查笔记", schema=schema, conversation=object(), thread_id="old")
    assert reply == {"text": '{"ok": true}', "thread_id": "deepseek-abc"}
    assert sent["auth"] == "Bearer k"
    assert sent["model"] == "deepseek-chat"
    assert sent["response_format"] == {"type": "json_object"}
    assert json.dumps(schema, ensure_ascii=False) in sent["messages"][0]["content"]
    assert sent["messages"][1] == {"role": "user", "content": "检查笔记"}


def test_images_truncation_missing_key_and_rejected_key_fail_loudly(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    ai = DeepSeekAI("deepseek-chat", api_key="k", client=_client(lambda _: _reply("{}", "length")))
    with pytest.raises(AIError, match="图片"):
        ai.ask("x", images=["page.png"])
    with pytest.raises(AIError, match="截断"):
        ai.ask("x")
    with pytest.raises(AIUnavailable, match="DEEPSEEK_API_KEY"):
        DeepSeekAI("deepseek-chat", api_key="").ask("x")
    denied = DeepSeekAI("deepseek-chat", api_key="bad", client=_client(lambda _: httpx.Response(401)))
    with pytest.raises(AIUnavailable, match="API key"):
        denied.ask("x")


def test_only_deepseek_model_names_leave_codex():
    codex = object()
    assert isinstance(provider_for({"model": "deepseek-chat"}, lambda _: codex), DeepSeekAI)
    assert provider_for({"model": "gpt-6-luna"}, lambda _: codex) is codex
    assert deepseek_status({"note_review_model": "gpt-6-luna", "goal_model": ""}) is None


def test_learning_model_cannot_be_deepseek_but_goal_and_review_models_can(tmp_path):
    client = TestClient(create_app(tmp_path / "data", lambda _: None), headers={"X-Learning-Map": "1"})
    assert client.post("/api/settings", json={"model": "deepseek-chat"}).status_code == 422
    saved = client.post("/api/settings", json={"note_review_model": "deepseek-chat", "goal_model": "deepseek-chat"})
    assert saved.status_code == 200
    assert saved.json()["goal_model"] == "deepseek-chat"


def test_goal_extraction_is_sent_to_the_goal_model(tmp_path):
    seen = []

    class Model:
        def ask(self, prompt, **options):
            return {"text": json.dumps({"goals": []}), "thread_id": "t"}

    def factory(settings):
        seen.append(settings["model"])
        return Model()

    client = TestClient(create_app(tmp_path / "data", factory), headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    client.post("/api/settings", json={"ai_enabled": True, "goal_model": "deepseek-chat"})
    seen.clear()
    assert client.post(f'/api/courses/{course["id"]}/goal-candidates').status_code == 200
    assert seen == ["deepseek-chat"]


def test_saved_key_is_write_only_and_used_for_requests(tmp_path, monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    client = TestClient(create_app(tmp_path / "data"), headers={"X-Learning-Map": "1"})
    saved = client.post("/api/settings", json={"note_review_model": "deepseek-chat", "deepseek_api_key": "sk-test"})
    assert saved.status_code == 200
    assert "deepseek_api_key" not in saved.json() and saved.json()["deepseek_key_set"] is True
    assert "sk-test" not in client.get("/api/settings").text
    assert client.get("/api/health").json()["deepseek"] == {"available": True}
    settings = client.app.state.store.settings() | {"model": "deepseek-chat"}
    assert client.app.state.learning.ai_factory(settings).api_key == "sk-test"
    # Saving other settings keeps the key; an empty string removes it.
    client.post("/api/settings", json={"goal_model": ""})
    assert client.get("/api/settings").json()["deepseek_key_set"] is True
    client.post("/api/settings", json={"deepseek_api_key": ""})
    assert client.get("/api/settings").json()["deepseek_key_set"] is False
    assert client.get("/api/health").json()["deepseek"]["available"] is False
