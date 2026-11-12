"""The Assistant tab's server side (src/bowser/assistant).

- keys: kept in the keychain when it works, else in a 0600 file; never in a
  response, the /config flag or the log;
- the relay: off unless BOWSER_ASSISTANT is set; keys from the page only with
  BOWSER_ASSISTANT_PAGE_KEYS and from this computer;
- the tool loop with a scripted provider (no network): a data tool runs on the
  server and its result goes back to the model; a page tool ends the request
  with ``page_tools``; the tools sent to the model are the MCP server's;
- the three wire formats against mock transports: OpenAI tool-call fragments,
  Gemini's parts, and Anthropic through the SDK (adaptive thinking, no sampling
  parameters or forced tool choice, refusals);
- Ollama: offered only when installed on the server's computer, started in
  the background when needed (a fake ``which``, process and transport) and
  stopped on exit only if Bowser started it; its models are the installed ones;
- ``/config`` and a chat whose data tool reads the real cube, on the full server
  and on bowser-lite (each in its own interpreter).

Nothing here imports bowser.main, bowser.state or bowser.config: the routes are
mounted on a small app with settings given as a dependency.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

httpx = pytest.importorskip("httpx")
pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import SecretStr  # noqa: E402

from bowser.assistant import providers, relay  # noqa: E402
from bowser.assistant.keys import KeyStore  # noqa: E402
from bowser.assistant.providers import ProviderError, ToolCall, Turn  # noqa: E402

REGRESSION = Path(__file__).resolve().parent / "regression"
KEY = "sk-test-0123456789-SECRET-abcd"

LAYERS = {
    "displacement": {
        "label": "Displacement",
        "unit": "m",
        "x_values": ["2020-01-01", "2020-02-01"],
        "n_time_steps": 2,
        "latlon_bounds": [-118.0, 33.0, -117.0, 34.0],
        "uses_spatial_ref": True,
        "reference_lonlat": [-117.5, 33.5],
        "reference_date": "2020-01-01",
    }
}


def settings(tmp_path: Path, **over) -> SimpleNamespace:
    """Settings as bowser.config gives them, with the Assistant's fields."""
    base = {
        "BOWSER_ASSISTANT": True,
        "BOWSER_ASSISTANT_PAGE_KEYS": True,
        "BOWSER_ASSISTANT_KEY_FILE": str(tmp_path / "assistant.json"),
        "BOWSER_AI_PROVIDER": "",
        "BOWSER_AI_KEY": SecretStr(""),
        "BOWSER_AI_MODEL": "",
        "ANTHROPIC_API_KEY": SecretStr(""),
        "OPENAI_API_KEY": SecretStr(""),
        "GEMINI_API_KEY": SecretStr(""),
        "OPENROUTER_API_KEY": SecretStr(""),
    }
    base.update(over)
    return SimpleNamespace(**base)


class FakeOllama:
    """Ollama as the relay sees it: installed or not, running, its models."""

    def __init__(self, installed=True, running=True, models=("qwen3",)):
        self.installed, self.up, self._models = installed, running, list(models)
        self.starts: list[bool] = []

    def binary(self):
        return "/usr/bin/ollama" if self.installed else None

    def ensure(self, start=True):
        self.starts.append(start)
        return self.installed and self.up

    def models(self):
        return list(self._models)


def make_app(s: SimpleNamespace, ollama=None) -> FastAPI:
    """The relay's routes, a fake /datasets for the data tools, and /config.

    Ollama is a fake (installed, running, with qwen3) unless one is given.
    """
    ollama = ollama or FakeOllama()
    app = FastAPI()
    app.include_router(relay.router)
    app.dependency_overrides[relay.get_settings] = lambda: s
    app.dependency_overrides[relay.get_ollama] = lambda: ollama

    @app.get("/datasets")
    def datasets():
        return LAYERS

    @app.get("/config")
    def config():
        return {"assistant": relay.assistant_config(s, ollama)}

    return app


def local(app: FastAPI) -> TestClient:
    """A client on this computer (the relay checks the client's address)."""
    return TestClient(app, client=("127.0.0.1", 50000))


def events(text: str) -> list[dict]:
    """The server-sent events of a chat response."""
    return [
        json.loads(block.removeprefix("data: "))
        for block in text.split("\n\n")
        if block.startswith("data: ")
    ]


class FakeKeyring:
    """A keychain in memory; ``broken`` makes every call fail like a locked one."""

    def __init__(self, broken: bool = False) -> None:
        self.items: dict[tuple[str, str], str] = {}
        self.broken = broken

    def set_password(self, service, user, key):
        if self.broken:
            raise RuntimeError("no D-Bus session")
        self.items[service, user] = key

    def get_password(self, service, user):
        return self.items.get((service, user))

    def delete_password(self, service, user):
        self.items.pop((service, user), None)


class ScriptedProvider:
    """A provider that replays turns and records what it was sent."""

    def __init__(self, turns: list[Turn]) -> None:
        self.turns = list(turns)
        self.sent: list[dict] = []

    async def stream(self, system, messages, tools):
        self.sent.append(
            {
                "system": system,
                "messages": json.loads(json.dumps(messages)),
                "tools": tools,
            }
        )
        turn = self.turns.pop(0)
        if turn.text:
            yield "text", turn.text
        yield "turn", turn

    async def check(self):
        return True


# --- keys --------------------------------------------------------------------------


def test_file_store_is_private_and_never_returns_the_key(tmp_path):
    store = KeyStore(tmp_path / "cfg" / "assistant.json", keyring=None)
    assert store.load("openai") is None
    assert store.save("openai", KEY) == "file"
    assert store.load("openai") == KEY
    path = tmp_path / "cfg" / "assistant.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert store.describe("openai") == {"saved": True, "store": "file", "hint": "…abcd"}
    assert KEY not in json.dumps(store.describe("openai"))
    store.remove_key("openai")
    assert store.load("openai") is None
    assert store.describe("openai")["saved"] is False
    assert KEY not in path.read_text()


def test_keychain_first_then_file_when_it_fails(tmp_path):
    ring = FakeKeyring()
    store = KeyStore(tmp_path / "a.json", keyring=ring)
    assert store.save("anthropic", KEY) == "keyring"
    assert KEY not in (tmp_path / "a.json").read_text()
    assert store.load("anthropic") == KEY
    store.remove_key("anthropic")
    assert ring.items == {}

    broken = KeyStore(tmp_path / "b.json", keyring=FakeKeyring(broken=True))
    assert broken.save("anthropic", KEY) == "file"
    assert broken.load("anthropic") == KEY


