"""bowser-lite's polygon statistics: the pixel selection, without GDAL.

- :func:`bowser.lite.polygon.rasterize` selects pixel centres inside the polygon
  (holes out, parts together), with GDAL's rule for centres exactly on an edge;
- :func:`bowser.lite.polygon.is_valid` accepts and rejects what shapely does;
- both agree with rasterio and shapely on random polygons (when installed);
- :func:`bowser.lite.polygon.summarize_cube` reads only the polygon's window,
  whatever the stored axis order or time chunking.

Nothing here needs rasterio, shapely or the full server, except the comparison
with them, which is skipped when they are missing.
"""

from __future__ import annotations

import numpy as np
import pytest
import xarray as xr
from pyproj import CRS, Transformer

from bowser.lite import polygon as lp

#: A 12 x 8 grid of unit pixels, north-up: pixel (col, row) spans x in
#: [col, col + 1] and y in [-row - 1, -row].
SHAPE = (8, 12)
ORIGIN, RES = (0.0, 0.0), (1.0, -1.0)


def _ring(points: list[tuple[float, float]]) -> np.ndarray:
    """Return a closed ring from pixel ``(col, row)`` corners."""
    xy = [(c, -r) for c, r in points]
    return np.array(xy + xy[:1], dtype=float)


def _burn(*polygons: list[np.ndarray]) -> np.ndarray:
    return lp.rasterize(list(polygons), SHAPE, ORIGIN, RES).astype(int)


def _box(c0: float, r0: float, c1: float, r1: float) -> np.ndarray:
    return _ring([(c0, r0), (c1, r0), (c1, r1), (c0, r1)])


def test_a_pixel_is_selected_when_its_centre_is_inside():
    got = _burn([_box(2.4, 1.4, 9.6, 5.6)])
    want = np.zeros(SHAPE, dtype=int)
    want[1:6, 2:10] = 1  # centres 2.5..9.5 x 1.5..5.5
    assert np.array_equal(got, want)
    # Not "all touched": a box that covers no centre selects nothing.
    assert _burn([_box(2.6, 1.6, 3.4, 2.4)]).sum() == 0


def test_centres_on_an_edge_follow_gdal():
    # Edges through pixel centres on a north-up grid, as GDAL burns them: a
    # centre on the left edge is out and one on the right edge is in, and the
    # rows of the top and bottom edges are in, whichever way the ring is drawn.
    box = _box(2.5, 1.5, 9.5, 5.5)
    want = np.zeros(SHAPE, dtype=int)
    want[1:6, 3:10] = 1
    assert np.array_equal(_burn([box]), want)
    assert np.array_equal(_burn([box[::-1]]), want)
    # A triangle's horizontal edge through a row of centres keeps that row,
    # at the bottom (cut like a bottom edge) or at the top.
    up = _ring([(2, 5.5), (10, 5.5), (6, 1.5)])
    row = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]
    assert _burn([up])[5].tolist() == row == _burn([up[::-1]])[5].tolist()
    down = _ring([(2, 1.5), (10, 1.5), (6, 5.5)])
    assert _burn([down])[1].tolist() == row == _burn([down[::-1]])[1].tolist()


def test_holes_are_excluded_and_parts_are_combined():
    outer, hole = _box(0.2, 0.2, 11.6, 7.6), _box(3, 2.5, 9, 5.5)
    got = _burn([outer, hole])
    want = np.ones(SHAPE, dtype=int)
    want[2:5, 3:9] = 0  # centres 2.5..4.5; the row on the hole's lower edge stays
    assert np.array_equal(got, want)
    two = _burn([_box(0.2, 0.2, 3.3, 3.3)], [_box(6.2, 4.2, 11.4, 7.7)])
    want = np.zeros(SHAPE, dtype=int)
    want[0:3, 0:3] = 1
    want[4:8, 6:11] = 1
    assert np.array_equal(two, want)


