"""Synchronous Codex app-server adapter for isolated learning conversations."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from contextlib import nullcontext
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
    observer: Callable[[str, dict[str, Any]], None] | None


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
            raise AIUnavailable("Codex app-server 的输入通道不可用。")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        self.process.stdin.write(encoded.encode("utf-8") + b"\n")
        self.process.stdin.flush()

    def request(self, request_id: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            message = self.next_message()
            if message.get("id") == request_id and ("result" in message or "error" in message):
                if "error" in message:
                    raise AIError(f"Codex {method} 失败：{_error_message(message['error'])}")
                response = message["result"]
                if not isinstance(response, dict):
                    raise AIError(f"Codex {method} 返回了无效响应。")
                return response
            if "id" in message and "method" in message:
                self.reject_server_request(message)

    def collect_turn(
        self,
        request_id: int,
        observer: Callable[[str, dict[str, Any]], None] | None,
        thread_id: str,
    ) -> tuple[str, str | None]:
        fragments_by_item: dict[str, list[str]] = {}
        unkeyed_fragments: list[str] = []
        completed_messages: list[dict[str, Any]] = []
        output_chars = 0
        turn_id: str | None = None
        while True:
            message = self.next_message()
            method = message.get("method")
            if message.get("id") == request_id and "result" in message:
                result = message.get("result") or {}
                result_turn = result.get("turn") if isinstance(result, dict) else None
                turn_id = _identify_turn(
                    result_turn.get("id") if isinstance(result_turn, dict) else None,
                    None,
                    thread_id,
                    turn_id,
                    observer,
                )
                continue
            if method:
                _observe(observer, "stream/message", message)
            params = message.get("params") or {}
            if not isinstance(params, dict):
                raise AIError("Codex app-server 发送了无效的通知参数。")
            turn = params.get("turn")
            turn = turn if isinstance(turn, dict) else {}
            candidate = _notification_turn_id(params, turn)
            turn_id = _identify_turn(candidate, params.get("threadId"), thread_id, turn_id, observer)
            if "id" in message and method:
                self.reject_server_request(message)
            if method == "item/agentMessage/delta":
                delta = params.get("delta")
                item_id = params.get("itemId")
                if not isinstance(delta, str):
                    raise AIError("Codex 返回了无效的消息片段。")
                target = fragments_by_item.setdefault(item_id, []) if isinstance(item_id, str) and item_id else unkeyed_fragments
                output_chars = self.append_delta(delta, target, output_chars)
            elif method in {"item/started", "item/completed"}:
                item = params.get("item") or {}
                self.validate_item(item)
                if method == "item/completed" and item.get("type") == "agentMessage":
                    completed_messages.append(item)
            elif method == "turn/completed":
                if not isinstance(turn, dict):
                    raise AIError("Codex 返回了无效的已完成轮次。")
                return _completed_turn_text(
                    turn, completed_messages, fragments_by_item, unkeyed_fragments
                ), turn_id
            if message.get("id") == request_id and "error" in message:
                raise AIError(f"Codex 本轮失败：{_error_message(message['error'])}")

    def next_message(self) -> dict[str, Any]:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AIError(f"Codex app-server 超过 {_TIMEOUT_SECONDS} 秒未完成。")
        try:
            line = self.incoming.get(timeout=remaining)
        except queue.Empty as exc:
            raise AIError(f"Codex app-server 超过 {_TIMEOUT_SECONDS} 秒未完成。") from exc
        if isinstance(line, BaseException):
            raise line
        message = json.loads(line.decode("utf-8"))
        if not isinstance(message, dict):
            raise AIError("Codex app-server 发送了无效的协议消息。")
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
        raise AIError("Codex 请求使用工具或审批，本轮已停止。")

    @staticmethod
    def append_delta(delta: Any, fragments: list[str], output_chars: int) -> int:
        if not isinstance(delta, str):
            raise AIError("Codex 返回了无效的消息片段。")
        output_chars += len(delta)
        if output_chars > _MAX_OUTPUT_CHARS:
            raise AIError("Codex 回复超过输出长度上限。")
        fragments.append(delta)
        return output_chars

    @staticmethod
    def validate_item(item: dict[str, Any]) -> None:
        if not isinstance(item, dict) or item.get("type") not in _SAFE_ITEM_TYPES:
            raise AIError("Codex 尝试使用工具，本轮已停止。")

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
        observer: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> dict[str, str]:
        request = self._validated_request(
            _AIRequest(prompt, thread_id, schema, images or [], conversation, observer)
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

    def read_turn(
        self, thread_id: str, turn_id: str | None = None, prompt: str | None = None
    ) -> dict[str, str]:
        """Read an existing turn by exact ID, or by a unique exact user prompt."""
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise AIError("会话 ID 不能为空。")
        if turn_id is not None and (not isinstance(turn_id, str) or not turn_id.strip()):
            raise AIError("轮次 ID 不能为空。")
        if turn_id is None and (not isinstance(prompt, str) or not prompt):
            raise AIError("未提供轮次 ID 时必须提供原始提示词。")
        executable = self._codex_executable()
        stderr_buffer = _StderrBuffer()
        return _read_turn_request(
            executable, self.working_dir, thread_id, turn_id, prompt, stderr_buffer
        )

    def organize_thread(self, thread_id: str, conversation: ConversationIdentity) -> str:
        """Set thread title and course section without resuming or generating a turn."""
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise AIError("Codex 会话 ID 不能为空。")
        identity = _validated_conversation(conversation)
        stderr_buffer = _StderrBuffer()
        try:
            executable = self._codex_executable()
            self._prepare_working_dir()
            return self._run_organization(executable, thread_id, identity, stderr_buffer)
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
    ) -> str:
        process: subprocess.Popen[bytes] | None = None
        try:
            process, incoming = _start_process(executable, self.working_dir, stderr_buffer)
            session = _AppServerSession(process, incoming, time.monotonic() + _TIMEOUT_SECONDS)
            self._initialize_session(session)
            return self._organize_thread(session, thread_id, conversation, 4)
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
        _observe(request.observer, "thread/opened", {"thread_id": thread_id})
        if request.conversation is not None:
            try:
                section_id = self._organize_thread(session, thread_id, request.conversation, 4)
                _observe(request.observer, "metadata/organized", {"section_id": section_id})
            except AIError as exc:
                if request.observer is None:
                    raise
                _observe(request.observer, "metadata/failed", {
                    "thread_id": thread_id, "error": str(exc),
                })
        text, turn_id = self._start_turn(session, thread_id, request)
        if request.observer is not None and turn_id is None:
            raise AIError("Codex 已完成，但没有返回恢复所需的轮次 ID。")
        _observe(request.observer, "response/completed", {
            "text": text, "thread_id": thread_id, "turn_id": turn_id,
        })
        result = {"text": text, "thread_id": thread_id}
        if request.observer is not None and turn_id is not None:
            result["turn_id"] = turn_id
        return result

    def _organize_thread(
        self,
        session: _AppServerSession,
        thread_id: str,
        conversation: ConversationIdentity,
        request_id: int,
    ) -> str:
        self._metadata_request(session, request_id, "thread/name/set", {
            "threadId": thread_id,
            "name": conversation.title,
        })
        request_id += 1
        section_id = conversation.native_section_id
        if section_id is None:
            section_id, request_id = self._find_or_create_section(session, conversation.group, request_id)
        self._metadata_request(session, request_id, "thread/section/move", {
            "threadId": thread_id,
            "sectionId": section_id,
        })
        return section_id

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
            raise AIError(f"Codex 会话元数据操作 {method} 失败：{exc}") from exc

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
            raise AIError("Codex threadSection/list 返回了无效的分页游标。")
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
            raise AIError("Codex threadSection/create 返回的分组没有 ID。")
        return section_id, request_id + 1

    def _list_section_page(
        self, session: _AppServerSession, request_id: int, cursor: str | None
    ) -> tuple[list[Any], str | None, int]:
        params = {"cursor": cursor} if cursor is not None else {}
        page = self._metadata_request(session, request_id, "threadSection/list", params)
        sections, next_cursor = page.get("data"), page.get("nextCursor")
        if not isinstance(sections, list):
            raise AIError("Codex threadSection/list 返回了无效的分组数据。")
        if next_cursor is not None and not isinstance(next_cursor, str):
            raise AIError("Codex threadSection/list 返回了无效的分页游标。")
        return sections, next_cursor, request_id + 1

    @staticmethod
    def _matching_section_id(sections: list[Any], group: str) -> str | None:
        for section in sections:
            if not isinstance(section, dict):
                raise AIError("Codex threadSection/list 返回了无效的分组。")
            if section.get("name") == group:
                section_id = section.get("id")
                if not isinstance(section_id, str) or not section_id:
                    raise AIError("Codex 返回的匹配分组没有 ID。")
                return section_id
        return None

    def _open_thread(self, session: _AppServerSession, thread_id: str | None) -> str:
        method = "thread/resume" if thread_id else "thread/start"
        params = self._thread_params(thread_id)
        thread = session.request(2, method, params).get("thread") or {}
        actual_thread_id = thread.get("id")
        if not isinstance(actual_thread_id, str) or not actual_thread_id:
            raise AIError("Codex 没有返回会话 ID。")
        if thread_id and actual_thread_id != thread_id:
            raise AIError("Codex 恢复了另一个会话，未发送本轮请求。")
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

    def _start_turn(
        self, session: _AppServerSession, thread_id: str, request: _AIRequest
    ) -> tuple[str, str | None]:
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
        send_guard = getattr(request.observer, "send_guard", nullcontext)
        with send_guard():
            _observe(request.observer, "turn/sending", {
                "thread_id": thread_id, "params": turn_params,
            })
            session.send({"id": 3, "method": "turn/start", "params": turn_params})
        return session.collect_turn(3, request.observer, thread_id)

    @staticmethod
    def _validated_request(request: _AIRequest) -> _AIRequest:
        if not isinstance(request.prompt, str) or not request.prompt.strip():
            raise AIError("AI 提示词不能为空。")
        if request.schema is not None and not isinstance(request.schema, dict):
            raise AIError("结构化输出的 schema 必须是 JSON 对象。")
        try:
            json.dumps(request.schema)
        except (TypeError, ValueError) as exc:
            raise AIError("结构化输出的 schema 只能包含 JSON 值。") from exc
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
            request.observer,
        )

    @staticmethod
    def _validated_images(images: list[Path]) -> list[Path]:
        paths: list[Path] = []
        for image in images:
            path = Path(image).expanduser().resolve()
            if not path.is_file():
                raise AIError(f"图片输入不是文件：{path.name}")
            paths.append(path)
        return paths

    def _prepare_working_dir(self) -> None:
        try:
            self.working_dir.mkdir(parents=True, exist_ok=True)
            if not self.working_dir.is_dir() or any(self.working_dir.iterdir()):
                raise AIError("Codex 需要一个专用的空工作目录。")
        except OSError as exc:
            raise AIError("Codex 工作目录不可用。") from exc


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
                incoming.put(EOFError("Codex app-server 关闭了输出通道。"))
                return
            if len(line) > _MAX_STDOUT_LINE:
                incoming.put(AIError("Codex app-server 发送的协议消息过大。"))
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


def _observe(
    observer: Callable[[str, dict[str, Any]], None] | None,
    event: str,
    payload: dict[str, Any],
) -> None:
    if observer is not None:
        try:
            observer(event, payload)
        except Exception as exc:
            raise AIError(f"AI 事件记录在 {event} 阶段失败。") from exc


def _identify_turn(
    candidate: Any,
    actual_thread_id: Any,
    expected_thread_id: str,
    current_turn_id: str | None,
    observer: Callable[[str, dict[str, Any]], None] | None,
) -> str | None:
    if actual_thread_id is not None and actual_thread_id != expected_thread_id:
        raise AIError("Codex 流式通知属于另一个会话。")
    if candidate is None:
        return current_turn_id
    if not isinstance(candidate, str) or not candidate:
        raise AIError("Codex 流式通知包含无效的轮次 ID。")
    if current_turn_id is not None and candidate != current_turn_id:
        raise AIError("Codex 流式通知属于另一个轮次。")
    if current_turn_id is None:
        _observe(observer, "turn/identified", {
            "thread_id": expected_thread_id,
            "turn_id": candidate,
        })
    return candidate


def _notification_turn_id(params: dict[str, Any], turn: dict[str, Any]) -> Any:
    identifiers = [value for value in (params.get("turnId"), turn.get("id")) if value is not None]
    if any(not isinstance(value, str) or not value for value in identifiers):
        raise AIError("Codex 流式通知包含无效的轮次 ID。")
    if len(set(identifiers)) > 1:
        raise AIError("Codex 流式通知包含相互矛盾的轮次 ID。")
    return identifiers[0] if identifiers else None


def _completed_turn_text(
    turn: dict[str, Any],
    completed_messages: list[dict[str, Any]],
    fragments_by_item: dict[str, list[str]],
    unkeyed_fragments: list[str],
) -> str:
    status = turn.get("status")
    if status != "completed":
        raise AIError(f"Codex 本轮未成功（{status or 'failed'}）。")
    items = turn.get("items")
    if isinstance(items, list):
        for item in items:
            _AppServerSession.validate_item(item)
        answer = _final_assistant_text(items)
        if answer:
            return answer
    answer = _final_assistant_text(completed_messages)
    if answer:
        return answer
    if unkeyed_fragments and not fragments_by_item:
        answer = "".join(unkeyed_fragments).strip()
        if answer:
            return answer
    if len(fragments_by_item) == 1 and not unkeyed_fragments:
        answer = "".join(next(iter(fragments_by_item.values()))).strip()
        if answer:
            return answer
    if len(fragments_by_item) > 1 or (fragments_by_item and unkeyed_fragments):
        raise AIError("Codex 已完成，返回了多条助手消息，但没有标记最终消息。")
    raise AIError("Codex 已完成，但没有返回助手消息。")


def _read_turn_request(
    executable: str,
    working_dir: Path,
    thread_id: str,
    turn_id: str | None,
    prompt: str | None,
    stderr_buffer: _StderrBuffer,
) -> dict[str, str]:
    process: subprocess.Popen[bytes] | None = None
    try:
        process, incoming = _start_process(executable, working_dir, stderr_buffer)
        session = _AppServerSession(process, incoming, time.monotonic() + _TIMEOUT_SECONDS)
        CodexAI._initialize_session(session)
        response = session.request(2, "thread/read", {
            "threadId": thread_id, "includeTurns": True,
        })
        thread = response.get("thread") or {}
        if not isinstance(thread, dict):
            raise AIError("Codex thread/read 返回了无效的会话数据。")
        if thread.get("id") != thread_id:
            raise AIError("Codex thread/read 返回了另一个会话。")
        turns = thread.get("turns")
        if not isinstance(turns, list):
            raise AIError("Codex thread/read 没有包含轮次记录。")
        return _read_turn_result(thread_id, _select_read_turn(turns, turn_id, prompt))
    except AIError:
        raise
    except (OSError, EOFError, UnicodeError, json.JSONDecodeError, TypeError) as exc:
        raise CodexAI._communication_error(stderr_buffer) from exc
    finally:
        if process is not None:
            _stop_process(process)


def _select_read_turn(
    turns: list[Any], turn_id: str | None, prompt: str | None
) -> dict[str, Any]:
    if turn_id is not None:
        matches = [turn for turn in turns if isinstance(turn, dict) and turn.get("id") == turn_id]
    else:
        matches = [
            turn for turn in turns
            if isinstance(turn, dict) and _turn_user_prompt(turn) == prompt
        ]
    if len(matches) != 1:
        raise AIError("无法在该会话中唯一确定所请求的轮次。")
    return matches[0]


def _turn_user_prompt(turn: dict[str, Any]) -> str | None:
    items = turn.get("items")
    if not isinstance(items, list):
        return None
    prompts: list[str] = []
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "userMessage":
            continue
        content = item.get("content")
        if not isinstance(content, list):
            return None
        text_parts = [
            part.get("text")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        if not text_parts or not all(isinstance(part, str) for part in text_parts):
            return None
        prompts.append("".join(text_parts))
    return prompts[0] if len(prompts) == 1 else None


def _read_turn_result(thread_id: str, turn: dict[str, Any]) -> dict[str, str]:
    actual_turn_id = turn.get("id")
    status = turn.get("status")
    items = turn.get("items")
    if not isinstance(actual_turn_id, str) or not actual_turn_id:
        raise AIError("Codex 返回的轮次没有 ID。")
    if not isinstance(status, str):
        raise AIError("Codex 返回的轮次没有状态。")
    if not isinstance(items, list):
        raise AIError("Codex 返回的轮次内容不完整。")
    if turn.get("itemsView", "full") != "full":
        raise AIError("Codex 返回的是摘要轮次，内容不完整。")
    unsafe = [
        item for item in items
        if not isinstance(item, dict) or item.get("type") not in _SAFE_ITEM_TYPES
    ]
    if unsafe:
        raise AIError("所请求的轮次含有工具调用，无法安全恢复。")
    final_text = _final_assistant_text(items)
    if status == "completed" and not final_text:
        raise AIError("已完成的轮次中没有可恢复的最终助手消息。")
    return {
        "status": status,
        "thread_id": thread_id,
        "turn_id": actual_turn_id,
        "text": final_text,
    }


def _final_assistant_text(items: list[Any]) -> str:
    for item in reversed(items):
        if not isinstance(item, dict) or item.get("type") != "agentMessage":
            continue
        if item.get("phase") not in {None, "final_answer"}:
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            return text
    return ""


def _validated_conversation(conversation: ConversationIdentity) -> ConversationIdentity:
    if not isinstance(conversation, ConversationIdentity):
        raise AIError("会话身份必须包含课程分组和会话标题。")
    if not isinstance(conversation.title, str) or not conversation.title.strip():
        raise AIError("会话标题不能为空。")
    if len(conversation.title) > 500:
        raise AIError("会话标题最多 500 个字符。")
    if not isinstance(conversation.group, str) or not conversation.group.strip():
        raise AIError("会话分组不能为空。")
    if len(conversation.group) > 250:
        raise AIError("会话分组最多 250 个字符。")
    if conversation.native_section_id is not None and (
            not isinstance(conversation.native_section_id, str) or not conversation.native_section_id
            or len(conversation.native_section_id) > 100):
        raise AIError("原生分组 ID 必须是 1 到 100 个字符的字符串。")
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
            raise AIUnavailable("Codex app-server 在终止后没有退出。") from exc


def _close_process_streams(process: subprocess.Popen[bytes]) -> None:
    for stream in (process.stdout, process.stderr):
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass
