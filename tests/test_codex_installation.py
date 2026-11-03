import os
from pathlib import Path

import pytest

from backend.ai import CodexAI
from backend.codex_installation import codex_executable


@pytest.fixture
def desktop_environment(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    local_appdata = tmp_path / "local-appdata"
    profile.mkdir()
    local_appdata.mkdir()
    monkeypatch.setenv("USERPROFILE", str(profile))
    monkeypatch.setenv("HOME", str(profile))
    monkeypatch.setenv("LOCALAPPDATA", str(local_appdata))
    monkeypatch.setenv("PATH", "")
    return profile, local_appdata


@pytest.mark.skipif(os.name != "nt", reason="Windows desktop installation discovery")
@pytest.mark.parametrize("location", ["local_appdata", "profile_fallback"])
def test_desktop_codex_is_found_without_path_and_tracks_version_updates(desktop_environment, location):
    profile, local_appdata = desktop_environment
    root = local_appdata if location == "local_appdata" else profile / "AppData" / "Local"
    old = root / "OpenAI" / "Codex" / "bin" / "old-hash" / "codex.exe"
    latest = root / "OpenAI" / "Codex" / "bin" / "new-hash" / "codex.exe"
    for executable, modified in ((old, 1000), (latest, 2000)):
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"test installation marker; not executed")
        os.utime(executable, (modified, modified))
    assert Path(codex_executable()) == latest
    latest.unlink()
    assert Path(codex_executable()) == old


def test_missing_installation_reports_unavailable_without_launching_model(desktop_environment, tmp_path):
    assert codex_executable() is None
    availability = CodexAI(tmp_path / "workspace").available()
    assert availability["available"] is False
    assert "未找到 Codex" in availability["reason"]