def test_saving_a_key_never_shows_or_logs_it(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    s = settings(tmp_path)
    monkeypatch.setattr(
        relay, "key_store", lambda _s: KeyStore(tmp_path / "k.json", keyring=None)
    )
    checked = []

    class Checker(ScriptedProvider):
        def __init__(self, key):
            super().__init__([])
            self.key = key

        async def check(self):
            checked.append(self.key)
            return self.key == KEY

    monkeypatch.setattr(relay, "open_provider", lambda _p, _m, key: Checker(key))
    client = local(make_app(s))
    r = client.put("/assistant/key", json={"provider": "anthropic", "key": KEY})
    assert r.status_code == 200, r.text
    assert r.json()["stored_in"] == "a file only you can read"
    anthropic = next(p for p in r.json()["providers"] if p["id"] == "anthropic")
    assert anthropic["configured"] and anthropic["source"] == "saved"
    assert anthropic["hint"] == "…abcd"
    bad = client.put("/assistant/key", json={"provider": "anthropic", "key": KEY + "x"})
    assert bad.status_code == 401
    assert checked == [KEY, KEY + "x"]
    seen = r.text + bad.text + client.get("/assistant/status").text
    seen += client.get("/config").text + caplog.text
    assert KEY not in seen
    assert client.get("/config").json()["assistant"]["configured"] == ["anthropic"]
    removed = client.delete("/assistant/key", params={"provider": "anthropic"})
    assert removed.status_code == 200
    assert client.get("/config").json()["assistant"]["configured"] == []


# --- gates -------------------------------------------------------------------------


def test_relay_is_off_unless_enabled(tmp_path):
    client = local(make_app(settings(tmp_path, BOWSER_ASSISTANT=False)))
    chat = {"provider": "ollama", "messages": [{"role": "user", "content": "hi"}]}
    assert client.post("/assistant/chat", json=chat).status_code == 403
    put = client.put("/assistant/key", json={"provider": "anthropic", "key": KEY})
    assert put.status_code == 403
    status = client.get("/assistant/status").json()
    assert status == {
        "enabled": False,
        "page_keys": False,
        "providers": [],
        "default_provider": None,
        "sign_in": {
            "allowed": False,
            "reason": "The Assistant is off on this server.",
            "methods": [],
        },
    }
    flag = client.get("/config").json()["assistant"]
    assert flag == {
        "enabled": False,
        "providers": [],
        "configured": [],
        "sign_in": [],
        "page_channel": False,
    }


def test_keys_only_from_this_computer_and_only_with_page_keys(tmp_path):
    body = {"provider": "anthropic", "key": KEY}
    remote = TestClient(make_app(settings(tmp_path)), client=("203.0.113.9", 5000))
    assert remote.put("/assistant/key", json=body).status_code == 403
    hosted = local(make_app(settings(tmp_path, BOWSER_ASSISTANT_PAGE_KEYS=False)))
    assert hosted.put("/assistant/key", json=body).status_code == 403
    # A hosted server's own key, from the environment, is used instead.
    s = settings(
        tmp_path,
        BOWSER_ASSISTANT_PAGE_KEYS=False,
        BOWSER_AI_PROVIDER="openai",
        BOWSER_AI_KEY=SecretStr(KEY),
    )
    status = local(make_app(s)).get("/assistant/status").json()
    openai = next(p for p in status["providers"] if p["id"] == "openai")
    assert (openai["configured"], openai["source"]) == (True, "environment")
    assert status["default_provider"] == "openai"
    assert KEY not in json.dumps(status)


def test_no_provider_needs_a_base_url(tmp_path):
    client = local(make_app(settings(tmp_path)))
    status = client.get("/assistant/status").json()
    assert "openai_compatible" not in [p["id"] for p in status["providers"]]
    assert all("base_url" not in p for p in status["providers"])
    flag = client.get("/config").json()["assistant"]
    assert "openai_compatible" not in flag["providers"]
    # The page cannot point a provider at another server.
    body = {"provider": "openai", "key": KEY, "base_url": "http://evil.example"}
    assert client.put("/assistant/key", json=body).status_code == 422
    r = client.put("/assistant/key", json={"provider": "ollama", "key": KEY})
    assert r.status_code == 400
    assert not (tmp_path / "assistant.json").exists()


def test_chat_needs_a_key_and_a_known_provider(tmp_path):
    client = local(make_app(settings(tmp_path)))
    msg = [{"role": "user", "content": "hi"}]
    r = client.post("/assistant/chat", json={"provider": "anthropic", "messages": msg})
    assert r.status_code == 400 and "API key" in r.json()["detail"]
    r = client.post("/assistant/chat", json={"provider": "chatgpt", "messages": msg})
    assert r.status_code == 400 and "Continue with ChatGPT" in r.json()["detail"]
    r = client.post(
        "/assistant/chat",
        json={"provider": "ollama", "model": "a b", "messages": msg},
    )
    assert r.status_code == 400


# --- the tool loop -----------------------------------------------------------------

PAGE_TOOL = {
    "name": "add_point",
    "description": "Add a time-series point to the page's map and chart.",
    "input_schema": {
        "type": "object",
        "properties": {"lon": {"type": "number"}, "lat": {"type": "number"}},
        "required": ["lon", "lat"],
    },
}


def test_data_tool_runs_on_the_server_and_its_result_goes_back(tmp_path, monkeypatch):
    fake = ScriptedProvider(
        [
            Turn("Let me look.", [ToolCall("c1", "list_layers", {})], "tool_use"),
            Turn("The cube has displacement.", [], "end"),
        ]
    )
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: fake)
    client = local(make_app(settings(tmp_path)))
    r = client.post(
        "/assistant/chat",
        json={
            "provider": "ollama",
            "messages": [{"role": "user", "content": "What layers?"}],
            "page_tools": [PAGE_TOOL],
        },
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    ev = events(r.text)
    kinds = [e["type"] for e in ev]
    assert kinds == [
        "text",
        "message",
        "tool_call",
        "tool_result",
        "message",
        "text",
        "message",
        "done",
    ]
    result = ev[3]
    assert result["ok"] and result["name"] == "list_layers"
    assert result["result"]["layers"]["displacement"]["unit_reported"] == "mm"
    # The call says what it is doing, from the tool's spec (shared with bowser mcp
    # and the signed-in agent).
    assert ev[2]["status"] == "Listing the layers"
    assert ev[-1] == {"type": "done", "stop": "end"}
    # The second request carries the tool's result for the model.
    tool_msg = fake.sent[1]["messages"][-1]
    assert tool_msg["role"] == "tool"
    assert tool_msg["results"][0]["id"] == "c1"
    assert json.loads(tool_msg["results"][0]["content"]) == result["result"]
    # The system prompt carries the MCP server's instructions.
    assert "never interpret displacement from the curve alone" in fake.sent[0]["system"]


def test_page_tool_ends_the_request_for_the_page(tmp_path, monkeypatch):
    calls = [
        ToolCall("c1", "add_point", {"lon": -117.5, "lat": 33.5}),
        ToolCall("c2", "no_such_tool", {}),
    ]
    fake = ScriptedProvider([Turn("", calls, "tool_use")])
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: fake)
    r = local(make_app(settings(tmp_path))).post(
        "/assistant/chat",
        json={
            "provider": "ollama",
            "messages": [{"role": "user", "content": "Add a point"}],
            "page_tools": [PAGE_TOOL],
        },
    )
    ev = events(r.text)
    waiting = next(e for e in ev if e["type"] == "page_tools")
    # Each page call carries its tool's status line, for the tab.
    assert waiting["calls"] == [
        {
            "id": "c1",
            "name": "add_point",
            "input": {"lon": -117.5, "lat": 33.5},
            "status": "Adding the point",
        }
    ]
    assert waiting["results"][0]["is_error"]
    assert "no_such_tool" in waiting["results"][0]["content"]
    assert ev[-1] == {"type": "done", "stop": "page_tools"}
    assert PAGE_TOOL["name"] in {t["name"] for t in fake.sent[0]["tools"]}


