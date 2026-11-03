"""Synchronous Codex app-server adapter for isolated learning conversations."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .codex_installation import codex_executable
from .conversation_identity import ConversationIdentity

_TIMEOUT_SECONDS = 180
_MAX_STDOUT_LINE = 2 * 1024 * 1024
_MAX_OUTPUT_CHARS = 1_000_000
_MAX_STDERR_BYTES = 8_192
_SAFE_ITEM_TYPES = {"agentMessage", "reasoning", "plan", "userMessage"}
_NO_TOOLS_INSTRUCTIONS = (
    "Answer using conversation context only. Do not use tools, execute commands, "
    "read or write files, invoke MCP servers, or delegate work. If a tool seems "
    "necessary, explain that you cannot use it and answer without it."
)


class AIUnavailable(RuntimeError):
    """Raised when Codex app-server is not installed or cannot start."""


class AIError(RuntimeError):
    """Raised when a Codex request fails or violates the adapter's safety rules."""


@dataclass(frozen=True)
class _AIRequest:
    prompt: str
    thread_id: str | None
    schema: dict[str, Any] | None
    images: list[Path]
    conversation: ConversationIdentity | None


class _StderrBuffer:
    def __init__(self) -> None:
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> None:
        with self._lock:
            self._chunks.append(chunk)
            self._size += len(chunk)
            while self._size > _MAX_STDERR_BYTES:
                self._size -= len(self._chunks.popleft())

    def text(self) -> str:
        with self._lock:
            raw = b"".join(self._chunks)
        return raw.decode("utf-8", errors="replace")[-_MAX_STDERR_BYTES:]