def test_polygons_reaching_past_the_grid_are_cut():
    got = _burn([_box(-5.3, -4.2, 3.4, 2.6)])
    want = np.zeros(SHAPE, dtype=int)
    want[0:3, 0:3] = 1
    assert np.array_equal(got, want)
    assert _burn([_box(20, 20, 30, 30)]).sum() == 0


@pytest.mark.parametrize(
    ("rings", "valid"),
    [
        ([[_box(0, 0, 4, 4)]], True),
        ([[_box(0, 0, 4, 4)[::-1]]], True),
        ([[_box(0, 0, 8, 8), _box(2, 2, 4, 4)]], True),
        ([[_box(0, 0, 4, 4)], [_box(6, 6, 9, 9)]], True),
        # Parts that touch at a corner are valid.
        ([[_box(0, 0, 4, 4)], [_box(4, 4, 9, 9)]], True),
        # A bow tie crosses itself.
        ([[_ring([(0, 0), (4, 4), (4, 0), (0, 4)])]], False),
        # A ring that touches itself.
        ([[_ring([(0, 0), (4, 0), (2, 2), (4, 4), (0, 4), (2, 2)])]], False),
        # A spike: the ring folds back on itself.
        ([[_ring([(0, 0), (4, 0), (8, 0), (4, 0), (4, 4)])]], False),
        # No area.
        ([[_ring([(0, 0), (4, 0), (8, 0)])]], False),
        # A hole outside its exterior, crossing it, and one inside another.
        ([[_box(0, 0, 4, 4), _box(6, 6, 8, 8)]], False),
        ([[_box(0, 0, 4, 4), _box(2, 2, 6, 6)]], False),
        ([[_box(0, 0, 9, 9), _box(1, 1, 8, 8), _box(3, 3, 5, 5)]], False),
        # A hole touching the exterior at one point is valid, at two it is not.
        ([[_box(0, 0, 8, 8), _ring([(0, 4), (3, 3), (3, 5)])]], True),
        ([[_box(0, 0, 8, 8), _ring([(0, 4), (4, 0), (5, 5)])]], False),
        # Overlapping parts, and one inside the other.
        ([[_box(0, 0, 4, 4)], [_box(2, 2, 6, 6)]], False),
        ([[_box(0, 0, 9, 9)], [_box(2, 2, 6, 6)]], False),
        # A part inside another's hole is valid.
        ([[_box(0, 0, 9, 9), _box(1, 1, 8, 8)], [_box(3, 3, 5, 5)]], True),
    ],
)
def test_validity(rings, valid):
    assert lp.is_valid(rings) is valid


def test_many_vertices_are_checked_quickly():
    import time

    angle = np.linspace(0, 2 * np.pi, 10_000)[:-1]
    radius = 1 + 0.3 * np.sin(40 * angle)
    ring = np.column_stack([radius * np.cos(angle), radius * np.sin(angle)])
    ring = np.vstack([ring, ring[:1]])
    t0 = time.perf_counter()
    assert lp.is_valid([[ring]])
    assert time.perf_counter() - t0 < 2.0


