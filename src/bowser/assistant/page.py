"""The page channel: Bowser's tools act on the page the user has open.

The page opens a server-sent-events stream (``GET /page/events``) with a random
page id, says when it has the focus (``POST /page/focus``) and answers each
command it receives (``POST /page/result``). A server-side tool, such as one of
``bowser mcp``'s page tools (a separate process, maybe started by a signed-in
Claude), sends a command with ``POST /page/command`` and waits for the page's
answer, up to :data:`TIMEOUT` seconds.

Which page: the most recently focused one (or, when none has had the focus yet,
the most recently opened), so with several tabs open only the one the user last
looked at acts.

Security, the same gate as keys from the page: nothing works unless
``BOWSER_ASSISTANT`` and ``BOWSER_ASSISTANT_PAGE_KEYS`` are set, and every
request must come from this computer (loopback). The page's routes refuse a
request from another web origin (the server allows any origin for its data
API, so a web page elsewhere could otherwise listen in); commands are refused
from any browser (a request with an ``Origin`` or ``Sec-Fetch-*`` header), and
need the server's page token (:mod:`bowser.page_token`): a random token written
to a private file when the server starts, which ``bowser mcp`` on the same
computer reads, so only Bowser's own tools can send them, never a page.
Commands, results, pages and waiting commands are all bounded in number, size
and rate.

One server process holds the channel: like the Assistant's agents, it needs a
single-worker server, which is what ``bowser run`` and ``bowser lite`` start on
the user's own computer.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import secrets
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import api_models as api
from .. import page_token
from ..geocode import ATTRIBUTION, GEOCODER, GeocodeError
from ..tools import PAGE_COMMANDS
from .relay import EventStream, _from_this_computer, _require_enabled, get_settings

#: Seconds a command waits for the page's answer.
TIMEOUT = 10.0
#: Seconds between keep-alive comments on an idle stream.
PING_SECONDS = 15.0
#: Most pages connected at once (the least recently seen is dropped).
MAX_PAGES = 16
#: Most commands waiting for an answer at once.
MAX_PENDING = 8
#: Most commands per :data:`RATE_WINDOW` seconds.
MAX_RATE = 20
RATE_WINDOW = 1.0
#: Largest command input and page answer (bytes of JSON).
MAX_INPUT = 8_000
MAX_RESULT = 200_000
#: Commands a tool may send: the page tools that ``bowser mcp`` offers.
COMMANDS = PAGE_COMMANDS
PAGE_ID = r"^[A-Za-z0-9_-]{8,64}$"


@dataclass
class Page:
    """One open page: its stream's queue and when it last had the focus."""

    id: str
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    opened: float
    focused: float = 0.0
    seen: float = 0.0
    closed: bool = False
    waiting: set[str] = field(default_factory=set)

    def send(self, msg: dict[str, Any]) -> None:
        """Queue ``msg`` for the page's stream (from any thread or loop)."""
        self.loop.call_soon_threadsafe(self.queue.put_nowait, msg)


@dataclass
class Pending:
    """A command waiting for its page's answer."""

    page: str
    future: asyncio.Future


#: Open pages by id.
PAGES: dict[str, Page] = {}
#: Commands waiting for an answer, by command id.
PENDING: dict[str, Pending] = {}
_sent: deque[float] = deque()


def reset() -> None:
    """Forget every page and command (tests)."""
    for page in PAGES.values():
        page.closed = True
        page.send({"type": "bye"})
    PAGES.clear()
    for p in PENDING.values():
        _settle(p.future, None, "reset")
    PENDING.clear()
    _sent.clear()


def target() -> Page | None:
    """Return the page commands go to: the most recently focused, else opened."""
    live = [p for p in PAGES.values() if not p.closed]
    if not live:
        return None
    return max(live, key=lambda p: (p.focused, p.opened))


def _settle(fut: asyncio.Future, value: Any, error: str | None = None) -> None:
    def done() -> None:
        if fut.done():
            return
        if error is not None:
            fut.set_exception(PageError(error))
        else:
            fut.set_result(value)

    fut.get_loop().call_soon_threadsafe(done)


class PageError(RuntimeError):
    """The page went away before answering."""


# --- the gates ------------------------------------------------------------------------


def _channel_gate(settings: Any, request: Request) -> None:
    """Apply the gate of page keys: on, with page keys, from this computer."""
    _require_enabled(settings)
    if not settings.BOWSER_ASSISTANT_PAGE_KEYS:
        raise HTTPException(
            status_code=403,
            detail="Tools cannot act on the page on this server: it needs "
            "BOWSER_ASSISTANT_PAGE_KEYS (on by default for `bowser run` or "
            "`bowser lite` on your own computer).",
        )
    if not _from_this_computer(request):
        raise HTTPException(
            status_code=403, detail="Only on the computer that runs Bowser."
        )


def _own_origin(request: Request) -> str:
    return f"{request.url.scheme}://{request.headers.get('host', '')}"