def test_refusal_and_provider_errors_end_the_turn(tmp_path, monkeypatch):
    refused = ScriptedProvider([Turn("", [], "refusal", detail="cyber")])
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: refused)
    client = local(make_app(settings(tmp_path)))
    chat = {"provider": "ollama", "messages": [{"role": "user", "content": "x"}]}
    assert events(client.post("/assistant/chat", json=chat).text)[-1] == {
        "type": "done",
        "stop": "refusal",
        "detail": "cyber",
    }

    class Down(ScriptedProvider):
        async def stream(self, *_args):
            raise ProviderError("rate_limit", "OpenAI: slow down", 429)
            yield

    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: Down([]))
    ev = events(client.post("/assistant/chat", json=chat).text)
    assert ev == [
        {"type": "error", "kind": "rate_limit", "message": "OpenAI: slow down"}
    ]


def test_tools_sent_to_the_model_are_the_mcp_tools(tmp_path, monkeypatch):
    pytest.importorskip("mcp")
    from mcp import Client  # noqa: PLC0415

    from bowser.mcp_server import build_server  # noqa: PLC0415

    fake = ScriptedProvider([Turn("Hi.", [], "end")])
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: fake)
    local(make_app(settings(tmp_path))).post(
        "/assistant/chat",
        json={"provider": "ollama", "messages": [{"role": "user", "content": "hi"}]},
    )
    sent = {t["name"]: t for t in fake.sent[0]["tools"]}

    async def listing():
        async with Client(build_server("http://127.0.0.1:1")) as client:
            return (await client.list_tools()).tools

    mcp_tools = asyncio.run(listing())
    # The page tools are among them; only add_overlay (files on the server) is the
    # Assistant's alone.
    assert set(sent) - {"add_overlay"} == {t.name for t in mcp_tools}
    assert {"go_to", "fly_to", "set_reference_point", "set_masks"} <= set(sent)
    for t in mcp_tools:
        assert sent[t.name] == {
            "name": t.name,
            "description": t.description,
            "input_schema": t.input_schema,
        }

    # A hosted server (no page keys) leaves out the tools that write files or read
    # server paths into the session.
    hosted = ScriptedProvider([Turn("Hi.", [], "end")])
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: hosted)
    s = settings(
        tmp_path,
        BOWSER_ASSISTANT_PAGE_KEYS=False,
        BOWSER_AI_PROVIDER="ollama",
    )
    local(make_app(s)).post(
        "/assistant/chat",
        json={"provider": "ollama", "messages": [{"role": "user", "content": "hi"}]},
    )
    names = {t["name"] for t in hosted.sent[0]["tools"]}
    assert names == set(sent) - {"export_geotiff", "convert_to_cog", "load_gnss_csv"}


# --- the page's context, the tool budget, finding a place --------------------------


def test_the_pages_context_reaches_the_model(tmp_path, monkeypatch):
    fake = ScriptedProvider([Turn("It is at the center.", [], "end")])
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: fake)
    context = {
        "layer": "displacement",
        "view": {"center": [-90.12, 34.76], "zoom": 13.2},
        "points": [{"name": "crest", "lon": -90.125, "lat": 34.756}],
        "reference_point": [-90.1, 34.8],
    }
    local(make_app(settings(tmp_path))).post(
        "/assistant/chat",
        json={
            "provider": "ollama",
            "messages": [{"role": "user", "content": "What is in the middle?"}],
            "page_context": context,
        },
    )
    system = fake.sent[0]["system"]
    assert "The page now" in system
    assert json.dumps(context, separators=(",", ":")) in system
    # The question itself is untouched.
    assert fake.sent[0]["messages"][0]["content"] == "What is in the middle?"
    # Kept short: a page with many points is cut.
    big = {"points": [{"name": f"p{i}", "lon": 0.0, "lat": 0.0} for i in range(500)]}
    assert len(relay.page_context_text(big)) <= relay.CONTEXT_CHARS + 1


def test_tool_budget_stops_the_loop_and_says_so(tmp_path, monkeypatch):
    calls = [
        Turn("", [ToolCall(f"c{i}", "list_layers", {"dataset": f"d{i}"})], "tool_use")
        for i in range(4)
    ]
    fake = ScriptedProvider(
        [*calls, Turn("I could not find it; please click it.", [], "end")]
    )
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: fake)
    s = settings(tmp_path, BOWSER_ASSISTANT_TOOL_BUDGET=3)
    r = local(make_app(s)).post(
        "/assistant/chat",
        json={"provider": "ollama", "messages": [{"role": "user", "content": "x"}]},
    )
    ev = events(r.text)
    results = [e for e in ev if e["type"] == "tool_result"]
    assert [e["ok"] for e in results] == [True, True, True, False]
    assert "limit of 3 tool calls" in results[-1]["result"]
    assert {"type": "budget", "limit": 3} in ev
    # The model is told to answer with what it has.
    assert "No tool calls are left" in fake.sent[-1]["system"]
    assert ev[-1] == {"type": "done", "stop": "end"}


