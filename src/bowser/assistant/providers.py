"""AI providers for the Assistant: presets and the three wire formats.

One conversation format is kept by the page and sent with every request; each
provider turns it into its own request, streams the answer and gives back the
next turn in the same format:

- ``{"role": "user", "content": "<text>"}``
- ``{"role": "assistant", "content": "<text>", "tool_calls": [{"id", "name",
  "input"}], "native": {"wire": ..., "content": ...}}``: ``native`` is the turn
  as the provider sent it (thinking blocks and their signatures, Gemini's thought
  signatures), sent back unchanged to the same wire format;
- ``{"role": "tool", "results": [{"id", "name", "content", "is_error"}]}``.

Wire formats: Anthropic Messages (through the official ``anthropic`` SDK),
OpenAI Chat Completions (also OpenRouter and Ollama) and Gemini
``streamGenerateContent``. The mapping follows RustGIS
(crates/assistant/src/provider.rs).

Imports ``httpx`` and ``anthropic`` only when a provider is used: they come with
the ``assistant`` extra.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Wire = Literal["anthropic", "openai", "gemini", "responses"]
StopReason = Literal["end", "tool_use", "max_tokens", "refusal"]

#: Output cap per model reply (the replies are short; tool loops are many turns).
MAX_TOKENS = 16000

_MODEL = re.compile(r"^[A-Za-z0-9._:/@+-]{1,200}$")


@dataclass(frozen=True)
class Preset:
    """A provider the Assistant offers, with its defaults."""

    id: str
    label: str
    wire: Wire
    base_url: str
    model: str
    #: Model names offered in the picker (any other name can be typed).
    models: tuple[str, ...] = ()
    #: Whether it needs an API key (local servers usually do not).
    needs_key: bool = True
    #: A model server on this computer (no key; nothing leaves it).
    local: bool = False
    #: The settings field holding the provider's usual environment variable.
    key_env: str = ""
    key_url: str = ""
    #: ``api_key``, ``none`` or ``sign_in`` (an account sign-in, not a key).
    auth: Literal["api_key", "none", "sign_in"] = "api_key"
    #: False for a provider listed as coming later.
    available: bool = True
    note: str = ""


PRESETS: tuple[Preset, ...] = (
    Preset(
        id="anthropic",
        label="Anthropic",
        wire="anthropic",
        base_url="https://api.anthropic.com",
        model="claude-opus-5-5",
        models=("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
        key_env="ANTHROPIC_API_KEY",
        key_url="https://console.anthropic.com/settings/keys",
    ),
    Preset(
        id="openai",
        label="OpenAI",
        wire="openai",
        base_url="https://api.openai.com/v1",
        model="gpt-5.5",
        models=("gpt-5.5",),
        key_env="OPENAI_API_KEY",
        key_url="https://platform.openai.com/api-keys",
    ),
    Preset(
        id="gemini",
        label="Google Gemini",
        wire="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        model="gemini-3.8-flash",
        models=("gemini-3.8-flash",),
        key_env="GEMINI_API_KEY",
        key_url="https://aistudio.google.com/apikey",
    ),
    Preset(
        id="openrouter",
        label="OpenRouter",
        wire="openai",
        base_url="https://openrouter.ai/api/v1",
        model="openrouter/auto",
        models=("openrouter/auto", "anthropic/claude-opus-5.5"),
        key_env="OPENROUTER_API_KEY",
        key_url="https://openrouter.ai/keys",
    ),
    Preset(
        id="ollama",
        label="Ollama (local)",
        wire="openai",
        # Offered only when installed here; see .ollama.
        base_url="http://127.0.0.1:11434/v1",
        model="qwen3",
        models=("qwen3",),
        needs_key=False,
        local=True,
        auth="none",
    ),
    # The seam for OpenAI's "Sign in with ChatGPT" for open-source apps: an
    # account sign-in that would use the Responses API. Listed, not built.
    Preset(
        id="chatgpt",
        label="Sign in with ChatGPT",
        wire="responses",
        base_url="",
        model="",
        auth="sign_in",
        available=False,
        note="Coming in a later version.",
    ),
)


def preset(provider_id: str) -> Preset | None:
    """Return the preset with this id."""
    return next((p for p in PRESETS if p.id == provider_id), None)


def valid_model(model: str) -> bool:
    """Whether ``model`` looks like a model name (no spaces, quotes or URLs)."""
    return bool(_MODEL.match(model)) and "//" not in model


# --- the turn a provider gives back -----------------------------------------------


@dataclass
class ToolCall:
    """A tool the model asked for."""

    id: str
    name: str
    input: dict[str, Any]


@dataclass
class Turn:
    """One reply of the model, in the page's conversation format."""

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop: StopReason = "end"
    native: dict[str, Any] | None = None
    #: Why a refusal happened, when the provider says.
    detail: str = ""

    def message(self) -> dict[str, Any]:
        """Return the turn as a conversation message."""
        msg: dict[str, Any] = {"role": "assistant", "content": self.text}
        if self.tool_calls:
            msg["tool_calls"] = [asdict(c) for c in self.tool_calls]
        if self.native is not None:
            msg["native"] = self.native
        return msg


