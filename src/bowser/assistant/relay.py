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
``BOWSER_ASSISTANT`` is set, and keys can be set from the page only
with ``BOWSER_ASSISTANT_PAGE_KEYS`` and from this computer. A hosted server sets
its own key (``BOWSER_AI_PROVIDER``/``BOWSER_AI_KEY`` or a provider's usual
variable) instead.

Signing in to an account (:mod:`.signin`) has the same gate as keys, and the
chat with a signed-in account answers this computer only: "Continue with
ChatGPT" (OAuth; its callback is ``GET /auth/callback``) runs the same tool loop
with the Responses API, and "Sign in with Claude" hands the conversation to the
user's Claude Code over ACP (:mod:`.acp`), with Bowser's MCP server as its tools
and its permission requests answered in the page (``POST /assistant/permission``).
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import hashlib
import html
import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .. import api_models as api
from . import acp, signin
from .keys import KeyStore, default_path
from .ollama import Ollama
from .providers import (
    CHATGPT,
    PRESETS,
    Preset,
    ProviderError,
    ResponsesProvider,
    open_provider,
    preset,
    valid_model,
)

#: Model replies per request before the loop stops (each may run tools).
MAX_STEPS = 12
#: Tool calls per question (data and page tools) before the loop stops; a call
#: like one already made costs double, the same call again is refused.
#: ``BOWSER_ASSISTANT_TOOL_BUDGET`` changes it.
TOOL_BUDGET = 8
#: Longest page context sent to the model (characters of JSON).
CONTEXT_CHARS = 2000
#: A tool result longer than this is cut (the model reads it on every turn).
RESULT_CHARS = 24_000
#: Seconds a provider's model list is kept (``GET /assistant/models``).
MODELS_TTL = 600.0
#: Model lists by (provider, a hash of the key): (time fetched, models).
_models_cache: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
#: Hosts a request "from this computer" comes from.
LOOPBACK = {"127.0.0.1", "::1", "localhost"}

SYSTEM = """\
You are the Assistant in Bowser's web page, next to the user's map and chart.
Answer with Bowser's tools: the data tools read the cube the page shows, and the
page tools act on the page (move the map, add a time-series point, set the
reference point or date, masks, colours, split screen, terrain, switch the layer,
open the chart, and the toolbar and panel commands).
Points and areas you read with the data tools are added to the map and chart for
the user automatically. Each user message starts with the page's state in
[page: ...]: use its layer, reference point and view unless the user asks for
something else. Keep answers short and plain; give numbers with their unit and
what they are relative to.

"""


SYSTEM_AGENT = """\
You are the Assistant in Bowser's web page, next to the user's map and chart.
Answer with the tools of the `bowser` MCP server: its data tools read the cube
the page shows, and its page tools act on the user's open page (move the map,
add points, set the reference, masks and colours, and the toolbar and panel
commands). Points and areas you read with the data tools are added to the
user's map and chart automatically. Each user message starts with
the page's state in [page: ...]: use its layer, dataset, reference point and
view unless the user asks for something else. Keep answers short and plain; give
numbers with their unit and what they are relative to.

"""

#: Network access for the OAuth sign-in and the agents' tools (tests replace it).
SIGNIN_TRANSPORT: Any = None


def get_settings() -> Any:
    """Return Bowser's settings (a dependency, so tests can give their own)."""
    from ..config import settings  # noqa: PLC0415

    return settings


def get_ollama() -> Ollama:
    """Return the server's Ollama (a dependency, so tests can give a fake)."""
    from .ollama import OLLAMA  # noqa: PLC0415

    return OLLAMA


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


def _ollama_state(
    settings: Any, ollama: Ollama, start: bool = True
) -> dict[str, Any] | None:
    """Return None when Ollama is not installed here, else its state.

    ``{"running": bool, "models": [...]}``. Ollama is started when it is not
    running, ``start`` is true and the server is on the user's own computer
    (``BOWSER_ASSISTANT_PAGE_KEYS``); a shared server only uses one already
    running.
    """
    if not settings.BOWSER_ASSISTANT or not ollama.binary():
        return None
    up = ollama.ensure(start=start and bool(settings.BOWSER_ASSISTANT_PAGE_KEYS))
    return {"running": up, "models": ollama.models() if up else []}


def assistant_config(settings: Any, ollama: Ollama | None = None) -> dict[str, Any]:
    """Return the Assistant's entry of ``GET /config``.

    Reads the key file's index only (never the keychain) and looks for the
    ``ollama`` program without starting it, so it is cheap.
    """
    if not settings.BOWSER_ASSISTANT:
        return {
            "enabled": False,
            "providers": [],
            "configured": [],
            "sign_in": [],
            "page_channel": False,
        }
    store = key_store(settings)
    installed = (ollama or get_ollama()).binary() is not None
    providers = [p for p in PRESETS if p.available and (p.id != "ollama" or installed)]
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
        "sign_in": [m.id for m in signin.METHODS]
        if settings.BOWSER_ASSISTANT_PAGE_KEYS
        else [],
        "page_channel": bool(settings.BOWSER_ASSISTANT_PAGE_KEYS),
    }


