"""The Assistant's routes: provider status, key storage and the chat relay.

Shared by the full server and bowser-lite (both include :data:`router`). The
page never holds an API key: it sends one once (``PUT /assistant/key``), the
server keeps it (:mod:`.keys`) and the page then chats through
``POST /assistant/chat``, which adds the key and talks to the provider.

The tool loop runs here, in that request: the server streams the model's reply,
runs Bowser's data tools itself (:mod:`bowser.tools`, the same tools as
``bowser mcp``, called on this app in-process) and sends the model their
results, until the model answers or asks for page tools (fly to a place, add a
point, ...), which only the page can run. Then the request ends with a
``page_tools`` event; the page runs them and sends the results in a new request.

Gates, following ``BOWSER_ALLOW_OPEN``: nothing works unless
``BOWSER_ASSISTANT`` is set, and keys and base URLs can be set from the page only
with ``BOWSER_ASSISTANT_PAGE_KEYS`` and from this computer. A hosted server sets
its own key (``BOWSER_AI_PROVIDER``/``BOWSER_AI_KEY`` or a provider's usual
variable) instead.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import api_models as api
from .keys import KeyStore, default_path
from .providers import (
    PRESETS,
    Preset,
    ProviderError,
    open_provider,
    preset,
    valid_model,
)

#: Model replies per request before the loop stops (each may run tools).
MAX_STEPS = 12
#: A tool result longer than this is cut (the model reads it on every turn).
RESULT_CHARS = 24_000
#: Hosts a request "from this computer" comes from.
LOOPBACK = {"127.0.0.1", "::1", "localhost"}

SYSTEM = """\
You are the Assistant in Bowser's web page, next to the user's map and chart.
Answer with Bowser's tools: the data tools read the cube the page shows, and the
page tools act on the page (fly the map, add a time-series point, set the
reference point or date, switch the layer, open the chart, add an overlay).
Points and areas you read with the data tools are added to the map and chart for
the user automatically. Each user message starts with the page's state in
[page: ...]: use its layer, reference point and view unless the user asks for
something else. Keep answers short and plain; give numbers with their unit and
what they are relative to.

"""


def get_settings() -> Any:
    """Return Bowser's settings (a dependency, so tests can give their own)."""
    from ..config import settings  # noqa: PLC0415

    return settings


def key_store(settings: Any) -> KeyStore:
    """Return the key store at ``BOWSER_ASSISTANT_KEY_FILE`` or the default."""
    path = settings.BOWSER_ASSISTANT_KEY_FILE
    return KeyStore(Path(path).expanduser() if path else default_path())


def _env_key(settings: Any, p: Preset) -> str | None:
    """Return the server's key for ``p`` from the environment, if any."""
    if settings.BOWSER_AI_PROVIDER == p.id:
        key = settings.BOWSER_AI_KEY.get_secret_value()
        if key:
            return key
    if p.key_env:
        key = getattr(settings, p.key_env).get_secret_value()
        if key:
            return key
    return None


def _key(settings: Any, store: KeyStore, p: Preset) -> tuple[str | None, str | None]:
    """Return ``(key, source)``: a saved key first, then the environment's."""
    if settings.BOWSER_ASSISTANT_PAGE_KEYS:
        saved = store.load(p.id)
        if saved:
            return saved, "saved"
    env = _env_key(settings, p)
    return (env, "environment") if env else (None, None)


def _base_url(settings: Any, store: KeyStore, p: Preset) -> str:
    """Return the base URL for ``p``: the server's, a saved one, or the preset's."""
    if not p.local:
        return p.base_url
    if settings.BOWSER_AI_PROVIDER == p.id and settings.BOWSER_AI_BASE_URL:
        return settings.BOWSER_AI_BASE_URL
    if settings.BOWSER_ASSISTANT_PAGE_KEYS:
        saved = store.prefs(p.id).get("base_url")
        if saved:
            return str(saved)
    return p.base_url


def assistant_config(settings: Any) -> dict[str, Any]:
    """Return the Assistant's entry of ``GET /config``.

    Reads the key file's index only (never the keychain), so it is cheap.
    """
    if not settings.BOWSER_ASSISTANT:
        return {"enabled": False, "providers": [], "configured": []}
    store = key_store(settings)
    providers = [p for p in PRESETS if p.available]
    configured = [
        p.id
        for p in providers
        if _env_key(settings, p)
        or (settings.BOWSER_ASSISTANT_PAGE_KEYS and store.describe(p.id)["saved"])
    ]
    return {
        "enabled": True,
        "providers": [p.id for p in providers],
        "configured": configured,
    }