class ProviderError(RuntimeError):
    """A failure to show the user.

    ``kind`` is ``auth`` (bad key), ``rate_limit``, ``provider_down`` (5xx,
    overloaded, unreachable), ``bad_request`` (unknown model, rejected request) or
    ``bad_response`` (a reply that could not be read). The message never holds
    the key.
    """

    def __init__(self, kind: str, message: str, status: int | None = None) -> None:
        """Keep ``kind`` and ``status`` with the message."""
        super().__init__(message)
        self.kind = kind
        self.status = status


def _kind(status: int) -> str:
    if status in (401, 403):
        return "auth"
    if status == 429:
        return "rate_limit"
    if status >= 500:
        return "provider_down"
    return "bad_request"


def _http_error(label: str, status: int, body: str) -> ProviderError:
    message = _error_text(body) or f"HTTP {status}"
    kind = _kind(status)
    # Gemini answers a bad key with 400 API_KEY_INVALID.
    if status == 400 and ("API_KEY_INVALID" in body or "API key not valid" in body):
        kind = "auth"
    return ProviderError(kind, f"{label}: {message}", status)


def _error_text(body: str) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return body.strip()[:300]
    if isinstance(data, list) and data:
        data = data[0]
    err = data.get("error", data) if isinstance(data, dict) else data
    if isinstance(err, dict):
        return str(err.get("message") or err)[:300]
    return str(err)[:300]


def _arguments(text: str) -> dict[str, Any]:
    """Parse a tool call's arguments (JSON text); invalid JSON gives an empty dict."""
    if not text.strip():
        return {}
    try:
        value = json.loads(text)
    except ValueError:
        return {"_invalid_json": text[:2000]}
    return value if isinstance(value, dict) else {"_invalid_json": text[:2000]}


async def _sse(lines: AsyncIterator[str]) -> AsyncIterator[str]:
    """Yield the data of each server-sent event."""
    data: list[str] = []
    async for line in lines:
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif not line.strip() and data:
            yield "\n".join(data)
            data = []
    if data:
        yield "\n".join(data)


# --- providers --------------------------------------------------------------------


class Provider:
    """One provider with its key, model and base URL.

    ``stream`` yields ``("text", delta)`` while the model writes, then
    ``("turn", Turn)`` once.
    """

    def __init__(
        self,
        preset: Preset,
        model: str,
        key: str | None,
        base_url: str | None = None,
        transport: Any = None,
    ) -> None:
        """Set up the provider; ``transport`` replaces the network (tests)."""
        self.preset = preset
        self.model = model or preset.model
        self._key = key or ""
        self.base_url = (base_url or preset.base_url).rstrip("/")
        self._transport = transport

    def __repr__(self) -> str:
        """Name the provider and model, never the key."""
        return f"{type(self).__name__}({self.preset.id!r}, {self.model!r})"

    async def stream(
        self,
        system: str,  # noqa: ARG002  (used by the subclasses)
        messages: list[dict],  # noqa: ARG002
        tools: list[dict],  # noqa: ARG002
    ) -> AsyncIterator[tuple[str, Any]]:
        """Send the conversation; yield text deltas, then the turn."""
        raise NotImplementedError
        yield  # pragma: no cover

    async def check(self) -> bool:
        """Whether the provider accepts the key (lists models; costs nothing).

        Raises ProviderError when the provider cannot be reached.
        """
        raise NotImplementedError

    def _client(self, timeout: float = 600.0):
        import httpx  # noqa: PLC0415

        return httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=30.0), transport=self._transport
        )


