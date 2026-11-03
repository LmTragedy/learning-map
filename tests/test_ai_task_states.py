"""The task tray in the frontend must know every state the backend writes."""

import re
from pathlib import Path

from backend.ai_tasks import ACTIVE_TASK_STATES, TASK_STATES

MODEL = Path(__file__).resolve().parents[1] / "frontend" / "src" / "aiTaskModel.ts"


def test_frontend_active_states_match_backend():
    source = MODEL.read_text(encoding="utf-8")
    declared = re.search(r"ACTIVE_STATES = new Set\(\[([^\]]*)\]\)", source)
    assert declared, "ACTIVE_STATES is no longer declared as a literal set"
    assert set(re.findall(r"'([a-z_]+)'", declared.group(1))) == set(ACTIVE_TASK_STATES)


def test_frontend_names_every_backend_state():
    source = MODEL.read_text(encoding="utf-8")
    missing = [state for state in TASK_STATES if f"'{state}'" not in source]
    assert not missing, f"aiTaskModel.ts does not handle: {missing}"