def _status(settings: Any) -> dict[str, Any]:
    enabled = bool(settings.BOWSER_ASSISTANT)
    page_keys = enabled and bool(settings.BOWSER_ASSISTANT_PAGE_KEYS)
    store = key_store(settings)
    out = []
    for p in PRESETS if enabled else ():
        saved = store.describe(p.id) if page_keys else {"saved": False}
        env = _env_key(settings, p)
        source = "saved" if saved["saved"] else "environment" if env else None
        model = p.model
        if settings.BOWSER_AI_PROVIDER == p.id and settings.BOWSER_AI_MODEL:
            model = settings.BOWSER_AI_MODEL
        out.append(
            {
                "id": p.id,
                "label": p.label,
                "wire": p.wire,
                "model": model,
                "models": list(p.models),
                "needs_key": p.needs_key,
                "local": p.local,
                "base_url": _base_url(settings, store, p),
                "auth": p.auth,
                "available": p.available,
                "note": p.note,
                "key_url": p.key_url,
                "configured": p.available and (bool(source) or not p.needs_key),
                "source": source,
                "hint": saved.get("hint") if saved["saved"] else None,
                "store": saved.get("store") if saved["saved"] else None,
            }
        )
    default = settings.BOWSER_AI_PROVIDER or next(
        (o["id"] for o in out if o["source"]), None
    )
    return {
        "enabled": enabled,
        "page_keys": page_keys,
        "providers": out,
        "default_provider": default if enabled else None,
    }


def _require_enabled(settings: Any) -> None:
    if not settings.BOWSER_ASSISTANT:
        raise HTTPException(
            status_code=403,
            detail="The Assistant is off on this server (set BOWSER_ASSISTANT=1, "
            "or run `bowser run` or `bowser lite` on your own computer).",
        )


def _require_page_keys(settings: Any, request: Request) -> None:
    _require_enabled(settings)
    if not settings.BOWSER_ASSISTANT_PAGE_KEYS:
        raise HTTPException(
            status_code=403,
            detail="Keys cannot be set from the page on this server; its "
            "administrator sets them.",
        )
    host = request.client.host if request.client else ""
    if host not in LOOPBACK and not host.startswith("127."):
        raise HTTPException(
            status_code=403,
            detail="Keys can only be set on the computer that runs Bowser.",
        )


def _preset(provider_id: str) -> Preset:
    p = preset(provider_id)
    if p is None:
        raise HTTPException(status_code=400, detail=f"No provider {provider_id!r}.")
    if not p.available:
        raise HTTPException(status_code=400, detail=f"{p.label}: {p.note}")
    return p


class KeyBody(BaseModel):
    """``PUT /assistant/key``."""

    provider: str = Field(description="Provider id, e.g. anthropic.")
    key: str | None = Field(
        None, min_length=8, max_length=400, description="The API key."
    )
    base_url: str | None = Field(
        None, max_length=300, description="Base URL of a local provider."
    )


class ChatBody(BaseModel):
    """``POST /assistant/chat``."""

    provider: str
    model: str = ""
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=400)
    page_tools: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    dataset: str | None = Field(
        None, description="The page's catalog dataset id, for the data tools."
    )


router = APIRouter()


@router.get(
    "/assistant/status",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("GET /assistant/status"),
)
def assistant_status(settings: Any = Depends(get_settings)):
    """Return the providers and which have a key (never the key)."""
    return _status(settings)


