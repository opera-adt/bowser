"""The MCP server (``bowser mcp``): its tools give the HTTP API's answers.

- every tool has a description and an input schema;
- each data tool, called through an MCP client session in memory, returns the
  numbers the HTTP API gives for the same request, on the full server and on
  bowser-lite (each app called in-process through an ASGI transport);
- lite reports the tools it cannot serve (polygon statistics, GeoTIFF export)
  as tool errors that say so;
- ``bowser mcp --stack-file`` talks MCP over stdio without other output.

Each app reads its settings at import, so the API calls run in a fresh
interpreter per app; nothing here imports bowser.main, bowser.state or
bowser.config.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("mcp")
pytest.importorskip("titiler.core")
pytest.importorskip("rioxarray")

from mcp import Client  # noqa: E402

from bowser.mcp_server import INSTRUCTIONS, build_server  # noqa: E402

REGRESSION = Path(__file__).resolve().parent / "regression"

TOOLS = {
    "server_info",
    "list_layers",
    "point_timeseries",
    "multi_point_timeseries",
    "trend_at_point",
    "value_at_point",
    "polygon_statistics",
    "profile",
    "layer_statistics",
    "export_geotiff",
}

#: Calls each app answers twice: through the MCP tool and through the HTTP API.
SCRIPT = textwrap.dedent(
    r"""
    import asyncio, importlib, json, sys
    from pathlib import Path

    import httpx
    from fastapi.testclient import TestClient
    from mcp import Client

    sys.path.insert(0, sys.argv[3])
    from cube import CENTER_LONLAT, EDGE_LONLAT, REF_LONLAT

    from bowser.mcp_server import build_server

    which, out = sys.argv[1], Path(sys.argv[2])
    app = importlib.import_module(
        "bowser.lite.main" if which == "lite" else "bowser.main"
    ).app
    http = TestClient(app)
    lon, lat = CENTER_LONLAT
    ref = list(REF_LONLAT)  # the cube's reference_lonlat
    ring = [[-117.678, 33.957], [-117.672, 33.957], [-117.672, 33.961],
            [-117.678, 33.961], [-117.678, 33.957]]
    line = [list(REF_LONLAT), list(EDGE_LONLAT)]
    export_dir = out.parent / f"export-{which}"
    export_dir.mkdir()

    calls = {
        "server_info": ("server_info", {}),
        "list_layers": ("list_layers", {}),
        "point": ("point_timeseries", {"lon": lon, "lat": lat}),
        "point_raw": ("point_timeseries",
                      {"lon": lon, "lat": lat, "use_cube_reference": False}),
        "point_buffer": ("point_timeseries",
                         {"lon": lon, "lat": lat, "ref_lon": EDGE_LONLAT[0],
                          "ref_lat": EDGE_LONLAT[1], "ref_buffer_m": 100}),
        "multi": ("multi_point_timeseries",
                  {"points": [{"lon": lon, "lat": lat, "name": "dam"},
                              {"lon": EDGE_LONLAT[0], "lat": EDGE_LONLAT[1]}]}),
        "trend": ("trend_at_point", {"lon": lon, "lat": lat}),
        "value": ("value_at_point", {"lon": lon, "lat": lat}),
        "value_step": ("value_at_point",
                       {"lon": lon, "lat": lat, "layer": "temporal_coherence",
                        "time_index": 2}),
        "polygon": ("polygon_statistics",
                    {"geometry": {"type": "Polygon", "coordinates": [ring]}}),
        "profile": ("profile", {"coords": line, "time_index": 3, "n_samples": 7}),
        "profile_strip": ("profile",
                          {"coords": line, "time_index": 3, "radius": 60,
                           "sampling_interval": 300}),
        "stats": ("layer_statistics", {"time_index": 2, "nbins": 8}),
        "export": ("export_geotiff",
                   {"time_index": 2, "save_to": str(export_dir)}),
        "outside": ("point_timeseries", {"lon": 10.0, "lat": 10.0}),
        "unknown": ("point_timeseries", {"lon": lon, "lat": lat, "layer": "nope"}),
        "no_time": ("point_timeseries", {"lon": lon, "lat": lat,
                                         "layer": "velocity"}),
    }

    async def via_mcp():
        server = build_server("http://bowser", httpx.ASGITransport(app=app))
        res = {}
        async with Client(server) as client:
            for key, (name, args) in calls.items():
                r = await client.call_tool(name, args)
                text = r.content[0].text if r.content else ""
                res[key] = (
                    {"error": text} if r.is_error else json.loads(text)
                )
        return res

    def get(path, **params):
        return http.get(path, params=params).json()

    def post(path, body):
        r = http.post(path, json=body)
        return {"status": r.status_code, "body": r.json()}

    point_ref = {"dataset_name": "displacement", "lon": lon, "lat": lat}
    api = {
        "config": get("/config"),
        "datasets": get("/datasets"),
        "chart": get("/chart_point", **point_ref, ref_lon=ref[0], ref_lat=ref[1]),
        "chart_raw": get("/chart_point", **point_ref),
        "multi_buffer": post("/multi_point", {
            "points": [{"id": "p", "lon": lon, "lat": lat}],
            "dataset_name": "displacement", "ref_lon": EDGE_LONLAT[0],
            "ref_lat": EDGE_LONLAT[1], "ref_buffer_m": 100})["body"],
        "multi": post("/multi_point", {
            "points": [{"id": "a", "lon": lon, "lat": lat},
                       {"id": "b", "lon": EDGE_LONLAT[0], "lat": EDGE_LONLAT[1]}],
            "dataset_name": "displacement", "ref_lon": ref[0], "ref_lat": ref[1],
            "calculate_trends": True})["body"],
        "trend": get("/trend_analysis/displacement", lon=lon, lat=lat,
                     ref_lon=ref[0], ref_lat=ref[1]),
        "velocity": get("/point", dataset_name="velocity", lon=lon, lat=lat),
        "velocity_ref": get("/point", dataset_name="velocity", lon=ref[0],
                            lat=ref[1]),
        "coherence": get("/point", dataset_name="temporal_coherence", lon=lon,
                         lat=lat, time_idx=2),
        "polygon": post("/polygon_timeseries", {
            "variable": "displacement",
            "geometry": {"type": "Polygon", "coordinates": [ring]}}),
        "profile": post("/profile", {"coords": line, "dataset_name": "displacement",
                                     "time_index": 3, "n_samples": 7})["body"],
        "profile_strip": post("/profile", {
            "coords": line, "dataset_name": "displacement", "time_index": 3,
            "radius": 60, "sampling_interval": 300, "n_random": 0})["body"],
        "histogram": get("/histogram/displacement", time_index=2, nbins=8),
    }
    if which == "full":
        tif = http.get("/export/geotiff",
                       params={"variable": "displacement", "time_idx": 2})
        api["export_size"] = len(tif.content)

    out.write_text(json.dumps({"mcp": asyncio.run(via_mcp()), "api": api}))
    """
)


def _env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(extra)
    return env


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("mcp-cube") / "regression.zarr")


@pytest.fixture(scope="module", params=["full", "lite"])
def answers(request, cube, tmp_path_factory) -> tuple[str, dict, dict]:
    """``(which, mcp, api)``: each call's MCP result and the API's answer."""
    which = request.param
    work = tmp_path_factory.mktemp(f"mcp-{which}")
    script = work / "run.py"
    script.write_text(SCRIPT)
    out = work / "out.json"
    proc = subprocess.run(
        [sys.executable, str(script), which, str(out), str(REGRESSION)],
        env=_env(BOWSER_STACK_DATA_FILE=str(cube)),
        cwd=work,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-4000:]
    result = json.loads(out.read_text())
    return which, result["mcp"], result["api"]


def _mm(values):
    return [None if v is None else v * 1000 for v in values]


def _close(a, b, tol=0.006):
    assert len(a) == len(b), (a, b)
    for x, y in zip(a, b):
        assert (x is None) == (y is None), (a, b)
        if x is not None:
            assert x == pytest.approx(y, abs=tol), (a, b)


def test_tools_have_descriptions_and_schemas():
    async def listing():
        async with Client(build_server("http://127.0.0.1:1")) as client:
            return (await client.list_tools()).tools

    tools = asyncio.run(listing())
    assert {t.name for t in tools} == TOOLS
    for t in tools:
        assert len(t.description or "") > 40, t.name
        schema = t.input_schema
        assert schema["type"] == "object", t.name
        for name, prop in schema.get("properties", {}).items():
            assert prop.get("description") or "$ref" in str(prop), (t.name, name)
    assert "line of sight" in INSTRUCTIONS
    assert "never interpret displacement from the curve alone" in INSTRUCTIONS


def test_unreachable_server_is_a_tool_error():
    async def call():
        async with Client(build_server("http://127.0.0.1:1")) as client:
            return await client.call_tool("list_layers", {})

    r = asyncio.run(call())
    assert r.is_error
    assert "Cannot reach the Bowser server" in r.content[0].text


def test_server_info_and_layers(answers):
    which, mcp, api = answers
    info = mcp["server_info"]
    assert info["server"] == which
    assert info["polygon_stats"] == api["config"]["polygon_stats"]
    assert info["geotiff_export"] == api["config"]["geotiff_export"]
    expected = [] if which == "full" else ["polygon_statistics", "export_geotiff"]
    assert info["unsupported_tools"] == expected

    layers = mcp["list_layers"]
    assert set(layers["layers"]) == set(api["datasets"])
    disp = layers["layers"]["displacement"]
    src = api["datasets"]["displacement"]
    assert disp["n_time_steps"] == src["n_time_steps"]
    assert [disp["first_date"], disp["last_date"]] == [
        src["x_values"][0],
        src["x_values"][-1],
    ]
    assert disp["unit_stored"] == "meters"
    assert disp["unit_reported"] == "mm"
    assert disp["relative_to_reference_point"] is True
    assert layers["reference_lonlat"] == src["reference_lonlat"]
    assert layers["latlon_bounds"] == src["latlon_bounds"]
    assert layers["layers"]["velocity"]["has_time_axis"] is False


def test_point_timeseries(answers):
    _, mcp, api = answers
    res = mcp["point"]
    data = api["chart"]["datasets"][0]["data"]
    assert res["dates"] == [d["x"] for d in data]
    _close(res["values"], _mm([d["y"] for d in data]))
    assert res["unit"] == "mm"
    assert (
        res["reference"]["point"] == api["datasets"]["displacement"]["reference_lonlat"]
    )
    assert "cube's reference point" in res["reference"]["note"]
    assert "2026-01-01" in res["reference"]["note"]

    raw = mcp["point_raw"]
    _close(
        raw["values"], _mm([d["y"] for d in api["chart_raw"]["datasets"][0]["data"]])
    )
    assert raw["reference"]["point"] is None

    buffered = mcp["point_buffer"]
    data = api["multi_buffer"]["datasets"][0]["data"]
    _close(buffered["values"], _mm([d["y"] for d in data]))
    assert "median within 100 m" in buffered["reference"]["note"]


def test_multi_point_timeseries(answers):
    _, mcp, api = answers
    res = mcp["multi"]
    assert res["dates"] == api["multi"]["labels"]
    for got, want in zip(res["points"], api["multi"]["datasets"]):
        by_date = {d["x"]: d["y"] for d in want["data"]}
        _close(got["values"], _mm([by_date.get(x) for x in res["dates"]]))
        assert got["rate_per_year"] == pytest.approx(
            want["trend"]["mmPerYear"], abs=0.006
        )
    assert [p["name"] for p in res["points"]] == ["dam", "point 2"]
    assert res["rate_unit"] == "mm/yr"


def test_trend_and_value_at_point(answers):
    _, mcp, api = answers
    trend = mcp["trend"]
    assert trend["rate_per_year"] == pytest.approx(
        api["trend"]["mm_per_year"], abs=0.006
    )
    assert trend["r_squared"] == pytest.approx(api["trend"]["r_squared"], rel=1e-5)
    assert trend["unit"] == "mm/yr"

    value = mcp["value"]
    want = (api["velocity"][0] - api["velocity_ref"][0]) * 1000
    assert value["value"] == pytest.approx(want, abs=0.006)
    assert value["unit"] == "mm/yr"

    step = mcp["value_step"]
    assert step["value"] == pytest.approx(api["coherence"][0], rel=1e-5)
    assert step["reference"]["point"] is None
    assert step["date"] == api["datasets"]["temporal_coherence"]["x_values"][2]


def test_profile_and_layer_statistics(answers):
    _, mcp, api = answers
    res = mcp["profile"]
    _close(res["values"], _mm([s["value"] for s in api["profile"]]))
    assert res["distance_m"] == pytest.approx(
        [s["dist"] for s in api["profile"]], abs=0.06
    )
    assert res["date"] == api["datasets"]["displacement"]["x_values"][3]

    strip = mcp["profile_strip"]
    _close(strip["values"], _mm([s["value"] for s in api["profile_strip"]["centre"]]))
    _close(
        strip["strip_median"],
        _mm([s["value"] for s in api["profile_strip"]["median"]]),
    )
    assert strip["bin_width_m"] == api["profile_strip"]["bin_width"]

    stats = mcp["stats"]
    hist = api["histogram"]
    for key in ("min", "max", "p2", "p16", "p84", "p98"):
        assert stats[key] == pytest.approx(hist[key] * 1000, abs=0.006)
    assert stats["histogram"]["counts"] == hist["counts"]
    _close(stats["histogram"]["edges"], _mm(hist["bins"]))


def test_polygon_and_export(answers):
    which, mcp, api = answers
    if which == "lite":
        assert api["polygon"]["status"] == 501
        assert "error" in mcp["polygon"]
        assert "HTTP 501" in mcp["polygon"]["error"]
        assert "full Bowser server" in mcp["polygon"]["error"]
        assert "bowser run" in mcp["export"]["error"]
        return
    res = mcp["polygon"]
    body = api["polygon"]["body"]
    assert res["dates"] == body["labels"]
    assert res["polygon_pixels"] == body["polygon_pixels"]
    stats = res["statistics"]
    assert stats["count"] == [s["count"] for s in body["statistics"]]
    _close(stats["median"], _mm([s["median"] for s in body["statistics"]]))
    _close(stats["p90"], _mm([s["percentiles"]["90"] for s in body["statistics"]]))

    export = mcp["export"]
    path = Path(export["path"])
    assert path.suffix == ".tif"
    assert path.stat().st_size == export["bytes"] == api["export_size"]
    assert path.read_bytes()[:2] in (b"II", b"MM")
    assert "/export/geotiff?variable=displacement&time_idx=2" in export["url"]


def test_errors_are_readable(answers):
    _, mcp, _ = answers
    assert "outside the cube" in mcp["outside"]["error"]
    assert "No layer 'nope'" in mcp["unknown"]["error"]
    assert "displacement" in mcp["unknown"]["error"]
    assert "value_at_point" in mcp["no_time"]["error"]


def test_cli_stack_file_over_stdio(cube):
    """``bowser mcp --stack-file`` answers over stdio; stdout carries only MCP."""
    from mcp.client.stdio import StdioServerParameters

    params = StdioServerParameters(
        command=sys.executable,
        args=[
            "-c",
            "from bowser.cli import cli_app; cli_app()",
            "mcp",
            "--stack-file",
            str(cube),
        ],
        env={k: v for k, v in _env().items() if k in ("PYTHONPATH", "NO_PROXY")},
    )

    async def call():
        async with Client(params) as client:
            return await client.call_tool(
                "point_timeseries", {"lon": -117.67462, "lat": 33.95859}
            )

    r = asyncio.run(call())
    assert not r.is_error, r.content
    res = json.loads(r.content[0].text)
    assert len(res["dates"]) == 6
    assert res["unit"] == "mm"
