"""Locate Codex without requiring the desktop app's temporary PATH additions."""

import os
import shutil
from pathlib import Path


def codex_executable() -> str | None:
    from_path = shutil.which("codex")
    if from_path:
        return from_path
    if os.name != "nt":
        return None
    candidates = _desktop_executables()
    if not candidates:
        return None
    return str(max(candidates, key=lambda executable: executable.stat().st_mtime_ns))


def _desktop_executables() -> list[Path]:
    # Desktop installs use versioned directories; do not pin a machine-specific hash.
    roots = {Path.home() / "AppData" / "Local"}
    if local_appdata := os.environ.get("LOCALAPPDATA"):
        roots.add(Path(local_appdata))
    return [
        executable
        for root in roots
        for executable in (root / "OpenAI" / "Codex" / "bin").glob("*/codex.exe")
        if executable.is_file()
    ]
