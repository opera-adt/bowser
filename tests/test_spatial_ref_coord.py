"""The full server reads ``spatial_ref`` as a coordinate, as bowser-lite does.

rioxarray writes the grid mapping as a data variable, so a plain store reopens
with ``spatial_ref`` among ``data_vars``. Promoted on read it stays out of the
layer loops, and ``rio.write_crs`` keeps the cached ``GeoTransform`` that lite
also reads.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import xarray as xr
from pyproj import CRS

from bowser.lite import cube as lcube
from bowser.state import _open_md

pytest.importorskip("rioxarray")

GEO_TRANSFORM = "500000.0 30.0 0.0 4000000.0 0.0 -30.0"


def _store(path: Path, pyramid: bool) -> Path:
    """A 16x16 cube with ``spatial_ref`` written as a scalar data variable."""
    n = 16
    for level in range(2 if pyramid else 1):
        m, res = n >> level, 30.0 * (1 << level)
        sr = xr.DataArray(
            0,
            attrs={
                "crs_wkt": CRS.from_epsg(32611).to_wkt(),
                "GeoTransform": f"500000.0 {res} 0.0 4000000.0 0.0 {-res}",
            },
        )
        ds = xr.Dataset(
            {
                "displacement": (
                    ("time", "y", "x"),
                    np.ones((2, m, m), "float32"),
                    {"grid_mapping": "spatial_ref"},
                ),
                "velocity": (
                    ("y", "x"),
                    np.ones((m, m), "float32"),
                    {"grid_mapping": "spatial_ref"},
                ),
                "spatial_ref": sr,
            },
            coords={
                "time": np.array(["2026-01-01", "2026-01-13"], "datetime64[ns]"),
                "x": 500000.0 + res * (np.arange(m) + 0.5),
                "y": 4000000.0 - res * (np.arange(m) + 0.5),
            },
        )
        ds.to_zarr(path, group=str(level) if pyramid else None, consolidated=False)
    if pyramid:
        import zarr

        zarr.open_group(path, mode="a").attrs["multiscales"] = {
            "layout": [{"asset": "0"}, {"asset": "1", "derived_from": "0"}]
        }
    assert (
        "spatial_ref"
        in xr.open_zarr(
            path, group="0" if pyramid else None, consolidated=False
        ).data_vars
    )
    return path


@pytest.mark.parametrize("pyramid", [False, True])
def test_spatial_ref_is_a_coordinate_on_every_level(tmp_path, pyramid):
    path = _store(tmp_path / "cube.zarr", pyramid)
    ds, _, levels = _open_md(str(path))
    assert len(levels) == (2 if pyramid else 1)
    assert set(ds.data_vars) == {"displacement", "velocity"}
    for lvl in levels:
        assert "spatial_ref" in lvl.dataset.coords
        assert "spatial_ref" not in lvl.dataset.data_vars
    # The cached affine survives rio.write_crs, as bowser-lite reads it.
    assert ds.spatial_ref.attrs["GeoTransform"] == GEO_TRANSFORM
    lite = lcube.open_cube(str(path))
    assert lcube.spatial_ref_attrs(lite.dataset)["GeoTransform"] == GEO_TRANSFORM
    assert list(ds.rio.bounds()) == list(lite.bounds())
