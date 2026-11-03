import io
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.ai import AIError, CodexAI
from backend.conversation_identity import ConversationIdentity


class FakeAppServer:
    def __init__(self, messages: list[dict[str, object]]) -> None:
        self.stdin = _CapturedInput()
        self.stdout = io.BytesIO(
            b"".join(json.dumps(message).encode("utf-8") + b"\n" for message in messages)
        )
        self.stderr = io.BytesIO(b"")
        self.returncode: int | None = None

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        self.returncode = self.returncode or 0
        return self.returncode


class _CapturedInput(io.BytesIO):
    def close(self) -> None:
        self.saved = self.getvalue()
        super().close()

    def getvalue(self) -> bytes:
        if self.closed:
            return self.saved
        return super().getvalue()


def _rpc_reply(request_id: int, result: dict[str, object]) -> dict[str, object]:
    return {"id": request_id, "result": result}


def _messages(
    *, tool_item: bool = False, status: str = "completed", thread_id: str = "thread-123",
) -> list[dict[str, object]]:
    events: list[dict[str, object]] = [
        _rpc_reply(1, {}),
        _rpc_reply(2, {"thread": {"id": thread_id}}),
        _rpc_reply(3, {}),
    ]
    if tool_item:
        events.append({"method": "item/started", "params": {"item": {"type": "commandExecution"}}})
    else:
        events.append(
            {
                "method": "item/agentMessage/delta",
                "params": {
                    "delta": "A concise answer.",
                    "itemId": "item-1",
                    "threadId": thread_id,
                    "turnId": "turn-1",
                },
            }
        )
    events.append(
        {
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {"id": "turn-1", "status": status}},
        }
    )
    return events


def _run_with_messages(
    tmp_path: Path,
    messages: list[dict[str, object]],
    *,
    thread_id: str | None = None,
    model: str = "",
    effort: str = "medium",
    schema: dict[str, object] | None = None,
    images: list[Path] | None = None,
    conversation: ConversationIdentity | None = None,
) -> tuple[dict[str, str] | None, FakeAppServer, list[str], dict[str, object]]:
    server = FakeAppServer(messages)
    captured: dict[str, object] = {}

    def launch(command: list[str], **kwargs: object) -> FakeAppServer:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return server

    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", side_effect=launch),
    ):
        response = CodexAI(tmp_path, model=model, effort=effort).ask(
            "Explain this material.", thread_id=thread_id, schema=schema, images=images,
            conversation=conversation,
        )
    sent = [json.loads(line) for line in server.stdin.getvalue().splitlines()]
    return response, server, sent, captured


def test_ask_starts_isolated_read_only_thread_and_returns_real_stream(tmp_path: Path) -> None:
    response, _, sent, captured = _run_with_messages(
        tmp_path,
        _messages(),
        schema={"type": "object", "properties": {"answer": {"type": "string"}}},
    )

    assert response == {"text": "A concise answer.", "thread_id": "thread-123"}
    assert captured["command"][-2:] == ["-c", "mcp_servers={}"]
    assert captured["kwargs"]["shell"] is False
    assert captured["kwargs"]["cwd"] == tmp_path.resolve()
    start = next(message for message in sent if message.get("method") == "thread/start")
    turn = next(message for message in sent if message.get("method") == "turn/start")
    assert start["params"]["sandbox"] == "read-only"
    assert start["params"]["approvalPolicy"] == "untrusted"
    assert start["params"]["config"] == {"mcp_servers": {}}
    assert "model" not in start["params"]
    assert turn["params"]["effort"] == "medium"
    assert turn["params"]["outputSchema"]["type"] == "object"
    assert turn["params"]["sandboxPolicy"] == {"type": "readOnly", "networkAccess": False}