@router.put(
    "/assistant/key",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("PUT /assistant/key"),
)
async def assistant_key_set(
    request: Request,
    body: KeyBody = Body(..., examples=[{"provider": "anthropic", "key": "sk-..."}]),
    settings: Any = Depends(get_settings),
):
    """Check a key with its provider and keep it on this computer."""
    _require_page_keys(settings, request)
    p = _preset(body.provider)
    store = key_store(settings)
    if body.base_url is not None and p.local:
        url = body.base_url.strip().rstrip("/")
        if url and not url.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="Give an http(s) URL.")
        await asyncio.to_thread(store.set_prefs, p.id, base_url=url or None)
    key = (body.key or "").strip()
    stored_in = None
    if key:
        provider = open_provider(p, "", key, _base_url(settings, store, p))
        try:
            ok = await provider.check()
        except ProviderError as e:
            raise HTTPException(
                status_code=502, detail=f"Could not check the key: {e}"
            ) from e
        if not ok:
            raise HTTPException(
                status_code=401, detail=f"{p.label} did not accept this API key."
            )
        store_kind = await asyncio.to_thread(store.save, p.id, key)
        stored_in = (
            "the system keychain"
            if store_kind == "keyring"
            else "a file only you can read"
        )
    return {**_status(settings), "stored_in": stored_in}


@router.delete(
    "/assistant/key",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("DELETE /assistant/key"),
)
async def assistant_key_remove(
    request: Request,
    provider: str = Query(..., description="Provider id, e.g. anthropic."),
    settings: Any = Depends(get_settings),
):
    """Forget a provider's saved key."""
    _require_page_keys(settings, request)
    p = _preset(provider)
    await asyncio.to_thread(key_store(settings).remove_key, p.id)
    return _status(settings)


class EventStream(StreamingResponse):
    """A stream of server-sent events."""

    media_type = "text/event-stream"