def test_random_polygons_match_rasterio_and_shapely():
    features = pytest.importorskip("rasterio.features")
    geometry = pytest.importorskip("shapely.geometry")
    from affine import Affine

    rng = np.random.default_rng(7)
    height, width = 30, 40
    transform = Affine(30.0, 0, 436950.0, 0, -30.0, 3758490.0)

    def ring(n: int, snap: bool, radial: bool) -> np.ndarray:
        if radial:
            angle = np.sort(rng.uniform(0, 2 * np.pi, n))
            r = rng.uniform(0.2, 18, n)
            cx, cy = rng.uniform(-4, width + 4), rng.uniform(-4, height + 4)
            px, py = cx + r * np.cos(angle), cy + r * np.sin(angle)
        else:
            px = rng.uniform(-4, width + 4, n)
            py = rng.uniform(-4, height + 4, n)
        if snap:  # vertices on pixel centres and edges: the tie cases
            px, py = np.round(px * 2) / 2, np.round(py * 2) / 2
        xy = np.column_stack(transform * (px, py))
        return np.vstack([xy, xy[:1]])

    compared = rejected = 0
    for k in range(1500):
        snap = bool(k % 2)
        kind = k % 4
        if kind == 0:
            polygons = [[ring(int(rng.integers(3, 12)), snap, True)]]
        elif kind == 1:
            polygons = [[ring(int(rng.integers(3, 6)), snap, False)]]
        elif kind == 2:
            outer = ring(int(rng.integers(4, 10)), snap, True)
            centre = outer[:-1].mean(axis=0)
            polygons = [[outer, centre + (outer - centre) * rng.uniform(0.2, 0.8)]]
        else:
            polygons = [[ring(4, snap, True)], [ring(5, snap, True)]]
        geojson = {
            "type": "MultiPolygon",
            "coordinates": [[r.tolist() for r in p] for p in polygons],
        }
        shape = geometry.shape(geojson)
        valid = not shape.is_empty and shape.is_valid
        assert lp.is_valid(polygons) == valid, geojson
        if not valid:
            rejected += 1
            continue
        want = features.geometry_mask(
            [geojson],
            out_shape=(height, width),
            transform=transform,
            invert=True,
            all_touched=False,
        )
        got = lp.rasterize(
            polygons,
            (height, width),
            (transform.c, transform.f),
            (transform.a, transform.e),
        )
        assert np.array_equal(got, want), geojson
        compared += 1
    assert compared > 500 and rejected > 100


# --- the statistics of a cube ------------------------------------------------------

NT, NY, NX = 7, 20, 24
X0, Y0, DX, EPSG = 500000.0, 4000000.0, 30.0, 32611


def _cube(flip_y: bool = False, flip_x: bool = False, chunks=None) -> xr.DataArray:
    rng = np.random.default_rng(3)
    data = rng.normal(size=(NT, NY, NX)).astype("float32")
    data[:, 4, 5] = np.nan
    data[2, 6:9, 6:9] = np.nan
    x = X0 + DX * (np.arange(NX) + 0.5)
    y = Y0 - DX * (np.arange(NY) + 0.5)
    t = np.datetime64("2026-01-01") + np.arange(NT) * np.timedelta64(12, "D")
    da = xr.DataArray(
        data,
        dims=("time", "y", "x"),
        coords={"time": t.astype("datetime64[ns]"), "y": y, "x": x},
        attrs={"units": "meters"},
        name="displacement",
    )
    if flip_y:
        da = da.isel(y=slice(None, None, -1))
    if flip_x:
        da = da.isel(x=slice(None, None, -1))
    if chunks:
        da.encoding["preferred_chunks"] = chunks
    return da


def _request(points: list[tuple[float, float]], **extra) -> lp.PolygonRequest:
    back = Transformer.from_crs(EPSG, 4326, always_xy=True)
    ring = [list(back.transform(X0 + DX * c, Y0 - DX * r)) for c, r in points]
    geometry = {"type": "Polygon", "coordinates": [ring + ring[:1]]}
    return lp.PolygonRequest(variable="displacement", geometry=geometry, **extra)


LABELS = [f"d{k}" for k in range(NT)]
AREA = [(3.2, 2.3), (15.7, 3.1), (14.4, 12.6), (4.1, 11.2)]