def test_ask_resumes_saved_thread_and_attaches_image(tmp_path: Path) -> None:
    image = tmp_path.parent / "diagram.png"
    image.write_bytes(b"image")
    response, _, sent, _ = _run_with_messages(
        tmp_path,
        _messages(thread_id="thread-existing"),
        thread_id="thread-existing",
        model="gpt-6.1-terra",
        effort="high",
        images=[image],
    )

    assert response == {"text": "A concise answer.", "thread_id": "thread-existing"}
    resume = next(message for message in sent if message.get("method") == "thread/resume")
    turn = next(message for message in sent if message.get("method") == "turn/start")
    assert resume["params"]["threadId"] == "thread-existing"
    assert resume["params"]["sandbox"] == "read-only"
    assert resume["params"]["approvalPolicy"] == "untrusted"
    assert resume["params"]["model"] == "gpt-6.1-terra"
    assert turn["params"]["effort"] == "high"
    assert turn["params"]["input"][-1] == {"type": "localImage", "path": str(image.resolve())}


def test_resume_returning_another_thread_rejects_before_sending_a_turn(tmp_path: Path) -> None:
    server = FakeAppServer(_messages())
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="resumed a different thread"),
    ):
        CodexAI(tmp_path).ask("Continue this topic.", thread_id="thread-existing")
    sent = [json.loads(line) for line in server.stdin.getvalue().splitlines()]
    assert not any(message.get("method") == "turn/start" for message in sent)


def test_ask_stops_if_app_server_emits_tool_item(tmp_path: Path) -> None:
    server = FakeAppServer(_messages(tool_item=True))
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="attempted to use a tool"),
    ):
        CodexAI(tmp_path).ask("Answer without using tools.")
    assert server.returncode == 0


def test_ask_cancels_approval_request_before_aborting(tmp_path: Path) -> None:
    server = FakeAppServer(
        [
            _rpc_reply(1, {}),
            _rpc_reply(2, {"thread": {"id": "thread-123"}}),
            {"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": {}},
        ]
    )
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="tool or approval"),
    ):
        CodexAI(tmp_path).ask("Answer without using tools.")

    replies = [json.loads(line) for line in server.stdin.getvalue().splitlines()]
    assert {"id": "approval-1", "result": {"decision": "cancel"}} in replies
    assert server.returncode == 0


def test_ask_rejects_noncompleted_turn(tmp_path: Path) -> None:
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=FakeAppServer(_messages(status="failed"))),
        pytest.raises(AIError, match="turn failed"),
    ):
        CodexAI(tmp_path).ask("Explain this material.")


def test_ask_rejects_nonempty_working_directory_before_launch(tmp_path: Path) -> None:
    (tmp_path / "course.txt").write_text("private course material", encoding="utf-8")
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen") as launch,
        pytest.raises(AIError, match="dedicated empty"),
    ):
        CodexAI(tmp_path).ask("Explain this material.")
    launch.assert_not_called()


def test_app_server_is_stopped_after_request(tmp_path: Path) -> None:
    server = FakeAppServer(_messages())
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        CodexAI(tmp_path).ask("Explain this material.")
    assert server.stdin.closed