def _require_same_origin(request: Request) -> None:
    """Refuse a browser request from another web site (CORS is open for data)."""
    origin = request.headers.get("origin")
    site = request.headers.get("sec-fetch-site")
    if (origin and origin != _own_origin(request)) or (
        site and site not in ("same-origin", "none")
    ):
        raise HTTPException(status_code=403, detail="Only Bowser's own page.")


def _require_not_a_browser(request: Request) -> None:
    """Refuse a command from a browser: commands come from Bowser's tools only."""
    if request.headers.get("origin") or any(
        k.startswith("sec-fetch-") for k in request.headers
    ):
        raise HTTPException(
            status_code=403,
            detail="Commands come from Bowser's tools (bowser mcp), not from a page.",
        )


# --- the page token ----------------------------------------------------------------

#: This server's token and the port its file is for (None until made).
_TOKEN: dict[str, Any] = {"token": None, "port": None}
#: The variable ``bowser run`` and ``bowser lite`` set to the port they serve on.
PORT_ENV = "BOWSER_SERVER_PORT"


def token_for(port: int | None) -> str:
    """Return the server's page token, making it (and its file) the first time."""
    if _TOKEN["token"] is None or (port and port != _TOKEN["port"]):
        if _TOKEN["token"] is not None and _TOKEN["port"]:
            page_token.remove(_TOKEN["port"], _TOKEN["token"])
        if port:
            _TOKEN["token"], _TOKEN["port"] = page_token.create(port), port
        else:  # no port known: a token for in-process callers only, no file
            _TOKEN["token"], _TOKEN["port"] = secrets.token_urlsafe(32), None
    return _TOKEN["token"]


def request_port(request: Request) -> int | None:
    """Return the port this server answers on (the one in its own URL)."""
    return request.url.port or (443 if request.url.scheme == "https" else 80)


def forget_token() -> None:
    """Remove the token file (the server stops)."""
    token, port = _TOKEN["token"], _TOKEN["port"]
    if token and port:
        page_token.remove(port, token)
    _TOKEN["token"], _TOKEN["port"] = None, None


atexit.register(forget_token)


