"""bowser-lite's GeoTIFF export equals the full server's.

``GET /export/geotiff`` is sent to both servers, each in its own interpreter,
on the same cubes, and both files are read with rasterio: the same values (bit
for bit), type, nodata, CRS, transform, tags (the provenance included), band
description, scale and offset, and the same download name; GDAL reads lite's
file without a warning. Requests that are refused get the same status and
message.

What differs is the file's layout, not its content: the full server's GDAL
writes strips, lite writes one strip or 512-pixel tiles (both Deflate, no
overviews), so the sizes are close but not equal.

The cubes: the regression cube (UTM, masks, a reference point and date), and a
lon/lat cube with a pyramid, an integer layer and a packed (scaled int16) one.
The real-cube test runs when ``BOWSER_LITE_REAL_CUBE`` points at a DISP
GeoZarr; it only reads it.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import textwrap
import warnings
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

rasterio = pytest.importorskip("rasterio")
pytest.importorskip("rioxarray")
pytest.importorskip("titiler.core")

REGRESSION = Path(__file__).resolve().parents[1] / "regression"
REAL_CUBE = os.environ.get("BOWSER_LITE_REAL_CUBE")

SCRIPT = textwrap.dedent(
    r"""
    import importlib, json, sys, time
    from pathlib import Path
    from fastapi.testclient import TestClient

    which, requests = sys.argv[1:3]
    main = importlib.import_module(
        "bowser.lite.main" if which == "lite" else "bowser.main"
    )
    client = TestClient(main.app)
    out = Path(which)
    out.mkdir()
    result = {"config": client.get("/config").json()}
    for name, params in json.load(open(requests)).items():
        t0 = time.perf_counter()
        r = client.get("/export/geotiff", params=params)
        entry = {
            "status": r.status_code,
            "seconds": time.perf_counter() - t0,
            "bytes": len(r.content),
            "type": r.headers.get("content-type"),
            "disposition": r.headers.get("content-disposition"),
            "length": r.headers.get("content-length"),
        }
        if r.status_code == 200:
            (out / f"{name}.tif").write_bytes(r.content)
        else:
            entry["body"] = r.json()
        result[name] = entry
    (out / "result.json").write_text(json.dumps(result))
    """
)


def _both(cube: Path, requests: dict, work: Path) -> tuple[Path, Path]:
    """Export from the full server and from lite; return their folders."""
    work.mkdir(parents=True, exist_ok=True)
    (work / "requests.json").write_text(json.dumps(requests))
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(BOWSER_STACK_DATA_FILE=str(cube), BOWSER_REFSTATS_WARMUP="0")
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", SCRIPT, which, "requests.json"],
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
    return work / "full", work / "lite"


class _Collect(logging.Handler):
    """Keep GDAL's warnings (rasterio logs them) in a list."""

    def __init__(self, records: list[logging.LogRecord]) -> None:
        super().__init__(level=logging.WARNING)
        self.records = records

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _same_number(a, b) -> bool:
    if a is None or b is None:
        return a is b
    return bool(a == b or (np.isnan(a) and np.isnan(b)))


def _assert_equal(full: Path, lite: Path) -> dict[str, dict]:
    """Compare every export of the two servers; return lite's results."""
    a = json.loads((full / "result.json").read_text())
    b = json.loads((lite / "result.json").read_text())
    assert a.keys() == b.keys()
    assert b["config"]["geotiff_export"] is a["config"]["geotiff_export"] is True
    records: list[logging.LogRecord] = []
    handler = _Collect(records)
    logging.getLogger("rasterio").addHandler(handler)
    try:
        for name in sorted(set(a) - {"config"}):
            x, y = a[name], b[name]
            assert x["status"] == y["status"], (name, x, y)
            if x["status"] != 200:
                assert x["body"] == y["body"], name
                continue
            assert x["type"] == y["type"] == "image/tiff", name
            assert x["disposition"] == y["disposition"], name
            assert int(y["length"]) == y["bytes"], name
            with warnings.catch_warnings():
                warnings.simplefilter("error")  # GDAL opens lite's file quietly
                with (
                    rasterio.open(full / f"{name}.tif") as f,
                    rasterio.open(lite / f"{name}.tif") as li,
                ):
                    assert li.driver == "GTiff" and li.count == f.count == 1, name
                    assert li.dtypes == f.dtypes, name
                    assert (li.width, li.height) == (f.width, f.height), name
                    assert li.crs == f.crs, name
                    assert li.crs.to_wkt() == f.crs.to_wkt(), name
                    assert li.transform == f.transform, name
                    assert _same_number(li.nodata, f.nodata), name
                    assert li.tags() == f.tags(), name
                    assert li.tags(1) == f.tags(1), name
                    assert li.descriptions == f.descriptions, name
                    assert li.scales == f.scales and li.offsets == f.offsets, name
                    assert li.units == f.units, name
                    assert li.profile["compress"] == f.profile["compress"], name
                    assert li.overviews(1) == f.overviews(1) == [], name
                    want, got = f.read(1), li.read(1)
                    assert np.array_equal(
                        got, want, equal_nan=want.dtype.kind == "f"
                    ), name
                    assert np.array_equal(li.dataset_mask(), f.dataset_mask()), name
            # Same content, another block layout: the sizes stay close.
            assert y["bytes"] < 1.25 * x["bytes"] + 4096, (name, x["bytes"], y["bytes"])
    finally:
        logging.getLogger("rasterio").removeHandler(handler)
    assert not records, [r.getMessage() for r in records]
    return b


