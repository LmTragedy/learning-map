import io
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.ai import AIError, CodexAI
from backend.conversation_identity import ConversationIdentity


class FakeAppServer:
    def __init__(self, messages: list[dict[str, object]]) -> None:
        self.stdin = CapturedInput()
        self.stdout = io.BytesIO(
            b"".join(json.dumps(message).encode() + b"\n" for message in messages)
        )
        self.stderr = io.BytesIO()
        self.returncode = None

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        self.returncode = self.returncode or 0
        return self.returncode


class CapturedInput(io.BytesIO):
    def close(self):
        self.saved = self.getvalue()
        super().close()

    def getvalue(self):
        return self.saved if self.closed else super().getvalue()


def rpc(request_id: int, result: dict[str, object]) -> dict[str, object]:
    return {"id": request_id, "result": result}


def execute(tmp_path: Path, server: FakeAppServer, callback=None, **kwargs):
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        result = CodexAI(tmp_path).ask("Exact prompt", observer=callback, **kwargs)
    sent = [json.loads(line) for line in server.stdin.getvalue().splitlines()]
    return result, sent


def test_observer_receives_recoverable_order_and_turn_id(tmp_path: Path) -> None:
    messages = [
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}),
        rpc(3, {"turn": {"id": "turn-1"}}),
        {"method": "item/agentMessage/delta", "params": {
            "delta": "Answer", "threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1",
        }},
        {"method": "turn/completed", "params": {
            "threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"},
        }},
    ]
    observed = []
    response, sent = execute(tmp_path, FakeAppServer(messages), lambda *event: observed.append(event))
    names = [event for event, _ in observed]
    assert names.index("thread/opened") < names.index("turn/sending")
    assert names.index("turn/sending") < names.index("stream/message")
    assert names.index("turn/identified") < names.index("response/completed")
    assert response == {"text": "Answer", "thread_id": "thread-1", "turn_id": "turn-1"}
    assert observed[-1][1] == response
    assert next(payload for name, payload in observed if name == "stream/message") == messages[3]
    assert sent[-1]["method"] == "turn/start"


def test_conversation_reset_cannot_interleave_with_the_actual_turn_write(tmp_path: Path):
    from fastapi.testclient import TestClient

    from backend.app import create_app

    app = create_app(tmp_path / "data")
    client = TestClient(app, headers={"X-Learning-Map": "1"})
    course = client.post("/api/sample").json()
    path = f"/api/courses/{course['id']}/nodes/{course['nodes'][0]['id']}/conversations/reset"
    server = FakeAppServer([
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}), rpc(3, {"turn": {"id": "turn-1"}}),
        {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
            "id": "turn-1", "status": "completed", "items": [
                {"type": "agentMessage", "id": "message-1", "phase": "final_answer", "text": "Original."}]}}},
    ])
    blocked = []
    original_write = server.stdin.write

    def write_with_reset_attempt(packet):
        if json.loads(packet).get("method") == "turn/start":
            blocked.append(client.post(path, json={"revision": course["revision"]}).status_code)
        return original_write(packet)

    class Observer:
        def __call__(self, event, payload):
            pass

        def send_guard(self):
            return app.state.learning.tasks.conversations.send_guard()

    with patch.object(server.stdin, "write", side_effect=write_with_reset_attempt):
        reply, sent = execute(tmp_path / "ai-workspace", server, Observer())
    assert reply["text"] == "Original."
    assert blocked == [409]
    assert len([packet for packet in sent if packet.get("method") == "turn/start"]) == 1
    assert client.post(path, json={"revision": course["revision"]}).status_code == 200