class OpenAIProvider(Provider):
    """OpenAI Chat Completions: OpenAI, OpenRouter and Ollama."""

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._key:
            headers["Authorization"] = f"Bearer {self._key}"
        if self.preset.id == "openrouter":
            headers["HTTP-Referer"] = "https://github.com/opera-adt/bowser"
            headers["X-Title"] = "Bowser"
        return headers

    @staticmethod
    def request_messages(system: str, messages: list[dict]) -> list[dict]:
        """Return the conversation as Chat Completions messages."""
        out: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["content"]})
            elif m["role"] == "assistant":
                msg: dict[str, Any] = {"role": "assistant", "content": m["content"]}
                if m.get("tool_calls"):
                    msg["content"] = m["content"] or None
                    msg["tool_calls"] = [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {
                                "name": c["name"],
                                "arguments": json.dumps(c["input"]),
                            },
                        }
                        for c in m["tool_calls"]
                    ]
                out.append(msg)
            elif m["role"] == "tool":
                out.extend(
                    {"role": "tool", "tool_call_id": r["id"], "content": r["content"]}
                    for r in m["results"]
                )
        return out

    async def stream(self, system, messages, tools):
        """Stream one reply (``stream: true``), assembling tool-call fragments."""
        import httpx  # noqa: PLC0415

        body: dict[str, Any] = {
            "model": self.model,
            "messages": self.request_messages(system, messages),
            "stream": True,
        }
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": t["input_schema"],
                    },
                }
                for t in tools
            ]
        label = self.preset.label
        text: list[str] = []
        calls: dict[int, dict[str, str]] = {}
        finish = None
        try:
            async with (
                self._client() as client,
                client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                ) as r,
            ):
                if r.status_code >= 400:
                    raise _http_error(label, r.status_code, (await r.aread()).decode())
                async for data in _sse(r.aiter_lines()):
                    if data.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if chunk.get("error"):
                        err = json.dumps(chunk)
                        status = chunk["error"].get("code")
                        status = status if isinstance(status, int) else 502
                        raise _http_error(label, status, err)
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        piece = delta.get("content") or delta.get("refusal")
                        if piece:
                            text.append(piece)
                            yield "text", piece
                        for tc in delta.get("tool_calls") or []:
                            c = calls.setdefault(
                                tc.get("index", len(calls)),
                                {"id": "", "name": "", "arguments": ""},
                            )
                            fn = tc.get("function") or {}
                            c["id"] = tc.get("id") or c["id"]
                            c["name"] += fn.get("name") or ""
                            c["arguments"] += fn.get("arguments") or ""
                        finish = choice.get("finish_reason") or finish
        except httpx.TransportError as e:
            raise ProviderError(
                "provider_down",
                f"Cannot reach {label} at {self.base_url} ({type(e).__name__}).",
            ) from e
        tool_calls = [
            ToolCall(c["id"] or f"call_{i}", c["name"], _arguments(c["arguments"]))
            for i, c in sorted(calls.items())
        ]
        stop: StopReason = "tool_use" if tool_calls else "end"
        if finish == "length":
            stop = "max_tokens"
        elif finish == "content_filter":
            stop = "refusal"
        yield "turn", Turn("".join(text), tool_calls, stop)

    async def check(self) -> bool:
        """List models (OpenRouter: describe the key) with the key."""
        import httpx  # noqa: PLC0415

        url = (
            f"{self.base_url}/key"
            if self.preset.id == "openrouter"
            else f"{self.base_url}/models"
        )
        try:
            async with self._client(30.0) as client:
                r = await client.get(url, headers=self._headers())
        except httpx.TransportError as e:
            raise ProviderError(
                "provider_down", f"Cannot reach {self.preset.label} at {self.base_url}."
            ) from e
        if r.status_code in (401, 403):
            return False
        if r.status_code >= 400:
            raise _http_error(self.preset.label, r.status_code, r.text)
        return True