def _status(settings: Any, local: dict[str, Any] | None) -> dict[str, Any]:
    """Return ``GET /assistant/status``; ``local`` is :func:`_ollama_state`."""
    enabled = bool(settings.BOWSER_ASSISTANT)
    page_keys = enabled and bool(settings.BOWSER_ASSISTANT_PAGE_KEYS)
    store = key_store(settings)
    out = []
    for p in PRESETS if enabled else ():
        models, available, note = list(p.models), p.available, p.note
        model = p.model
        if p.id == "ollama":
            if local is None:  # not installed here: not offered at all
                continue
            models = local["models"]
            available = bool(models)
            if not local["running"]:
                note = "Ollama did not start."
            elif not models:
                note = "No local models are installed."
            model = p.model if p.model in models else (models or [p.model])[0]
        saved = store.describe(p.id) if page_keys else {"saved": False}
        env = _env_key(settings, p)
        source = "saved" if saved["saved"] else "environment" if env else None
        if settings.BOWSER_AI_PROVIDER == p.id and settings.BOWSER_AI_MODEL:
            model = settings.BOWSER_AI_MODEL
        out.append(
            {
                "id": p.id,
                "label": p.label,
                "wire": p.wire,
                "model": model,
                "models": models,
                "needs_key": p.needs_key,
                "local": p.local,
                "auth": p.auth,
                "available": available,
                "note": note,
                "key_url": p.key_url,
                "configured": available and (bool(source) or not p.needs_key),
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


def _from_this_computer(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in LOOPBACK or host.startswith("127.")


def _require_page_keys(settings: Any, request: Request) -> None:
    _require_enabled(settings)
    if not settings.BOWSER_ASSISTANT_PAGE_KEYS:
        raise HTTPException(
            status_code=403,
            detail="Keys cannot be set from the page on this server; its "
            "administrator sets them.",
        )
    if not _from_this_computer(request):
        raise HTTPException(
            status_code=403,
            detail="Keys can only be set on the computer that runs Bowser.",
        )


def _sign_in_gate(settings: Any, request: Request) -> str | None:
    """Why signing in is not possible for this request, or None."""
    if not settings.BOWSER_ASSISTANT:
        return "The Assistant is off on this server."
    if not settings.BOWSER_ASSISTANT_PAGE_KEYS:
        return (
            "Signing in works when Bowser runs on your own computer (bowser run, "
            "bowser lite or the desktop app); this server uses its own key."
        )
    if not _from_this_computer(request):
        return "Signing in works only on the computer that runs Bowser."
    return None


def _require_sign_in(settings: Any, request: Request) -> None:
    why = _sign_in_gate(settings, request)
    if why:
        raise HTTPException(status_code=403, detail=why)


def _method(method_id: str) -> signin.Method:
    m = signin.method(method_id)
    if m is None:
        raise HTTPException(status_code=400, detail=f"No sign-in {method_id!r}.")
    return m


async def _sign_in_status(settings: Any, request: Request) -> dict[str, Any]:
    """Return the ``sign_in`` part of the status: each method and its state."""
    why = _sign_in_gate(settings, request)
    if why:
        return {"allowed": False, "reason": why, "methods": []}
    store = key_store(settings)
    out = []
    for m in signin.METHODS:
        out.append(await _method_status(m, store))
    return {"allowed": True, "reason": None, "methods": out}


async def _method_status(m: signin.Method, store: KeyStore) -> dict[str, Any]:
    rec = await asyncio.to_thread(store.account, m.id)
    entry: dict[str, Any] = {
        "id": m.id,
        "label": m.label,
        "kind": m.kind,
        "vendor": m.vendor,
        "blurb": m.blurb,
        "state": "signed_out",
        "account": None,
        "plan": None,
        "detail": None,
        "install_url": None,
        "usage_url": None,
        "model": "",
        "models": [],
    }
    if m.oauth is not None:
        entry["usage_url"] = m.oauth.usage_url or None
        if rec.get("signed_in"):
            entry["account"] = rec.get("email") or None
            if rec.get("plan"):
                entry["state"] = "signed_in"
                entry["plan"] = "ChatGPT plan"
            else:
                entry["state"] = "no_plan"
                entry["detail"] = (
                    "Your ChatGPT plan was not allowed for Bowser. Continue again "
                    "and allow it, or use an API key."
                )
            models = [x["slug"] for x in rec.get("models") or [] if isinstance(x, dict)]
            entry["models"] = models
            entry["model"] = models[0] if models else ""
        elif signin.pending_for(m.id):
            entry["state"] = "pending"
        return entry
    agent = m.agent
    assert agent is not None
    entry["install_url"] = agent.install_url
    login = signin.login_state(m)
    if login is not None and login.running and not login.error:
        entry["state"] = "pending"
        return entry
    state = await signin.agent_state(m, fresh=login is not None)
    if login is not None:
        signin.end_login(m)
        if not state.signed_in:
            entry["detail"] = login.error or (
                f"Signing in did not finish. If no {m.vendor} page opened, sign "
                f"in to {agent.program} once in a terminal on this computer."
            )
        else:
            await asyncio.to_thread(store.set_account, m.id, connected=True)
            rec["connected"] = True
    if not state.installed:
        entry["state"] = "not_installed"
        entry["detail"] = state.detail
    elif state.signed_in and rec.get("connected"):
        entry["state"] = "signed_in"
        entry["account"] = state.account
        entry["plan"] = state.plan
    elif state.detail:
        entry["detail"] = state.detail
    return entry


async def _full_status(
    settings: Any, request: Request, local: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return the status: providers (``local``: Ollama's state) and sign-ins."""
    return {
        **_status(settings, local),
        "sign_in": await _sign_in_status(settings, request),
    }


def _preset(provider_id: str) -> Preset:
    p = preset(provider_id)
    if p is None:
        raise HTTPException(status_code=400, detail=f"No provider {provider_id!r}.")
    if not p.available:
        raise HTTPException(status_code=400, detail=f"{p.label}: {p.note}")
    return p


class KeyBody(BaseModel):
    """``PUT /assistant/key``."""

    model_config = ConfigDict(extra="forbid")

    provider: str = Field(description="Provider id, e.g. anthropic.")
    key: str = Field(min_length=8, max_length=400, description="The API key.")


class ChatBody(BaseModel):
    """``POST /assistant/chat``."""

    provider: str
    model: str = ""
    conversation: str | None = Field(
        None,
        pattern=r"^[A-Za-z0-9_-]{1,64}$",
        description="The page's id for this chat (keeps a signed-in agent's "
        "session between questions).",
    )
    messages: list[dict[str, Any]] = Field(min_length=1, max_length=400)
    page_tools: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    dataset: str | None = Field(
        None, description="The page's catalog dataset id, for the data tools."
    )
    page_masks: list[dict[str, Any]] | None = Field(
        None,
        max_length=20,
        description="The page's layer masks ({dataset, threshold, mode}), applied "
        "by the data tools that take use_page_masks.",
    )
    auto_allow: bool = Field(
        False,
        description="A signed-in agent runs Bowser's own tools without asking.",
    )
    page_context: dict[str, Any] | None = Field(
        None,
        description="What the page shows now (view, layer, date, reference, "
        "masks, points, split screen, terrain, selection), told to the model "
        "with this question.",
    )


class SignInBody(BaseModel):
    """``POST /assistant/signin``."""

    model_config = ConfigDict(extra="forbid")

    method: str = Field(description="Sign-in id, e.g. chatgpt or claude.")
    consent: bool = Field(
        False, description="Ask the provider to show its consent page again."
    )


class PermissionBody(BaseModel):
    """``POST /assistant/permission``."""

    model_config = ConfigDict(extra="forbid")

    conversation: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    id: str = Field(max_length=40, description="The permission event's id.")
    choice: str = Field(pattern=r"^(allow|allow_always|reject)$")


class StopBody(BaseModel):
    """``POST /assistant/stop``."""

    model_config = ConfigDict(extra="forbid")

    conversation: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{1,64}$")


@asynccontextmanager
async def _lifespan(_app: Any):
    """Kill the agents when the server stops."""
    yield
    await acp.stop()


atexit.register(acp.kill_all_now)

router = APIRouter(lifespan=_lifespan)


@router.get(
    "/assistant/status",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("GET /assistant/status"),
)
async def assistant_status(
    request: Request,
    settings: Any = Depends(get_settings),
    ollama: Ollama = Depends(get_ollama),
):
    """Return the providers, which have a key (never the key) and the sign-ins."""
    local = await asyncio.to_thread(_ollama_state, settings, ollama)
    return await _full_status(settings, request, local)


@router.put(
    "/assistant/key",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("PUT /assistant/key"),
)
async def assistant_key_set(
    request: Request,
    body: KeyBody = Body(..., examples=[{"provider": "anthropic", "key": "sk-..."}]),
    settings: Any = Depends(get_settings),
    ollama: Ollama = Depends(get_ollama),
):
    """Check a key with its provider and keep it on this computer."""
    _require_page_keys(settings, request)
    p = _preset(body.provider)
    if p.auth != "api_key":
        raise HTTPException(status_code=400, detail=f"{p.label} takes no API key.")
    key = body.key.strip()
    provider = open_provider(p, "", key)
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
    store_kind = await asyncio.to_thread(key_store(settings).save, p.id, key)
    stored_in = (
        "the system keychain" if store_kind == "keyring" else "a file only you can read"
    )
    local = await asyncio.to_thread(_ollama_state, settings, ollama, False)
    return {**(await _full_status(settings, request, local)), "stored_in": stored_in}


@router.delete(
    "/assistant/key",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("DELETE /assistant/key"),
)
async def assistant_key_remove(
    request: Request,
    provider: str = Query(..., description="Provider id, e.g. anthropic."),
    settings: Any = Depends(get_settings),
    ollama: Ollama = Depends(get_ollama),
):
    """Forget a provider's saved key."""
    _require_page_keys(settings, request)
    p = _preset(provider)
    await asyncio.to_thread(key_store(settings).remove_key, p.id)
    local = await asyncio.to_thread(_ollama_state, settings, ollama, False)
    return await _full_status(settings, request, local)


@router.get(
    "/assistant/models",
    responses={200: {"model": api.AssistantModels}},
    **api.route_doc("GET /assistant/models"),
)
async def assistant_models(
    provider: str = Query(..., description="Provider id, e.g. anthropic."),
    refresh: bool = Query(False, description="Ask the provider again now."),
    settings: Any = Depends(get_settings),
    ollama: Ollama = Depends(get_ollama),
):
    """Return the provider's own model list, fetched with its key (never shown)."""
    _require_enabled(settings)
    p = _preset(provider)
    if p.id == "ollama":
        local = await asyncio.to_thread(_ollama_state, settings, ollama)
        if local is None:
            raise HTTPException(
                status_code=400, detail="Ollama is not installed on this computer."
            )
        models = [{"id": m, "label": None} for m in local["models"]]
        return {"provider": p.id, "models": models, "cached": False}
    store = key_store(settings)
    key, _ = await asyncio.to_thread(_key, settings, store, p)
    if p.needs_key and not key:
        raise HTTPException(
            status_code=400, detail=f"Add an API key for {p.label} first."
        )
    slot = (p.id, hashlib.sha256((key or "").encode()).hexdigest())
    hit = _models_cache.get(slot)
    if hit and not refresh and time.monotonic() - hit[0] < MODELS_TTL:
        return {"provider": p.id, "models": hit[1], "cached": True}
    try:
        models = await open_provider(p, "", key).list_models()
    except ProviderError as e:
        status = 401 if e.kind == "auth" else 502
        raise HTTPException(
            status_code=status, detail=f"Could not list the models: {e}"
        ) from e
    _models_cache[slot] = (time.monotonic(), models)
    return {"provider": p.id, "models": models, "cached": False}


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
    ollama: Ollama = Depends(get_ollama),
):
    """Run the conversation with the provider; stream events (SSE)."""
    _require_enabled(settings)
    if signin.method(body.provider) is not None:
        return await _signed_in_chat(request, body, settings)
    p = _preset(body.provider)
    if p.id == "ollama":
        local = await asyncio.to_thread(_ollama_state, settings, ollama)
        if local is None:
            raise HTTPException(
                status_code=400, detail="Ollama is not installed on this computer."
            )
        if not local["running"]:
            raise HTTPException(status_code=502, detail="Ollama did not start.")
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
    provider = open_provider(p, model, key)
    tools = _data_tools(
        request, bool(settings.BOWSER_ASSISTANT_PAGE_KEYS), body.page_masks
    )
    page = _page_tools(body.page_tools, tools)
    return EventStream(
        run_chat(
            provider,
            body.messages,
            tools,
            page,
            body.dataset,
            body.page_context,
            tool_budget(settings),
        ),
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def _signed_in_chat(request: Request, body: ChatBody, settings: Any):
    """Chat with a signed-in account: ChatGPT's tool loop, or an agent."""
    _require_sign_in(settings, request)
    m = _method(body.provider)
    store = key_store(settings)
    headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
    if m.kind == "oauth":
        assert m.oauth is not None
        rec = await asyncio.to_thread(store.account, m.id)
        if not rec.get("signed_in"):
            raise HTTPException(status_code=400, detail=f"{m.label} first.")
        if not rec.get("plan"):
            raise HTTPException(
                status_code=403,
                detail="Your ChatGPT plan is not allowed for Bowser; continue "
                "with ChatGPT again and allow it.",
            )
        listed = {x["slug"]: x for x in rec.get("models") or [] if isinstance(x, dict)}
        model = body.model.strip() or next(iter(listed), "")
        if not valid_model(model):
            raise HTTPException(status_code=400, detail="Choose a model.")
        try:
            token = await signin.access_token(m, store, SIGNIN_TRANSPORT)
        except signin.SignInError as e:
            raise HTTPException(status_code=401, detail=str(e)) from e
        reasoning = bool(listed.get(model, {}).get("reasoning", True))
        provider = ResponsesProvider(
            CHATGPT,
            model,
            token,
            m.oauth.api_url,
            SIGNIN_TRANSPORT,
            reasoning=reasoning,
        )
        tools = _data_tools(request, True, body.page_masks)
        page = _page_tools(body.page_tools, tools)
        return EventStream(
            run_chat(
                provider,
                body.messages,
                tools,
                page,
                body.dataset,
                body.page_context,
                tool_budget(settings),
            ),
            headers=headers,
        )
    if not body.conversation:
        raise HTTPException(status_code=400, detail="Give the chat's id.")
    await _require_agent(m, store)
    tools = _data_tools(request, True)
    slot = _warm(m, store, request, body.conversation, tools)
    return EventStream(
        run_agent(
            body,
            slot,
            budget=tool_budget(settings),
            quiet={name for name, t in tools.items() if t.quiet},
            permission_seconds=permission_seconds(settings),
        ),
        headers=headers,
    )


def permission_seconds(settings: Any) -> float:
    """Return the seconds an agent's permission request waits for the page."""
    return float(
        getattr(settings, "BOWSER_ASSISTANT_PERMISSION_SECONDS", 0)
        or acp.PERMISSION_SECONDS
    )


async def _require_agent(m: signin.Method, store: KeyStore) -> None:
    """Refuse unless the agent is installed, signed in and chosen here."""
    state = await signin.agent_state(m)
    rec = await asyncio.to_thread(store.account, m.id)
    if not (state.installed and state.signed_in and rec.get("connected")):
        raise HTTPException(status_code=400, detail=f"{m.label} first.")


async def _agent_argv(
    m: signin.Method, on_install: Any = None
) -> tuple[list[str], dict[str, str], str | None]:
    """Return the agent's command, its extra variables and a note.

    The variables are added to the minimal environment; the note is set when the
    slower npx stands in for the installed adapter.
    """
    spec = m.agent
    assert spec is not None
    program = signin.find_program(spec.program)
    if program is None:
        raise acp.AgentError(f"{spec.program} is not installed.")
    if not spec.adapter:
        return [program], {}, None
    try:
        argv, note = await signin.adapter_command(spec, on_install)
    except signin.SignInError as e:
        raise acp.AgentError(str(e)) from e
    extra = {spec.program_env: program} if spec.program_env else {}
    return argv, extra, note


def _warm(
    m: signin.Method,
    store: KeyStore,
    request: Request,
    conversation: str,
    tools: dict[str, Any],
) -> acp.Slot:
    """Start (or find) the conversation's agent session, in the background.

    The session gets Bowser's MCP server (this server's data and page tools)
    and Bowser's instructions; ``tools`` are those tools, by name, so the
    agent's calls to them are recognised and say what they are doing.
    """
    from ..tools import INSTRUCTIONS  # noqa: PLC0415

    spec = m.agent
    assert spec is not None
    known = set(tools)
    command, args, mcp_env = signin.mcp_command(_self_url(request))
    name = spec.name or f"{m.vendor}'s agent"
    starting = f"Starting {name}…"

    install_text = f"Installing {m.vendor}'s adapter (first time only)…"

    def installing(slot: acp.Slot) -> None:
        slot.phase, slot.text = "installing", install_text

    async def prepare(slot: acp.Slot) -> acp.AgentSession:
        argv, extra, note = await _agent_argv(m, lambda: installing(slot))
        slot.note = note
        slot.phase, slot.text = "starting", starting
        session = acp.AgentSession(
            argv,
            signin.agent_env(extra),
            str(await asyncio.to_thread(signin.workdir, store)),
            spec.name or m.vendor,
            known,
        )
        slot.session = session
        await session.start(
            {"command": command, "args": args, "env": mcp_env},
            SYSTEM_AGENT + INSTRUCTIONS,
        )
        return session

    labels = {name: t.status_text for name, t in tools.items()}
    first_time = bool(spec.adapter) and signin.installed_adapter(spec) is None
    if first_time and signin.find_program("node"):
        slot = acp.open_session(conversation, prepare, "installing", install_text)
    else:
        slot = acp.open_session(conversation, prepare, "starting", starting)
    slot.labels = labels
    return slot


def _self_url(request: Request) -> str:
    """Return this server's URL as the agent's MCP server reaches it (loopback)."""
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    return f"{request.url.scheme}://127.0.0.1:{port}"


def _transcript(messages: list[dict[str, Any]]) -> str:
    """Return the user's last message, after the earlier ones for a new agent."""
    said = [
        (m["role"], str(m.get("content") or ""))
        for m in messages
        if m.get("role") in ("user", "assistant") and m.get("content")
    ]
    if not said:
        return ""
    *before, last = said
    if not before:
        return last[1]
    earlier = "\n\n".join(f"{who}: {text}" for who, text in before)[-20_000:]
    return f"Earlier in this chat:\n{earlier}\n\nNow the user asks:\n{last[1]}"


async def run_agent(
    body: ChatBody,
    slot: acp.Slot,
    *,
    budget: int = TOOL_BUDGET,
    quiet: set[str] | None = None,
    permission_seconds: float = acp.PERMISSION_SECONDS,
) -> AsyncIterator[str]:
    """Hand the question to the signed-in agent; yield server-sent events.

    The session comes from ``slot`` (started by :func:`_warm`). Each question
    sets its own limits on it: ``budget`` tool calls, the ``quiet`` tools that
    never ask, the seconds a permission request waits and the page's
    auto-allow toggle; the page's state goes before the question as
    ``[page: ...]``.

    Waits for the agent's session when it is still starting (a ``status`` event
    each second, with the phase and the seconds so far).
    """
    conv = body.conversation or ""
    finished = False
    try:
        while slot.task is not None and not slot.task.done():
            yield _event({"type": "status", **slot.state()})
            await asyncio.wait({slot.task}, timeout=1.0)
        session = acp.SESSIONS.get(conv)
        if slot.phase != "ready" or session is None or not session.alive:
            why = slot.error or "The agent did not start."
            yield _event({"type": "error", "kind": "agent", "message": why})
            finished = True
            return
        if session.busy:
            yield _event(
                {"type": "error", "kind": "busy", "message": "Still answering."}
            )
            finished = True
            return
        if session.turns == 0:
            text = _transcript(body.messages)
        else:
            last = body.messages[-1]
            text = str(last.get("content") or "") if last.get("role") == "user" else ""
        if not text:
            yield _event(
                {"type": "error", "kind": "bad_request", "message": "Ask something."}
            )
            finished = True
            return
        session.auto_allow = body.auto_allow
        session.budget = budget
        session.quiet = quiet or set()
        session.permission_seconds = permission_seconds
        context = page_context_text(body.page_context)
        if context:
            text = f"[page: {context}]\n\n{text}"
        acp.hold(conv)
        async for event in session.prompt(text):
            if event["type"] == "tool_call":
                event["status"] = slot.labels.get(event["name"], event["name"])
            if event["type"] == "done":
                answer = event.pop("text", "")
                yield _event(
                    {
                        "type": "message",
                        "message": {"role": "assistant", "content": answer},
                    }
                )
            yield _event(event)
        acp.arm_idle(conv)
        finished = True
    finally:
        if not finished:
            # The page went away (Stop, closed tab): end the agent too.
            with contextlib.suppress(Exception):
                await acp.stop(conv)


def _data_tools(
    request: Request,
    page_keys: bool,
    page_masks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return Bowser's tools, the data tools calling this app in-process.

    The page tools are among them (``spec.page``): the page runs those. A tool
    that writes files (``export_geotiff``) is offered only where the page may set
    keys, i.e. on the user's own computer. ``page_masks`` are the page's masks,
    which the data tools apply by default.
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
    bowser.page_masks = page_masks
    return {
        s.name: s for s in build_tools(bowser) if s.read_only or s.page or page_keys
    }


def _page_tools(specs: list[dict[str, Any]], tools: dict[str, Any]) -> list[dict]:
    """Return the page tools: Bowser's own, and any extra the page sends.

    The page's specs are checked (a name, a description and an object schema);
    one with the name of a Bowser page tool is left out (Bowser's spec is used).
    """
    out = [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema}
        for t in tools.values()
        if t.page
    ]
    own = {t["name"] for t in out}
    taken = set(tools)
    for s in specs:
        name = s.get("name")
        if name in own:
            continue
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


def tool_budget(settings: Any) -> int:
    """Return the tool calls allowed per question."""
    value = getattr(settings, "BOWSER_ASSISTANT_TOOL_BUDGET", 0)
    return int(value) if value and int(value) > 0 else TOOL_BUDGET


def page_context_text(context: dict[str, Any] | None) -> str:
    """Return the page's context as compact JSON, cut to :data:`CONTEXT_CHARS`."""
    if not context:
        return ""
    text = json.dumps(context, separators=(",", ":"), default=str)
    return text if len(text) <= CONTEXT_CHARS else text[:CONTEXT_CHARS] + "…"


def _call_keys(name: str, args: Any) -> tuple[str, str]:
    """Return ``(exact, near)`` keys of a tool call: near rounds numbers to ~100 m."""

    def near(v: Any) -> Any:
        if isinstance(v, float):
            return round(v, 3)
        if isinstance(v, dict):
            return {k: near(x) for k, x in v.items()}
        if isinstance(v, list):
            return [near(x) for x in v]
        return v

    exact = json.dumps([name, args], sort_keys=True, default=str)
    return exact, json.dumps([name, near(args)], sort_keys=True, default=str)


class ToolBudget:
    """The tool calls of one question: what they cost and which were made.

    Each call costs 1, a call like an earlier one (numbers within ~100 m) 2, and
    the same call again is refused. ``messages`` are the conversation so far:
    the calls since the user's last message count (the question may span
    several requests when the page runs tools).
    """

    def __init__(
        self, limit: int, messages: list[dict[str, Any]] | None = None
    ) -> None:
        """Start with the calls already made for this question in ``messages``."""
        self.limit = limit
        self.used = 0
        self.exact: set[str] = set()
        self.near: set[str] = set()
        messages = list(messages or [])
        last_user = max(
            (i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1
        )
        for m in messages[last_user + 1 :]:
            if m.get("role") == "assistant":
                for c in m.get("tool_calls") or []:
                    self.charge(str(c.get("name")), c.get("input"))

    def charge(self, name: str, args: Any) -> str | None:
        """Count a call; return why it is refused, or None."""
        exact, near = _call_keys(name, args)
        if exact in self.exact:
            return (
                f"Not run: {name} was already called with these arguments for this "
                "question; use that result."
            )
        cost = 2 if near in self.near else 1
        if self.used + cost > self.limit:
            self.used = max(self.used, self.limit)
            return (
                f"Not run: the limit of {self.limit} tool calls for one question is "
                "reached. Answer with what you have, or ask the user (for example to "
                "click the place on the map)."
            )
        self.used += cost
        self.exact.add(exact)
        self.near.add(near)
        return None

    @property
    def spent(self) -> bool:
        """Whether no call is left."""
        return self.used >= self.limit


async def run_chat(
    provider: Any,
    messages: list[dict[str, Any]],
    tools: dict[str, Any],
    page_tools: list[dict],
    dataset: str | None = None,
    page_context: dict[str, Any] | None = None,
    budget: int = TOOL_BUDGET,
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
    page_context : dict, optional
        What the page shows now, told to the model in the system prompt.
    budget : int
        Tool calls allowed for this question (see :class:`ToolBudget`).

    """
    from ..tools import INSTRUCTIONS  # noqa: PLC0415

    system = SYSTEM + INSTRUCTIONS
    context = page_context_text(page_context)
    if context:
        system += (
            "\n\nThe page now (use it for 'here', 'this area', 'the middle of the "
            f"view', 'my point'; no tool call needed): {context}"
        )
    spend = ToolBudget(budget, messages)
    told = spend.spent
    refused_before = False
    if told:
        system += (
            f"\n\nNo tool calls are left for this question (limit {spend.limit}): "
            "answer now with what you have, or ask the user."
        )
    page_names = {t["name"] for t in page_tools}
    specs = [
        {"name": s.name, "description": s.description, "input_schema": s.input_schema}
        for s in tools.values()
        if s.name not in page_names
    ] + page_tools
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
            err = {"type": "error", "kind": e.kind, "message": str(e)}
            if e.code:
                err["code"] = e.code
            yield _event(err)
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
        refused = 0
        for call in turn.tool_calls:
            spec = tools.get(call.name)
            why = spend.charge(call.name, call.input)
            if why is None and call.name in page_names:
                page_call = {"id": call.id, "name": call.name, "input": call.input}
                if spec is not None:
                    page_call["status"] = spec.status_text
                waiting.append(page_call)
                continue
            yield _event(
                {
                    "type": "tool_call",
                    "id": call.id,
                    "name": call.name,
                    "input": call.input,
                    "runs": "server",
                    "status": spec.status_text if spec else call.name,
                }
            )
            if why is not None:
                content, ok, result = why, False, None
                refused += 1
            elif spec is None:
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
        if spend.spent and not told:
            told = True
            yield _event({"type": "budget", "limit": spend.limit})
            system += (
                f"\n\nNo tool calls are left for this question (limit {spend.limit}): "
                "answer now with what you have, or ask the user."
            )
        if waiting:
            yield _event({"type": "page_tools", "calls": waiting, "results": results})
            yield _event({"type": "done", "stop": "page_tools"})
            return
        tool_msg = {"role": "tool", "results": results}
        messages.append(tool_msg)
        yield _event({"type": "message", "message": tool_msg})
        if told and refused == len(turn.tool_calls) and refused_before:
            # Told twice and still calling tools: stop here.
            yield _event({"type": "done", "stop": "budget"})
            return
        refused_before = told and refused == len(turn.tool_calls)
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


# --- signing in ---------------------------------------------------------------------


@router.post(
    "/assistant/signin",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("POST /assistant/signin"),
)
async def assistant_sign_in(
    request: Request,
    body: SignInBody,
    settings: Any = Depends(get_settings),
    ollama: Ollama = Depends(get_ollama),
):
    """Start signing in; for OAuth, return the provider's page for the browser."""
    _require_sign_in(settings, request)
    m = _method(body.method)
    store = key_store(settings)
    url = None
    if m.kind == "oauth":
        port = request.url.port or 80
        redirect = f"http://127.0.0.1:{port}{signin.CALLBACK_PATH}"
        url = await asyncio.to_thread(signin.begin, m, store, redirect, body.consent)
    else:
        state = await signin.agent_state(m, fresh=True)
        if not state.installed:
            raise HTTPException(
                status_code=400,
                detail=f"{m.agent.program if m.agent else m.id} is not installed.",
            )
        if state.signed_in:
            await asyncio.to_thread(store.set_account, m.id, connected=True)
        else:
            try:
                await asyncio.to_thread(signin.start_login, m)
            except (OSError, signin.SignInError) as e:
                raise HTTPException(status_code=500, detail=str(e)) from e
    local = await asyncio.to_thread(_ollama_state, settings, ollama, False)
    return {**(await _full_status(settings, request, local)), "sign_in_url": url}


@router.delete(
    "/assistant/signin",
    responses={200: {"model": api.AssistantStatus}},
    **api.route_doc("DELETE /assistant/signin"),
)
async def assistant_sign_out(
    request: Request,
    method: str = Query(..., description="Sign-in id, e.g. chatgpt."),
    settings: Any = Depends(get_settings),
    ollama: Ollama = Depends(get_ollama),
):
    """Sign out: revoke and forget the tokens, or stop using the agent."""
    _require_sign_in(settings, request)
    m = _method(method)
    store = key_store(settings)
    note = None
    if m.kind == "oauth":
        signin.cancel_pending(m.id)
        revoked = await signin.sign_out(m, store, SIGNIN_TRANSPORT)
        if not revoked:
            note = (
                "Signed out here, but OpenAI did not confirm it; disconnect Bowser "
                "in ChatGPT's settings to be sure."
            )
    else:
        signin.end_login(m)
        await acp.stop()
        await asyncio.to_thread(store.set_account, m.id, connected=None)
    local = await asyncio.to_thread(_ollama_state, settings, ollama, False)
    return {**(await _full_status(settings, request, local)), "note": note}


_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bowser</title><style>body{{font:15px/1.5 system-ui,sans-serif;margin:15vh auto;
max-width:30em;padding:0 16px;color:#222;background:#fff}}h1{{font-size:20px}}
@media (prefers-color-scheme:dark){{body{{color:#eee;background:#1e1e1e}}}}</style>
</head><body><h1>{title}</h1><p>{text}</p>
<script>setTimeout(function(){{window.close()}},{close})</script></body></html>"""


def _page(title: str, text: str, status: int = 200, close: int = 1500) -> HTMLResponse:
    return HTMLResponse(
        _PAGE.format(title=html.escape(title), text=html.escape(text), close=close),
        status_code=status,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@router.get(
    signin.CALLBACK_PATH,
    response_class=HTMLResponse,
    include_in_schema=True,
    **api.route_doc("GET /auth/callback"),
)
async def assistant_sign_in_callback(
    request: Request, settings: Any = Depends(get_settings)
):
    """Where the provider's sign-in page sends the browser back."""
    if _sign_in_gate(settings, request):
        return _page("Not here", "Sign-in is not possible on this server.", 403)
    params = {k: v for k, v in request.query_params.items() if isinstance(v, str)}
    pending = signin.take_pending(params.get("state", ""))
    if pending is None:
        return _page(
            "Sign-in expired",
            "This sign-in is not the one Bowser started, or it is too old. Go back "
            "to Bowser and try again.",
            400,
            close=60_000,
        )
    m = _method(pending.method)
    store = key_store(settings)
    try:
        await signin.complete(m, store, pending, params, SIGNIN_TRANSPORT)
    except signin.SignInError as e:
        return _page(
            "Not signed in", f"{e} Go back to Bowser and try again.", 400, 60_000
        )
    return _page("Signed in", "You can close this tab and go back to Bowser.")


@router.post(
    "/assistant/permission",
    responses={200: {"model": api.AssistantAnswered}},
    **api.route_doc("POST /assistant/permission"),
)
async def assistant_permission(
    request: Request, body: PermissionBody, settings: Any = Depends(get_settings)
):
    """Answer an agent's request to run a tool."""
    _require_sign_in(settings, request)
    session = acp.SESSIONS.get(body.conversation)
    if session is None or not session.answer(body.id, body.choice):
        raise HTTPException(status_code=404, detail="That request is no longer open.")
    return {"ok": True}


@router.post(
    "/assistant/stop",
    responses={200: {"model": api.AssistantStopped}},
    **api.route_doc("POST /assistant/stop"),
)
async def assistant_stop(
    request: Request, body: StopBody, settings: Any = Depends(get_settings)
):
    """Stop a chat's agent (Stop, New chat): its process is killed."""
    _require_enabled(settings)
    if not _from_this_computer(request):
        raise HTTPException(status_code=403, detail="Only from this computer.")
    return {"stopped": await acp.stop(body.conversation)}


class AgentBody(BaseModel):
    """``POST /assistant/agent``."""

    model_config = ConfigDict(extra="forbid")

    conversation: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")


@router.post(
    "/assistant/agent",
    responses={200: {"model": api.AssistantAgent}},
    **api.route_doc("POST /assistant/agent"),
)
async def assistant_agent_start(
    request: Request, body: AgentBody, settings: Any = Depends(get_settings)
):
    """Start the signed-in agent for a chat now, before its first question."""
    _require_sign_in(settings, request)
    m = next((x for x in signin.METHODS if x.kind == "local_agent"), None)
    if m is None:
        raise HTTPException(status_code=400, detail="No agent to sign in with.")
    store = key_store(settings)
    await _require_agent(m, store)
    tools = _data_tools(request, True)
    return _warm(m, store, request, body.conversation, tools).state()


@router.get(
    "/assistant/agent",
    responses={200: {"model": api.AssistantAgent}},
    **api.route_doc("GET /assistant/agent"),
)
async def assistant_agent_state(
    request: Request,
    conversation: str = Query(..., pattern=r"^[A-Za-z0-9_-]{1,64}$"),
    settings: Any = Depends(get_settings),
):
    """Say how far the chat's agent has started (``none`` when not at all)."""
    _require_sign_in(settings, request)
    slot = acp.SLOTS.get(conversation)
    if slot is None:
        return {
            "phase": "none",
            "text": "",
            "elapsed": 0.0,
            "error": None,
            "note": None,
        }
    return slot.state()