@router.post(
    "/assistant/chat",
    response_class=EventStream,
    responses={
        200: {
            "description": 'Server-sent events, each `data: {"type": ...}`.',
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    },
    **api.route_doc("POST /assistant/chat"),
)
async def assistant_chat(
    request: Request,
    body: ChatBody,
    settings: Any = Depends(get_settings),
):
    """Run the conversation with the provider; stream events (SSE)."""
    _require_enabled(settings)
    p = _preset(body.provider)
    model = body.model.strip()
    if settings.BOWSER_AI_PROVIDER == p.id and not model:
        model = settings.BOWSER_AI_MODEL
    model = model or p.model
    if not valid_model(model):
        raise HTTPException(status_code=400, detail="Choose a model.")
    store = key_store(settings)
    key, _ = await asyncio.to_thread(_key, settings, store, p)
    if p.needs_key and not key:
        raise HTTPException(
            status_code=400, detail=f"Add an API key for {p.label} first."
        )
    provider = open_provider(p, model, key, _base_url(settings, store, p))
    tools = _data_tools(request, page_keys=bool(settings.BOWSER_ASSISTANT_PAGE_KEYS))
    page = _page_tools(body.page_tools, set(tools))
    return EventStream(
        run_chat(provider, body.messages, tools, page, body.dataset),
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


def _data_tools(request: Request, page_keys: bool) -> dict[str, Any]:
    """Return Bowser's data tools, calling this app in-process.

    A tool that writes files (``export_geotiff``) is offered only where the page
    may set keys, i.e. on the user's own computer.
    """
    import httpx  # noqa: PLC0415

    from ..tools import BowserAPI, build_tools  # noqa: PLC0415

    headers = {}
    if auth := request.headers.get("authorization"):
        headers["Authorization"] = auth
    bowser = BowserAPI(
        str(request.base_url),
        httpx.ASGITransport(app=request.app),
        headers=headers,
    )
    return {s.name: s for s in build_tools(bowser) if s.read_only or page_keys}


def _page_tools(specs: list[dict[str, Any]], taken: set[str]) -> list[dict]:
    """Check the page's tool specs: a name, a description and an object schema."""
    out = []
    for s in specs:
        name = s.get("name")
        schema = s.get("input_schema")
        if (
            not isinstance(name, str)
            or not name.isidentifier()
            or name in taken
            or not isinstance(schema, dict)
            or schema.get("type") != "object"
        ):
            raise HTTPException(status_code=400, detail=f"Bad page tool {name!r}.")
        out.append(
            {
                "name": name,
                "description": str(s.get("description") or "")[:2000],
                "input_schema": schema,
            }
        )
        taken.add(name)
    return out


def _event(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, separators=(',', ':'))}\n\n"


async def run_chat(
    provider: Any,
    messages: list[dict[str, Any]],
    tools: dict[str, Any],
    page_tools: list[dict],
    dataset: str | None = None,
) -> AsyncIterator[str]:
    """Run the tool loop; yield server-sent events.

    Parameters
    ----------
    provider : Provider
        The model to talk to (see :mod:`.providers`).
    messages : list of dict
        The conversation so far, in the page's format.
    tools : dict
        The data tools by name (:class:`bowser.tools.ToolSpec`), run here.
    page_tools : list of dict
        The page's tools (name, description, input_schema), run by the page.
    dataset : str, optional
        The page's catalog dataset id, given to data tools that take one.

    """
    from ..tools import INSTRUCTIONS  # noqa: PLC0415

    system = SYSTEM + INSTRUCTIONS
    specs = [
        {"name": s.name, "description": s.description, "input_schema": s.input_schema}
        for s in tools.values()
    ] + page_tools
    page_names = {t["name"] for t in page_tools}
    messages = list(messages)
    for _ in range(MAX_STEPS):
        turn = None
        try:
            async for kind, value in provider.stream(system, messages, specs):
                if kind == "text":
                    yield _event({"type": "text", "text": value})
                else:
                    turn = value
        except ProviderError as e:
            yield _event({"type": "error", "kind": e.kind, "message": str(e)})
            return
        if turn is None:
            yield _event(
                {"type": "error", "kind": "bad_response", "message": "No reply."}
            )
            return
        msg = turn.message()
        messages.append(msg)
        yield _event({"type": "message", "message": msg})
        if turn.stop == "refusal":
            yield _event({"type": "done", "stop": "refusal", "detail": turn.detail})
            return
        if turn.stop == "max_tokens" or not turn.tool_calls:
            yield _event({"type": "done", "stop": turn.stop})
            return
        results: list[dict[str, Any]] = []
        waiting: list[dict[str, Any]] = []
        for call in turn.tool_calls:
            spec = tools.get(call.name)
            if call.name in page_names:
                waiting.append({"id": call.id, "name": call.name, "input": call.input})
                continue
            yield _event(
                {
                    "type": "tool_call",
                    "id": call.id,
                    "name": call.name,
                    "input": call.input,
                    "runs": "server",
                }
            )
            if spec is None:
                content, ok, result = f"No tool named {call.name!r}.", False, None
            else:
                content, ok, result = await _run_tool(spec, call.input, dataset)
            results.append(
                {
                    "id": call.id,
                    "name": call.name,
                    "content": content,
                    "is_error": not ok,
                }
            )
            yield _event(
                {
                    "type": "tool_result",
                    "id": call.id,
                    "name": call.name,
                    "input": call.input,
                    "ok": ok,
                    "result": result if ok else content,
                }
            )
        if waiting:
            yield _event({"type": "page_tools", "calls": waiting, "results": results})
            yield _event({"type": "done", "stop": "page_tools"})
            return
        tool_msg = {"role": "tool", "results": results}
        messages.append(tool_msg)
        yield _event({"type": "message", "message": tool_msg})
    yield _event({"type": "done", "stop": "max_steps"})


async def _run_tool(
    spec: Any, arguments: dict[str, Any], dataset: str | None
) -> tuple[str, bool, Any]:
    """Run one data tool; return ``(text for the model, ok, result)``."""
    from pydantic import ValidationError  # noqa: PLC0415

    from ..tools import BowserError  # noqa: PLC0415

    args = dict(arguments)
    params = spec.input_schema.get("properties", {})
    if dataset and "dataset" in params and not args.get("dataset"):
        args["dataset"] = dataset
    # Gemini sends a free-form object (a GeoJSON geometry) as JSON text.
    for name, value in list(args.items()):
        if isinstance(value, str) and params.get(name, {}).get("type") == "object":
            try:
                args[name] = json.loads(value)
            except ValueError:
                pass
    try:
        result = await spec.call(args)
    except ValidationError as e:
        problems = "; ".join(
            f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}"
            for err in e.errors()[:5]
        )
        return f"Invalid arguments: {problems}", False, None
    except BowserError as e:
        return str(e), False, None
    except Exception as e:  # noqa: BLE001  (the model should hear of it, not crash)
        return f"The tool failed: {type(e).__name__}: {e}"[:500], False, None
    text = json.dumps(result, separators=(",", ":"))
    if len(text) > RESULT_CHARS:
        text = text[:RESULT_CHARS] + " …(cut)"
    return text, True, result
