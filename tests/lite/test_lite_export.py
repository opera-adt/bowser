"""bowser-lite's GeoTIFF export (``bowser.lite.export``), checked without GDAL.

The exported file is parsed with the standard library (``test_lite_geotiff``):
the pixels are the cube's, masked and re-referenced as asked, the type and
nodata follow the layer, and the provenance tags and filename describe the
export. Equality with the full server's file is in ``test_lite_export_parity``.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pytest
import xarray as xr
from fastapi import HTTPException
from pyproj import CRS, Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_lite_geotiff import parse, pixels  # noqa: E402

from bowser.lite import cube as lcube  # noqa: E402
from bowser.lite.export import export_layer  # noqa: E402

N, EPSG = 20, 32611
X0, Y0, DX = 500000.0, 4000000.0, 30.0


@pytest.fixture(scope="module")
def cube(tmp_path_factory):
    rng = np.random.default_rng(11)
    disp = rng.normal(size=(3, N, N)).astype("float32")
    disp[:, :2, :2] = np.nan
    coh = rng.uniform(0, 1, size=(N, N)).astype("float32")
    sr = xr.DataArray(0, attrs={"crs_wkt": CRS.from_epsg(EPSG).to_wkt()})
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                disp,
                {"units": "meters", "long_name": "LOS displacement"},
            ),
            "coherence": (("y", "x"), coh),
            "count": (("y", "x"), rng.integers(0, 9, (N, N)).astype("uint16")),
        },
        coords={
            "time": np.array(
                ["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]"
            ),
            "x": X0 + DX * (np.arange(N) + 0.5),
            "y": Y0 - DX * (np.arange(N) + 0.5),
            "spatial_ref": sr,
        },
        attrs={"sensor": "Example radar"},
    )
    path = tmp_path_factory.mktemp("export") / "cube.zarr"
    ds.to_zarr(path, mode="w", consolidated=False)
    return lcube.open_cube(str(path)), ds


def _tags(raw: bytes) -> dict[str, str]:
    """Dataset items of the file's ``GDAL_METADATA`` (values unescaped twice)."""
    from xml.sax.saxutils import unescape

    items = re.findall(r'<Item name="([^"]+)">(.*?)</Item>', parse(raw)[42112], re.S)
    quote = {"&quot;": '"'}
    return {k: unescape(unescape(v), quote) for k, v in items}


def test_a_step_is_exported_as_stored(cube):
    opened, ds = cube
    parts, filename = export_layer(opened, variable="displacement", time_idx=1)
    raw = b"".join(parts)
    assert filename == "displacement_20260113.tif"
    f = parse(raw)
    assert (f[256], f[257], f[258], f[339]) == ([N], [N], [32], [3])
    assert f[42113] == "nan"
    assert f[33550] == [DX, DX, 0.0] and f[33922][3:5] == [X0, Y0]
    assert np.array_equal(pixels(raw, "<f4"), ds.displacement.values[1], equal_nan=True)
    tags = _tags(raw)
    assert tags["units"] == "meters" and tags["long_name"] == "LOS displacement"
    assert tags["BOWSER_EXPORT_LAYER"] == "displacement"
    assert tags["BOWSER_EXPORT_MASKED"] == "false"
    assert tags["BOWSER_EXPORT_REFERENCE_MODE"] == "stored"
    assert tags["BOWSER_TIME_SELECTED_DATE"] == "2026-01-13"
    assert tags["BOWSER_SOURCE_SENSOR"] == "Example radar"
    provenance = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])
    assert provenance["nodata"]["export"] == "nan"
    assert provenance["time"]["selected_index"] == 1
    assert 'role="description">LOS displacement<' in f[42112]


def test_masks_reference_and_reference_date_change_the_values(cube):
    opened, ds = cube
    back = Transformer.from_crs(EPSG, 4326, always_xy=True)
    lon, lat = back.transform(X0 + DX * 10.5, Y0 - DX * 7.5)  # pixel (7, 10)
    masks = json.dumps([{"dataset": "coherence", "threshold": 0.4, "mode": "min"}])
    parts, filename = export_layer(
        opened,
        variable="displacement",
        time_idx=2,
        ref_time_idx=0,
        layer_masks=masks,
        ref_lon=lon,
        ref_lat=lat,
    )
    raw = b"".join(parts)
    assert filename == "displacement_20260101-20260125_masked.tif"
    step = ds.displacement.values[2] - ds.displacement.values[0]
    want = np.where(ds.coherence.values >= 0.4, step, np.nan) - step[7, 10]
    got = pixels(raw, "<f4")
    assert np.array_equal(np.isnan(got), np.isnan(want))
    assert np.allclose(got, want.astype("float32"), equal_nan=True, atol=1e-6)
    assert np.isnan(got).sum() > 100  # the mask did hide pixels
    tags = _tags(raw)
    assert tags["BOWSER_EXPORT_MASKED"] == "true"
    assert tags["BOWSER_EXPORT_REFERENCE_MODE"] == "interactive"
    assert tags["BOWSER_REFERENCE_METHOD"] == "nearest_pixel"
    assert float(tags["BOWSER_REFERENCE_VALUE"]) == pytest.approx(float(step[7, 10]))
    assert tags["BOWSER_TIME_REFERENCE_DATE"] == "2026-01-01"
    applied = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])["masks"]["applied"]
    assert applied == [
        {
            "kind": "layer",
            "layer": "coherence",
            "operator": ">=",
            "threshold": 0.4,
            "time_index": None,
            "time_label": None,
            "threshold_units": None,
        }
    ]


def test_an_integer_layer_keeps_its_type_until_it_is_masked(cube):
    opened, ds = cube
    parts, filename = export_layer(opened, variable="count")
    raw = b"".join(parts)
    f = parse(raw)
    assert filename == "count.tif"
    assert (f[258], f[339]) == ([16], [1]) and 42113 not in f  # uint16, no nodata
    assert np.array_equal(pixels(raw, "<u2"), ds["count"].values)
    masks = json.dumps([{"dataset": "coherence", "threshold": 0.5, "mode": "max"}])
    raw = b"".join(export_layer(opened, variable="count", layer_masks=masks)[0])
    f = parse(raw)
    assert f[339] == [3] and f[42113] == "nan"  # masked pixels need NaN
    want = np.where(ds.coherence.values <= 0.5, ds["count"].values, np.nan)
    assert np.array_equal(pixels(raw, f"<f{f[258][0] // 8}"), want, equal_nan=True)


@pytest.mark.parametrize(
    ("params", "status", "detail"),
    [
        ({"variable": "nope"}, 404, "Unknown layer: nope"),
        ({"variable": "displacement", "ref_lon": 1.0}, 422, "Supply both"),
        (
            {"variable": "displacement", "layer_masks": '[{"dataset": "nope"}]'},
            422,
            "Unknown mask layer: nope",
        ),
        ({"variable": "displacement", "layer_masks": "{}"}, 422, "JSON list"),
        (
            {"variable": "displacement", "mask_variable": "nope"},
            422,
            "Unknown mask layer",
        ),
        ({"variable": "coherence", "ref_time_idx": 1}, 422, "no time axis"),
        (
            {"variable": "displacement", "ref_lon": 10.0, "ref_lat": 10.0},
            422,
            "outside the source raster",
        ),
        (
            {"variable": "coherence", "ref_lon": -117.0, "ref_lat": 36.14},
            422,
            "does not use an interactive spatial reference",
        ),
    ],
)
def test_bad_requests_are_refused_like_the_full_server(cube, params, status, detail):
    with pytest.raises(HTTPException) as caught:
        export_layer(cube[0], **params)
    assert caught.value.status_code == status
    assert detail in caught.value.detail
