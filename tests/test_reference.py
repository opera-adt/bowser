"""The one selection of reference pixels shared by the viewer and the export."""

import numpy as np
import pytest
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import Transformer

from bowser.reference import (
    pool,
    reference_median,
    reference_offset,
    select_circle,
    select_point,
    select_reference,
)


def _cube(n_time=3, size=9, descending_y=True):
    x = 500000 + 10 * (np.arange(size) + 0.5)
    y = 100 - 10 * (np.arange(size) + 0.5)
    if not descending_y:
        y = y[::-1]
    data = np.arange(n_time * size * size, dtype="float32").reshape(n_time, size, size)
    return xr.DataArray(
        data, dims=("time", "y", "x"), coords={"x": x, "y": y}
    ).rio.write_crs(32631)


def test_point_selects_one_pixel_per_time_step():
    da = _cube()
    cx, cy = float(da.x[4]) + 2, float(da.y[3]) - 3
    picked = select_point(da, cx, cy)
    assert picked.values.shape == (3, 1, 1)
    assert picked.inside.tolist() == [[True]]
    np.testing.assert_array_equal(
        picked.values[:, 0, 0], da.sel(x=cx, y=cy, method="nearest").values
    )


def test_point_methods_differ_only_on_a_pixel_boundary():
    da = _cube()
    cx, cy = float(da.x[4]) + 5, float(da.y[4]) - 5  # corner of four pixels
    nearest = select_point(da, cx, cy, "nearest").values
    containing = select_point(da, cx, cy, "containing").values
    assert nearest[0, 0, 0] == da.sel(x=cx, y=cy, method="nearest")[0]
    assert containing[0, 0, 0] == da[0, 5, 5]
    with pytest.raises(ValueError, match="outside the source raster"):
        select_point(da, 0.0, 0.0, "containing")


@pytest.mark.parametrize("margin_window", [False, True])
@pytest.mark.parametrize("sqrt_distance", [False, True])
def test_circle_selects_pixel_centres_within_the_radius(margin_window, sqrt_distance):
    da = _cube()
    cx, cy = float(da.x[4]), float(da.y[4])
    circle = select_circle(
        da, cx, cy, 12, margin_window=margin_window, sqrt_distance=sqrt_distance
    )
    assert circle is not None
    # A 12 m circle on a 10 m grid: the centre and its 4 edge neighbours.
    selected = circle.values[:, circle.inside]
    expected = da.values[:, [3, 4, 4, 4, 5], [4, 3, 4, 5, 4]]
    np.testing.assert_array_equal(selected, expected)


def test_window_with_margin_is_one_pixel_wider_and_can_miss():
    da = _cube()
    cx, cy = float(da.x[4]), float(da.y[4])
    exact = select_circle(da, cx, cy, 12)
    margin = select_circle(da, cx, cy, 12, margin_window=True)
    assert exact is not None and margin is not None
    assert exact.inside.shape == (3, 3)
    assert margin.inside.shape == (5, 5)
    assert select_circle(da, 0.0, 0.0, 12, margin_window=True) is None
    # The margin window is written for descending y (an ascending axis misses,
    # and the viewer falls back to a point); the exact window takes either.
    ascending = _cube(descending_y=False)
    assert select_circle(ascending, cx, cy, 12, margin_window=True) is None
    flipped = select_circle(ascending, cx, cy, 12)
    assert flipped is not None and flipped.inside.sum() == 5


def test_reference_dispatches_on_buffer():
    da = _cube()
    cx, cy = float(da.x[4]), float(da.y[4])
    assert select_reference(da, cx, cy, 0).values.shape == (3, 1, 1)
    circle = select_reference(da, cx, cy, 12)
    assert circle is not None and circle.inside.sum() == 5


def test_median_is_per_time_step_and_ignores_nan():
    da = _cube()
    cx, cy = float(da.x[4]), float(da.y[4])
    circle = select_circle(da, cx, cy, 12)
    assert circle is not None
    values = circle.values.copy()
    values[0, 1, 1] = np.nan  # the centre pixel at time 0
    pooled = pool(values, circle.inside)
    assert pooled.shape == (3, 9)
    median = reference_median(pooled)
    # Time 0 pools the 4 edge neighbours, the others the full cross.
    neighbours = da.values[0, [3, 4, 4, 5], [4, 3, 5, 4]]
    np.testing.assert_array_equal(
        median, [np.median(neighbours), *np.median(circle.values[1:, circle.inside], 1)]
    )
    assert np.isnan(reference_median(np.full((2, 4), np.nan))).all()


@pytest.mark.parametrize("margin_window", [False, True])
def test_2d_layer_pools_to_one_step(margin_window):
    """A layer without a time axis is one step, not one series per window row."""
    da = _cube().isel(time=1)
    cx, cy = float(da.x[4]), float(da.y[4])
    circle = select_circle(da, cx, cy, 25, margin_window=margin_window)
    assert circle is not None and circle.values.ndim == 2
    pooled = pool(*circle)
    assert pooled.shape == (1, circle.inside.size)
    np.testing.assert_array_equal(
        reference_median(pooled), [np.median(circle.values[circle.inside])]
    )


def test_viewer_median_and_export_offset_agree():
    """The map's buffer median and the GeoTIFF reference are the same value."""
    da = _cube()
    lon, lat = Transformer.from_crs(32631, 4326, always_xy=True).transform(
        float(da.x[4]) + 3, float(da.y[4]) - 4
    )
    cx, cy = Transformer.from_crs(4326, 32631, always_xy=True).transform(lon, lat)
    circle = select_circle(da, cx, cy, 25, margin_window=True, sqrt_distance=True)
    assert circle is not None
    viewer = reference_median(pool(*circle))
    for t in range(3):
        offset, tags = reference_offset(da.isel(time=t), lon, lat, 25)
        assert offset == viewer[t]
        assert tags["BOWSER_REFERENCE_VALID_PIXELS"] == str(circle.inside.sum())