def test_the_same_call_again_is_refused_and_a_similar_one_costs_double():
    b = relay.ToolBudget(4)
    assert b.charge("profile", {"coords": [[-90.12345, 34.75], [-90.1, 34.8]]}) is None
    assert "already called" in b.charge(
        "profile", {"coords": [[-90.12345, 34.75], [-90.1, 34.8]]}
    )
    assert b.charge("profile", {"coords": [[-90.12341, 34.75], [-90.1, 34.8]]}) is None
    assert b.used == 3
    assert "limit of 4" in b.charge(
        "profile", {"coords": [[-90.12342, 34.75], [-90.1, 34.8]]}
    )
    # Calls made earlier in the same question (before the page ran tools) count.
    history = [
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "tool_calls": [{"id": "1", "name": "go_to", "input": {"query": "dam"}}],
        },
        {"role": "tool", "results": []},
    ]
    b = relay.ToolBudget(4, history)
    assert b.used == 1 and "already called" in b.charge("go_to", {"query": "dam"})
    assert relay.tool_budget(SimpleNamespace()) == relay.TOOL_BUDGET


def test_a_named_place_is_geocoded_not_scanned(tmp_path, monkeypatch):
    """A wiring test: a scripted model asks for "the dam"; geocode answers on the
    server (a mock Nominatim), then point_timeseries reads there; no profile."""
    from bowser import geocode  # noqa: PLC0415
    from bowser.assistant import page  # noqa: PLC0415

    def nominatim(_request):
        return httpx.Response(
            200,
            json=[
                {
                    "display_name": "Arkabutla Dam",
                    "lon": "-117.5",
                    "lat": "33.5",
                    "boundingbox": ["33.49", "33.51", "-117.51", "-117.49"],
                    "type": "dam",
                }
            ],
        )

    g = geocode.Geocoder(interval=0, transport=httpx.MockTransport(nominatim))
    monkeypatch.setattr(page, "GEOCODER", g)
    fake = ScriptedProvider(
        [
            Turn(
                "", [ToolCall("g", "geocode", {"query": "Arkabutla Dam"})], "tool_use"
            ),
            Turn(
                "",
                [ToolCall("p", "point_timeseries", {"lon": -117.5, "lat": 33.5})],
                "tool_use",
            ),
            Turn("The dam moved 1 mm.", [], "end"),
        ]
    )
    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: fake)
    app = make_app(settings(tmp_path))
    app.include_router(page.router)

    @app.get("/chart_point")
    def chart_point():
        return {
            "labels": ["2020-01-01", "2020-02-01"],
            "datasets": [
                {
                    "data": [
                        {"x": "2020-01-01", "y": 0.0},
                        {"x": "2020-02-01", "y": 0.001},
                    ]
                }
            ],
        }

    r = local(app).post(
        "/assistant/chat",
        json={
            "provider": "ollama",
            "messages": [{"role": "user", "content": "Trend at the dam?"}],
            "page_masks": [],
        },
    )
    ev = events(r.text)
    ran = [(e["name"], e["ok"]) for e in ev if e["type"] == "tool_result"]
    assert ran == [("geocode", True), ("point_timeseries", True)]
    found = next(e for e in ev if e["type"] == "tool_result")["result"]
    assert found["results"][0]["lon"] == -117.5
    assert "profile" not in [e.get("name") for e in ev if e["type"] == "tool_call"]
    # The instructions and profile's description steer away from scanning.
    sent = {t["name"]: t for t in fake.sent[0]["tools"]}
    assert "never to find a feature or a place" in sent["profile"]["description"]
    assert (
        "Never search for\na place by scanning with profile" in fake.sent[0]["system"]
    )


# --- Ollama on this computer -------------------------------------------------------


def test_ollama_is_hidden_when_not_installed(tmp_path):
    gone = FakeOllama(installed=False)
    client = local(make_app(settings(tmp_path), gone))
    status = client.get("/assistant/status").json()
    assert "ollama" not in [p["id"] for p in status["providers"]]
    assert "ollama" not in client.get("/config").json()["assistant"]["providers"]
    chat = {"provider": "ollama", "messages": [{"role": "user", "content": "hi"}]}
    r = client.post("/assistant/chat", json=chat)
    assert r.status_code == 400 and "not installed" in r.json()["detail"]
    assert gone.starts == []


def test_ollama_lists_its_installed_models_or_says_there_are_none(tmp_path):
    def status_with(fake, s=None):
        app = make_app(s or settings(tmp_path), fake)
        status = local(app).get("/assistant/status").json()
        return next(p for p in status["providers"] if p["id"] == "ollama")

    up = FakeOllama(models=["llama3.2", "qwen3"])
    o = status_with(up)
    assert o["models"] == ["llama3.2", "qwen3"] and o["model"] == "qwen3"
    assert o["available"] and o["configured"] and "base_url" not in o
    assert up.starts == [True]  # started on the user's own computer when needed

    assert status_with(FakeOllama(models=["mistral"]))["model"] == "mistral"

    o = status_with(FakeOllama(models=[]))
    assert (o["available"], o["note"]) == (False, "No local models are installed.")

    # A shared server never starts it; one not running is listed as not started.
    hosted = FakeOllama(running=False)
    o = status_with(hosted, settings(tmp_path, BOWSER_ASSISTANT_PAGE_KEYS=False))
    assert hosted.starts == [False]
    assert (o["available"], o["note"]) == (False, "Ollama did not start.")


class FakeProcess:
    """A started ``ollama serve``: running until stopped (or ``exits``)."""

    def __init__(self, argv, exits=False, **kwargs):
        self.argv, self.kwargs = argv, kwargs
        self.returncode = 1 if exits else None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):  # noqa: ARG002
        return self.returncode


def _ollama_server(state):
    """Ollama's API: answers only once ``state["up"]``; two models installed."""

    def handler(request):
        if not state["up"]:
            raise httpx.ConnectError("refused")
        if request.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.12.0"})
        if request.url.path == "/api/tags":
            models = [{"name": "qwen3:latest"}, {"name": "llama3.2:3b"}]
            return httpx.Response(200, json={"models": models})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def test_ollama_is_started_in_the_background_and_stopped_on_exit(tmp_path, monkeypatch):
    from bowser.assistant import ollama as local_ollama  # noqa: PLC0415

    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    registered = []
    monkeypatch.setattr(local_ollama.atexit, "register", registered.append)
    state = {"up": False}
    started = []

    def popen(argv, **kwargs):
        started.append(FakeProcess(argv, **kwargs))
        state["up"] = True  # it answers once started
        return started[-1]

    o = local_ollama.Ollama(
        which=lambda name: f"/opt/bin/{name}",
        popen=popen,
        transport=_ollama_server(state),
        log_dir=tmp_path / "cache",
    )
    assert o.ensure() is True
    (proc,) = started
    assert proc.argv == ["/opt/bin/ollama", "serve"]
    env = proc.kwargs["env"]
    assert env["OLLAMA_HOST"] == "127.0.0.1:11434"
    assert "OPENAI_API_KEY" not in env and KEY not in json.dumps(env)
    assert (tmp_path / "cache" / "ollama.log").exists()
    assert o.started_here and registered == [o.stop]
    assert o.models() == ["llama3.2:3b", "qwen3"]
    assert o.ensure() is True and len(started) == 1  # not started twice
    o.stop()
    assert proc.terminated and not o.started_here