class GeminiProvider(Provider):
    """Gemini ``streamGenerateContent`` (server-sent events)."""

    def _headers(self) -> dict[str, str]:
        return {"Content-Type": "application/json", "x-goog-api-key": self._key}

    @staticmethod
    def request_contents(messages: list[dict]) -> list[dict]:
        """Return the conversation as Gemini contents."""
        contents: list[dict] = []
        for m in messages:
            if m["role"] == "user":
                contents.append({"role": "user", "parts": [{"text": m["content"]}]})
            elif m["role"] == "assistant":
                native = m.get("native") or {}
                if native.get("wire") == "gemini":
                    contents.append(native["content"])
                    continue
                parts: list[dict] = []
                if m["content"]:
                    parts.append({"text": m["content"]})
                parts.extend(
                    {"functionCall": {"name": c["name"], "args": c["input"]}}
                    for c in m.get("tool_calls") or []
                )
                if parts:
                    contents.append({"role": "model", "parts": parts})
            elif m["role"] == "tool":
                parts = []
                for r in m["results"]:
                    key = "error" if r.get("is_error") else "result"
                    response: dict[str, Any] = {
                        "name": r["name"],
                        "response": {key: r["content"]},
                    }
                    if not r["id"].startswith(_MADE_UP):
                        response["id"] = r["id"]
                    parts.append({"functionResponse": response})
                contents.append({"role": "user", "parts": parts})
        return contents

    async def stream(self, system, messages, tools):
        """Stream one reply; function calls arrive whole."""
        import httpx  # noqa: PLC0415

        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": self.request_contents(messages),
        }
        if tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": t["name"],
                            "description": t["description"],
                            "parameters": gemini_schema(t["input_schema"]),
                        }
                        for t in tools
                    ]
                }
            ]
        model = self.model.removeprefix("models/")
        url = f"{self.base_url}/models/{model}:streamGenerateContent?alt=sse"
        label = self.preset.label
        parts: list[dict] = []
        text: list[str] = []
        calls: list[ToolCall] = []
        finish = None
        blocked = ""
        try:
            async with (
                self._client() as client,
                client.stream("POST", url, headers=self._headers(), json=body) as r,
            ):
                if r.status_code >= 400:
                    raise _http_error(label, r.status_code, (await r.aread()).decode())
                async for data in _sse(r.aiter_lines()):
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    blocked = (chunk.get("promptFeedback") or {}).get(
                        "blockReason"
                    ) or blocked
                    for cand in (chunk.get("candidates") or [])[:1]:
                        for p in (cand.get("content") or {}).get("parts") or []:
                            parts.append(p)
                            if p.get("thought"):
                                continue
                            if p.get("text"):
                                text.append(p["text"])
                                yield "text", p["text"]
                            if p.get("functionCall"):
                                f = p["functionCall"]
                                calls.append(
                                    ToolCall(
                                        f.get("id") or f"{_MADE_UP}{len(calls)}",
                                        f.get("name", ""),
                                        f.get("args") or {},
                                    )
                                )
                        finish = cand.get("finishReason") or finish
        except httpx.TransportError as e:
            raise ProviderError(
                "provider_down", f"Cannot reach {label} ({type(e).__name__})."
            ) from e
        stop: StopReason = "tool_use" if calls else "end"
        detail = ""
        if blocked or finish in _GEMINI_REFUSALS:
            stop, detail = "refusal", blocked or finish or ""
            calls = []
        elif finish == "MAX_TOKENS":
            stop = "max_tokens"
        native = {"wire": "gemini", "content": {"role": "model", "parts": parts}}
        yield "turn", Turn("".join(text), calls, stop, native, detail)

    async def check(self) -> bool:
        """List models with the key."""
        import httpx  # noqa: PLC0415

        try:
            async with self._client(30.0) as client:
                r = await client.get(f"{self.base_url}/models", headers=self._headers())
        except httpx.TransportError as e:
            raise ProviderError("provider_down", "Cannot reach Google Gemini.") from e
        err = _http_error(self.preset.label, r.status_code, r.text)
        if r.status_code >= 400 and err.kind == "auth":
            return False
        if r.status_code >= 400:
            raise err
        return True


