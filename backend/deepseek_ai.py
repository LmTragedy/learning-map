"""DeepSeek chat-completions adapter for the two text-only, locally checked tasks.

Only note review and goal extraction are routed here (see `provider_for`). DeepSeek keeps no
server-side thread and accepts no images, so every request is one self-contained turn.
"""

from __future__ import annotations

import json
import os
from typing import Any
from uuid import uuid4

import httpx

from .ai import AIError, AIUnavailable

DEFAULT_BASE_URL = "https://api.deepseek.com"
_TIMEOUT_SECONDS = 180
_MAX_OUTPUT_TOKENS = 8192


def is_deepseek(model: str) -> bool:
    return model.strip().lower().startswith("deepseek")


class DeepSeekAI:
    def __init__(self, model: str, *, api_key: str | None = None, base_url: str | None = None,
                 client: httpx.Client | None = None) -> None:
        self.model = model.strip()
        self.api_key = (api_key if api_key is not None else os.environ.get("DEEPSEEK_API_KEY", "")).strip()
        self.base_url = (base_url or os.environ.get("DEEPSEEK_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.client = client

    def available(self) -> dict[str, Any]:
        if not self.api_key:
            return {"available": False, "reason": "未设置 DEEPSEEK_API_KEY 环境变量；设置后重启本地服务。"}
        return {"available": True}

    def ask(self, prompt: str, *, thread_id: str | None = None, schema: dict[str, Any] | None = None,
            images: list | None = None, conversation: Any = None, observer: Any = None) -> dict[str, str]:
        # thread_id and conversation are Codex concepts; both routed tasks send self-contained prompts.
        if images:
            raise AIError("DeepSeek 不接收图片；这个任务请使用 Codex 模型。")
        if not self.api_key:
            raise AIUnavailable("未设置 DEEPSEEK_API_KEY 环境变量；设置后重启本地服务。")
        messages = [{"role": "user", "content": prompt}]
        body: dict[str, Any] = dict(model=self.model, messages=messages, max_tokens=_MAX_OUTPUT_TOKENS, stream=False)
        if schema is not None:
            messages.insert(0, {"role": "system", "content": (
                "只输出一个 JSON 对象，不要代码围栏或其他文字。它必须符合下面的 JSON Schema，"
                "所有 properties 都要给出，不要添加额外字段：\n" + json.dumps(schema, ensure_ascii=False))})
            body["response_format"] = {"type": "json_object"}
        data = self._post(body)
        try:
            choice = data["choices"][0]
            text = choice["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise AIError("DeepSeek 返回了无法识别的响应。") from exc
        if choice.get("finish_reason") == "length":
            raise AIError("DeepSeek 输出达到长度上限被截断；结果未使用。")
        if not text.strip():
            raise AIError("DeepSeek 返回了空结果。")
        return {"text": text, "thread_id": f"deepseek-{data.get('id') or uuid4().hex}"}

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        url = f"{self.base_url}/chat/completions"
        try:
            if self.client is not None:
                response = self.client.post(url, json=body, headers=headers, timeout=_TIMEOUT_SECONDS)
            else:
                with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
                    response = client.post(url, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise AIError(f"DeepSeek 请求超过 {_TIMEOUT_SECONDS} 秒未完成。") from exc
        except httpx.HTTPError as exc:
            raise AIUnavailable(f"无法连接 DeepSeek：{exc}") from exc
        if response.status_code in {401, 403}:
            raise AIUnavailable("DeepSeek 拒绝了 API key，请检查 DEEPSEEK_API_KEY。")
        if response.status_code >= 400:
            raise AIError(f"DeepSeek 请求失败（HTTP {response.status_code}）：{response.text[:300]}")
        try:
            return response.json()
        except ValueError as exc:
            raise AIError("DeepSeek 返回的不是 JSON。") from exc


def deepseek_status(settings):
    """Key check for the routed tasks, or None when neither uses DeepSeek."""
    models = [settings["note_review_model"], settings.get("goal_model", "")]
    return DeepSeekAI(next(m for m in models if is_deepseek(m))).available() if any(map(is_deepseek, models)) else None


def provider_for(settings, codex_factory):
    """DeepSeek for a deepseek-* model (only reachable from note review and goal extraction)."""
    if is_deepseek(settings["model"]):
        return DeepSeekAI(settings["model"])
    return codex_factory(settings)