def test_completed_final_item_is_used_without_joining_commentary_deltas(tmp_path: Path) -> None:
    messages = [
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}), rpc(3, {"turn": {"id": "turn-1"}}),
        {"method": "item/agentMessage/delta", "params": {
            "delta": "Commentary ", "itemId": "comment", "threadId": "thread-1", "turnId": "turn-1",
        }},
        {"method": "item/completed", "params": {
            "threadId": "thread-1", "turnId": "turn-1",
            "item": {"id": "comment", "type": "agentMessage", "phase": "commentary", "text": "Commentary"},
        }},
        {"method": "item/agentMessage/delta", "params": {
            "delta": '{"answer":42}', "itemId": "final", "threadId": "thread-1", "turnId": "turn-1",
        }},
        {"method": "item/completed", "params": {
            "threadId": "thread-1", "turnId": "turn-1",
            "item": {"id": "final", "type": "agentMessage", "phase": "final_answer", "text": '{"answer":42}'},
        }},
        {"method": "turn/completed", "params": {
            "threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed", "items": []},
        }},
    ]
    response, _ = execute(tmp_path, FakeAppServer(messages), lambda *_: None)
    assert response["text"] == '{"answer":42}'


@pytest.mark.parametrize(
    "notification",
    [
        {"threadId": "other-thread", "turnId": "turn-1", "delta": "x", "itemId": "i"},
        {"threadId": "thread-1", "turnId": "other-turn", "delta": "x", "itemId": "i"},
    ],
)
def test_stream_rejects_foreign_thread_or_turn_after_observing_raw_message(
    tmp_path: Path, notification
) -> None:
    server = FakeAppServer([
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}), rpc(3, {"turn": {"id": "turn-1"}}),
        {"method": "item/agentMessage/delta", "params": notification},
    ])
    observed = []
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="另一个(会话|轮次)"),
    ):
        CodexAI(tmp_path).ask("Exact prompt", observer=lambda *event: observed.append(event))
    raw = [payload for name, payload in observed if name == "stream/message"]
    assert raw and raw[-1]["params"] == notification
    assert "response/completed" not in [name for name, _ in observed]


def test_stream_rejects_ambiguous_delta_groups_without_final_marker(tmp_path: Path) -> None:
    server = FakeAppServer([
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}), rpc(3, {"turn": {"id": "turn-1"}}),
        {"method": "item/agentMessage/delta", "params": {"delta": "first", "itemId": "a", "turnId": "turn-1"}},
        {"method": "item/agentMessage/delta", "params": {"delta": "second", "itemId": "b", "turnId": "turn-1"}},
        {"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}},
    ])
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="多条助手消息"),
    ):
        CodexAI(tmp_path).ask("Exact prompt")


def test_observer_failure_prevents_turn_send(tmp_path: Path) -> None:
    server = FakeAppServer([rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}})])

    def fail(event, payload):
        if event == "thread/opened":
            raise OSError("persistence unavailable")

    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="thread/opened 阶段失败"),
    ):
        CodexAI(tmp_path).ask("Exact prompt", observer=fail)
    assert "turn/start" not in [json.loads(x).get("method") for x in server.stdin.getvalue().splitlines()]


def test_turn_sending_observer_failure_prevents_turn_start(tmp_path: Path) -> None:
    server = FakeAppServer([rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}})])

    def fail(event, payload):
        if event == "turn/sending":
            raise OSError("write-ahead log unavailable")

    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="turn/sending 阶段失败"),
    ):
        CodexAI(tmp_path).ask("Exact prompt", observer=fail)
    methods = [json.loads(line).get("method") for line in server.stdin.getvalue().splitlines()]
    assert "turn/start" not in methods


def test_observer_requires_turn_id_before_reporting_completion(tmp_path: Path) -> None:
    server = FakeAppServer([
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}), rpc(3, {}),
        {"method": "item/agentMessage/delta", "params": {"delta": "answer"}},
        {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
    ])
    observed = []
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="恢复所需的轮次 ID"),
    ):
        CodexAI(tmp_path).ask("Exact prompt", observer=lambda *event: observed.append(event))
    assert "response/completed" not in [event for event, _ in observed]


def test_metadata_failure_is_observed_and_generation_continues(tmp_path: Path) -> None:
    observed = []
    server = FakeAppServer([
        rpc(1, {}), rpc(2, {"thread": {"id": "thread-1"}}),
        {"id": 4, "error": {"code": -32000, "message": "metadata denied"}},
        rpc(3, {}),
        {"method": "item/agentMessage/delta", "params": {"delta": "ok", "turnId": "turn-1"}},
        {"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}},
    ])
    response, sent = execute(
        tmp_path, server, lambda *event: observed.append(event),
        conversation=ConversationIdentity("title", "group"),
    )
    assert response["text"] == "ok"
    assert any(event == "metadata/failed" for event, _ in observed)
    assert "turn/start" in [message.get("method") for message in sent]


def _turn(turn_id: str, prompt: str, status="completed", assistant="answer", tool=False):
    items = [{"id": f"u-{turn_id}", "type": "userMessage", "content": [{"type": "text", "text": prompt}]}]
    if tool:
        items.append({"id": "tool", "type": "commandExecution"})
    if assistant:
        items.append({"id": f"a-{turn_id}", "type": "agentMessage", "text": assistant})
    return {"id": turn_id, "status": status, "items": items}


def read_turn(tmp_path: Path, turns, **kwargs):
    server = FakeAppServer([rpc(1, {}), rpc(2, {"thread": {"id": "thread-1", "turns": turns}})])
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        result = CodexAI(tmp_path).read_turn("thread-1", **kwargs)
    methods = [json.loads(x).get("method") for x in server.stdin.getvalue().splitlines()]
    assert "thread/read" in methods
    assert "thread/start" not in methods and "thread/resume" not in methods
    assert "turn/start" not in methods
    return result


def test_read_turn_selects_by_explicit_id_and_returns_full_result(tmp_path: Path) -> None:
    turns = [_turn("old", "Exact prompt", assistant="old answer"), _turn("new", "different")]
    assert read_turn(tmp_path, turns, turn_id="old") == {
        "status": "completed", "thread_id": "thread-1", "turn_id": "old", "text": "old answer",
    }


def test_read_turn_does_not_create_a_working_directory(tmp_path: Path) -> None:
    missing = tmp_path / "absent"
    server = FakeAppServer([rpc(1, {}), rpc(2, {"thread": {"id": "thread-1", "turns": []}})])
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        with pytest.raises(AIError, match="唯一确定"):
            CodexAI(missing).read_turn("thread-1", turn_id="missing")
    assert not missing.exists()


def test_read_turn_uses_only_unique_exact_prompt(tmp_path: Path) -> None:
    assert read_turn(tmp_path, [_turn("only", "Exact prompt")], prompt="Exact prompt")["turn_id"] == "only"
    with pytest.raises(AIError, match="唯一确定"):
        read_turn(tmp_path, [_turn("a", "Exact prompt"), _turn("b", "Exact prompt")], prompt="Exact prompt")
    with pytest.raises(AIError, match="唯一确定"):
        read_turn(tmp_path, [_turn("a", "exact prompt")], prompt="Exact prompt")


@pytest.mark.parametrize(
    "turn,match",
    [
        (_turn("bad", "Exact prompt", status="inProgress"), None),
        (_turn("tool", "Exact prompt", tool=True), "含有工具调用"),
        (_turn("empty", "Exact prompt", assistant=""), "没有可恢复的最终"),
    ],
)
def test_read_turn_refuses_incomplete_or_unsafe_turns(tmp_path: Path, turn, match) -> None:
    if match:
        with pytest.raises(AIError, match=match):
            read_turn(tmp_path, [turn], turn_id=turn["id"])
    else:
        assert read_turn(tmp_path, [turn], turn_id=turn["id"])["status"] == "inProgress"


def test_read_turn_requires_full_item_view_and_prefers_declared_final(tmp_path: Path) -> None:
    turn = _turn("phased", "Exact prompt")
    turn["itemsView"] = "summary"
    with pytest.raises(AIError, match="摘要轮次"):
        read_turn(tmp_path, [turn], turn_id="phased")

    turn["itemsView"] = "full"
    turn["items"].extend([
        {"id": "c", "type": "agentMessage", "phase": "commentary", "text": "progress"},
        {"id": "f", "type": "agentMessage", "phase": "final_answer", "text": "final"},
    ])
    assert read_turn(tmp_path, [turn], turn_id="phased")["text"] == "final"