class _AppServerSession:
    def __init__(
        self,
        process: subprocess.Popen[bytes],
        incoming: queue.Queue[bytes | BaseException],
        deadline: float,
    ) -> None:
        self.process = process
        self.incoming = incoming
        self.deadline = deadline

    def send(self, message: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise AIUnavailable("Codex app-server stdin is unavailable.")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        self.process.stdin.write(encoded.encode("utf-8") + b"\n")
        self.process.stdin.flush()

    def request(self, request_id: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            message = self.next_message()
            if message.get("id") == request_id and ("result" in message or "error" in message):
                if "error" in message:
                    raise AIError(f"Codex {method} failed: {_error_message(message['error'])}")
                response = message["result"]
                if not isinstance(response, dict):
                    raise AIError(f"Codex {method} returned an invalid response.")
                return response
            if "id" in message and "method" in message:
                self.reject_server_request(message)

    def collect_turn(self, request_id: int) -> str:
        fragments: list[str] = []
        output_chars = 0
        while True:
            message = self.next_message()
            method = message.get("method")
            params = message.get("params") or {}
            if "id" in message and method:
                self.reject_server_request(message)
            if method == "item/agentMessage/delta":
                output_chars = self.append_delta(params.get("delta"), fragments, output_chars)
            elif method in {"item/started", "item/completed"}:
                self.validate_item(params.get("item") or {})
            elif method == "turn/completed":
                return self.completed_text(params.get("turn") or {}, fragments)
            if message.get("id") == request_id and "error" in message:
                raise AIError(f"Codex turn failed: {_error_message(message['error'])}")

    def next_message(self) -> dict[str, Any]:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AIError("Codex app-server timed out after 180 seconds.")
        try:
            line = self.incoming.get(timeout=remaining)
        except queue.Empty as exc:
            raise AIError("Codex app-server timed out after 180 seconds.") from exc
        if isinstance(line, BaseException):
            raise line
        message = json.loads(line.decode("utf-8"))
        if not isinstance(message, dict):
            raise AIError("Codex app-server sent an invalid protocol message.")
        return message

    def reject_server_request(self, request: dict[str, Any]) -> None:
        method = request.get("method", "")
        response = _rejection_for(method)
        if response is None:
            self.send({"id": request.get("id"), "error": {
                "code": -32601, "message": "Approval and tool requests are disabled."}
            })
        else:
            self.send({"id": request["id"], "result": response})
        raise AIError("Codex requested a tool or approval; the turn was stopped.")

    @staticmethod
    def append_delta(delta: Any, fragments: list[str], output_chars: int) -> int:
        if not isinstance(delta, str):
            raise AIError("Codex returned an invalid message fragment.")
        output_chars += len(delta)
        if output_chars > _MAX_OUTPUT_CHARS:
            raise AIError("Codex response exceeded the output limit.")
        fragments.append(delta)
        return output_chars

    @staticmethod
    def validate_item(item: dict[str, Any]) -> None:
        if item.get("type") not in _SAFE_ITEM_TYPES:
            raise AIError("Codex attempted to use a tool; the turn was stopped.")

    @staticmethod
    def completed_text(turn: dict[str, Any], fragments: list[str]) -> str:
        if turn.get("status") != "completed":
            raise AIError(f"Codex turn {turn.get('status', 'failed')}.")
        response = "".join(fragments).strip()
        if not response:
            raise AIError("Codex completed without an assistant message.")
        return response


class CodexAI:
    def __init__(self, working_dir: Path, model: str = "", effort: str = "medium") -> None:
        self.working_dir = Path(working_dir).expanduser().resolve()
        self.model = model.strip()
        if effort not in {"low", "medium", "high"}:
            raise AIError("推理力度必须为 low、medium 或 high。")
        self.effort = effort

    def available(self) -> dict[str, Any]:
        executable = codex_executable()
        if executable is None:
            return {"available": False, "reason": "未找到 Codex：已检查命令路径和本机 Codex 桌面版安装目录。"}
        try:
            completed = subprocess.run(
                [executable, "app-server", "--help"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return {"available": False, "reason": "已找到 Codex，但无法运行 app-server 检查；请确认安装和本机权限。"}
        if completed.returncode != 0:
            return {"available": False, "reason": "Codex 的 app-server 检查未通过，请更新或修复本机 Codex。"}
        return {"available": True}

    # Override the Clean Code argument limit to preserve keywords and add identity; revisit if options grow.
    def ask(
        self,
        prompt: str,
        *,
        thread_id: str | None = None,
        schema: dict[str, Any] | None = None,
        images: list[Path] | None = None,
        conversation: ConversationIdentity | None = None,
    ) -> dict[str, str]:
        request = self._validated_request(
            _AIRequest(prompt, thread_id, schema, images or [], conversation)
        )
        stderr_buffer = _StderrBuffer()
        try:
            executable = self._codex_executable()
            self._prepare_working_dir()
            return self._run_request(executable, request, stderr_buffer)
        except AIError:
            raise
        except (OSError, EOFError, UnicodeError, json.JSONDecodeError, TypeError) as exc:
            raise self._communication_error(stderr_buffer) from exc

    def organize_thread(self, thread_id: str, conversation: ConversationIdentity) -> None:
        """Set thread title and course section without resuming or generating a turn."""
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise AIError("Codex thread ID must not be empty.")
        identity = _validated_conversation(conversation)
        stderr_buffer = _StderrBuffer()
        try:
            executable = self._codex_executable()
            self._prepare_working_dir()
            self._run_organization(executable, thread_id, identity, stderr_buffer)
        except AIError:
            raise
        except (OSError, EOFError, UnicodeError, json.JSONDecodeError, TypeError) as exc:
            raise self._communication_error(stderr_buffer) from exc

    def _run_organization(
        self,
        executable: str,
        thread_id: str,
        conversation: ConversationIdentity,
        stderr_buffer: _StderrBuffer,
    ) -> None:
        process: subprocess.Popen[bytes] | None = None
        try:
            process, incoming = _start_process(executable, self.working_dir, stderr_buffer)
            session = _AppServerSession(process, incoming, time.monotonic() + _TIMEOUT_SECONDS)
            self._initialize_session(session)
            self._organize_thread(session, thread_id, conversation, 4)
        finally:
            if process is not None:
                _stop_process(process)

    @staticmethod
    def _initialize_session(session: _AppServerSession) -> None:
        session.request(1, "initialize", {
            "clientInfo": {"name": "learning_map", "title": "Learning Map", "version": "1.0"}
        })
        session.send({"method": "initialized"})

    @staticmethod
    def _codex_executable() -> str:
        executable = codex_executable()
        if executable is None:
            raise AIUnavailable("未找到 Codex：请确认本机已安装 Codex 桌面版或 CLI。")
        return executable

    @staticmethod
    def _communication_error(buffer: _StderrBuffer) -> AIUnavailable:
        detail = buffer.text().strip()
        message = "Codex app-server communication failed."
        if detail:
            message = f"{message} {detail[-2_000:]}"
        return AIUnavailable(message)

    def _run_request(
        self, executable: str, request: _AIRequest, stderr_buffer: _StderrBuffer
    ) -> dict[str, str]:
        process: subprocess.Popen[bytes] | None = None
        try:
            process, incoming = _start_process(executable, self.working_dir, stderr_buffer)
            return self._exchange(process, incoming, request)
        finally:
            if process is not None:
                _stop_process(process)

    def _exchange(
        self,
        process: subprocess.Popen[bytes],
        incoming: queue.Queue[bytes | BaseException],
        request: _AIRequest,
    ) -> dict[str, str]:
        session = _AppServerSession(process, incoming, time.monotonic() + _TIMEOUT_SECONDS)
        self._initialize_session(session)
        thread_id = self._open_thread(session, request.thread_id)
        if request.conversation is not None:
            self._organize_thread(session, thread_id, request.conversation, 4)
        text = self._start_turn(session, thread_id, request)
        return {"text": text, "thread_id": thread_id}

    def _organize_thread(
        self,
        session: _AppServerSession,
        thread_id: str,
        conversation: ConversationIdentity,
        request_id: int,
    ) -> None:
        self._metadata_request(session, request_id, "thread/name/set", {
            "threadId": thread_id,
            "name": conversation.title,
        })
        request_id += 1
        section_id, request_id = self._find_or_create_section(
            session, conversation.group, request_id
        )
        self._metadata_request(session, request_id, "thread/section/move", {
            "threadId": thread_id,
            "sectionId": section_id,
        })

    @staticmethod
    def _metadata_request(
        session: _AppServerSession,
        request_id: int,
        method: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            return session.request(request_id, method, params)
        except AIError as exc:
            raise AIError(f"Codex thread metadata operation {method} failed: {exc}") from exc

    def _find_or_create_section(
        self, session: _AppServerSession, group: str, request_id: int
    ) -> tuple[str, int]:
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            sections, next_cursor, request_id = self._list_section_page(
                session, request_id, cursor
            )
            section_id = self._matching_section_id(sections, group)
            if section_id is not None:
                return section_id, request_id
            if next_cursor is None:
                return self._create_section(session, group, request_id)
            cursor = self._validated_section_cursor(next_cursor, seen_cursors)

    @staticmethod
    def _validated_section_cursor(next_cursor: str, seen_cursors: set[str]) -> str:
        if not next_cursor or next_cursor in seen_cursors:
            raise AIError("Codex threadSection/list returned an invalid pagination cursor.")
        seen_cursors.add(next_cursor)
        return next_cursor

    def _create_section(
        self, session: _AppServerSession, group: str, request_id: int
    ) -> tuple[str, int]:
        created = self._metadata_request(
            session, request_id, "threadSection/create", {"name": group}
        )
        section = created.get("section")
        section_id = section.get("id") if isinstance(section, dict) else None
        if not isinstance(section_id, str) or not section_id:
            raise AIError("Codex threadSection/create returned a section without an ID.")
        return section_id, request_id + 1

    def _list_section_page(
        self, session: _AppServerSession, request_id: int, cursor: str | None
    ) -> tuple[list[Any], str | None, int]:
        params = {"cursor": cursor} if cursor is not None else {}
        page = self._metadata_request(session, request_id, "threadSection/list", params)
        sections, next_cursor = page.get("data"), page.get("nextCursor")
        if not isinstance(sections, list):
            raise AIError("Codex threadSection/list returned invalid section data.")
        if next_cursor is not None and not isinstance(next_cursor, str):
            raise AIError("Codex threadSection/list returned an invalid pagination cursor.")
        return sections, next_cursor, request_id + 1

    @staticmethod
    def _matching_section_id(sections: list[Any], group: str) -> str | None:
        for section in sections:
            if not isinstance(section, dict):
                raise AIError("Codex threadSection/list returned an invalid section.")
            if section.get("name") == group:
                section_id = section.get("id")
                if not isinstance(section_id, str) or not section_id:
                    raise AIError("Codex returned a matching section without an ID.")
                return section_id
        return None

    def _open_thread(self, session: _AppServerSession, thread_id: str | None) -> str:
        method = "thread/resume" if thread_id else "thread/start"
        params = self._thread_params(thread_id)
        thread = session.request(2, method, params).get("thread") or {}
        actual_thread_id = thread.get("id")
        if not isinstance(actual_thread_id, str) or not actual_thread_id:
            raise AIError("Codex did not return a thread ID.")
        return actual_thread_id

    def _thread_params(self, thread_id: str | None) -> dict[str, Any]:
        params: dict[str, Any] = {
            "cwd": str(self.working_dir),
            "sandbox": "read-only",
            "approvalPolicy": "untrusted",
            "developerInstructions": _NO_TOOLS_INSTRUCTIONS,
            "config": {"mcp_servers": {}},
        }
        if thread_id:
            params["threadId"] = thread_id
        if self.model:
            params["model"] = self.model
        return params

    def _start_turn(self, session: _AppServerSession, thread_id: str, request: _AIRequest) -> str:
        user_input: list[dict[str, Any]] = [{"type": "text", "text": request.prompt}]
        user_input.extend({"type": "localImage", "path": str(path)} for path in request.images)
        turn_params: dict[str, Any] = {
            "threadId": thread_id,
            "input": user_input,
            "effort": self.effort,
            "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
        }
        if request.schema is not None:
            turn_params["outputSchema"] = request.schema
        session.send({"id": 3, "method": "turn/start", "params": turn_params})
        return session.collect_turn(3)

    @staticmethod
    def _validated_request(request: _AIRequest) -> _AIRequest:
        if not isinstance(request.prompt, str) or not request.prompt.strip():
            raise AIError("AI prompt must not be empty.")
        if request.schema is not None and not isinstance(request.schema, dict):
            raise AIError("Structured output schema must be a JSON object.")
        try:
            json.dumps(request.schema)
        except (TypeError, ValueError) as exc:
            raise AIError("Structured output schema must contain JSON values only.") from exc
        conversation = (
            _validated_conversation(request.conversation)
            if request.conversation is not None
            else None
        )
        return _AIRequest(
            request.prompt,
            request.thread_id,
            request.schema,
            CodexAI._validated_images(request.images),
            conversation,
        )

    @staticmethod
    def _validated_images(images: list[Path]) -> list[Path]:
        paths: list[Path] = []
        for image in images:
            path = Path(image).expanduser().resolve()
            if not path.is_file():
                raise AIError(f"Image input is not a file: {path.name}")
            paths.append(path)
        return paths

    def _prepare_working_dir(self) -> None:
        try:
            self.working_dir.mkdir(parents=True, exist_ok=True)
            if not self.working_dir.is_dir() or any(self.working_dir.iterdir()):
                raise AIError("Codex requires a dedicated empty working directory.")
        except OSError as exc:
            raise AIError("Codex working directory is unavailable.") from exc


def _start_process(
    executable: str, working_dir: Path, stderr_buffer: _StderrBuffer
) -> tuple[subprocess.Popen[bytes], queue.Queue[bytes | BaseException]]:
    command = [executable, "app-server", "--listen", "stdio://", "-c", "mcp_servers={}"]
    process = subprocess.Popen(
        command,
        cwd=working_dir,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
        shell=False,
        env=os.environ.copy(),
    )
    incoming: queue.Queue[bytes | BaseException] = queue.Queue(maxsize=16)
    threading.Thread(target=_read_stdout, args=(process, incoming), daemon=True).start()
    threading.Thread(target=_read_stderr, args=(process, stderr_buffer), daemon=True).start()
    return process, incoming


def _read_stdout(
    process: subprocess.Popen[bytes], incoming: queue.Queue[bytes | BaseException]
) -> None:
    assert process.stdout is not None
    try:
        while True:
            line = process.stdout.readline(_MAX_STDOUT_LINE + 1)
            if not line:
                incoming.put(EOFError("Codex app-server closed stdout."))
                return
            if len(line) > _MAX_STDOUT_LINE:
                incoming.put(AIError("Codex app-server sent an oversized protocol message."))
                return
            incoming.put(line)
    except (OSError, ValueError) as exc:
        incoming.put(exc)


def _read_stderr(process: subprocess.Popen[bytes], buffer: _StderrBuffer) -> None:
    assert process.stderr is not None
    try:
        while True:
            chunk = process.stderr.read(1_024)
            if not chunk:
                return
            buffer.append(chunk)
    except (OSError, ValueError):
        return


def _rejection_for(method: str) -> dict[str, str] | None:
    if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
        return {"decision": "cancel"}
    if method == "mcpServer/elicitation/request":
        return {"action": "cancel"}
    if method == "item/tool/requestUserInput":
        return {"answers": []}
    return None


def _error_message(error: Any) -> str:
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"][:2_000]
    return "invalid protocol response"


def _validated_conversation(conversation: ConversationIdentity) -> ConversationIdentity:
    if not isinstance(conversation, ConversationIdentity):
        raise AIError("Conversation identity must contain a course group and thread title.")
    if not isinstance(conversation.title, str) or not conversation.title.strip():
        raise AIError("Conversation title must not be empty.")
    if len(conversation.title) > 500:
        raise AIError("Conversation title must be at most 500 characters.")
    if not isinstance(conversation.group, str) or not conversation.group.strip():
        raise AIError("Conversation group must not be empty.")
    if len(conversation.group) > 250:
        raise AIError("Conversation group must be at most 250 characters.")
    return conversation


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.stdin is not None:
        try:
            process.stdin.close()
        except OSError:
            pass
    try:
        _terminate_process(process)
    except OSError:
        pass
    finally:
        _close_process_streams(process)


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired as exc:
            raise AIUnavailable("Codex app-server did not stop after termination.") from exc


def _close_process_streams(process: subprocess.Popen[bytes]) -> None:
    for stream in (process.stdout, process.stderr):
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass
