"""The chart tools (src/bowser/chart_tools.py) on the MCP server and in the Assistant.

- the specs: the same tools, descriptions and schemas for ``bowser mcp`` and the
  Assistant; the ones that only read are read-only and quiet, every other one
  (remove_point above all) asks first; the page channel accepts them all; the
  instructions tell the model how to use them;
- dates are checked before the page sees them (a real YYYY-MM-DD, start before
  end), and the page's own refusal (a date outside the series) reaches the model;
- "Sign in with Claude": a fake ACP agent fits a linear trend with an annual
  cycle, adds a step and reads the step size, through ``bowser mcp`` and the page
  channel, with a fake page that fits the model with numpy.

Nothing here imports bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import re
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest

httpx = pytest.importorskip("httpx")
pytest.importorskip("mcp")
pytest.importorskip("jwt")
pytest.importorskip("cryptography")

from fake_page import FakePage, Refuse  # noqa: E402
from mcp import Client  # noqa: E402
from test_assistant_signin import (  # noqa: E402, F401  (the signed-in agent's fixtures)
    _ask,
    claude,
    served,
    store,
)

from bowser.assistant import page  # noqa: E402
from bowser.chart_tools import CHART_COMMANDS  # noqa: E402
from bowser.mcp_server import build_server  # noqa: E402
from bowser.tools import INSTRUCTIONS, BowserAPI, build_tools  # noqa: E402

READ_ONLY = {
    "get_chart_data",
    "get_fit_results",
    "list_points",
    "list_areas",
    "check_series",
}


def _mcp_tools(url: str = "http://127.0.0.1:1"):
    async def listing():
        async with Client(build_server(url)) as client:
            return (await client.list_tools()).tools

    return {t.name: t for t in asyncio.run(listing())}


def _call(url: str, name: str, args: dict):
    async def go():
        # Our own transport, closed here: an unclosed socket would surface as a
        # ResourceWarning in whichever test happens to run next.
        transport = httpx.AsyncHTTPTransport()
        try:
            async with Client(build_server(url, transport)) as client:
                return await client.call_tool(name, args)
        finally:
            await transport.aclose()

    return asyncio.run(go())


def _text(result) -> str:
    return result.content[0].text if result.content else ""


# --- the specs --------------------------------------------------------------------


def test_chart_tools_are_the_same_for_mcp_and_the_assistant():
    specs = {s.name: s for s in build_tools(BowserAPI())}
    mcp = _mcp_tools()
    assert len(CHART_COMMANDS) == 19
    for name in CHART_COMMANDS:
        spec, tool = specs[name], mcp[name]
        assert spec.page and spec.mcp, name
        assert tool.description == spec.description, name
        assert tool.input_schema == spec.input_schema, name
        assert tool.annotations.read_only_hint is spec.read_only, name
    assert {n for n in CHART_COMMANDS if specs[n].read_only} == READ_ONLY
    # Reading is quiet; anything that changes the chart asks first (a signed-in agent).
    assert {n for n in CHART_COMMANDS if specs[n].quiet} == READ_ONLY
    assert "Destructive: ask the user first" in specs["remove_point"].description
    assert "ask the user before" in specs["check_series"].description
    # The page channel takes them.
    assert page.COMMANDS >= CHART_COMMANDS


def test_the_page_runs_every_chart_tool():
    """The page's list (src/assistant/chartView.ts) is the server's."""
    ts = (
        Path(__file__).resolve().parents[1] / "src" / "assistant" / "chartView.ts"
    ).read_text()
    block = ts.split("CHART_TOOL_NAMES = new Set([", 1)[1].split("]);", 1)[0]
    assert set(re.findall(r"'([a-z_]+)'", block)) == CHART_COMMANDS


def test_the_instructions_say_how_to_use_them():
    for words in (
        "use set_fit and add_step",
        "Read numbers with get_chart_data",
        "get_fit_results",
        "instead of fetching the series again",
        "Run check_series before suggesting a step",
        "ask the user before adding it",
    ):
        assert words in INSTRUCTIONS, words


# --- arguments --------------------------------------------------------------------


@pytest.fixture
def chart_page(served):  # noqa: F811
    """A fake page whose series spans 2020-01-01 to 2021-12-01."""

    def handle(name, args):
        if name in ("add_step", "remove_step"):
            if not "2020-01-01" < args["date"] <= "2021-12-01":
                raise Refuse(
                    f"{args['date']} is outside the series shown "
                    "(2020-01-01 to 2021-12-01)."
                )
        return {"ok": True, "name": name, **args}

    page.reset()
    p = FakePage(served.url, handle).open()
    yield p
    p.close()
    page.reset()


def test_dates_are_checked_before_the_page(served, chart_page):  # noqa: F811
    url = served.url
    bad = [
        ("add_step", {"date": "2021-02-30"}),
        ("add_step", {"date": "1 March 2021"}),
        ("set_fit", {"steps": ["2021-01-01", "2021/02/01"]}),
        ("set_fit", {"segments": ["2021-13-01"]}),
        ("set_fit", {"steps": [f"2021-01-{d:02d}" for d in range(1, 22)]}),
        ("set_date_range", {"start": "2021-06-01", "end": "2021-01-01"}),
        ("set_point_style", {"point": "A", "marker": "hexagon"}),
        ("set_area_style", {"area": "F", "width": 7}),
        ("check_series", {"wavelength_m": 5.5}),
    ]
    for name, args in bad:
        res = _call(url, name, args)
        assert res.is_error, (name, args)
    assert chart_page.commands == []
    assert "not a date" in _text(_call(url, "add_step", {"date": "2021-02-30"}))
    assert "before end" in _text(
        _call(url, "set_date_range", {"start": "2021-06-01", "end": "2021-01-01"})
    )

    # Good arguments go to the page as given (None left out).
    ok = _call(url, "set_fit", {"polynomial_order": 1, "steps": ["2021-01-01"]})
    assert not ok.is_error
    assert chart_page.commands[-1] == (
        "set_fit",
        {"polynomial_order": 1, "steps": ["2021-01-01"]},
    )
    # A date outside the series: the page refuses, and the model reads why.
    out = _call(url, "add_step", {"date": "2019-06-01"})
    assert out.is_error and "outside the series" in _text(out)


# --- Sign in with Claude fits a model and reads the step ---------------------------

DATES = [dt.date(2020, 1, 1) + dt.timedelta(days=12 * i) for i in range(70)]
STEP = "2021-03-01"
TRUE_STEP_MM = -15.0


def _series() -> np.ndarray:
    """mm: 6 mm/yr, a 4 mm annual cycle, a -15 mm step at STEP, a little noise."""
    t = np.array([(d - DATES[0]).days / 365.25 for d in DATES])
    step = np.array([d.isoformat() >= STEP for d in DATES], dtype=float)
    noise = 0.3 * np.sin(np.arange(len(t)) * 12.9898)
    return 6 * t + 4 * np.cos(2 * np.pi * t) + TRUE_STEP_MM * step + noise


def _fit(model: dict) -> dict:
    """The page's least squares, as the chart does (polynomial, seasonal, steps)."""
    t = np.array([(d - DATES[0]).days / 365.25 for d in DATES])
    cols, names = [np.ones_like(t)], ["offset"]
    if model["polynomial_order"] >= 1:
        cols.append(t - t.mean())
        names.append("rate")
    if model["annual"]:
        cols += [np.sin(2 * np.pi * t), np.cos(2 * np.pi * t)]
        names += ["annual sin", "annual cos"]
    for s in model["steps"]:
        cols.append(np.array([d.isoformat() >= s for d in DATES], dtype=float))
        names.append(f"step {s}")
    a = np.column_stack(cols)
    y = _series()
    c, *_ = np.linalg.lstsq(a, y, rcond=None)
    resid = y - a @ c
    cov = resid @ resid / (len(y) - len(c)) * np.linalg.inv(a.T @ a)
    sd = np.sqrt(np.diag(cov))
    out: dict[str, Any] = {
        "model": model,
        "rate": {"value": round(c[1], 3), "sigma": round(sd[1], 3)},
    }
    out["steps"] = [
        {"date": s, "size": {"value": round(c[i], 3), "sigma": round(sd[i], 3)}}
        for i, n in enumerate(names)
        for s in [n[5:]]
        if n.startswith("step ")
    ]
    return out


