"""The page channel (src/bowser/assistant/page.py) and the page tools over MCP.

- a command reaches a page listening on ``GET /page/events``, and its answer
  comes back; a page that does not answer times out; with no page open the
  tool says to open one; the page focused most recently gets the commands;
- only from this computer, only with page keys, only Bowser's own page may
  listen, and commands are refused from a browser; sizes and rates are bounded;
- ``bowser mcp``'s page tools, through an MCP client in memory, send what the
  model asked to the page (get_view, fly_to, fit_bounds, pan, zoom, go_to, the
  reference, masks, display and commands), check layer names with close
  matches before sending, and the data tools apply the page's masks;
- ``GET /geocode`` through the server, with a mock geocoder.

A small app (the relay's and the channel's routes, a fake data API) runs on a
real local server, as the page and ``bowser mcp`` reach it. Nothing here imports
bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

pytest.importorskip("httpx")
pytest.importorskip("fastapi")
pytest.importorskip("mcp")

from fake_page import FakePage, Refuse  # noqa: E402
from fastapi import Body, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from mcp import Client  # noqa: E402
from pydantic import SecretStr  # noqa: E402

from bowser import geocode  # noqa: E402
from bowser.assistant import page, relay  # noqa: E402
from bowser.mcp_server import build_server  # noqa: E402

_LAYER_SPECS: list[tuple[str, str, list]] = [
    ("displacement", "m", ["2020-01-01", "2020-02-01", "2020-03-01"]),
    ("temporal_coherence", "", [0]),
    ("phase_similarity", "", [0]),
    ("timeseries_inversion_residuals", "", [0]),
    ("recommended_mask", "", [0]),
]
LAYERS: dict[str, dict] = {
    name: {
        "label": name,
        "unit": unit,
        "x_values": dates,
        "n_time_steps": len(dates),
        "latlon_bounds": [-90.2, 34.7, -89.9, 34.9],
        "uses_spatial_ref": name == "displacement",
        "reference_lonlat": [-90.1, 34.8],
        "reference_date": "2020-01-01",
    }
    for name, unit, dates in _LAYER_SPECS
}


def settings(**over) -> SimpleNamespace:
    base = {
        "BOWSER_ASSISTANT": True,
        "BOWSER_ASSISTANT_PAGE_KEYS": True,
        "BOWSER_ASSISTANT_KEY_FILE": "",
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


def make_app(s: SimpleNamespace, seen: list | None = None) -> FastAPI:
    """The relay's and the channel's routes, and the data routes the tools call."""
    app = FastAPI()
    app.include_router(relay.router)
    app.include_router(page.router)
    app.dependency_overrides[relay.get_settings] = lambda: s
    app.dependency_overrides[relay.get_ollama] = _Ollama
    seen = seen if seen is not None else []

    @app.get("/datasets")
    def datasets():
        return LAYERS

    @app.get("/chart_point")
    def chart_point(lon: float, lat: float, dataset_name: str):
        seen.append(("chart_point", {"lon": lon, "lat": lat}))
        return {
            "labels": LAYERS[dataset_name]["x_values"],
            "datasets": [
                {
                    "data": [
                        {"x": "2020-01-01", "y": 0.0},
                        {"x": "2020-02-01", "y": 0.01},
                    ]
                }
            ],
        }

    @app.post("/multi_point")
    def multi_point(body: dict = Body(...)):
        seen.append(("multi_point", body))
        return {
            "labels": ["2020-01-01", "2020-02-01", "2020-03-01"],
            "datasets": [
                {
                    "pointId": p["id"],
                    "data": [{"x": "2020-01-01", "y": 0.0}],
                    "trend": {"mmPerYear": 1.0, "stdMmPerYear": 0.1, "rSquared": 0.5}
                    if body.get("calculate_trends")
                    else None,
                }
                for p in body["points"]
            ],
        }

    @app.get("/reference_candidates")
    def reference_candidates(radius_m: float = 100, n: int = 5):
        seen.append(("reference_candidates", {"radius_m": radius_m, "n": n}))
        best = {
            "rank": 1,
            "lon": -90.05,
            "lat": 34.82,
            "radius_m": radius_m,
            "temporal_coherence_median": 0.93,
            "phase_similarity_median": 0.9,
            "viable_fraction": 0.8,
            "displacement_scatter_m": 0.002,
            "velocity": 0.0004,
            "reason": "coherent, flat",
            "extra": "dropped",
        }
        return {
            "recommended": best,
            "candidates": [best],
            "thresholds": {"temporal_coherence": 0.9},
            "distribution": {"temporal_coherence": {"p50": 0.6}},
        }

    return app


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    """A clean channel, a quick keep-alive and a geocoder with no network."""
    page.reset()
    monkeypatch.setattr(page, "PING_SECONDS", 0.2)
    monkeypatch.setattr(page, "TIMEOUT", 3.0)
    yield
    page.reset()


def serve(app: FastAPI):
    import uvicorn

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try:
            httpx.get(f"{url}/datasets", timeout=1)
            break
        except httpx.TransportError:
            time.sleep(0.05)
    return SimpleNamespace(url=url, server=server, thread=thread)


@pytest.fixture
def served():
    seen: list = []
    s = serve(make_app(settings(), seen))
    s.seen = seen
    yield s
    s.server.should_exit = True
    s.thread.join(10)


def command(url: str, name: str, args: dict | None = None) -> httpx.Response:
    return httpx.post(
        f"{url}/page/command", json={"name": name, "input": args or {}}, timeout=30
    )


# --- the channel --------------------------------------------------------------------


def test_command_reaches_the_page_and_its_answer_comes_back(served):
    view = {"center": [-90.1, 34.8], "zoom": 11}
    p = FakePage(served.url, lambda _name, _args: view).open()
    r = command(served.url, "get_view")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "result": view}
    assert p.commands == [("get_view", {})]
    # The page's refusal comes back as an error answer, not a server error.
    p.handler = lambda _name, _args: (_ for _ in ()).throw(Refuse("No layer 'x'."))
    r = command(served.url, "switch_layer", {"layer": "x"})
    assert r.json() == {"ok": False, "result": None, "error": "No layer 'x'."}
    p.close()


def test_no_page_and_a_page_that_does_not_answer(served, monkeypatch):
    r = command(served.url, "get_view")
    assert r.status_code == 409
    assert "No Bowser page is open — open http://127.0.0.1:" in r.json()["detail"]
    monkeypatch.setattr(page, "TIMEOUT", 0.5)
    p = FakePage(served.url, answer=False).open()
    t = time.monotonic()
    r = command(served.url, "get_view")
    assert r.status_code == 504 and "did not answer" in r.json()["detail"]
    assert time.monotonic() - t < 3
    assert p.commands == [("get_view", {})]
    assert not page.PENDING
    # Closed, the page is forgotten (at the next keep-alive).
    p.close()
    for _ in range(50):
        if not page.PAGES:
            break
        time.sleep(0.1)
    assert command(served.url, "get_view").status_code == 409


def test_the_page_focused_last_gets_the_commands(served):
    a = FakePage(served.url, lambda _n, _x: "a").open()
    b = FakePage(served.url, lambda _n, _x: "b").open()
    assert command(served.url, "get_view").json()["result"] == "b"
    assert a.focus() == 200
    assert command(served.url, "get_view").json()["result"] == "a"
    assert (len(a.commands), len(b.commands)) == (1, 1)
    # Never focused: the one opened last.
    page.reset()
    c = FakePage(served.url, lambda _n, _x: "c").open(focus=False)
    time.sleep(0.01)
    d = FakePage(served.url, lambda _n, _x: "d").open(focus=False)
    assert command(served.url, "get_view").json()["result"] == "d"
    for p in (a, b, c, d):
        p.close()


def test_only_this_computer_page_keys_and_bowsers_own_page():
    app = make_app(settings())
    far = TestClient(app, client=("10.1.2.3", 5000))
    near = TestClient(app, client=("127.0.0.1", 5000))
    body = {"name": "get_view", "input": {}}
    assert far.post("/page/command", json=body).status_code == 403
    assert far.get("/page/events", params={"page": "abcdefgh1"}).status_code == 403
    focus = {"page": "abcdefgh1"}
    assert far.post("/page/focus", json=focus).status_code == 403
    # A browser cannot send commands, not even Bowser's own page.
    origin = {"Origin": "http://127.0.0.1:8000"}
    r = near.post("/page/command", json=body, headers=origin)
    assert r.status_code == 403 and "not from a page" in r.json()["detail"]
    r = near.post("/page/command", json=body, headers={"Sec-Fetch-Mode": "cors"})
    assert r.status_code == 403
    # Another web site cannot listen or answer.
    evil = {"Origin": "https://evil.example"}
    params = {"page": "abcdefgh1"}
    assert near.get("/page/events", params=params, headers=evil).status_code == 403
    r = near.get(
        "/page/events", params=params, headers={"Sec-Fetch-Site": "cross-site"}
    )
    assert r.status_code == 403
    assert near.post("/page/focus", json=focus, headers=evil).status_code == 403
    # Not a command a tool may send.
    assert near.post("/page/command", json={"name": "add_overlay"}).status_code == 400
    # Without page keys (a shared server) or with the Assistant off: nothing.
    for s in (
        settings(BOWSER_ASSISTANT_PAGE_KEYS=False),
        settings(BOWSER_ASSISTANT=False),
    ):
        c = TestClient(make_app(s), client=("127.0.0.1", 5000))
        assert c.post("/page/command", json=body).status_code == 403
        assert c.get("/page/events", params=params).status_code == 403
        assert relay.assistant_config(s, _NoOllama())["page_channel"] is False
    assert relay.assistant_config(settings(), _NoOllama())["page_channel"] is True


class _NoOllama:
    def binary(self):
        return None


class _Ollama:
    """A local model, installed and running (for the chat's scripted model)."""

    def binary(self):
        return "/usr/bin/ollama"

    def ensure(self, start=True):  # noqa: ARG002
        return True

    def models(self):
        return ["qwen3"]


def test_sizes_and_rates_are_bounded(served, monkeypatch):
    p = FakePage(served.url, lambda _n, _x: "x" * (page.MAX_RESULT + 10)).open()
    r = command(served.url, "list_commands", {"query": "q" * (page.MAX_INPUT + 1)})
    assert r.status_code == 413
    # An answer too large is refused; the command then times out.
    monkeypatch.setattr(page, "TIMEOUT", 0.5)
    assert command(served.url, "get_view").status_code == 504
    monkeypatch.setattr(page, "MAX_RATE", 2)
    p.handler = lambda _n, _x: 1
    codes = [command(served.url, "get_view").status_code for _ in range(4)]
    assert 429 in codes
    # An answer for a command that is not waiting (or for another page) is refused.
    r = httpx.post(
        f"{served.url}/page/result", json={"page": p.id, "id": "nope", "ok": True}
    )
    assert r.status_code == 404
    p.close()


# --- the tools through MCP ---------------------------------------------------------


def call(url: str, name: str, args: dict | None = None):
    async def run():
        transport = httpx.AsyncHTTPTransport()
        try:
            async with Client(build_server(url, transport)) as client:
                return await client.call_tool(name, args or {})
        finally:
            await transport.aclose()

    r = asyncio.run(run())
    text = r.content[0].text if r.content else ""
    if r.is_error:
        return False, text
    return True, json.loads(text)


def test_map_tools_send_what_the_model_asked(served):
    def answer(name, args):
        return {"did": name, "args": args}

    p = FakePage(served.url, answer).open()
    asks = [
        ("get_view", {}),
        ("fly_to", {"lon": -90.12, "lat": 34.75}),
        ("fly_to", {"lon": -90.12, "lat": 34.75, "zoom": 13}),
        ("fit_bounds", {"west": -90.2, "south": 34.7, "east": -89.9, "north": 34.9}),
        ("pan", {"direction": "east", "fraction": 0.25}),
        ("pan", {"direction": "north", "distance_m": 2000}),
        ("zoom", {"delta": -1}),
        ("zoom", {"level": 12}),
        ("go_to", {"query": "Arkabutla Dam, Mississippi"}),
        ("set_terrain", {"on": True, "exaggeration": 5}),
        ("set_reference_point", {"lon": -90.1, "lat": 34.8, "radius_m": 200}),
        ("get_reference", {}),
        ("reset_reference", {}),
        ("set_reference_date", {"date": "2020-02-01"}),
        ("add_point", {"lon": -90.1, "lat": 34.8, "name": "crest"}),
        ("set_colormap", {"name": "RdBu", "reverse": True}),
        ("set_color_range", {"preset": "2sigma"}),
        ("run_command", {"id": "map.draw_tools", "args": {"on": True}}),
    ]
    for name, args in asks:
        ok, result = call(served.url, name, args)
        assert ok, (name, result)
        sent = {"padding": 40} if name == "fit_bounds" else {}
        if name == "pan" and "fraction" not in args:
            sent["fraction"] = 0.5
        if name in ("get_display", "set_colormap", "set_color_range"):
            sent["side"] = "left"
        assert result == {"did": name, "args": {**sent, **args}}, name
    assert [c[0] for c in p.commands] == [a[0] for a in asks]
    p.close()


def test_tools_check_their_arguments_before_the_page(served):
    p = FakePage(served.url).open()
    ok, text = call(served.url, "fly_to", {"lon": 200, "lat": 0})
    assert not ok
    ok, text = call(served.url, "zoom", {"level": 3, "delta": 1})
    assert not ok and "not both" in text
    ok, text = call(
        served.url, "fit_bounds", {"west": 1, "south": 0, "east": 0, "north": 1}
    )
    assert not ok and "west < east" in text
    ok, text = call(
        served.url,
        "set_masks",
        {
            "masks": [
                {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"},
                {
                    "dataset": "time_series_residual_inversion",
                    "threshold": 0,
                    "mode": "max",
                },
            ]
        },
    )
    assert not ok
    assert "did you mean timeseries_inversion_residuals?" in text
    ok, text = call(
        served.url,
        "set_split_screen",
        {
            "on": True,
            "left_layer": "phase similarity",
            "right_layer": "temporal_coherence",
        },
    )
    assert not ok and "did you mean phase_similarity?" in text
    assert p.commands == []
    # With the right names they reach the page.
    masks = [
        {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"},
        {"dataset": "phase_similarity", "threshold": 0.6, "mode": "min"},
        {"dataset": "timeseries_inversion_residuals", "threshold": 0, "mode": "max"},
    ]
    ok, _ = call(served.url, "set_masks", {"masks": masks})
    assert ok
    assert p.commands[-1] == ("set_masks", {"masks": masks, "replace": True})
    ok, _ = call(
        served.url,
        "set_split_screen",
        {
            "on": True,
            "left_layer": "phase_similarity",
            "right_layer": "temporal_coherence",
        },
    )
    assert ok
    assert p.commands[-1] == (
        "set_split_screen",
        {
            "on": True,
            "left_layer": "phase_similarity",
            "right_layer": "temporal_coherence",
        },
    )
    p.close()


def test_no_page_is_a_clear_tool_error(served):
    ok, text = call(served.url, "go_to", {"query": "Arkabutla Dam"})
    assert not ok and "No Bowser page is open — open http://127.0.0.1:" in text


def test_data_tools_apply_the_pages_masks(served):
    masks = [{"layer": "temporal_coherence", "threshold": 0.7, "mode": "min"}]

    def answer(name, args):
        assert (name, args) == ("get_masks", {"layer_ranges": False})
        return {"masks": masks, "recommended_mask": False}

    p = FakePage(served.url, answer).open()
    ok, res = call(served.url, "point_timeseries", {"lon": -90.1, "lat": 34.8})
    assert ok, res
    kind, body = served.seen[-1]
    assert kind == "multi_point"
    assert body["layer_masks"] == [
        {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}
    ]
    assert res["masks"]["source"] == "page"
    ok, res = call(served.url, "trend_at_point", {"lon": -90.1, "lat": 34.8})
    assert (
        ok
        and served.seen[-1][1]["layer_masks"]
        and served.seen[-1][1]["calculate_trends"]
    )
    ok, res = call(
        served.url,
        "multi_point_timeseries",
        {"points": [{"lon": -90.1, "lat": 34.8}]},
    )
    assert (
        ok and served.seen[-1][1]["layer_masks"][0]["dataset"] == "temporal_coherence"
    )
    # Asked not to, or without a page: unmasked, and the result says so.
    ok, res = call(
        served.url,
        "point_timeseries",
        {"lon": -90.1, "lat": 34.8, "use_page_masks": False},
    )
    assert served.seen[-1][0] == "chart_point" and res["masks"]["source"] == "none"
    p.close()
    page.reset()
    ok, res = call(served.url, "point_timeseries", {"lon": -90.1, "lat": 34.8})
    assert served.seen[-1][0] == "chart_point"
    assert "No Bowser page is connected" in res["masks"]["note"]


def test_geocode_through_the_server_needs_no_page(served, monkeypatch):
    def nominatim(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "display_name": "Arkabutla Dam, Tate County, Mississippi",
                    "lon": "-90.1253",
                    "lat": "34.7562",
                    "boundingbox": ["34.75", "34.76", "-90.13", "-90.12"],
                    "type": "dam",
                    "category": "waterway",
                }
            ],
        )

    monkeypatch.setattr(geocode, "GEOCODER", geocode.Geocoder(interval=0))
    monkeypatch.setattr(page, "GEOCODER", geocode.GEOCODER)
    geocode.GEOCODER.transport = httpx.MockTransport(nominatim)
    ok, res = call(served.url, "geocode", {"query": "Arkabutla Dam"})
    assert ok, res
    best = res["results"][0]
    assert best["bbox"] == [-90.13, 34.75, -90.12, 34.76]
    assert (best["lon"], best["lat"], best["kind"]) == (-90.1253, 34.7562, "dam")
    assert "OpenStreetMap" in res["attribution"]


# --- choosing a reference ----------------------------------------------------------


def test_reference_finder_wrapper_with_a_mock_server():
    from bowser.tools import BowserAPI, build_tools  # noqa: PLC0415

    asked = []

    def handle(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        if request.url.path != "/reference_candidates":
            return httpx.Response(404, json={"detail": "Not Found"})
        if request.url.params.get("dataset") == "nope":
            return httpx.Response(404, json={"detail": "No dataset 'nope'."})
        return httpx.Response(
            200,
            json={
                "recommended": {"lon": 1.0, "lat": 2.0, "radius_m": 150},
                "candidates": [
                    {"rank": 1, "lon": 1.0, "lat": 2.0, "radius_m": 150, "x": 9}
                ],
                "thresholds": {},
                "distribution": {},
            },
        )

    async def run(args, transport=None):
        api = BowserAPI("http://bowser", transport or httpx.MockTransport(handle))
        spec = next(
            s for s in build_tools(api) if s.name == "find_reference_candidates"
        )
        try:
            return await spec.call(args)
        finally:
            await api.aclose()

    out = asyncio.run(run({"radius_m": 150, "n": 3, "use_masks": True}))
    assert out["recommended"] == {"lon": 1.0, "lat": 2.0, "radius_m": 150}
    assert out["candidates"] == [{"rank": 1, "lon": 1.0, "lat": 2.0, "radius_m": 150}]
    q = dict(asked[-1].url.params)
    assert q == {"radius_m": "150.0", "n": "3", "use_masks": "true", "quantile": "0.95"}
    from bowser.tools import BowserError  # noqa: PLC0415

    with pytest.raises(BowserError, match="No dataset 'nope'"):
        asyncio.run(run({"dataset": "nope"}))
    no_route = httpx.MockTransport(
        lambda _r: httpx.Response(404, json={"detail": "Not Found"})
    )
    with pytest.raises(BowserError, match="no reference finder"):
        asyncio.run(run({}, no_route))


def test_find_a_stable_reference_and_move_it_there(served):
    """The flow a model follows: find_reference_candidates, then set_reference_point
    with the recommended lon, lat and radius_m; the page receives it."""
    p = FakePage(served.url, lambda _name, args: {"ok": True, **args}).open()
    ok, found = call(served.url, "find_reference_candidates", {"radius_m": 150})
    assert ok, found
    best = found["recommended"]
    assert "extra" not in found["candidates"][0]
    ok, moved = call(
        served.url,
        "set_reference_point",
        {"lon": best["lon"], "lat": best["lat"], "radius_m": best["radius_m"]},
    )
    assert ok
    assert p.commands == [
        ("set_reference_point", {"lon": -90.05, "lat": 34.82, "radius_m": 150.0})
    ]
    p.close()


def test_the_assistant_moves_the_reference_to_the_finders_choice(served, monkeypatch):
    """The same flow in the Assistant, with a scripted model: the finder runs on the
    server, set_reference_point goes to the page with the recommended values."""
    from bowser.assistant.providers import ToolCall, Turn  # noqa: PLC0415

    class Scripted:
        def __init__(self):
            self.sent = []

        async def stream(self, _system, messages, _tools):
            self.sent.append(messages)
            if len(self.sent) == 1:
                yield (
                    "turn",
                    Turn(
                        "",
                        [ToolCall("f", "find_reference_candidates", {"radius_m": 150})],
                        "tool_use",
                    ),
                )
                return
            res = json.loads(messages[-1]["results"][0]["content"])["recommended"]
            args = {"lon": res["lon"], "lat": res["lat"], "radius_m": res["radius_m"]}
            yield (
                "turn",
                Turn("", [ToolCall("s", "set_reference_point", args)], "tool_use"),
            )

    monkeypatch.setattr(relay, "open_provider", lambda *_a, **_k: Scripted())
    r = httpx.post(
        f"{served.url}/assistant/chat",
        json={
            "provider": "ollama",
            "messages": [
                {
                    "role": "user",
                    "content": "Find good coherence and move the reference there.",
                }
            ],
            "page_masks": [],
        },
        timeout=60,
    )
    ev = [json.loads(b[6:]) for b in r.text.split("\n\n") if b.startswith("data: ")]
    waiting = next(e for e in ev if e["type"] == "page_tools")
    assert waiting["calls"] == [
        {
            "id": "s",
            "name": "set_reference_point",
            "input": {"lon": -90.05, "lat": 34.82, "radius_m": 150.0},
        }
    ]
