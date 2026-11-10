"""Bowser as an Agent Client Protocol (ACP) client.

ACP (https://agentclientprotocol.com) is JSON-RPC 2.0 over an agent process's
stdin and stdout, one message per line. Bowser starts the agent, gives it
Bowser's MCP server (``bowser mcp --url <this server>``) so it answers with
Bowser's data tools, sends the user's question (``session/prompt``) and turns
what the agent reports (``session/update``) into the tab's chat events. When
the agent asks to run a tool (``session/request_permission``), the question goes
to the page; with no answer in :data:`PERMISSION_SECONDS` it is declined.

The agent gets no file system or terminal from Bowser (it is told so in
``initialize``), runs in an empty folder with a minimal environment, and its
process group is killed on Stop, New chat and server shutdown. Follows RustGIS
(crates/assistant/src/acp.rs).
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import os
import re
import signal
import sys
from collections.abc import AsyncIterator
from typing import Any

PROTOCOL_VERSION = 1
#: Seconds the page has to answer a permission request before it is declined.
PERMISSION_SECONDS = 120.0
#: Seconds to start the agent and its session (npx may download the adapter).
START_SECONDS = 180.0
#: A message line longer than this is dropped (a broken or hostile agent).
MAX_LINE = 8 * 1024 * 1024
#: Text shown for a tool call's input, at most.
MAX_DETAIL = 4096
#: Modes that run tools without asking; Bowser switches to an asking mode.
BYPASS_MODES = ("bypassPermissions", "agent-full-access", "full-access", "yolo")
ASKING_MODES = ("default", "agent", "ask")
#: Bowser's MCP server's name, as the agent prefixes its tools.
MCP_NAME = "bowser"


class AgentError(RuntimeError):
    """A failure to show the user; ``kind`` is ``auth`` when it must sign in."""

    def __init__(self, message: str, kind: str = "agent") -> None:
        """Keep ``kind`` with the message."""
        super().__init__(message)
        self.kind = kind


def tool_name(update: dict[str, Any], known: set[str]) -> str:
    """Return the Bowser tool an agent's tool call is, or its title.

    Agents name MCP tools differently (``mcp__bowser__point_timeseries``,
    ``bowser.point_timeseries``, a title such as ``point_timeseries (bowser)``).
    """
    meta = (update.get("_meta") or {}).get("claudeCode") or {}
    for text in (meta.get("toolName"), update.get("title"), update.get("kind")):
        if not isinstance(text, str):
            continue
        for word in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text):
            name = word.removeprefix(f"mcp__{MCP_NAME}__")
            if name in known:
                return name
    title = update.get("title")
    return str(title)[:200] if isinstance(title, str) and title else "tool"


class AgentSession:
    """One agent process and its ACP session.

    Parameters
    ----------
    argv : list of str
        The command that starts the agent (speaking ACP on stdio).
    env : dict
        Its whole environment (see :func:`.signin.agent_env`).
    cwd : str
        The folder it runs in.
    label : str
        The agent's name, for messages.
    known_tools : set of str
        Bowser's data tool names, to recognise them among the agent's calls.

    """

    def __init__(
        self,
        argv: list[str],
        env: dict[str, str],
        cwd: str,
        label: str,
        known_tools: set[str],
    ) -> None:
        """Set up the session; call :meth:`start`."""
        self.argv = argv
        self.env = env
        self.cwd = cwd
        self.label = label
        self.known = known_tools
        self.proc: asyncio.subprocess.Process | None = None
        self.session_id: str | None = None
        self._ids = itertools.count(1)
        self._calls: dict[int, asyncio.Future] = {}
        self._events: asyncio.Queue[dict[str, Any] | None] | None = None
        self._permissions: dict[str, tuple[Any, list[dict], asyncio.TimerHandle]] = {}
        self._perm_ids = itertools.count(1)
        self._tools: dict[str, dict[str, Any]] = {}
        self._reader: asyncio.Task | None = None
        self._stderr: list[str] = []
        self.busy = False

    @property
    def alive(self) -> bool:
        """Whether the agent process is running."""
        return self.proc is not None and self.proc.returncode is None

    # --- the process ------------------------------------------------------------------

    async def start(self, mcp: dict[str, Any], system: str) -> None:
        """Start the agent, ``initialize`` and open a session with ``mcp``.

        Parameters
        ----------
        mcp : dict
            ``{"command", "args", "env"}`` of Bowser's MCP server.
        system : str
            Text added to the agent's system prompt.

        """
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.env,
                cwd=self.cwd,
                limit=MAX_LINE,
                start_new_session=sys.platform != "win32",
            )
        except OSError as e:
            raise AgentError(f"{self.label} could not be started: {e}") from e
        self._reader = asyncio.create_task(self._read())
        asyncio.create_task(self._read_stderr())
        try:
            async with asyncio.timeout(START_SECONDS):
                await self._open(mcp, system)
        except TimeoutError as e:
            await self.close()
            raise AgentError(f"{self.label} did not start in time.") from e
        except AgentError:
            await self.close()
            raise

    async def _open(self, mcp: dict[str, Any], system: str) -> None:
        init = await self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
                "clientInfo": {"name": "bowser", "title": "Bowser", "version": "1"},
            },
        )
        version = init.get("protocolVersion") if isinstance(init, dict) else None
        if version != PROTOCOL_VERSION:
            raise AgentError(
                f"{self.label} speaks ACP version {version}; Bowser speaks "
                f"{PROTOCOL_VERSION}."
            )
        env = [{"name": k, "value": v} for k, v in mcp.get("env", {}).items()]
        new = await self.request(
            "session/new",
            {
                "cwd": self.cwd,
                "mcpServers": [
                    {
                        "name": MCP_NAME,
                        "command": mcp["command"],
                        "args": list(mcp["args"]),
                        "env": env,
                    }
                ],
                # Claude Code: Bowser's text after its own system prompt, and
                # none of its built-in tools (files, shell, web): only Bowser's.
                "_meta": {
                    "systemPrompt": {"append": system},
                    "claudeCode": {"options": {"tools": []}},
                },
            },
        )
        sid = new.get("sessionId") if isinstance(new, dict) else None
        if not isinstance(sid, str) or not sid:
            raise AgentError(f"{self.label} started no session.")
        self.session_id = sid
        modes = (new.get("modes") or {}) if isinstance(new, dict) else {}
        current = modes.get("currentModeId")
        offered = [m.get("id") for m in modes.get("availableModes") or []]
        if current in BYPASS_MODES:
            asking = next((m for m in ASKING_MODES if m in offered), None)
            if asking is None:
                raise AgentError(
                    f"{self.label} would run tools without asking (mode {current})."
                )
            await self.request("session/set_mode", {"sessionId": sid, "modeId": asking})

    async def close(self) -> None:
        """Kill the agent and everything it started; decline open permissions."""
        for key in list(self._permissions):
            self._settle(key, None, "closed")
        proc = self.proc
        if proc is not None and proc.returncode is None:
            _kill(proc, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except asyncio.TimeoutError:
                _kill(proc, signal.SIGKILL)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), 3)
        if proc is not None:
            # The group may outlive its leader (npx starts node, which starts the
            # agent): end it too.
            _kill(proc, signal.SIGKILL)
        if self._reader:
            self._reader.cancel()
        for fut in self._calls.values():
            if not fut.done():
                fut.set_exception(AgentError(f"{self.label} was stopped."))
        self._calls.clear()
        if self._events is not None:
            self._events.put_nowait(None)

    # --- JSON-RPC ---------------------------------------------------------------------

    def _send(self, msg: dict[str, Any]) -> None:
        if not self.alive or self.proc is None or self.proc.stdin is None:
            raise AgentError(f"{self.label} has stopped.")
        msg = {"jsonrpc": "2.0", **msg}
        self.proc.stdin.write(json.dumps(msg).encode() + b"\n")

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        """Send a request; return its result (raise AgentError on an error)."""
        rid = next(self._ids)
        fut = asyncio.get_running_loop().create_future()
        self._calls[rid] = fut
        self._send({"id": rid, "method": method, "params": params})
        assert self.proc is not None and self.proc.stdin is not None
        with contextlib.suppress(ConnectionError):
            await self.proc.stdin.drain()
        return await fut

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            while True:
                try:
                    line = await self.proc.stdout.readline()
                except ValueError:  # longer than MAX_LINE
                    continue
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    self._dispatch(msg)
        finally:
            why = " ".join(self._stderr[-3:]).strip()
            err = AgentError(
                f"{self.label} stopped" + (f": {why[:300]}" if why else ".")
            )
            for fut in self._calls.values():
                if not fut.done():
                    fut.set_exception(err)
            self._calls.clear()
            if self._events is not None:
                self._events.put_nowait(None)

    async def _read_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        with contextlib.suppress(Exception):
            async for line in self.proc.stderr:
                self._stderr.append(line.decode(errors="replace").strip()[:500])
                del self._stderr[:-20]

    def _dispatch(self, msg: dict[str, Any]) -> None:
        method = msg.get("method")
        if method is None and "id" in msg:
            fut = (
                self._calls.pop(msg["id"], None) if isinstance(msg["id"], int) else None
            )
            if fut is None or fut.done():
                return
            if isinstance(msg.get("error"), dict):
                fut.set_exception(_agent_error(self.label, msg["error"]))
            else:
                fut.set_result(msg.get("result"))
        elif method == "session/update":
            update = (msg.get("params") or {}).get("update") or {}
            for event in self._update(update):
                self._emit(event)
        elif method == "session/request_permission" and "id" in msg:
            self._permission(msg["id"], msg.get("params") or {})
        elif "id" in msg:
            # Bowser offers no file system, terminal or other client methods.
            self._send(
                {
                    "id": msg["id"],
                    "error": {
                        "code": -32601,
                        "message": f"Bowser does not provide {str(method)[:80]}",
                    },
                }
            )

    def _emit(self, event: dict[str, Any]) -> None:
        if self._events is not None:
            self._events.put_nowait(event)

    # --- what the agent reports -------------------------------------------------------

    def _update(self, u: dict[str, Any]) -> list[dict[str, Any]]:
        kind = u.get("sessionUpdate")
        if kind == "agent_message_chunk":
            text = (u.get("content") or {}).get("text")
            return (
                [{"type": "text", "text": text}]
                if isinstance(text, str) and text
                else []
            )
        if kind == "tool_call":
            tid = str(u.get("toolCallId") or "")[:200]
            raw = u.get("rawInput")
            info: dict[str, Any] = {
                "name": tool_name(u, self.known),
                "input": raw if isinstance(raw, dict) else {},
            }
            self._tools[tid] = info
            del_old(self._tools, 500)
            return [
                {
                    "type": "tool_call",
                    "id": tid,
                    "name": info["name"],
                    "input": info["input"],
                    "runs": "agent",
                }
            ]
        if kind == "tool_call_update":
            tid = str(u.get("toolCallId") or "")[:200]
            entry = self._tools.get(tid)
            if entry is None:
                return []
            if isinstance(u.get("rawInput"), dict):
                entry["input"] = u["rawInput"]
            status = u.get("status")
            if status not in ("completed", "failed"):
                return []
            return [
                {
                    "type": "tool_result",
                    "id": tid,
                    "name": entry["name"],
                    "input": entry["input"],
                    "ok": status == "completed",
                    "result": None,
                }
            ]
        return []

    def _permission(self, rid: Any, params: dict[str, Any]) -> None:
        call = params.get("toolCall") or {}
        options = [
            {
                "id": str(o.get("optionId")),
                "name": str(o.get("name") or o.get("kind") or "")[:80],
                "kind": str(o.get("kind") or ""),
            }
            for o in params.get("options") or []
            if isinstance(o, dict) and o.get("optionId") is not None
        ]
        info = self._tools.get(str(call.get("toolCallId") or ""), {})
        raw = call.get("rawInput", info.get("input"))
        detail = raw if isinstance(raw, str) else json.dumps(raw) if raw else ""
        if len(detail) > MAX_DETAIL:
            detail = f"(an input of {len(detail)} characters, too long to show)"
        name = tool_name(call, self.known) if call else info.get("name", "tool")
        key = f"p{next(self._perm_ids)}"
        timer = asyncio.get_running_loop().call_later(
            PERMISSION_SECONDS, self._settle, key, None, "timeout"
        )
        self._permissions[key] = (rid, options, timer)
        self._emit(
            {
                "type": "permission",
                "id": key,
                "name": name,
                "title": str(call.get("title") or name)[:200],
                "detail": detail,
                "options": [{"kind": o["kind"], "name": o["name"]} for o in options],
                "timeout": PERMISSION_SECONDS,
            }
        )

    def answer(self, key: str, choice: str) -> bool:
        """Answer permission request ``key``.

        ``choice`` is ``allow``, ``allow_always`` or ``reject``. Return False
        when there is no such open request.
        """
        if key not in self._permissions:
            return False
        kinds = {
            "allow": ("allow_once",),
            "allow_always": ("allow_always", "allow_once"),
            "reject": ("reject_once", "reject_always"),
        }.get(choice, ())
        self._settle(key, kinds, choice if kinds else "reject")
        return True

    def _settle(self, key: str, kinds: tuple[str, ...] | None, how: str) -> None:
        """Send the answer to a permission request (none: declined)."""
        entry = self._permissions.pop(key, None)
        if entry is None:
            return
        rid, options, timer = entry
        timer.cancel()
        if kinds is None:
            kinds = ("reject_once", "reject_always")
        option = next((o["id"] for k in kinds for o in options if o["kind"] == k), None)
        outcome = (
            {"outcome": "selected", "optionId": option}
            if option is not None
            else {"outcome": "cancelled"}
        )
        with contextlib.suppress(AgentError):
            self._send({"id": rid, "result": {"outcome": outcome}})
        self._emit({"type": "permission_closed", "id": key, "outcome": how})

    # --- a turn -----------------------------------------------------------------------

    async def prompt(self, text: str) -> AsyncIterator[dict[str, Any]]:
        """Send the user's message; yield chat events until the agent answers.

        Ends with ``{"type": "done", "stop": ..., "text": <the whole answer>}``.
        """
        if self.session_id is None:
            raise AgentError(f"{self.label} has no session.")
        self.busy = True
        self._events = asyncio.Queue()
        answer: list[str] = []
        task = asyncio.ensure_future(
            self.request(
                "session/prompt",
                {
                    "sessionId": self.session_id,
                    "prompt": [{"type": "text", "text": text}],
                },
            )
        )

        def _ended(_task: asyncio.Future) -> None:
            if self._events is not None:
                self._events.put_nowait(None)

        task.add_done_callback(_ended)
        try:
            while True:
                event = await self._events.get()
                if event is None:
                    # The prompt ended (or the process did): drain what is left.
                    while not self._events.empty():
                        e = self._events.get_nowait()
                        if e is not None:
                            if e["type"] == "text":
                                answer.append(e["text"])
                            yield e
                    break
                if event["type"] == "text":
                    answer.append(event["text"])
                yield event
            try:
                result = await task
            except AgentError as e:
                yield {"type": "error", "kind": e.kind, "message": str(e)}
                return
            stop = (result or {}).get("stopReason", "end_turn")
            yield {
                "type": "done",
                "stop": {
                    "end_turn": "end",
                    "max_tokens": "max_tokens",
                    "refusal": "refusal",
                    "cancelled": "cancelled",
                }.get(stop, "end"),
                "text": "".join(answer),
            }
        finally:
            self.busy = False
            if not task.done():
                task.cancel()
            self._events = None

    async def cancel(self) -> None:
        """Ask the agent to stop the current turn (``session/cancel``)."""
        if self.session_id and self.alive:
            with contextlib.suppress(AgentError):
                self._send(
                    {
                        "method": "session/cancel",
                        "params": {"sessionId": self.session_id},
                    }
                )


def del_old(d: dict, keep: int) -> None:
    """Drop the oldest entries of ``d`` beyond ``keep``."""
    for k in list(d)[: max(0, len(d) - keep)]:
        d.pop(k, None)


def _agent_error(label: str, err: dict[str, Any]) -> AgentError:
    message = str(err.get("message") or "an error")[:300]
    data: dict[str, Any] = err["data"] if isinstance(err.get("data"), dict) else {}
    low = message.lower()
    auth = (
        err.get("code") == -32000
        or low.startswith(("authentication required", "not authenticated", "sign in"))
        or data.get("type") == "auth_required"
        or data.get("code") == "auth_required"
    )
    if auth:
        return AgentError(f"{label} needs you to sign in ({message}).", "auth")
    return AgentError(f"{label}: {message}")


def _kill(proc: asyncio.subprocess.Process, sig: int) -> None:
    """Signal the agent's process group (the agent and what it started)."""
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        if sys.platform == "win32":
            proc.kill()
        else:
            os.killpg(proc.pid, sig)


# --- the open sessions ------------------------------------------------------------

#: Sessions by the page's conversation id; few at a time.
SESSIONS: dict[str, AgentSession] = {}
MAX_SESSIONS = 3


async def keep(conversation: str, session: AgentSession) -> None:
    """Remember ``session`` for ``conversation``.

    The oldest sessions beyond :data:`MAX_SESSIONS` are closed.
    """
    SESSIONS[conversation] = session
    while len(SESSIONS) > MAX_SESSIONS:
        oldest = next(iter(SESSIONS))
        await SESSIONS.pop(oldest).close()


async def stop(conversation: str | None = None) -> int:
    """Kill one conversation's agent, or all of them; return how many."""
    keys = [conversation] if conversation else list(SESSIONS)
    n = 0
    for key in keys:
        s = SESSIONS.pop(key, None)
        if s is not None:
            await s.close()
            n += 1
    return n


def kill_all_now() -> None:
    """Kill every agent at once (at exit, when there is no event loop)."""
    for s in list(SESSIONS.values()):
        proc = getattr(s, "proc", None)
        if proc is not None and proc.returncode is None:
            _kill(proc, signal.SIGKILL)
    SESSIONS.clear()