def _given_token(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    return request.headers.get(page_token.HEADER)


def _require_token(request: Request) -> None:
    """Refuse a command without this server's page token (401)."""
    token = token_for(_TOKEN["port"] or request_port(request))
    if not page_token.matches(_given_token(request), token):
        raise HTTPException(
            status_code=401,
            detail="Page commands need this Bowser server's page token: start "
            "bowser mcp on the same computer as the Bowser server (or pass "
            "--token).",
        )


def _rate() -> None:
    now = time.monotonic()
    while _sent and now - _sent[0] > RATE_WINDOW:
        _sent.popleft()
    if len(_sent) >= MAX_RATE:
        raise HTTPException(status_code=429, detail="Too many commands; slow down.")
    _sent.append(now)


# --- the routes ---------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(_app: Any):
    """Make the page token (and its file) at start, remove the file at stop."""
    port = os.environ.get(PORT_ENV, "")
    if port.isdigit():
        token_for(int(port))
    try:
        yield
    finally:
        forget_token()


router = APIRouter(lifespan=_lifespan)


class FocusBody(BaseModel):
    """``POST /page/focus``."""

    model_config = ConfigDict(extra="forbid")

    page: str = Field(pattern=PAGE_ID, description="The page's random id.")
    focused: bool = Field(True, description="Whether the page has the focus now.")


class ResultBody(BaseModel):
    """``POST /page/result``."""

    model_config = ConfigDict(extra="forbid")

    page: str = Field(pattern=PAGE_ID)
    id: str = Field(max_length=40, description="The command's id.")
    ok: bool = Field(description="Whether the command worked.")
    result: Any = Field(None, description="What the command did (when ok).")
    error: str | None = Field(None, max_length=2000, description="Why not.")


class CommandBody(BaseModel):
    """``POST /page/command``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="The page tool, e.g. fly_to.")
    input: dict[str, Any] = Field(default_factory=dict, description="Its arguments.")


@router.get(
    "/page/events",
    response_class=EventStream,
    responses={
        200: {
            "description": 'Server-sent events, each `data: {"type": ...}`.',
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    },
    **api.route_doc("GET /page/events"),
)
async def page_events(
    request: Request,
    page: str = Query(..., pattern=PAGE_ID, description="The page's random id."),
    settings: Any = Depends(get_settings),
):
    """Stream the commands for this page (server-sent events)."""
    _channel_gate(settings, request)
    _require_same_origin(request)
    token_for(_TOKEN["port"] or request_port(request))
    old = PAGES.pop(page, None)
    if old is not None:
        old.closed = True
        old.send({"type": "bye"})
    while len(PAGES) >= MAX_PAGES:
        stale = min(PAGES.values(), key=lambda p: max(p.seen, p.focused, p.opened))
        stale.closed = True
        stale.send({"type": "bye"})
        PAGES.pop(stale.id, None)
    now = time.monotonic()
    me = Page(page, asyncio.Queue(), asyncio.get_running_loop(), now, seen=now)
    PAGES[page] = me
    return EventStream(
        _stream(me, request),
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def _stream(me: Page, request: Request) -> AsyncIterator[str]:
    try:
        yield _event({"type": "hello", "page": me.id})
        while not me.closed:
            try:
                msg = await asyncio.wait_for(me.queue.get(), PING_SECONDS)
            except asyncio.TimeoutError:
                if await request.is_disconnected():
                    break
                yield ": ping\n\n"
                continue
            if msg.get("type") == "bye":
                break
            yield _event(msg)
    finally:
        me.closed = True
        if PAGES.get(me.id) is me:
            del PAGES[me.id]
        for cid in list(me.waiting):
            pending = PENDING.pop(cid, None)
            if pending is not None:
                _settle(pending.future, None, "The page was closed.")


def _event(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, separators=(',', ':'))}\n\n"


@router.post(
    "/page/focus",
    responses={200: {"model": api.PageAck}},
    **api.route_doc("POST /page/focus"),
)
async def page_focus(
    request: Request, body: FocusBody, settings: Any = Depends(get_settings)
):
    """Note that the page has (or lost) the focus; the last focused one acts."""
    _channel_gate(settings, request)
    _require_same_origin(request)
    me = PAGES.get(body.page)
    if me is None or me.closed:
        raise HTTPException(status_code=404, detail="No such page; reconnect.")
    now = time.monotonic()
    me.seen = now
    if body.focused:
        me.focused = now
    return {"ok": True}


@router.post(
    "/page/result",
    responses={200: {"model": api.PageAck}},
    **api.route_doc("POST /page/result"),
)
async def page_result(request: Request, settings: Any = Depends(get_settings)):
    """Take the page's answer to a command."""
    _channel_gate(settings, request)
    _require_same_origin(request)
    raw = await request.body()
    if len(raw) > MAX_RESULT:
        raise HTTPException(status_code=413, detail="The answer is too large.")
    try:
        body = ResultBody.model_validate_json(raw)
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Not a page answer.") from e
    pending = PENDING.get(body.id)
    if pending is None or pending.page != body.page:
        raise HTTPException(status_code=404, detail="No such command is waiting.")
    del PENDING[body.id]
    page = PAGES.get(body.page)
    if page is not None:
        page.waiting.discard(body.id)
        page.seen = time.monotonic()
    answer = {"ok": body.ok, "result": body.result if body.ok else None}
    if not body.ok:
        answer["error"] = body.error or "The page could not do that."
    _settle(pending.future, answer)
    return {"ok": True}


def page_url(request: Request) -> str:
    """Return the address a user opens the page at."""
    port = request.url.port
    return f"{request.url.scheme}://127.0.0.1" + (f":{port}" if port else "") + "/"


@router.post(
    "/page/command",
    responses={200: {"model": api.PageCommandAnswer}},
    **api.route_doc("POST /page/command"),
)
async def page_command(
    request: Request, body: CommandBody, settings: Any = Depends(get_settings)
):
    """Send a command to the open page and return its answer."""
    _channel_gate(settings, request)
    _require_not_a_browser(request)
    _require_token(request)
    if body.name not in COMMANDS:
        raise HTTPException(status_code=400, detail=f"No page command {body.name!r}.")
    if len(json.dumps(body.input)) > MAX_INPUT:
        raise HTTPException(status_code=413, detail="The command is too large.")
    _rate()
    page = target()
    if page is None:
        raise HTTPException(
            status_code=409,
            detail=f"No Bowser page is open — open {page_url(request)} in a "
            "browser on this computer, then try again.",
        )
    if len(PENDING) >= MAX_PENDING:
        raise HTTPException(status_code=429, detail="Too many commands waiting.")
    cid = secrets.token_urlsafe(12)
    fut = asyncio.get_running_loop().create_future()
    PENDING[cid] = Pending(page.id, fut)
    page.waiting.add(cid)
    page.send({"type": "command", "id": cid, "name": body.name, "input": body.input})
    try:
        answer = await asyncio.wait_for(fut, TIMEOUT)
    except asyncio.TimeoutError as e:
        raise HTTPException(
            status_code=504,
            detail=f"The page did not answer within {TIMEOUT:g} s; is it still "
            "open and loaded?",
        ) from e
    except PageError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    finally:
        PENDING.pop(cid, None)
        page.waiting.discard(cid)
    return answer


# --- geocoding (no page needed) -------------------------------------------------------


@router.get(
    "/geocode",
    responses={200: {"model": api.GeocodeAnswer}},
    **api.route_doc("GET /geocode"),
)
async def geocode(
    q: str = Query(..., min_length=1, max_length=200, description="Place or address."),
    limit: int = Query(5, ge=1, le=10, description="Most candidates to return."),
    settings: Any = Depends(get_settings),
):
    """Find a place name or address: candidates with lon/lat and a bounding box."""
    _require_enabled(settings)
    try:
        results, cached = await GEOCODER.search(q, limit)
    except GeocodeError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
    return {
        "query": q,
        "results": results,
        "cached": cached,
        "attribution": ATTRIBUTION,
    }
