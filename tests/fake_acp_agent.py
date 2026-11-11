"""A stand-in ACP agent for the Assistant's tests (no AI, no network).

Speaks the Agent Client Protocol on stdin/stdout, one JSON message per line,
like an agent CLI such as Claude Code's ACP adapter:

- ``initialize`` and ``session/new``: starts the MCP server it is given (Bowser's
  ``bowser mcp --url ...``) and talks MCP to it over stdio; reports the bypass
  mode, so the client must switch it to ``default``;
- ``session/prompt``: announces a ``list_layers`` tool call, asks permission,
  and when allowed calls the tool through MCP and answers with the layer names;
  when declined it says so. A prompt with "hang" starts a child process and never
  answers (to test that Stop kills both).

Writes what it saw to ``<out>/`` (argv[1]): ``env.json``, ``new.json``,
``pids.txt``, ``modes.json``, and a line in ``starts.txt`` per start.
"""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "env.json").write_text(json.dumps(dict(os.environ)))
with (OUT / "starts.txt").open("a") as f:
    f.write(f"{os.getpid()}\n")
lock = threading.Lock()
answers: dict = {}
waiting: dict = {}
mcp = None
session_id = "fake-session-1"


def send(msg):
    with lock:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", **msg}) + "\n")
        sys.stdout.flush()


def update(u):
    send({"method": "session/update", "params": {"sessionId": session_id, "update": u}})


class MCP:
    """A tiny MCP client over the server's stdio."""

    def __init__(self, server):
        env = dict(os.environ)
        env.update({e["name"]: e["value"] for e in server.get("env", [])})
        self.proc = subprocess.Popen(
            [server["command"], *server["args"]],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=env,
            text=True,
        )
        self.n = 0
        self.call(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "fake-agent", "version": "1"},
            },
        )
        self.write({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def write(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params):
        self.n += 1
        self.write({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP server ended")
            msg = json.loads(line)
            if msg.get("id") == self.n:
                return msg


def ask_permission(call_id):
    rid = 900 + len(waiting)
    ev = threading.Event()
    waiting[rid] = ev
    send(
        {
            "id": rid,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": {
                    "toolCallId": call_id,
                    "title": "mcp__bowser__list_layers",
                    "rawInput": {},
                },
                "options": [
                    {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "always", "name": "Always", "kind": "allow_always"},
                    {"optionId": "no", "name": "Reject", "kind": "reject_once"},
                ],
            },
        }
    )
    ev.wait()
    return answers.pop(rid)


def run_prompt(rid, text):
    if "hang" in text:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        (OUT / "pids.txt").write_text(f"{os.getpid()} {child.pid}")
        update(
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Working…"},
            }
        )
        return  # never answers
    update(
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "t1",
            "title": "mcp__bowser__list_layers",
            "kind": "other",
            "status": "pending",
            "rawInput": {},
            "_meta": {"claudeCode": {"toolName": "mcp__bowser__list_layers"}},
        }
    )
    outcome = ask_permission("t1").get("outcome", {})
    if outcome.get("optionId") in ("yes", "always"):
        res = mcp.call("tools/call", {"name": "list_layers", "arguments": {}})
        content = (res.get("result") or {}).get("content") or [{}]
        data = json.loads(content[0].get("text") or "{}")
        update(
            {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
            }
        )
        names = ", ".join(sorted(data.get("layers", {})))
        answer = f"The layers are: {names}."
    else:
        update(
            {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "failed",
            }
        )
        answer = f"Not allowed ({outcome.get('outcome')})."
    for piece in (answer[:10], answer[10:]):
        update(
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": piece},
            }
        )
    send({"id": rid, "result": {"stopReason": "end_turn"}})


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method is None and msg.get("id") in waiting:
        answers[msg["id"]] = msg.get("result") or {}
        waiting.pop(msg["id"]).set()
    elif method == "initialize":
        (OUT / "init.json").write_text(json.dumps(msg["params"]))
        send(
            {
                "id": msg["id"],
                "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {},
                    "authMethods": [],
                },
            }
        )
    elif method == "session/new":
        (OUT / "new.json").write_text(json.dumps(msg["params"]))
        mcp = MCP(msg["params"]["mcpServers"][0])
        send(
            {
                "id": msg["id"],
                "result": {
                    "sessionId": session_id,
                    "modes": {
                        "currentModeId": "bypassPermissions",
                        "availableModes": [
                            {"id": "default", "name": "Default"},
                            {"id": "bypassPermissions", "name": "Bypass"},
                        ],
                    },
                },
            }
        )
    elif method == "session/set_mode":
        (OUT / "modes.json").write_text(json.dumps(msg["params"]))
        send({"id": msg["id"], "result": {}})
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        (OUT / "prompt.txt").write_text(text)
        threading.Thread(target=run_prompt, args=(msg["id"], text), daemon=True).start()
    elif method == "session/cancel":
        pass
    elif "id" in msg:
        send({"id": msg["id"], "error": {"code": -32601, "message": "no"}})