def test_ask_creates_course_section_and_names_thread_before_turn(tmp_path: Path) -> None:
    messages = [
        _rpc_reply(1, {}),
        _rpc_reply(2, {"thread": {"id": "thread-123"}}),
        _rpc_reply(4, {}),
        _rpc_reply(5, {"data": [], "nextCursor": None}),
        _rpc_reply(6, {"section": {"id": "section-course"}}),
        _rpc_reply(7, {}),
        _rpc_reply(3, {}),
        {"method": "item/agentMessage/delta", "params": {"delta": "Organized."}},
        {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
    ]
    response, _, sent, _ = _run_with_messages(
        tmp_path,
        messages,
        conversation=ConversationIdentity("COMP4418｜Bayes nets", "COMP4418"),
    )

    assert response == {"text": "Organized.", "thread_id": "thread-123"}
    metadata = [
        message for message in sent
        if message.get("method") in {
            "thread/name/set", "threadSection/list", "threadSection/create", "thread/section/move",
        }
    ]
    assert [(message["method"], message["params"]) for message in metadata] == [
        ("thread/name/set", {"threadId": "thread-123", "name": "COMP4418｜Bayes nets"}),
        ("threadSection/list", {}),
        ("threadSection/create", {"name": "COMP4418"}),
        ("thread/section/move", {"threadId": "thread-123", "sectionId": "section-course"}),
    ]
    assert all(message.get("id", 0) >= 4 for message in metadata)
    assert [message["method"] for message in sent if message.get("id") == 3] == ["turn/start"]


def test_resume_reuses_section_from_later_page_and_organizes_existing_thread(tmp_path: Path) -> None:
    messages = [
        _rpc_reply(1, {}),
        _rpc_reply(2, {"thread": {"id": "thread-existing"}}),
        _rpc_reply(4, {}),
        _rpc_reply(5, {"data": [], "nextCursor": "page-2"}),
        _rpc_reply(6, {
            "data": [{"id": "section-course", "name": "COMP4418"}],
            "nextCursor": None,
        }),
        _rpc_reply(7, {}),
        _rpc_reply(3, {}),
        {"method": "item/agentMessage/delta", "params": {"delta": "Continued."}},
        {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
    ]
    response, _, sent, _ = _run_with_messages(
        tmp_path,
        messages,
        thread_id="thread-existing",
        conversation=ConversationIdentity("COMP4418｜Bayes nets", "COMP4418"),
    )

    assert response == {"text": "Continued.", "thread_id": "thread-existing"}
    methods = [message.get("method") for message in sent]
    assert methods.count("thread/resume") == 1
    assert "thread/start" not in methods
    assert "threadSection/create" not in methods
    assert methods.index("thread/section/move") < methods.index("turn/start")
    page_calls = [message for message in sent if message.get("method") == "threadSection/list"]
    assert [message["params"] for message in page_calls] == [{}, {"cursor": "page-2"}]
    moved = next(message for message in sent if message.get("method") == "thread/section/move")
    assert moved["params"] == {"threadId": "thread-existing", "sectionId": "section-course"}


def test_organize_thread_only_updates_metadata_without_opening_or_generating(tmp_path: Path) -> None:
    server = FakeAppServer([
        _rpc_reply(1, {}),
        _rpc_reply(4, {}),
        _rpc_reply(5, {"data": [{"id": "section-course", "name": "COMP4418"}], "nextCursor": None}),
        _rpc_reply(6, {}),
    ])
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
    ):
        CodexAI(tmp_path).organize_thread(
            "thread-known", ConversationIdentity("COMP4418｜Bayes nets", "COMP4418")
        )

    sent = [json.loads(line) for line in server.stdin.getvalue().splitlines()]
    methods = [message.get("method") for message in sent]
    assert "thread/start" not in methods
    assert "thread/resume" not in methods
    assert "turn/start" not in methods
    assert [message["method"] for message in sent if message.get("id", 0) >= 4] == [
        "thread/name/set", "threadSection/list", "thread/section/move",
    ]


def test_ask_fails_clearly_when_thread_metadata_update_fails(tmp_path: Path) -> None:
    server = FakeAppServer([
        _rpc_reply(1, {}),
        _rpc_reply(2, {"thread": {"id": "thread-123"}}),
        {"id": 4, "error": {"code": -32000, "message": "write denied"}},
    ])
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen", return_value=server),
        pytest.raises(AIError, match="thread metadata operation thread/name/set failed"),
    ):
        CodexAI(tmp_path).ask(
            "Explain this material.",
            conversation=ConversationIdentity("COMP4418｜Bayes nets", "COMP4418"),
        )

    sent = [json.loads(line) for line in server.stdin.getvalue().splitlines()]
    assert "turn/start" not in [message.get("method") for message in sent]


@pytest.mark.parametrize(
    ("title", "group", "message"),
    [
        (" ", "COMP4418", "title must not be empty"),
        ("x" * 501, "COMP4418", "title must be at most 500"),
        ("Bayes nets", " ", "group must not be empty"),
        ("Bayes nets", "x" * 251, "group must be at most 250"),
    ],
)
def test_ask_validates_conversation_metadata_before_launch(
    tmp_path: Path, title: str, group: str, message: str
) -> None:
    with (
        patch("backend.codex_installation.shutil.which", return_value="codex.exe"),
        patch("backend.ai.subprocess.Popen") as launch,
        pytest.raises(AIError, match=message),
    ):
        CodexAI(tmp_path).ask(
            "Explain this material.", conversation=ConversationIdentity(title, group)
        )
    launch.assert_not_called()