def test_signed_in_claude_fits_a_trend_and_reads_the_step(served):  # noqa: F811
    """Fit a linear trend with an annual cycle, add a step, report its size."""
    model = {"polynomial_order": 0, "annual": False, "steps": []}

    def handle(name, args):
        if name == "set_fit":
            model.update(
                {k: v for k, v in args.items() if k in ("polynomial_order", "annual")}
            )
            return {"series": [{"series": "Dam crest", **_fit(model)}]}
        if name == "add_step":
            model["steps"] = sorted({*model["steps"], args["date"]})
            fit = _fit(model)
            size = next(s["size"] for s in fit["steps"] if s["date"] == args["date"])
            return {"ok": True, "step": args["date"], "step_size": [size]}
        if name == "get_fit_results":
            return {"series": [{"series": "Dam crest", **_fit(model)}], "unit": "mm"}
        raise Refuse(f"unexpected {name}")

    page.reset()
    p = FakePage(served.url, handle).open()
    served.claude.state.write_text("signed in")
    calls = [
        'CALL set_fit {"polynomial_order": 1, "annual": true}',
        f'CALL add_step {{"date": "{STEP}"}}',
        "CALL get_fit_results {}",
    ]
    try:
        with httpx.Client(base_url=served.url, timeout=120) as c:
            c.post("/assistant/signin", json={"method": "claude"})
            results, asked = _ask(c, "fit-1", "\n".join(calls))
    finally:
        p.close()
        page.reset()
    # Changing the model asks the user; reading the results does not.
    assert [a["name"] for a in asked] == ["set_fit", "add_step"]
    assert all(r["ok"] for r in results), results
    assert p.commands == [
        ("set_fit", {"polynomial_order": 1, "annual": True}),
        ("add_step", {"date": STEP}),
        ("get_fit_results", {}),
    ]
    step = results[2]["result"]["series"][0]["steps"][0]
    assert step["date"] == STEP
    assert step["size"]["value"] == pytest.approx(TRUE_STEP_MM, abs=0.5)
    assert 0 < step["size"]["sigma"] < 0.5
    assert results[1]["result"]["step_size"][0] == step["size"]
    assert results[2]["result"]["series"][0]["model"] == {
        "polynomial_order": 1,
        "annual": True,
        "steps": [STEP],
    }
