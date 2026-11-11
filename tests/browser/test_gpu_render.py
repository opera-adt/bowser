"""The GPU renderer draws what the server's ``/point`` says, in a real browser.

On a small synthetic cube (tests/regression/cube.py, rechunked so a view spans
several chunks and the reference date sits in another block of dates than the
date shown), the page is opened with ``?render=gpu`` in headless Chromium and
driven through its page channel, as the Assistant's tools drive it: a reference
point, a reference date, a date, one threshold mask, a colormap and a range. Then,
at the centre of every cube pixel in the view:

- the colour the GPU drew is the colormap's entry for the value computed from the
  server's ``/point`` series (date minus reference date, the mask, minus the
  reference point's shift), in float32 as the shader does; masked and nodata
  pixels show the map underneath (the same screenshot with the layer at opacity 0);
- displacement (metres) is drawn from float16 textures and the mask from float32
  ones (src/map/gpu/half.ts), so the expected value rounds the date's and the
  reference date's ``/point`` values to float16 first; that rounding stays within
  0.1 mm of the float32 values;
- the server's tiles (``?render=tiles``, same state) agree on almost every pixel.

Also ``?render=auto`` picks tiles under SwiftShader (a software renderer).

SwiftShader renders WebGL2 exactly enough for this. Opt-in, as it needs a browser
and the built page (``npm run build``)::

    BOWSER_BROWSER_TESTS=1 pytest tests/browser

``BOWSER_TEST_CHROME`` names a Chromium (default: Playwright's own),
``BOWSER_TEST_SERVER_PYTHON`` a Python with Bowser's server dependencies (default:
this one), ``BOWSER_TEST_PORT`` the first of two free ports (default 5181) and
``BOWSER_TEST_SHOTS`` a folder to keep the screenshots in.
Nothing here imports bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import io
import json
import math
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pytest

if os.environ.get("BOWSER_BROWSER_TESTS") != "1":
    pytest.skip(
        "browser tests are opt-in: BOWSER_BROWSER_TESTS=1", allow_module_level=True
    )
sync_api = pytest.importorskip("playwright.sync_api")
Image = pytest.importorskip("PIL.Image")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DIST = ROOT / "src" / "bowser" / "dist" / "index.html"
sys.path.insert(0, str(HERE.parent / "regression"))
from cube import NT, make_cube  # noqa: E402

CHROME_ARGS = [
    "--use-angle=swiftshader",
    "--use-gl=angle",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
]
T, REF_T = NT - 1, 1  # the date shown, the reference date (another block of 4 dates)
VMIN, VMAX, CMAP = -0.012, 0.012, "viridis"
MASK = {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}
ZOOM = 15.0
# Show only the map canvas in screenshots (no panels, label or controls over it).
CANVAS_ONLY = (
    "body * { visibility: hidden !important; } "
    ".maplibregl-canvas { visibility: visible !important; }"
)


def _free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    """The regression cube, in 20x20-pixel chunks of 4 dates (zarr v3)."""
    import xarray as xr

    root = tmp_path_factory.mktemp("gpu_cube")
    plain = make_cube(root / "plain.zarr")
    ds = xr.open_zarr(plain, consolidated=False, chunks=None).load()
    for v in ds.data_vars.values():
        v.encoding = {"chunks": (4, 20, 20) if v.ndim == 3 else (20, 20)}
    out = root / "gpu.zarr"
    ds.to_zarr(out, mode="w", consolidated=False, zarr_format=3)
    return out


@pytest.fixture(scope="module", params=["full", "lite"])
def server(request, cube):
    if not DIST.exists():
        pytest.skip("build the page first: npm run build")
    port = int(os.environ.get("BOWSER_TEST_PORT", "5181")) + (request.param == "lite")
    if not _free(port):
        pytest.skip(f"port {port} is in use")
    app = "bowser.lite.main:app" if request.param == "lite" else "bowser.main:app"
    env = {
        **os.environ,
        "BOWSER_STACK_DATA_FILE": str(cube),
        "BOWSER_ASSISTANT": "true",
        "BOWSER_ASSISTANT_PAGE_KEYS": "true",
        "BOWSER_SERVER_PORT": str(port),
        "NO_PROXY": "*",
    }
    env.pop("BOWSER_CATALOG_FILE", None)
    python = os.environ.get("BOWSER_TEST_SERVER_PYTHON", sys.executable)
    log = cube.parent / f"{request.param}.log"
    with open(log, "w") as out:
        proc = subprocess.Popen(
            [python, "-m", "uvicorn", app, "--host", "127.0.0.1", "--port", str(port)],
            env=env,
            cwd=cube.parent,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(240):
            if proc.poll() is not None:
                break
            try:
                urllib.request.urlopen(f"{base}/mode", timeout=2).close()
                break
            except OSError:
                time.sleep(0.5)
        else:
            pytest.fail("server did not start")
        if proc.poll() is not None:
            pytest.fail(f"server exited: {log.read_text()[-2000:]}")
        yield {"base": base, "port": port, "kind": request.param}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


def _get(base: str, path: str, **params):
    url = f"{base}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())


def _command(server, command: str, **inp):
    """Send a page command as ``bowser mcp`` does (page token, not a browser)."""
    folder = Path(os.environ["XDG_RUNTIME_DIR"]) / "bowser"
    token = (folder / f"page-token-{server['port']}").read_text().strip()
    req = urllib.request.Request(
        f"{server['base']}/page/command",
        data=json.dumps({"name": command, "input": inp}).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        answer = json.loads(r.read())
    assert answer.get("ok"), (command, inp, answer)
    return answer["result"]


@pytest.fixture(scope="module")
def browser():
    with sync_api.sync_playwright() as p:
        exe = os.environ.get("BOWSER_TEST_CHROME") or None
        b = p.chromium.launch(executable_path=exe, args=CHROME_ARGS)
        yield b
        b.close()


def _open(browser, server, render: str):
    ctx = browser.new_context(viewport={"width": 1100, "height": 800})
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    page.on("request", lambda r: logs.append(f"request: {r.url}"))
    page.goto(f"{server['base']}/?render={render}")
    page.wait_for_selector("[data-testid=render-label]", timeout=60_000)
    # The page channel is up once a command gets an answer.
    for _ in range(120):
        try:
            _command(server, "get_view")
            break
        except urllib.error.HTTPError:
            time.sleep(0.5)
    return ctx, page, logs


def _settled(page, timeout_s: float = 90.0) -> np.ndarray:
    """The map canvas once it stops changing (no request in flight, same pixels 3x)."""
    page.add_style_tag(content=CANVAS_ONLY)
    canvas = page.locator(".maplibregl-canvas")
    last, same, t0 = None, 0, time.time()
    while time.time() - t0 < timeout_s:
        page.wait_for_timeout(400)
        shot = canvas.screenshot()
        if shot == last:
            same += 1
            if same >= 3:
                return np.asarray(Image.open(io.BytesIO(shot)).convert("RGB")).astype(
                    int
                )
        else:
            same = 0
        last = shot
    pytest.fail("the map never settled")


def _set_state(server, ref_lonlat):
    dates = _get(server["base"], "/datasets")["displacement"]["x_values"]
    _command(server, "set_opacity", opacity=1)
    assert (
        _command(server, "set_colormap", name=CMAP, reverse=False)["colormap"] == CMAP
    )
    _command(server, "set_color_range", vmin=VMIN, vmax=VMAX)
    _command(server, "set_masks", masks=[MASK])
    _command(server, "set_reference_point", lon=ref_lonlat[0], lat=ref_lonlat[1])
    _command(server, "set_reference_date", date=str(dates[REF_T])[:10])
    _command(server, "run_command", id="time.go_to", args={"index": T})
    _command(server, "fly_to", lon=CENTER[0], lat=CENTER[1], zoom=ZOOM)
    ref = _command(server, "get_reference")
    assert str(dates[REF_T]).startswith(ref["reference_date"]), ref
    return _command(server, "get_view")


def _mercator(lon: float, lat: float) -> tuple[float, float]:
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return (180 + lon) / 360, (180 - math.degrees(y)) / 360


# The cube's grid (tests/regression/cube.py): UTM 11N, 30 m, 48x48 pixels.
def _pixel_lonlats():
    from cube import DX, NX, NY, X0, Y0
    from pyproj import Transformer

    to_ll = Transformer.from_crs(32611, 4326, always_xy=True)
    for row in range(NY):
        for col in range(NX):
            x, y = X0 + DX * (col + 0.5), Y0 - DX * (row + 0.5)
            yield row, col, *to_ll.transform(x, y)


CENTER = (-117.67462, 33.95859)
# The reference point: a pixel centre with data and coherence (row 10, col 34).
REF_PIXEL = (10, 34)


# The largest float16 rounding the GPU path allows for metres (half.ts).
HALF_TOLERANCE_M = 1e-4


def _half(v) -> np.float32:
    """``v`` as the GPU reads it from a float16 texture."""
    return np.float32(np.float16(np.float32(v)))


def _expected(server, points, ref_series):
    """The shader's arithmetic in float32 on /point values; None where masked/nodata.

    The displacement values are rounded to float16 as the textures hold them; the
    result also carries the value without that rounding (for the error summary).
    """
    f = np.float32
    shift_t = ref_series[T] if ref_series[T] is not None else 0.0
    shift = f(f(shift_t) - f(ref_series[REF_T] or 0.0))
    out = {}
    for row, col, lon, lat in points:
        series = _get(
            server["base"], "/point", dataset_name="displacement", lon=lon, lat=lat
        )
        coh = _get(
            server["base"], "/point", dataset_name=MASK["dataset"], lon=lon, lat=lat
        )
        v_t, v_r, m = series[T], series[REF_T], coh[T]
        if v_t is None or v_r is None or m is None or not f(m) >= f(MASK["threshold"]):
            out[(row, col)] = None
            continue
        v = f(f(_half(v_t) - _half(v_r)) - shift)
        v32 = f(f(f(v_t) - f(v_r)) - shift)
        t = f(f(min(max(v, f(VMIN)), f(VMAX)) - f(VMIN)) / f(f(VMAX) - f(VMIN)))
        idx = min(255, max(0, math.floor(f(t * f(255)))))
        out[(row, col)] = (idx, float(t * 255), abs(float(v) - float(v32)))
    return out


def _lut() -> np.ndarray:
    import base64

    luts = json.loads((ROOT / "src/map/gpu/colormapLuts.json").read_text())
    return np.frombuffer(base64.b64decode(luts[CMAP]), dtype=np.uint8).reshape(256, 4)


def test_gpu_draws_the_values_of_point(browser, server):
    points = list(_pixel_lonlats())
    ref_lonlat = next((lon, lat) for r, c, lon, lat in points if (r, c) == REF_PIXEL)
    ref_series = _get(
        server["base"],
        "/point",
        dataset_name="displacement",
        lon=ref_lonlat[0],
        lat=ref_lonlat[1],
    )

    shots = {}
    for render in ("gpu", "tiles"):
        ctx, page, logs = _open(browser, server, render)
        view = _set_state(server, ref_lonlat)
        assert (
            view["zoom"] == ZOOM and view["pitch"] == 0 and view["bearing"] == 0
        ), view
        label = page.get_attribute("[data-testid=render-label]", "data-renderer")
        assert label == render, (
            page.inner_text("[data-testid=render-label]"),
            [m for m in logs if "request" not in m],
        )
        shots[render] = _settled(page)
        if render == "gpu":
            stats = json.loads(
                page.get_attribute("[data-testid=render-label]", "data-gpu-stats")
                or "{}"
            )
            _command(server, "set_opacity", opacity=0)
            shots["under"] = _settled(page)
            info = [m for m in logs if "[bowser] data layer" in m]
            assert info == [
                "info: [bowser] data layer: GPU — render=gpu (forced)"
            ], logs
            assert not [m for m in logs if m.startswith("pageerror")], logs
            requests = [m for m in logs if m.startswith("request: ")]
            assert any("/zarr/displacement/c/" in m for m in requests), requests
            assert not [m for m in requests if "/md/tiles/" in m], requests
            # The chunks are fetched and decoded in the decoder workers.
            workers = [w.url for w in page.workers]
            assert any("decode.worker" in u for u in workers), workers
        ctx.close()

    if os.environ.get("BOWSER_TEST_SHOTS"):
        for name, shot in shots.items():
            path = (
                Path(os.environ["BOWSER_TEST_SHOTS"])
                / f"synthetic_{server['kind']}_{name}.png"
            )
            Image.fromarray(shot.astype(np.uint8)).save(path)
    gpu, tiles, under = shots["gpu"], shots["tiles"], shots["under"]
    h, w = gpu.shape[:2]
    mcx, mcy = _mercator(*CENTER)
    world = 512 * 2**ZOOM
    lut = _lut()
    # Inside the view, away from the cube's edge (tiles blend edge pixels).
    samples = []
    for row, col, lon, lat in points:
        mx, my = _mercator(lon, lat)
        x, y = w / 2 + (mx - mcx) * world, h / 2 + (my - mcy) * world
        if 4 <= x < w - 4 and 4 <= y < h - 4 and 0 < row < 47 and 0 < col < 47:
            samples.append((row, col, lon, lat, int(x), int(y)))
    assert len(samples) > 1500, len(samples)
    expected = _expected(server, [s[:4] for s in samples], ref_series)

    drawn = masked = near_edge = 0
    tile_agree = 0
    max_half_err = 0.0
    bad = []
    for row, col, _, _, x, y in samples:
        exp = expected[(row, col)]
        got = gpu[y, x]
        tile_agree += int(np.abs(got - tiles[y, x]).max() <= 1)
        if exp is None:
            masked += 1
            if np.abs(got - under[y, x]).max() > 2:
                bad.append(("masked", row, col, got.tolist(), under[y, x].tolist()))
            continue
        drawn += 1
        idx, exact, half_err = exp
        max_half_err = max(max_half_err, half_err)
        want = lut[idx, :3].astype(int)
        if np.abs(got - want).max() <= 1:
            continue
        # A value within float error of a colour boundary may take the next entry.
        if abs(exact - round(exact)) < 1e-3:
            near = [lut[i, :3].astype(int) for i in (idx - 1, idx + 1) if 0 <= i < 256]
            if any(np.abs(got - n).max() <= 1 for n in near):
                near_edge += 1
                continue
        bad.append(("colour", row, col, idx, got.tolist(), want.tolist()))

    summary = {
        "server": server["kind"],
        "samples": len(samples),
        "drawn": drawn,
        "masked_or_nodata": masked,
        "boundary": near_edge,
        "gpu_eq_tiles": tile_agree,
        "max_float16_error_m": max_half_err,
        "gpu_stats": stats,
        "bad": bad[:10],
    }
    print(json.dumps(summary))
    assert drawn > 500 and masked > 100, summary  # both kinds are really tested
    assert not bad, summary
    assert tile_agree >= 0.97 * len(samples), summary
    # Displacement in float16 (half the memory), the coherence mask in float32.
    assert stats.get("f16", 0) > 0 and stats.get("f32", 0) > 0, summary
    assert 0 < stats["maxHalfError"] <= HALF_TOLERANCE_M, summary
    assert 0 < max_half_err <= 2 * HALF_TOLERANCE_M, summary


def test_auto_picks_tiles_under_swiftshader(browser, server):
    ctx, page, logs = _open(browser, server, "auto")
    label = page.locator("[data-testid=render-label]")
    assert label.get_attribute("data-renderer") == "tiles"
    assert "auto: software renderer" in label.inner_text(), label.inner_text()
    page.wait_for_timeout(1500)
    requests = [m for m in logs if m.startswith("request: ")]
    assert any("/md/" in m for m in requests), requests  # tiles
    assert not [m for m in requests if "/zarr/" in m or "runtime-" in m], requests
    assert any("data layer: tiles — auto: software renderer" in m for m in logs), logs
    ctx.close()


def test_tiles_when_the_decoder_worker_cannot_load(browser, server):
    ctx = browser.new_context(viewport={"width": 1100, "height": 800})
    ctx.route("**/decode.worker*", lambda route: route.abort())
    page = ctx.new_page()
    logs: list[str] = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("request", lambda r: logs.append(f"request: {r.url}"))
    page.goto(f"{server['base']}/?render=gpu")
    label = page.locator("[data-testid=render-label][data-renderer=tiles]")
    label.wait_for(timeout=60_000)
    assert (
        "fell back to tiles: decoder worker" in label.inner_text()
    ), label.inner_text()
    page.wait_for_timeout(1500)
    requests = [m for m in logs if m.startswith("request: ")]
    assert any("/md/tiles/" in m for m in requests), requests
    assert any(
        "data layer: tiles — fell back to tiles: decoder" in m for m in logs
    ), logs
    ctx.close()