def test_regression_cube(tmp_path):
    sys.path.insert(0, str(REGRESSION))
    from cube import REF_LONLAT, make_cube

    cube = make_cube(tmp_path / "regression.zarr")
    masks = json.dumps(
        [
            {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"},
            {"dataset": "phase_similarity", "threshold": 0.8, "mode": "max"},
        ]
    )
    ref = {"ref_lon": REF_LONLAT[0], "ref_lat": REF_LONLAT[1]}
    requests = {
        "plain": {"variable": "displacement", "time_idx": 3},
        "no_time_idx": {"variable": "displacement"},
        "clamped": {"variable": "displacement", "time_idx": 99},
        "velocity": {"variable": "velocity"},
        "masked": {"variable": "displacement", "time_idx": 2, "layer_masks": masks},
        "mask_variable": {
            "variable": "velocity",
            "time_idx": 2,
            "mask_variable": "recommended_mask",
            "mask_min_value": 0.5,
        },
        "mask_variable_no_time": {
            "variable": "displacement",
            "mask_variable": "recommended_mask",
        },
        "ref_point": {"variable": "displacement", "time_idx": 4, **ref},
        "ref_buffer": {
            "variable": "displacement",
            "time_idx": 4,
            **ref,
            "ref_buffer_m": 60,
        },
        "ref_date": {"variable": "displacement", "time_idx": 5, "ref_time_idx": 1},
        "everything": {
            "variable": "displacement",
            "time_idx": 4,
            "ref_time_idx": 1,
            **ref,
            "ref_buffer_m": 60,
            "layer_masks": masks,
            "mask_variable": "recommended_mask",
        },
        "unknown": {"variable": "nope"},
        "unknown_mask": {
            "variable": "displacement",
            "layer_masks": '[{"dataset": "nope"}]',
        },
        "bad_json": {"variable": "displacement", "layer_masks": "{"},
        "half_reference": {"variable": "displacement", "ref_lon": -117.6},
        "reference_outside": {"variable": "displacement", "ref_lon": 10, "ref_lat": 10},
        "reference_on_unitless": {
            "variable": "temporal_coherence",
            "time_idx": 1,
            **ref,
        },
        "ref_date_without_time": {"variable": "velocity", "ref_time_idx": 1},
    }
    lite = _assert_equal(*_both(cube, requests, tmp_path / "run"))
    ok = {k for k, v in lite.items() if k != "config" and v["status"] == 200}
    # A static velocity cannot pick an arbitrary date from a dynamic mask.
    assert ok == set(list(requests)[:11]) - {"mask_variable"}
    assert lite["mask_variable"]["status"] == 422
    assert "static summary" in lite["mask_variable"]["body"]["detail"]
    assert lite["everything"]["disposition"] == (
        'attachment; filename="displacement_20260113-20260218_masked.tif"'
    )
    assert lite["unknown"]["status"] == 404
    with rasterio.open(tmp_path / "run" / "lite" / "everything.tif") as src:
        tags = src.tags()
        assert tags["BOWSER_REFERENCE_METHOD"] == "circular_median"
        assert tags["BOWSER_EXPORT_MASKED"] == "true"
        assert np.isnan(src.read(1)).mean() > 0.3


def _lonlat_cube(path: Path) -> Path:
    """A lon/lat cube with a pyramid, an integer layer and a packed int16 one."""
    import rioxarray  # noqa: F401
    import zarr

    rng = np.random.default_rng(5)
    nt, ny, nx = 4, 600, 700  # larger than one GeoTIFF tile
    x = -117.5 + 0.001 * (np.arange(nx) + 0.5)
    y = 34.2 - 0.001 * (np.arange(ny) + 0.5)
    t = np.datetime64("2026-01-01") + np.arange(nt) * np.timedelta64(12, "D")
    disp = rng.normal(size=(nt, ny, nx)).astype("float32")
    disp[:, :60, :90] = np.nan
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), disp, {"units": "meters"}),
            "quality": (("y", "x"), rng.uniform(0, 1, (ny, nx)).astype("float32")),
            "count": (("y", "x"), rng.integers(0, 50, (ny, nx)).astype("uint16")),
            "packed": (("y", "x"), np.round(disp[0], 2), {"units": "meters"}),
        },
        coords={"time": t.astype("datetime64[ns]"), "y": y, "x": x},
        attrs={"sensor": "Example radar", "frame_id": 42},
    ).rio.write_crs(4326)
    enc = {
        "packed": {"dtype": "int16", "scale_factor": 0.01, "_FillValue": -32768},
    }
    ds.to_zarr(path, group="0", mode="w", consolidated=False, encoding=enc)
    coarse = ds.coarsen(x=2, y=2).mean().assign_coords(spatial_ref=ds.spatial_ref)
    coarse.to_zarr(path, group="1", mode="a", consolidated=False)
    zarr.open_group(str(path), mode="a").attrs.update(
        {"multiscales": {"layout": [{"asset": "0"}, {"asset": "1"}]}}
    )
    return path