def test_ollama_already_running_is_used_and_never_stopped(tmp_path):
    from bowser.assistant import ollama as local_ollama  # noqa: PLC0415

    def popen(*_a, **_k):
        raise AssertionError("must not start a second Ollama")

    o = local_ollama.Ollama(
        which=lambda _name: "/opt/bin/ollama",
        popen=popen,
        transport=_ollama_server({"up": True}),
        log_dir=tmp_path,
    )
    assert o.ensure() is True and not o.started_here
    o.stop()  # nothing of Bowser's to stop


def test_ollama_that_does_not_start_or_is_not_allowed_to(tmp_path):
    from bowser.assistant import ollama as local_ollama  # noqa: PLC0415

    started = []

    def popen(argv, **kwargs):
        started.append(FakeProcess(argv, exits=True, **kwargs))
        return started[-1]

    o = local_ollama.Ollama(
        which=lambda _name: "/opt/bin/ollama",
        popen=popen,
        transport=_ollama_server({"up": False}),
        log_dir=tmp_path,
        start_timeout=5,
    )
    assert o.ensure(start=False) is False and started == []
    assert o.ensure() is False and len(started) == 1  # it exited at once
    assert o.models() == []
    missing = local_ollama.Ollama(which=lambda _name: None, popen=popen)
    assert missing.binary() is None and missing.ensure() is False
    assert len(started) == 1


# --- wire formats ------------------------------------------------------------------


def sse(*chunks: dict | str) -> bytes:
    """A server-sent event stream of ``chunks`` (dicts as JSON)."""
    out = ""
    for c in chunks:
        out += f"data: {c if isinstance(c, str) else json.dumps(c)}\n\n"
    return out.encode()


def run_stream(provider, messages, tools=()):
    async def go():
        got = []
        async for kind, value in provider.stream("SYSTEM", messages, list(tools)):
            got.append((kind, value))
        return got

    return asyncio.run(go())


TOOL = {
    "name": "point_timeseries",
    "description": "Series at a point.",
    "input_schema": {
        "type": "object",
        "properties": {
            "lon": {"type": "number", "description": "lon"},
            "lat": {"type": "number", "description": "lat"},
            "dataset": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "default": None,
                "title": "Dataset",
            },
            "geometry": {"type": "object", "additionalProperties": True},
        },
        "required": ["lon", "lat"],
    },
}

HISTORY = [
    {"role": "user", "content": "Is it moving?"},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "t1", "name": "point_timeseries", "input": {"lon": 1}}],
    },
    {
        "role": "tool",
        "results": [
            {"id": "t1", "name": "point_timeseries", "content": "{}", "is_error": False}
        ],
    },
]


def test_openai_stream_assembles_tool_calls():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            content=sse(
                {"choices": [{"delta": {"content": "Checking "}}]},
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "function": {
                                            "name": "point_timeseries",
                                            "arguments": '{"lon": -117',
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": ', "lat": 34}'},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
                "[DONE]",
            ),
            headers={"content-type": "text/event-stream"},
        )

    p = providers.open_provider(
        providers.preset("openai"), "gpt-5.5", KEY, None, httpx.MockTransport(handler)
    )
    got = run_stream(p, HISTORY, [TOOL])
    assert got[0] == ("text", "Checking ")
    turn = got[-1][1]
    assert turn.stop == "tool_use"
    assert turn.tool_calls == [
        ToolCall("call_1", "point_timeseries", {"lon": -117, "lat": 34})
    ]
    assert seen["url"] == "https://api.openai.com/v1/chat/completions"
    assert seen["auth"] == f"Bearer {KEY}"
    body = seen["body"]
    assert body["stream"] is True
    assert "temperature" not in body and "tool_choice" not in body
    assert body["messages"][0] == {"role": "system", "content": "SYSTEM"}
    assert body["messages"][2]["tool_calls"][0]["function"]["arguments"] == '{"lon": 1}'
    assert body["messages"][3] == {
        "role": "tool",
        "tool_call_id": "t1",
        "content": "{}",
    }
    assert body["tools"][0]["function"]["parameters"] == TOOL["input_schema"]
    assert KEY not in repr(p)


@pytest.mark.parametrize(
    ("status", "kind"),
    [(401, "auth"), (429, "rate_limit"), (503, "provider_down"), (404, "bad_request")],
)
def test_http_errors_say_what_went_wrong(status, kind):
    transport = httpx.MockTransport(
        lambda _r: httpx.Response(status, json={"error": {"message": "nope"}})
    )
    p = providers.open_provider(
        providers.preset("openrouter"), "", KEY, None, transport
    )
    with pytest.raises(ProviderError) as e:
        run_stream(p, HISTORY)
    assert e.value.kind == kind
    assert "nope" in str(e.value) and KEY not in str(e.value)


def test_unreachable_local_server_is_provider_down():
    def handler(_request):
        raise httpx.ConnectError("refused")

    p = providers.open_provider(
        providers.preset("ollama"), "", None, None, httpx.MockTransport(handler)
    )
    with pytest.raises(ProviderError) as e:
        run_stream(p, HISTORY)
    assert e.value.kind == "provider_down"
    assert "127.0.0.1:11434" in str(e.value)


