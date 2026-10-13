"""View cubes: a UTM cube resampled onto the Web Mercator tile grid, values kept."""

import math

import numpy as np
import pandas as pd
import pytest
import xarray as xr
from pyproj import CRS, Transformer

from bowser.view_cube import (
    TILE,
    make_view_cube,
    mercator_res,
    native_zoom,
    view_grid,
)


@pytest.fixture
def utm_cube(tmp_path):
    """Return a 10 m UTM 11N cube near Prado Dam; every pixel value is unique."""
    ny, nx, nt = 50, 60, 3
    x = 436970.0 + 5 + 10 * np.arange(nx)
    y = 3758470.0 - 5 - 10 * np.arange(ny)
    values = np.arange(nt * ny * nx, dtype=np.float32).reshape(nt, ny, nx)
    values[:, 0, 0] = np.nan
    crs = CRS.from_epsg(32611)
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                values,
                {"units": "meters", "grid_mapping": "spatial_ref"},
            ),
            "velocity": (("y", "x"), values[0] * 2, {"grid_mapping": "spatial_ref"}),
            "labels": (("y", "x"), np.arange(ny * nx, dtype=np.int32).reshape(ny, nx)),
            "reference_time": (
                ("time",),
                pd.date_range("2026-01-01", periods=nt, freq="12D"),
            ),
            "spatial_ref": ((), 0, {"crs_wkt": crs.to_wkt()}),
        },
        coords={
            "time": pd.date_range("2026-01-13", periods=nt, freq="12D"),
            "y": y,
            "x": x,
        },
        attrs={
            "proj:code": "EPSG:32611",
            "title": "Prado Dam (CA) · test",
            "reference_lonlat": "[-117.67, 33.95]",
            "reference_row": "1",
            "reference_col": "2",
        },
    )
    path = tmp_path / "utm.zarr"
    ds.to_zarr(path, zarr_format=3)
    return path


def test_native_zoom_is_the_coarsest_zoom_no_larger_than_the_source():
    for res, lat in [(10, 33.95), (10, 47.0), (30, 0.0), (5, 60.0)]:
        z = native_zoom(res, lat)
        ground = lambda zz: mercator_res(zz) * math.cos(math.radians(lat))  # noqa: E731
        assert ground(z) <= res < ground(z - 1)
    assert native_zoom(10, 33.95) == 14


def test_grid_is_whole_tiles_of_the_global_grid():
    g = view_grid((-13100000.0, 4020000.0, -13090000.0, 4030000.0), 14)
    span = TILE * mercator_res(14)
    assert g.shape == (g.ntile_y * TILE, g.ntile_x * TILE)
    # edges fall on tile boundaries, and the footprint is inside
    assert math.isclose((g.x0 + math.pi * 6378137.0) / span, g.tile_col0)
    assert g.x0 <= -13100000.0 and g.x0 + g.shape[1] * g.res >= -13090000.0
    assert g.y0 >= 4030000.0 and g.y0 - g.shape[0] * g.res <= 4020000.0


def test_view_cube_keeps_every_value_at_its_place(utm_cube, tmp_path):
    out = make_view_cube(utm_cube, tmp_path / "view.zarr")
    src = xr.open_zarr(utm_cube)
    v = xr.open_zarr(out)
    a = v.attrs
    assert (
        a["proj:code"] == "EPSG:3857"
        and a["view:zoom"] == 14
        and a["title"] == "Prado Dam (CA) · test"
    )
    assert v["displacement"].encoding["chunks"] == (1, TILE, TILE)
    assert v.sizes["y"] % TILE == 0 and v.sizes["x"] % TILE == 0
    assert CRS.from_wkt(v["spatial_ref"].attrs["crs_wkt"]).to_epsg() == 3857

    # Every view pixel holds the source value at its centre (xarray's nearest lookup).
    to_utm = Transformer.from_crs(3857, 32611, always_xy=True)
    disp = v["displacement"].values
    rows, cols = np.nonzero(np.isfinite(disp[1]))
    e, n = to_utm.transform(v.x.values[cols], v.y.values[rows])
    expect = (
        src["displacement"]
        .isel(time=1)
        .sel(x=xr.DataArray(e), y=xr.DataArray(n), method="nearest")
        .values
    )
    np.testing.assert_array_equal(disp[1][rows, cols], expect)

    # Every source pixel is kept (the view grid is finer than the source).
    kept = np.unique(disp[0][np.isfinite(disp[0])])
    source = src["displacement"].isel(time=0).values
    np.testing.assert_array_equal(kept, np.sort(source[np.isfinite(source)]))

    # Integer layers become float with NaN outside; non-spatial variables are copied.
    assert v["labels"].dtype == np.float32 and np.isnan(v["labels"].values[0, 0])
    np.testing.assert_array_equal(
        v["reference_time"].values, src["reference_time"].values
    )
    np.testing.assert_array_equal(v["time"].values, src["time"].values)

    # The reference pixel is recomputed for the new grid and contains the reference.
    lon, lat = -117.67, 33.95
    x, y = Transformer.from_crs(4326, 3857, always_xy=True).transform(lon, lat)
    r, c = a["reference_row"], a["reference_col"]
    assert (
        v.y.values[r] - v.attrs["spatial:transform"][0] / 2
        <= y
        <= v.y.values[r] + v.attrs["spatial:transform"][0] / 2
    )
    assert abs(v.x.values[c] - x) <= v.attrs["spatial:transform"][0] / 2


def test_refuses_to_overwrite(utm_cube, tmp_path):
    out = tmp_path / "view.zarr"
    out.mkdir()
    with pytest.raises(FileExistsError):
        make_view_cube(utm_cube, out)