def test_lonlat_pyramid_cube(tmp_path):
    cube = _lonlat_cube(tmp_path / "lonlat.zarr")
    masks = json.dumps([{"dataset": "quality", "threshold": 0.5, "mode": "min"}])
    ref = {"ref_lon": -117.2, "ref_lat": 34.0}
    requests = {
        "tiled": {"variable": "displacement", "time_idx": 2},
        "masked_ref": {
            "variable": "displacement",
            "time_idx": 3,
            "ref_time_idx": 0,
            "layer_masks": masks,
            **ref,
        },
        # A buffer in metres needs a projected CRS: refused by both.
        "buffer_in_degrees": {
            "variable": "displacement",
            "time_idx": 1,
            **ref,
            "ref_buffer_m": 500,
        },
        "integer": {"variable": "count"},
        "integer_masked": {"variable": "count", "layer_masks": masks},
        "packed": {"variable": "packed"},
        "packed_masked": {"variable": "packed", "layer_masks": masks},
    }
    full, lite_dir = _both(cube, requests, tmp_path / "run")
    lite = _assert_equal(full, lite_dir)
    assert lite["tiled"]["status"] == lite["integer"]["status"] == 200
    assert lite["buffer_in_degrees"]["status"] == 422
    with rasterio.open(lite_dir / "tiled.tif") as src:
        assert (src.height, src.width) == (600, 700)  # level 0, not the pyramid
        assert src.block_shapes == [(512, 512)] and src.crs.to_epsg() == 4326
    with rasterio.open(lite_dir / "integer.tif") as src:
        assert src.dtypes == ("uint16",) and src.nodata is None


@pytest.mark.skipif(
    not (REAL_CUBE and Path(REAL_CUBE).exists()),
    reason="set BOWSER_LITE_REAL_CUBE to a DISP GeoZarr",
)
def test_real_cube(tmp_path):
    root = xr.open_zarr(REAL_CUBE, consolidated=False)
    ds = root if "x" in root.coords else xr.open_zarr(REAL_CUBE, group="0")
    names = [n for n, v in ds.data_vars.items() if {"y", "x"} <= set(v.dims)]
    name = "displacement" if "displacement" in names else names[0]
    requests = {
        "step": {"variable": name, "time_idx": 1},
        **{f"layer_{n}": {"variable": n} for n in names[:4]},
    }
    lite = _assert_equal(*_both(Path(REAL_CUBE), requests, tmp_path / "run"))
    assert lite["step"]["status"] == 200