def test_gemini_parts_signatures_and_schema():
    seen = {}
    call_part = {
        "functionCall": {"name": "point_timeseries", "args": {"lon": 2, "lat": 3}},
        "thoughtSignature": "sig==",
    }

    def handler(request):
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            content=sse(
                {
                    "candidates": [
                        {"content": {"parts": [{"text": "Looking", "thought": True}]}}
                    ]
                },
                {
                    "candidates": [
                        {"content": {"parts": [{"text": "Sure."}, call_part]}}
                    ]
                },
                {"candidates": [{"finishReason": "STOP"}]},
            ),
        )

    p = providers.open_provider(
        providers.preset("gemini"), "", KEY, None, httpx.MockTransport(handler)
    )
    got = run_stream(p, HISTORY, [TOOL])
    assert [g for g in got if g[0] == "text"] == [("text", "Sure.")]
    turn = got[-1][1]
    assert turn.tool_calls[0].name == "point_timeseries"
    assert turn.tool_calls[0].input == {"lon": 2, "lat": 3}
    assert seen["url"].endswith(
        "/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    )
    assert seen["key"] == KEY
    body = seen["body"]
    assert body["systemInstruction"] == {"parts": [{"text": "SYSTEM"}]}
    assert body["contents"][2]["parts"][0]["functionResponse"]["response"] == {
        "result": "{}"
    }
    params = body["tools"][0]["functionDeclarations"][0]["parameters"]
    assert params["properties"]["dataset"] == {"type": "string", "nullable": True}
    assert params["properties"]["geometry"]["type"] == "string"
    # The turn goes back as Gemini sent it, thought signature included.
    again = HISTORY[:1] + [turn.message()]
    contents = providers.GeminiProvider.request_contents(again)
    assert call_part in contents[1]["parts"]

    blocked = httpx.MockTransport(
        lambda _r: httpx.Response(
            200,
            content=sse({"candidates": [{"finishReason": "SAFETY"}]}),
        )
    )
    p = providers.open_provider(providers.preset("gemini"), "", KEY, None, blocked)
    assert run_stream(p, HISTORY)[-1][1].stop == "refusal"


def _anthropic_events(content: list[dict], stop: str) -> bytes:
    msg = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": [],
        "stop_reason": None,
        "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 0},
    }
    out: list[dict] = [{"type": "message_start", "message": msg}]
    for i, block in enumerate(content):
        if block["type"] == "text":
            out.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {"type": "text", "text": ""},
                }
            )
            out.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {"type": "text_delta", "text": block["text"]},
                }
            )
        elif block["type"] == "thinking":
            out.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {
                        "type": "thinking",
                        "thinking": "",
                        "signature": "",
                    },
                }
            )
            out.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {
                        "type": "signature_delta",
                        "signature": block["signature"],
                    },
                }
            )
        else:
            out.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {**block, "input": {}},
                }
            )
            out.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": json.dumps(block["input"]),
                    },
                }
            )
        out.append({"type": "content_block_stop", "index": i})
    out.append(
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop, "stop_sequence": None},
            "usage": {"output_tokens": 5},
        }
    )
    out.append({"type": "message_stop"})
    return "".join(
        f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in out
    ).encode()


def test_anthropic_through_the_sdk():
    pytest.importorskip("anthropic")
    seen = []
    content = [
        {"type": "thinking", "signature": "SIG"},
        {"type": "text", "text": "Reading the series."},
        {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "point_timeseries",
            "input": {"lon": 1, "lat": 2},
        },
    ]

    def handler(request):
        seen.append(
            {
                "url": str(request.url),
                # SDK 2 sends the key as a bearer token, earlier ones as x-api-key.
                "key": request.headers.get("x-api-key")
                or request.headers.get("authorization", "").removeprefix("Bearer "),
                "beta": request.headers.get("anthropic-beta", ""),
                "body": json.loads(request.content),
            }
        )
        return httpx.Response(
            200,
            content=_anthropic_events(content, "tool_use"),
            headers={"content-type": "text/event-stream"},
        )

    import httpx2  # the SDK's HTTP client  # noqa: PLC0415

    p = providers.open_provider(
        providers.preset("anthropic"),
        "claude-opus-5-5",
        KEY,
        None,
        httpx2.MockTransport(lambda r: _to_httpx2(handler, r, httpx2)),
    )
    got = run_stream(p, HISTORY, [TOOL])
    assert ("text", "Reading the series.") in got
    turn = got[-1][1]
    assert turn.stop == "tool_use"
    assert turn.tool_calls == [
        ToolCall("toolu_1", "point_timeseries", {"lon": 1, "lat": 2})
    ]
    assert turn.native["wire"] == "anthropic"
    assert turn.native["content"][0]["signature"] == "SIG"

    req = seen[0]
    assert req["url"].startswith("https://api.anthropic.com/v1/messages")
    assert req["key"] == KEY
    body = req["body"]
    assert body["model"] == "claude-opus-5-5"
    assert body["stream"] is True
    assert body["thinking"] == {"type": "adaptive"}
    assert body["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in req["beta"]
    for banned in ("temperature", "top_p", "top_k", "tool_choice"):
        assert banned not in body
    assert body["tools"][0]["eager_input_streaming"] is True
    assert body["messages"][1]["content"][0]["type"] == "tool_use"
    assert body["messages"][2]["content"][0] == {
        "type": "tool_result",
        "tool_use_id": "t1",
        "content": "{}",
        "is_error": False,
    }

    # The thinking block goes back unchanged on the next request.
    again = providers.AnthropicProvider.request_messages(HISTORY[:1] + [turn.message()])
    assert again[1]["content"][0] == turn.native["content"][0]


def test_anthropic_refusal_and_bad_key():
    pytest.importorskip("anthropic")
    import httpx2  # noqa: PLC0415

    refusal = httpx2.MockTransport(
        lambda _r: httpx2.Response(
            200,
            content=_anthropic_events([{"type": "text", "text": ""}], "refusal"),
            headers={"content-type": "text/event-stream"},
        )
    )
    p = providers.open_provider(providers.preset("anthropic"), "", KEY, None, refusal)
    turn = run_stream(p, HISTORY)[-1][1]
    assert turn.stop == "refusal" and turn.tool_calls == []

    denied = httpx2.MockTransport(
        lambda _r: httpx2.Response(
            401,
            json={
                "type": "error",
                "error": {
                    "type": "authentication_error",
                    "message": "invalid x-api-key",
                },
            },
        )
    )
    p = providers.open_provider(providers.preset("anthropic"), "", KEY, None, denied)
    with pytest.raises(ProviderError) as e:
        run_stream(p, HISTORY)
    assert e.value.kind == "auth" and KEY not in str(e.value)
    assert asyncio.run(p.check()) is False


def _to_httpx2(handler, request, httpx2):
    """Call an httpx-style handler with an httpx2 request (same API)."""
    r = handler(
        SimpleNamespace(
            url=request.url, headers=request.headers, content=request.content
        )
    )
    return httpx2.Response(r.status_code, content=r.content, headers=dict(r.headers))


# --- the providers' model lists ----------------------------------------------------


def models_client(tmp_path, monkeypatch, transport, ollama=None, **over):
    """A client whose providers talk to ``transport``; an empty model cache."""
    monkeypatch.setattr(relay, "_models_cache", {})
    monkeypatch.setattr(
        relay,
        "open_provider",
        lambda p, m, key: providers.open_provider(p, m, key, None, transport),
    )
    return local(make_app(settings(tmp_path, **over), ollama))


def test_openai_models_are_the_chat_models_newest_first_and_cached(
    tmp_path, monkeypatch
):
    seen = []

    def handler(request):
        seen.append((str(request.url), request.headers.get("authorization")))
        data = [
            {"id": "gpt-5-mini", "created": 2},
            {"id": "text-embedding-3-large", "created": 9},
            {"id": "tts-1", "created": 9},
            {"id": "whisper-1", "created": 9},
            {"id": "gpt-image-1", "created": 9},
            {"id": "omni-moderation-latest", "created": 9},
            {"id": "gpt-5.5", "created": 3},
        ]
        return httpx.Response(200, json={"object": "list", "data": data})

    client = models_client(
        tmp_path,
        monkeypatch,
        httpx.MockTransport(handler),
        OPENAI_API_KEY=SecretStr(KEY),
    )
    r = client.get("/assistant/models", params={"provider": "openai"})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "provider": "openai",
        "models": [
            {"id": "gpt-5.5", "label": None},
            {"id": "gpt-5-mini", "label": None},
        ],
        "cached": False,
    }
    assert seen == [("https://api.openai.com/v1/models", f"Bearer {KEY}")]
    assert KEY not in r.text
    # Kept for ten minutes: the provider is not asked again...
    again = client.get("/assistant/models", params={"provider": "openai"})
    assert again.json()["cached"] is True and len(seen) == 1
    # ...unless the page asks for a refresh, or the ten minutes are over.
    fresh = client.get("/assistant/models", params={"provider": "openai", "refresh": 1})
    assert fresh.json()["cached"] is False and len(seen) == 2
    monkeypatch.setattr(relay, "MODELS_TTL", 0.0)
    client.get("/assistant/models", params={"provider": "openai"})
    assert len(seen) == 3
    # The models' model validates the response.
    from bowser import api_models as api  # noqa: PLC0415

    api.AssistantModels.model_validate(r.json())


