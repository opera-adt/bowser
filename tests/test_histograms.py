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

import warnings
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

from bowser import histograms as H
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
