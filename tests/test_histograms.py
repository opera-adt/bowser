"""Per-date colour histograms (``bowser.histograms``) and the endpoints of both servers.

- every date in one pass equals each date on its own, in the stored format;
- big cubes are summarised from a coarse pyramid level, close to full resolution;
- results are cached, identical requests share one computation, at most one runs
  at a time, and a queued one nobody waits for any more is dropped;
- the full server answers ``/config`` while a histogram is being computed;
- ``bowser add-histograms`` stores them, and both servers then serve them as is;
- the background computation is kept on disk across a restart, and yields to
  requests like the reference finder's warm-up.

The servers read their settings at import, so they run in subprocesses; nothing
here imports ``bowser.main``, ``bowser.state`` or ``bowser.config``.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import textwrap
import threading
import time
import urllib.request
import warnings
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

from bowser import histograms as H
from bowser import refstats
from bowser.refstats import Source

N = 96
NT = 9
#: Valid pixels to aim for in the server tests: picks level 1 of the cube below.
LIMIT = 3000


def _pyramid(path: Path, levels: int = 3, seed: int = 0) -> Path:
    """A ``(time, y, x)`` cube with 2x2-average pyramid levels, chunks of 4 dates.

    A ramp growing with time (+-10 mm), 0.5 mm of noise and a NaN corner.
    """
    from pyproj import CRS

    rng = np.random.default_rng(seed)
    yy, xx = np.meshgrid(np.linspace(-1, 1, N), np.linspace(-1, 1, N), indexing="ij")
    k = (np.arange(NT, dtype="float32") + 1)[:, None, None] / NT
    disp = 0.01 * k * (xx + 0.5 * yy)[None] + 0.0005 * rng.standard_normal((NT, N, N))
    disp = disp.astype("float32")
    disp[:, : N // 4, : N // 3] = np.nan
    vel = (0.004 * xx).astype("float32")
    sr = xr.DataArray(0, attrs={"crs_wkt": CRS.from_epsg(32611).to_wkt()})
    t = np.datetime64("2026-01-01") + np.arange(NT) * np.timedelta64(12, "D")
    layout = []
    for lv in range(levels):
        f = 2**lv
        n = N // f
        x = 500000.0 + 30.0 * f * (np.arange(n) + 0.5)
        y = 4000000.0 - 30.0 * f * (np.arange(n) + 0.5)
        with warnings.catch_warnings():  # all-NaN blocks stay NaN
            warnings.simplefilter("ignore", RuntimeWarning)
            d = np.nanmean(disp.reshape(NT, n, f, n, f), axis=(2, 4)) if f > 1 else disp
        v = vel.reshape(n, f, n, f).mean(axis=(1, 3)) if f > 1 else vel
        ds = xr.Dataset(
            {
                "displacement": (
                    ("time", "y", "x"),
                    d.astype("float32"),
                    {"units": "meters"},
                ),
                "velocity": (
                    ("y", "x"),
                    v.astype("float32"),
                    {"units": "meters / year"},
                ),
            },
            coords={"time": t, "x": x, "y": y, "spatial_ref": sr},
        )
        enc = {
            "displacement": {"chunks": (4, 32, 32)},
            "velocity": {"chunks": (32, 32)},
        }
        ds.to_zarr(
            path,
            group=str(lv),
            mode="w" if lv == 0 else "a",
            consolidated=False,
            encoding=enc,
        )
        layout.append({"asset": str(lv)})
    import zarr

    zarr.open_group(str(path), mode="a").attrs["multiscales"] = {"layout": layout}
    return path


@pytest.fixture(scope="module")
def cube(tmp_path_factory) -> Path:
    return _pyramid(tmp_path_factory.mktemp("hist") / "pyramid.zarr")


def _levels(path: Path) -> list[xr.Dataset]:
    return [
        xr.open_zarr(path, group=str(lv), consolidated=False, chunks=None)
        for lv in range(3)
    ]


def _old_format(values: np.ndarray, nbins: int) -> dict:
    """What the converter and both servers used to compute for one date."""
    valid = values.ravel().astype(np.float64)
    valid = valid[np.isfinite(valid)]
    counts, edges = np.histogram(valid, bins=nbins)
    return {
        "bins": edges.tolist(),
        "counts": counts.tolist(),
        "min": float(valid.min()),
        "max": float(valid.max()),
        "p2": float(np.percentile(valid, 2)),
        "p98": float(np.percentile(valid, 98)),
        "p16": float(np.percentile(valid, 16)),
        "p84": float(np.percentile(valid, 84)),
        "p23": float(np.percentile(valid, 2.275)),
        "p977": float(np.percentile(valid, 97.725)),
    }


# --- the computation ------------------------------------------------------------


@pytest.mark.parametrize("workers", [1, 3])
def test_one_pass_equals_each_date(cube, workers):
    da = _levels(cube)[0]["displacement"]
    blocks = []
    got = H.compute_histograms(
        da,
        50,
        source=Source(str(cube), "0"),
        workers=workers,
        on_block=lambda t0, b: blocks.append((t0, len(b))),
    )
    assert blocks == [(0, 4), (4, 4), (8, 1)]  # one time chunk at a time
    assert len(got) == NT
    for t in range(NT):
        one = H.compute_one(da, t, 50)
        assert got[t] == one
        assert {k: v for k, v in one.items() if k != "level"} == _old_format(
            da.isel(time=t).values, 50
        )
    # Through xarray (no direct zarr read) and for a 2-D layer, the same.
    assert H.compute_histograms(da, 50, workers=workers) == got
    vel = _levels(cube)[0]["velocity"]
    assert H.compute_histograms(vel, 50) == [H.compute_one(vel, 0, 50)]


def test_converter_stores_the_same_format(cube):
    from bowser._tifs_to_geozarr import _compute_histogram_stats

    arr = _levels(cube)[0]["displacement"].values
    assert _compute_histogram_stats(arr) == [
        H.compute_one(xr.DataArray(arr, dims=("time", "y", "x")), t) for t in range(NT)
    ]


def test_big_cubes_use_a_coarse_level_close_to_full_resolution(cube):
    levels = _levels(cube)
    assert H.pick_level(levels, "displacement", limit=10**9) == 0
    assert H.pick_level(levels, "displacement", limit=0) == 0
    assert H.pick_level(levels, "displacement", limit=LIMIT) == 1
    assert H.pick_level(levels, "displacement", limit=600) == 2
    assert H.pick_level(levels[:1], "displacement", limit=10) == 0  # no pyramid
    for t in (2, NT - 1):
        full = H.compute_one(levels[0]["displacement"], t)
        coarse = H.compute_one(levels[1]["displacement"], t, level=1)
        span = full["p98"] - full["p2"]
        for k in ("p2", "p16", "p84", "p98"):
            assert abs(coarse[k] - full[k]) < 0.03 * span, (t, k)


# --- the service ----------------------------------------------------------------


class _Owner:
    """Stands in for an opened dataset (held weakly)."""


def test_service_caches_coalesces_caps_and_drops_abandoned_work():
    svc = H.Service()
    owner = _Owner()
    running, peak, calls = [0], [0], []
    lock = threading.Lock()

    def slow(key):
        def run():
            with lock:
                running[0] += 1
                peak[0] = max(peak[0], running[0])
                calls.append(key)
            time.sleep(0.15)
            with lock:
                running[0] -= 1
            return {"key": key}

        return run

    async def main():
        # Identical requests share one computation; a repeat is a cache hit.
        same = await asyncio.gather(*(svc.get(owner, "a", slow("a")) for _ in range(5)))
        assert same == [{"key": "a"}] * 5 and calls == ["a"]
        assert await svc.get(owner, "a", slow("a")) == {"key": "a"}
        assert calls == ["a"]
        # Different requests run one at a time.
        got = await asyncio.gather(*(svc.get(owner, k, slow(k)) for k in "bcd"))
        assert got == [{"key": k} for k in "bcd"] and peak[0] == 1
        # A queued request whose client went away is never computed.
        first = asyncio.ensure_future(svc.get(owner, "e", slow("e")))
        await asyncio.sleep(0.02)
        gone = asyncio.ensure_future(svc.get(owner, "f", slow("f")))
        await asyncio.sleep(0.02)
        gone.cancel()
        assert await first == {"key": "e"}
        await asyncio.sleep(0.05)
        assert "f" not in calls and svc.skipped == 1
        # ...and asked again, it is.
        assert await svc.get(owner, "f", slow("f")) == {"key": "f"}

    asyncio.run(main())
    assert svc.computed == len(calls) == 6


# --- the servers ------------------------------------------------------------------


def _env(**extra: str) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(extra)
    return env


SERVE = textwrap.dedent(
    r"""
    import json, sys
    from fastapi.testclient import TestClient
    which = sys.argv[1]
    mod = __import__(which, fromlist=["app"])
    from bowser import histograms as H
    c = TestClient(mod.app)
    out = {}
    for t in (2, 7, 2):
        r = c.get("/histogram/displacement", params={"time_index": t})
        assert r.status_code == 200, r.text
        out[f"t{t}"] = r.json()
    out["velocity"] = c.get("/histogram/velocity").json()
    out["computed"] = H.SERVICE.computed
    print("RESULT" + json.dumps(out))
    """
)


def _serve(which: str, cube: Path, cwd: Path, **env: str) -> dict:
    r = subprocess.run(
        [sys.executable, "-c", SERVE, which],
        env=_env(BOWSER_STACK_DATA_FILE=str(cube), BOWSER_HISTOGRAM_WARMUP="0", **env),
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=300,
    )
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
    line = next(x for x in r.stdout.splitlines() if x.startswith("RESULT"))
    return json.loads(line[len("RESULT") :])


@pytest.mark.parametrize("which", ["bowser.main", "bowser.lite.main"])
def test_servers_use_the_coarse_level_and_cache(cube, tmp_path, which):
    pytest.importorskip("rioxarray")
    out = _serve(which, cube, tmp_path, BOWSER_HISTOGRAM_MAX_PIXELS=str(LIMIT))
    levels = _levels(cube)
    assert out["t2"]["level"] == 1
    assert out["t2"] == H.compute_one(levels[1]["displacement"], 2, level=1)
    assert out["t7"] == H.compute_one(levels[1]["displacement"], 7, level=1)
    assert out["computed"] == 3  # t=2 twice: the second is a cache hit
    full = _serve(which, cube, tmp_path, BOWSER_HISTOGRAM_MAX_PIXELS="0")
    assert full["t2"] == H.compute_one(levels[0]["displacement"], 2)


def test_full_and_lite_agree_on_a_pyramid(cube, tmp_path):
    pytest.importorskip("rioxarray")
    a = _serve("bowser.main", cube, tmp_path, BOWSER_HISTOGRAM_MAX_PIXELS=str(LIMIT))
    b = _serve(
        "bowser.lite.main", cube, tmp_path, BOWSER_HISTOGRAM_MAX_PIXELS=str(LIMIT)
    )
    assert a == b


UVICORN = textwrap.dedent(
    r"""
    import sys, time
    import numpy as np
    import uvicorn
    which, port = sys.argv[1], int(sys.argv[2])
    def slow(f):  # slow statistics, wherever they are computed
        def run(*a, **k):
            time.sleep(1.5)
            return f(*a, **k)
        return run
    np.histogram, np.percentile = slow(np.histogram), slow(np.percentile)
    mod = __import__(which, fromlist=["app"])
    uvicorn.run(mod.app, host="127.0.0.1", port=port, log_level="warning")
    """
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.parametrize("which", ["bowser.main", "bowser.lite.main"])
@pytest.mark.parametrize(
    "path", ["/histogram/displacement?time_index=3", "/dataset_range/displacement"]
)
def test_config_is_answered_while_statistics_are_computed(cube, tmp_path, which, path):
    pytest.importorskip("rioxarray")
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    log = tmp_path / f"{which}.log"
    with open(log, "wb") as out:
        proc = subprocess.Popen(
            [sys.executable, "-c", UVICORN, which, str(port)],
            env=_env(
                BOWSER_STACK_DATA_FILE=str(cube),
                BOWSER_HISTOGRAM_WARMUP="0",
                BOWSER_REFSTATS_WARMUP="0",
                NO_PROXY="*",
            ),
            cwd=tmp_path,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(path: str, timeout: float) -> bytes:
        with opener.open(base + path, timeout=timeout) as r:
            return r.read()

    try:
        for _ in range(600):
            try:
                get("/config", 5)
                break
            except OSError:
                if proc.poll() is not None:
                    pytest.fail(log.read_text()[-3000:])
                time.sleep(0.1)
        done = {}
        th = threading.Thread(target=lambda: done.setdefault("h", get(path, 60)))
        th.start()
        time.sleep(0.5)  # now sleeping inside np.histogram or np.percentile
        t0 = time.perf_counter()
        get("/config", 60)
        waited = time.perf_counter() - t0
        th.join()
        assert "h" in done
        assert waited < 1.5, f"/config waited {waited:.1f} s behind {path}"
    finally:
        proc.terminate()
        proc.wait(timeout=30)


# --- every date in the background ----------------------------------------------------


WARM = textwrap.dedent(
    r"""
    import json, sys, time
    import xarray as xr
    from bowser import histograms as H
    from bowser.refstats import Source
    path = sys.argv[1]
    levels = [xr.open_zarr(path, group=str(i), consolidated=False, chunks=None)
              for i in range(3)]
    sources = [Source(path, str(i)) for i in range(3)]
    assert H.start_warm_up(levels, "displacement", 1, sources=sources, workers=1)
    k = (id(levels[0]), "displacement")
    for _ in range(600):
        if k in H.WARM_DONE:
            break
        time.sleep(0.05)
    hits = [H.SERVICE.cached(levels[0], ("displacement", t, H.NBINS)) for t in range(9)]
    print("RESULT" + json.dumps({"how": H.WARM_DONE.get(k), "hits": hits}))
    """
)


def test_background_dates_are_kept_on_disk_across_a_restart(cube, tmp_path):
    env = _env(
        BOWSER_REFSTATS_CACHE_DIR=str(tmp_path / "cache"),
        BOWSER_REFSTATS_WARMUP_DELAY_S="0",
        BOWSER_REFSTATS_WARMUP_IDLE_S="0",
    )

    def run() -> dict:
        r = subprocess.run(
            [sys.executable, "-c", WARM, str(cube)],
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert r.returncode == 0, r.stderr[-3000:]
        line = next(x for x in r.stdout.splitlines() if x.startswith("RESULT"))
        return json.loads(line[len("RESULT") :])

    first = run()
    assert first["how"] == "computed"
    assert list((tmp_path / "cache").glob("*.json"))
    second = run()  # a new process: a restarted server
    assert second["how"] == "disk"
    want = H.compute_histograms(_levels(cube)[1]["displacement"], level=1)
    assert first["hits"] == second["hits"] == want


def test_background_waits_while_requests_are_in_flight(cube, monkeypatch):
    monkeypatch.setenv("BOWSER_REFSTATS_CACHE", "0")
    monkeypatch.setenv("BOWSER_HISTOGRAM_WARMUP", "1")
    monkeypatch.setenv("BOWSER_REFSTATS_WARMUP_DELAY_S", "0")
    monkeypatch.setenv("BOWSER_REFSTATS_WARMUP_IDLE_S", "0")
    monkeypatch.setenv("BOWSER_REFSTATS_WARMUP_RESUME_S", "0.05")
    levels = _levels(cube)
    k = (id(levels[0]), "displacement")
    refstats.ACTIVITY.begin()  # a request is being served
    try:
        assert H.start_warm_up(levels, "displacement", 1, workers=1)
        assert not H.start_warm_up(levels, "displacement", 1)  # once per layer
        time.sleep(0.8)
        assert k not in H.WARM_DONE
        assert H.SERVICE.cached(levels[0], ("displacement", 0, H.NBINS)) is None
    finally:
        refstats.ACTIVITY.end()
    for _ in range(200):
        if k in H.WARM_DONE:
            break
        time.sleep(0.05)
    assert H.WARM_DONE[k] == "computed"
    assert H.SERVICE.cached(levels[0], ("displacement", 8, H.NBINS)) == H.compute_one(
        levels[1]["displacement"], 8, level=1
    )