def test_openrouter_models_are_those_that_take_tools(tmp_path, monkeypatch):
    def handler(request):
        assert request.url.path == "/api/v1/models"
        data = [
            {
                "id": "old/no-tools",
                "name": "No tools",
                "created": 5,
                "supported_parameters": ["temperature"],
            },
            {
                "id": "anthropic/claude-opus-5.5",
                "name": "Anthropic: Claude Opus 5.5",
                "created": 4,
                "supported_parameters": ["tools", "tool_choice"],
            },
            {
                "id": "openai/gpt-5.5",
                "name": "OpenAI: GPT-5.5",
                "created": 7,
                "supported_parameters": ["tools"],
            },
            {"id": "openrouter/auto", "name": "Auto Router", "created": 1},
        ]
        return httpx.Response(200, json={"data": data})

    client = models_client(
        tmp_path,
        monkeypatch,
        httpx.MockTransport(handler),
        OPENROUTER_API_KEY=SecretStr(KEY),
    )
    r = client.get("/assistant/models", params={"provider": "openrouter"})
    assert r.status_code == 200, r.text
    assert r.json()["models"] == [
        {"id": "openai/gpt-5.5", "label": "OpenAI: GPT-5.5"},
        {"id": "anthropic/claude-opus-5.5", "label": "Anthropic: Claude Opus 5.5"},
        {"id": "openrouter/auto", "label": "Auto Router"},
    ]


def test_gemini_models_that_generate_content_from_every_page(tmp_path, monkeypatch):
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        assert request.headers.get("x-goog-api-key") == KEY
        if "pageToken" not in request.url.params:
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "models/gemini-3.8-flash",
                            "displayName": "Gemini 3.8 Flash",
                            "supportedGenerationMethods": [
                                "generateContent",
                                "countTokens",
                            ],
                        },
                        {
                            "name": "models/text-embedding-005",
                            "displayName": "Text Embedding",
                            "supportedGenerationMethods": ["embedContent"],
                        },
                    ],
                    "nextPageToken": "p2",
                },
            )
        return httpx.Response(
            200,
            json={
                "models": [
                    {
                        "name": "models/gemini-3.8-pro",
                        "supportedGenerationMethods": ["generateContent"],
                    }
                ]
            },
        )

    client = models_client(
        tmp_path,
        monkeypatch,
        httpx.MockTransport(handler),
        GEMINI_API_KEY=SecretStr(KEY),
    )
    r = client.get("/assistant/models", params={"provider": "gemini"})
    assert r.status_code == 200, r.text
    assert r.json()["models"] == [
        {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"},
        {"id": "gemini-3.8-pro", "label": None},
    ]
    assert [s.get("pageToken") for s in seen] == [None, "p2"]
    assert KEY not in r.text and KEY not in json.dumps(seen)


def test_anthropic_models_through_the_sdk_every_page(tmp_path, monkeypatch):
    pytest.importorskip("anthropic")
    import httpx2  # the SDK's HTTP client  # noqa: PLC0415

    pages = {
        None: {
            "data": [
                {
                    "type": "model",
                    "id": "claude-opus-5-5",
                    "display_name": "Claude Opus 5.5",
                    "created_at": "2026-09-01T00:00:00Z",
                }
            ],
            "has_more": True,
            "first_id": "claude-opus-5-5",
            "last_id": "claude-opus-5-5",
        },
        "claude-opus-5-5": {
            "data": [
                {
                    "type": "model",
                    "id": "claude-haiku-5-5",
                    "display_name": "Claude Haiku 5.5",
                    "created_at": "2026-08-01T00:00:00Z",
                }
            ],
            "has_more": False,
            "first_id": "claude-haiku-5-5",
            "last_id": "claude-haiku-5-5",
        },
    }
    seen = []

    def handler(request):
        after = request.url.params.get("after_id")
        seen.append((request.url.path, after))
        return httpx2.Response(200, json=pages[after])

    client = models_client(
        tmp_path,
        monkeypatch,
        httpx2.MockTransport(handler),
        ANTHROPIC_API_KEY=SecretStr(KEY),
    )
    r = client.get("/assistant/models", params={"provider": "anthropic"})
    assert r.status_code == 200, r.text
    assert r.json()["models"] == [
        {"id": "claude-opus-5-5", "label": "Claude Opus 5.5"},
        {"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5"},
    ]
    assert seen == [("/v1/models", None), ("/v1/models", "claude-opus-5-5")]
    assert KEY not in r.text


def test_model_list_gates_and_errors(tmp_path, monkeypatch):
    def denied(_request):
        return httpx.Response(401, json={"error": {"message": f"bad key {KEY[:6]}"}})

    off = models_client(
        tmp_path, monkeypatch, httpx.MockTransport(denied), BOWSER_ASSISTANT=False
    )
    assert (
        off.get("/assistant/models", params={"provider": "openai"}).status_code == 403
    )
    client = models_client(tmp_path, monkeypatch, httpx.MockTransport(denied))
    r = client.get("/assistant/models", params={"provider": "openai"})
    assert r.status_code == 400 and "API key" in r.json()["detail"]
    assert (
        client.get("/assistant/models", params={"provider": "nope"}).status_code == 400
    )
    assert (
        client.get("/assistant/models", params={"provider": "chatgpt"}).status_code
        == 400
    )

    keyed = models_client(
        tmp_path,
        monkeypatch,
        httpx.MockTransport(denied),
        OPENAI_API_KEY=SecretStr(KEY),
    )
    r = keyed.get("/assistant/models", params={"provider": "openai"})
    assert r.status_code == 401 and KEY not in r.text
    assert relay._models_cache == {}  # a failure is not kept

    def down(_request):
        raise httpx.ConnectError("refused")

    keyed = models_client(
        tmp_path,
        monkeypatch,
        httpx.MockTransport(down),
        OPENAI_API_KEY=SecretStr(KEY),
    )
    r = keyed.get("/assistant/models", params={"provider": "openai"})
    assert r.status_code == 502 and KEY not in r.text


def test_ollama_model_list_is_the_installed_models(tmp_path, monkeypatch):
    def nothing(_request):
        raise AssertionError("Ollama's list comes from Ollama itself")

    up = FakeOllama(models=["llama3.2", "qwen3"])
    client = models_client(tmp_path, monkeypatch, httpx.MockTransport(nothing), up)
    r = client.get("/assistant/models", params={"provider": "ollama"})
    assert r.json()["models"] == [
        {"id": "llama3.2", "label": None},
        {"id": "qwen3", "label": None},
    ]
    gone = models_client(
        tmp_path, monkeypatch, httpx.MockTransport(nothing), FakeOllama(installed=False)
    )
    assert (
        gone.get("/assistant/models", params={"provider": "ollama"}).status_code == 400
    )


def test_built_in_model_lists_keep_their_defaults():
    anthropic = providers.preset("anthropic")
    assert anthropic.model == "claude-opus-5-5"
    assert anthropic.models == (
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-fable-5-2",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-8",
    )
    for p in providers.PRESETS:
        assert not p.model or p.model in p.models or p.id == "chatgpt", p.id


# --- the real apps -----------------------------------------------------------------

SCRIPT = textwrap.dedent(
    r"""
    import importlib, json, sys
    from pathlib import Path

    from fastapi.testclient import TestClient

    sys.path.insert(0, sys.argv[3])
    from cube import CENTER_LONLAT, REF_LONLAT

    which, out = sys.argv[1], Path(sys.argv[2])
    app = importlib.import_module(
        "bowser.lite.main" if which == "lite" else "bowser.main"
    ).app

    from bowser.assistant import ollama, relay, signin
    from bowser.assistant.providers import ToolCall, Turn

    # Never look for (or start) a real Ollama or an agent program.
    ollama.OLLAMA = ollama.Ollama(which=lambda _name: None)
    signin.find_program = lambda _name: None

    class Scripted:
        def __init__(self):
            lon, lat = CENTER_LONLAT
            self.turns = [
                Turn("", [ToolCall("c1", "point_timeseries",
                                   {"lon": lon, "lat": lat})], "tool_use"),
                Turn("Done.", [], "end"),
            ]

        async def stream(self, system, messages, tools):
            yield "turn", self.turns.pop(0)

    relay.open_provider = lambda *_a, **_k: Scripted()
    http = TestClient(app, client=("127.0.0.1", 50000))
    chat = http.post("/assistant/chat", json={
        "provider": "openrouter",
        "messages": [{"role": "user", "content": "series?"}],
    })
    lon, lat = CENTER_LONLAT
    out.write_text(json.dumps({
        "config": http.get("/config").json(),
        "status": http.get("/assistant/status").json(),
        "chat_status": chat.status_code,
        "chat": chat.text,
        "api": http.get("/chart_point", params={
            "dataset_name": "displacement", "lon": lon, "lat": lat,
            "ref_lon": REF_LONLAT[0], "ref_lat": REF_LONLAT[1]}).json(),
    }))
    """
)


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    pytest.importorskip("rioxarray")
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("assistant-cube") / "regression.zarr")


