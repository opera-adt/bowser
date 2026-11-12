"""bowser-lite's polygon statistics equal the full server's.

``POST /polygon_timeseries`` is sent to both servers, each in its own
interpreter, on the same cubes: the same status, the same pixel counts and the
same statistics (numbers within a relative 1e-9; they are computed by the same
code from the same pixels) for every shape of ``parity.polygon_bodies``, and the
same error for the ones that are refused.

The cubes: the regression cube (UTM), and a lon/lat cube with a pyramid, time
chunks, a 2-D layer and an integer layer. The real-cube test runs when
``BOWSER_LITE_REAL_CUBE`` points at a DISP GeoZarr; it only reads it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parity  # noqa: E402

pytest.importorskip("rioxarray")
pytest.importorskip("titiler.core")

REGRESSION = Path(__file__).resolve().parents[1] / "regression"
REAL_CUBE = os.environ.get("BOWSER_LITE_REAL_CUBE")

SCRIPT = textwrap.dedent(
    r"""
    import importlib, json, sys, time
    from fastapi.testclient import TestClient

    which, bodies, out = sys.argv[1:4]
    main = importlib.import_module(
        "bowser.lite.main" if which == "lite" else "bowser.main"
    )
    client = TestClient(main.app)
    result = {}
    for name, body in json.load(open(bodies)).items():
        t0 = time.perf_counter()
        r = client.post("/polygon_timeseries", json=body)
        result[name] = {
            "status": r.status_code,
            "body": r.json(),
            "seconds": time.perf_counter() - t0,
        }
    json.dump(result, open(out, "w"))
    """
)


def _both(cube: Path, bodies: dict, work: Path) -> tuple[dict, dict]:
    """Answers of the full server and of lite to the same bodies."""
    work.mkdir(parents=True, exist_ok=True)
    (work / "bodies.json").write_text(json.dumps(bodies))
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(BOWSER_STACK_DATA_FILE=str(cube), BOWSER_REFSTATS_WARMUP="0")
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", SCRIPT, which, "bodies.json", f"{which}.json"],
            env={**env, "BOWSER_REFSTATS_CACHE_DIR": str(work / f"refstats-{which}")},
            cwd=work,
            stderr=subprocess.PIPE,
            text=True,
        )
        for which in ("full", "lite")
    ]
    for proc in procs:
        _, err = proc.communicate(timeout=900)
        assert proc.returncode == 0, err[-4000:]
    full, lite = (
        json.loads((work / f"{w}.json").read_text()) for w in ("full", "lite")
    )
    return full, lite


def _assert_equal(full: dict, lite: dict) -> None:
    assert full.keys() == lite.keys()
    for name in full:
        a, b = full[name], lite[name]
        assert a["status"] == b["status"], (name, a["body"], b["body"])
        diffs = parity.json_diffs(a["body"], b["body"], name, rel=1e-9)
        assert not diffs, diffs[:10]


def _lonlat_cube(path: Path) -> Path:
    """A lon/lat cube with a pyramid, time chunks of 4, a 2-D and an integer layer."""
    import rioxarray  # noqa: F401
    import zarr

    rng = np.random.default_rng(5)
    nt, ny, nx = 10, 64, 80
    x = -117.5 + 0.001 * (np.arange(nx) + 0.5)
    y = 34.2 - 0.001 * (np.arange(ny) + 0.5)
    t = np.datetime64("2026-01-01") + np.arange(nt) * np.timedelta64(12, "D")
    disp = rng.normal(size=(nt, ny, nx)).astype("float32")
    disp[:, :6, :9] = np.nan
    disp[3, 20:40, 30:50] = np.nan
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), disp, {"units": "meters"}),
            "velocity": (("y", "x"), disp[-1] / 3, {"units": "m/yr"}),
            "count": (("y", "x"), rng.integers(0, 50, (ny, nx)).astype("uint16")),
        },
        coords={"time": t.astype("datetime64[ns]"), "y": y, "x": x},
    ).rio.write_crs(4326)
    enc = {"displacement": {"chunks": (4, 32, 32)}}
    ds.to_zarr(path, group="0", mode="w", consolidated=False, encoding=enc)
    coarse = ds.coarsen(x=2, y=2).mean().assign_coords(spatial_ref=ds.spatial_ref)
    coarse.to_zarr(path, group="1", mode="a", consolidated=False)
    zarr.open_group(str(path), mode="a").attrs.update(
        {"multiscales": {"layout": [{"asset": "0"}, {"asset": "1"}]}}
    )
    return path


def test_regression_cube(tmp_path):
    sys.path.insert(0, str(REGRESSION))
    from cube import DX, EPSG, NX, NY, X0, Y0, make_cube

    cube = make_cube(tmp_path / "regression.zarr")
    bodies = parity.polygon_bodies("displacement", X0, Y0, DX, NX, NY, EPSG)
    bodies["velocity"] = {**bodies["concave"], "variable": "velocity"}
    bodies["unknown"] = {**bodies["convex"], "variable": "missing"}
    full, lite = _both(cube, bodies, tmp_path / "run")
    _assert_equal(full, lite)
    ok = {k for k, v in full.items() if v["status"] == 200}
    assert ok == set(bodies) - {"tiny_miss", "outside", "bowtie", "unknown"}
    assert full["unknown"]["status"] == 404
    assert full["tiny_hit"]["body"]["polygon_pixels"] == 1
    assert full["covers_all"]["body"]["polygon_pixels"] == NX * NY
    assert "beyond the source grid" in " ".join(
        lite["partly_outside"]["body"]["warnings"]
    )
    assert lite["tiny_miss"]["body"]["detail"].startswith("No native pixel centers")
    assert "does not intersect" in lite["outside"]["body"]["detail"]


def test_lonlat_pyramid_cube(tmp_path):
    cube = _lonlat_cube(tmp_path / "lonlat.zarr")
    grid = (-117.5, 34.2, 0.001, 80, 64, 4326)
    bodies = parity.polygon_bodies("displacement", *grid)
    for name in ("concave", "multi", "edge"):
        bodies[f"velocity_{name}"] = {**bodies[name], "variable": "velocity"}
        bodies[f"count_{name}"] = {**bodies[name], "variable": "count"}
    full, lite = _both(cube, bodies, tmp_path / "run")
    _assert_equal(full, lite)
    assert full["hole"]["status"] == full["count_multi"]["status"] == 200
    assert full["hole"]["body"]["grid"]["crs"] == "EPSG:4326"
    assert full["hole"]["body"]["grid"]["shape"] == [64, 80]  # level 0, not the pyramid


@pytest.mark.skipif(
    not (REAL_CUBE and Path(REAL_CUBE).exists()),
    reason="set BOWSER_LITE_REAL_CUBE to a DISP GeoZarr",
)
def test_real_cube(tmp_path):
    ds = xr.open_zarr(REAL_CUBE, group=None, consolidated=False)
    if "x" not in ds.coords:
        ds = xr.open_zarr(REAL_CUBE, group="0", consolidated=False)
    import rioxarray  # noqa: F401

    name = "displacement" if "displacement" in ds else next(iter(ds.data_vars))
    dx = abs(float(ds.x[1] - ds.x[0]))
    nx, ny = min(ds.sizes["x"], 96), min(ds.sizes["y"], 96)
    x0 = float(ds.x[ds.sizes["x"] // 2 - nx // 2]) - dx / 2
    y0 = float(ds.y[ds.sizes["y"] // 2 - ny // 2]) + dx / 2
    root = xr.open_zarr(REAL_CUBE, consolidated=False)
    code = root.attrs.get("proj:code") or ds.rio.crs.to_string()
    epsg = int(str(code).split(":")[-1])
    bodies = parity.polygon_bodies(name, x0, y0, dx, nx, ny, epsg)
    full, lite = _both(Path(REAL_CUBE), bodies, tmp_path / "run")
    _assert_equal(full, lite)
    assert full["hole"]["status"] == 200
