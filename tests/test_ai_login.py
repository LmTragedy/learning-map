import subprocess

from fastapi.testclient import TestClient

from backend import ai as ai_module
from backend.ai import CodexAI
from backend.app import create_app


def _run_returning(code, stdout="", stderr=""):
    def fake_run(command, **_kwargs):
        assert command[1:] == ["login", "status"]
        return subprocess.CompletedProcess(command, code, stdout, stderr)
    return fake_run


def _codex(tmp_path, monkeypatch, run):
    ai_module._LOGIN_CACHE.clear()
    monkeypatch.setattr(ai_module, "codex_executable", lambda: "codex")
    monkeypatch.setattr(ai_module.subprocess, "run", run)
    return CodexAI(tmp_path)


def test_login_status_reads_codex_login_status(tmp_path, monkeypatch):
    assert _codex(tmp_path, monkeypatch, _run_returning(0, stderr="Logged in using ChatGPT\n")).login_status() == "ok"
    assert _codex(tmp_path, monkeypatch, _run_returning(1, stderr="Not logged in\n")).login_status() == "missing"


def test_login_status_is_cached_until_refresh(tmp_path, monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return _run_returning(0, stderr="Logged in using ChatGPT")(command, **kwargs)

    codex = _codex(tmp_path, monkeypatch, run)
    codex.login_status()
    codex.login_status()
    assert len(calls) == 1
    codex.login_status(refresh=True)
    assert len(calls) == 2


def test_login_status_is_unknown_when_the_check_cannot_run(tmp_path, monkeypatch):
    def run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("codex", 15)
    assert _codex(tmp_path, monkeypatch, run).login_status() == "unknown"


class _FakeAI:
    def __init__(self, login):
        self.login = login
        self.refreshed = False

    def available(self):
        return {"available": True}

    def login_status(self, *, refresh=False):
        self.refreshed = refresh
        return self.login


def test_health_reports_login_and_test_connection_refreshes(tmp_path):
    fake = _FakeAI("missing")
    client = TestClient(create_app(tmp_path / "data", ai_factory=lambda _settings: fake), headers={"X-Learning-Map": "1"})
    assert client.get("/api/health").json()["ai"] == {"available": True, "login": "missing"}
    fake.login = "ok"
    assert client.post("/api/health/ai-check").json() == {"available": True, "login": "ok"}
    assert fake.refreshed is True


def test_adapters_without_a_login_check_report_unknown(tmp_path):
    class Plain:
        def available(self):
            return {"available": True}
    client = TestClient(create_app(tmp_path / "data", ai_factory=lambda _settings: Plain()), headers={"X-Learning-Map": "1"})
    assert client.get("/api/health").json()["ai"]["login"] == "unknown"