_MADE_UP = "gemini-call-"
_GEMINI_REFUSALS = {
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
}


def gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Return a JSON schema in the subset Gemini's ``parameters`` take.

    References to ``$defs`` are inlined, ``anyOf [X, null]`` becomes ``X`` with
    ``nullable``, keywords Gemini rejects are dropped, and an object without
    properties (a free-form GeoJSON geometry) becomes a string of JSON, which the
    data tools accept.
    """
    defs = schema.get("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            target = defs.get(node["$ref"].rsplit("/", 1)[-1], {})
            return walk({**target, **{k: v for k, v in node.items() if k != "$ref"}})
        options = node.get("anyOf")
        if isinstance(options, list):
            rest = [o for o in options if o.get("type") != "null"]
            if len(rest) == 1:
                merged = {**rest[0], **{k: v for k, v in node.items() if k != "anyOf"}}
                out = walk(merged)
                if len(rest) < len(options):
                    out["nullable"] = True
                return out
        if node.get("type") == "object" and not node.get("properties"):
            desc = node.get("description") or "A JSON object"
            return {"type": "string", "description": f"{desc} (as JSON text)"}
        drop = {"title", "default", "additionalProperties", "$schema", "$defs"}
        return {k: walk(v) for k, v in node.items() if k not in drop}

    return walk(schema)


class AnthropicProvider(Provider):
    """Anthropic Messages through the official SDK, streamed."""

    def _sdk(self, timeout: float = 600.0):
        try:
            import anthropic  # noqa: PLC0415
        except ImportError as e:
            raise ProviderError(
                "bad_request",
                "Anthropic needs the `anthropic` package: "
                "pip install 'bowser-insar[assistant]'.",
            ) from e
        http_client = None
        if self._transport is not None:
            http_client = anthropic.DefaultAsyncHttpxClient(transport=self._transport)
        return anthropic, anthropic.AsyncAnthropic(
            api_key=self._key,
            base_url=self.base_url,
            timeout=timeout,
            max_retries=2,
            http_client=http_client,
        )

    @staticmethod
    def request_messages(messages: list[dict]) -> list[dict]:
        """Return the conversation as Messages API messages.

        An earlier Anthropic turn goes back exactly as it came (thinking blocks
        included), as the API requires.
        """
        out: list[dict] = []
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["content"]})
            elif m["role"] == "assistant":
                native = m.get("native") or {}
                if native.get("wire") == "anthropic":
                    out.append({"role": "assistant", "content": native["content"]})
                    continue
                blocks: list[dict] = []
                if m["content"]:
                    blocks.append({"type": "text", "text": m["content"]})
                blocks.extend(
                    {
                        "type": "tool_use",
                        "id": c["id"],
                        "name": c["name"],
                        "input": c["input"],
                    }
                    for c in m.get("tool_calls") or []
                )
                if blocks:
                    out.append({"role": "assistant", "content": blocks})
            elif m["role"] == "tool":
                out.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": r["id"],
                                "content": r["content"],
                                "is_error": bool(r.get("is_error")),
                            }
                            for r in m["results"]
                        ],
                    }
                )
        return out

    def request(self, system: str, messages: list[dict], tools: list[dict]) -> dict:
        """Return the keyword arguments of ``client.beta.messages.stream``.

        Adaptive thinking on the models that have it; no sampling parameters and
        no forced tool choice (current models reject both); the server-side
        fallback on a declined request where the model offers it.
        """
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": self.request_messages(messages),
        }
        if tools:
            kwargs["tools"] = [
                {
                    "name": t["name"],
                    "description": t["description"],
                    "input_schema": t["input_schema"],
                    "eager_input_streaming": True,
                }
                for t in tools
            ]
        if _adaptive(self.model):
            kwargs["thinking"] = {"type": "adaptive"}
        if _has_fallback(self.model):
            kwargs["betas"] = ["server-side-fallback-2026-07-01"]
            kwargs["fallbacks"] = "default"
        return kwargs

    async def stream(self, system, messages, tools):
        """Stream one reply with ``client.beta.messages.stream``."""
        anthropic, client = self._sdk()
        try:
            async with client.beta.messages.stream(
                **self.request(system, messages, tools)
            ) as stream:
                async for event in stream:
                    if event.type == "text" and event.text:
                        yield "text", event.text
                message = await stream.get_final_message()
        except ValueError as e:
            # A tool input the SDK could not parse (eager input streaming).
            raise ProviderError(
                "bad_response", "Claude sent a tool call that could not be read."
            ) from e
        except anthropic.APIError as e:
            raise _anthropic_error(anthropic, e) from e
        finally:
            await client.close()
        content = [b.to_dict() for b in message.content]
        calls = [
            ToolCall(b.id, b.name, b.input if isinstance(b.input, dict) else {})
            for b in message.content
            if b.type == "tool_use"
        ]
        text = "".join(b.text for b in message.content if b.type == "text")
        stop: StopReason = "tool_use" if calls else "end"
        detail = ""
        if message.stop_reason == "refusal":
            stop, calls = "refusal", []
            details = getattr(message, "stop_details", None)
            detail = getattr(details, "category", None) or ""
        elif message.stop_reason == "max_tokens":
            stop = "max_tokens"
        native = {"wire": "anthropic", "content": content}
        yield "turn", Turn(text, calls, stop, native, detail)

    async def check(self) -> bool:
        """List one model with the key."""
        anthropic, client = self._sdk(30.0)
        try:
            await client.models.list(limit=1)
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
            return False
        except anthropic.APIError as e:
            raise _anthropic_error(anthropic, e) from e
        finally:
            await client.close()
        return True


def _anthropic_error(anthropic: Any, e: Exception) -> ProviderError:
    if isinstance(e, anthropic.APIConnectionError):
        return ProviderError("provider_down", "Cannot reach Anthropic.")
    status = getattr(e, "status_code", None) or 500
    message = getattr(e, "message", None) or str(e)
    body = getattr(e, "body", None)
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        message = body["error"].get("message") or message
    kind = _kind(status) if status != 529 else "provider_down"
    return ProviderError(kind, f"Anthropic: {message}"[:400], status)


def _adaptive(model: str) -> bool:
    """Whether the model takes ``thinking: {type: "adaptive"}`` (4.6 and later)."""
    old = (
        "claude-3",
        "claude-haiku-4-5",
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-opus-4-1",
        "claude-opus-4-0",
        "claude-sonnet-4-0",
    )
    return model.startswith("claude-") and not model.startswith(old)


def _has_fallback(model: str) -> bool:
    """Whether the model has the server-side fallback on a declined request."""
    return model.startswith(
        ("claude-opus-5", "claude-fable-5", "claude-mythos-5", "claude-sonnet-5-5")
    )


_CLASSES: dict[str, type[Provider]] = {
    "anthropic": AnthropicProvider,
    "openai": OpenAIProvider,
    "gemini": GeminiProvider,
}


def open_provider(
    p: Preset,
    model: str,
    key: str | None,
    base_url: str | None = None,
    transport: Any = None,
) -> Provider:
    """Return the provider for preset ``p``."""
    cls = _CLASSES.get(p.wire)
    if cls is None or not p.available:
        raise ProviderError("bad_request", f"{p.label} is not available yet.")
    return cls(p, model, key, base_url, transport)