def test_statistics_are_those_of_the_selected_pixels():
    source = _cube()
    request = _request(AREA, support="per_date", percentiles=[25, 90])
    result = lp.summarize_cube(source, CRS.from_epsg(EPSG), request, LABELS)
    # The same pixels, selected here from the projected ring.
    to_native = Transformer.from_crs(4326, EPSG, always_xy=True)
    ring = np.array(request.geometry["coordinates"][0])
    native = np.column_stack(to_native.transform(ring[:, 0], ring[:, 1]))
    inside = lp.rasterize([[native]], (NY, NX), (X0, Y0), (DX, -DX))
    assert result["polygon_pixels"] == int(inside.sum()) > 50
    assert result["grid"] == {
        "crs": "EPSG:32611",
        "transform": [DX, 0.0, X0, 0.0, -DX, Y0],
        "shape": [NY, NX],
    }
    for k, row in enumerate(result["statistics"]):
        values = source.values[k][inside].astype(float)
        values = values[np.isfinite(values)]
        assert row["count"] == values.size == result["valid_per_date"][k]
        assert row["mean"] == float(np.mean(values))
        assert row["median"] == float(np.median(values))
        assert row["spatial_std"] == float(np.std(values))
        assert row["percentiles"] == {
            "25": float(np.percentile(values, 25)),
            "90": float(np.percentile(values, 90)),
        }
    common = np.isfinite(source.values[:, inside]).all(axis=0).sum()
    assert result["common_pixels"] == int(common) < result["polygon_pixels"]


@pytest.mark.parametrize(
    "variant",
    [
        {"flip_y": True},
        {"flip_x": True},
        {"flip_y": True, "flip_x": True},
        {"chunks": {"time": 3}},
        {"chunks": {"time": 100}},
    ],
)
def test_storage_order_and_chunking_do_not_change_the_answer(variant, monkeypatch):
    request = _request(AREA)
    crs = CRS.from_epsg(EPSG)
    want = lp.summarize_cube(_cube(), crs, request, LABELS)
    assert lp.summarize_cube(_cube(**variant), crs, request, LABELS) == want
    # Also when a block of time steps holds a single one.
    monkeypatch.setattr(lp, "_READ_BLOCK", 1)
    assert lp.summarize_cube(_cube(**variant), crs, request, LABELS) == want


def test_only_the_polygons_window_is_read():
    source = _cube(chunks={"time": 3})
    read: list[tuple[int, ...]] = []

    real = xr.DataArray.values.fget

    def values(self):
        out = real(self)
        if self.ndim == 3:
            read.append(out.shape)
        return out

    request = _request([(10.2, 5.2), (13.8, 5.3), (13.7, 8.9), (10.1, 8.7)])
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(xr.DataArray, "values", property(values))
        result = lp.summarize_cube(source, CRS.from_epsg(EPSG), request, LABELS)
    assert result["polygon_pixels"] == 16
    # Blocks of three dates of the 4 x 4 window, each read once per pass.
    assert set(read) == {(3, 4, 4), (1, 4, 4)}
    assert len(read) == 6


@pytest.mark.parametrize(
    ("points", "message"),
    [
        ([(40, 2), (44, 2), (44, 6), (40, 6)], "does not intersect the source grid"),
        ([(5.05, 5.05), (5.3, 5.07), (5.2, 5.3)], "No native pixel centers"),
    ],
)
def test_polygons_without_pixels_are_refused(points, message):
    with pytest.raises(ValueError, match=message):
        lp.summarize_cube(_cube(), CRS.from_epsg(EPSG), _request(points), LABELS)


def test_the_pixel_budget_is_the_full_servers(monkeypatch):
    monkeypatch.setattr(lp, "MAX_PIXEL_EPOCHS", NT * 16 - 1)
    request = _request([(10.2, 5.2), (13.8, 5.3), (13.7, 8.9), (10.1, 8.7)])
    with pytest.raises(ValueError, match="pixel-epoch budget"):
        lp.summarize_cube(_cube(), CRS.from_epsg(EPSG), request, LABELS)


def test_request_is_validated_without_shapely():
    with pytest.raises(ValueError, match="topologically valid"):
        _request([(5, 5), (15, 15), (15, 5), (5, 15)])
    with pytest.raises(ValueError, match="closed with at least four"):
        lp.PolygonRequest(
            variable="v",
            geometry={"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]},
        )