@pytest.mark.parametrize("which", ["full", "lite"])
def test_config_flag_and_chat_on_the_real_apps(which, cube, tmp_path):
    if which == "full":
        pytest.importorskip("titiler.core")
    script = tmp_path / "run.py"
    script.write_text(SCRIPT)
    out = tmp_path / "out.json"
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
        env.pop(name, None)
    env.update(
        BOWSER_STACK_DATA_FILE=str(cube),
        BOWSER_ASSISTANT="true",
        BOWSER_ASSISTANT_PAGE_KEYS="true",
        BOWSER_ASSISTANT_KEY_FILE=str(tmp_path / "keys.json"),
        OPENROUTER_API_KEY=KEY,
    )
    proc = subprocess.run(
        [sys.executable, str(script), which, str(out), str(REGRESSION)],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]
    res = json.loads(out.read_text())
    flag = res["config"]["assistant"]
    assert flag["enabled"] is True
    assert "anthropic" in flag["providers"] and "chatgpt" not in flag["providers"]
    assert flag["configured"] == ["openrouter"]
    # Sign-in is offered on this computer: Claude (not installed here) and ChatGPT.
    assert flag["sign_in"] == ["claude", "chatgpt"]
    methods = {m["id"]: m for m in res["status"]["sign_in"]["methods"]}
    assert res["status"]["sign_in"]["allowed"] is True
    assert methods["claude"]["state"] == "not_installed"
    assert methods["claude"]["install_url"].startswith("https://code.claude.com/")
    assert methods["chatgpt"]["state"] == "signed_out"
    assert KEY not in json.dumps(res["config"]) + json.dumps(res["status"])

    from bowser import api_models as api  # pydantic only; no settings

    api.ConfigInfo.model_validate(res["config"])
    api.AssistantStatus.model_validate(res["status"])

    assert res["chat_status"] == 200
    ev = events(res["chat"])
    result = next(e for e in ev if e["type"] == "tool_result")
    assert result["ok"], result
    # The tool read the cube the page shows: the same dates as the HTTP API.
    assert result["result"]["dates"] == [
        d["x"] for d in res["api"]["datasets"][0]["data"]
    ]
    assert ev[-1] == {"type": "done", "stop": "end"}


def test_every_tool_says_what_it_is_doing():
    """Each data tool has a short status line, shown while it runs."""
    from bowser.tools import BowserAPI, ToolSpec, build_tools

    tools = build_tools(BowserAPI("http://x"))
    # Every tool, data or page, has its own label (not one made from its name).
    assert [t.name for t in tools if not t.status] == []
    specs = {t.name: t.status_text for t in tools}
    assert specs["point_timeseries"] == "Reading the time series"
    assert specs["fly_to"] == "Moving the map"
    assert specs["set_masks"] == "Setting the masks"
    assert specs["trend_at_point"] == "Fitting the trend"
    assert all(text and not text.endswith(("…", ".")) for text in specs.values())

    async def some_tool():
        return {}

    assert ToolSpec("some_tool", "", some_tool).status_text == "Some tool"
