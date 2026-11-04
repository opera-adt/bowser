"""Unit tests for bowser-lite's pieces: PNG, colormaps, geometry, warp, tile rendering.

Where the full environment has the library lite replaces (rasterio, rio-tiler,
morecantile, rioxarray), the lite function is checked against it directly.
"""

from __future__ import annotations

import io
import json
import math
import zlib

import numpy as np
import pytest
import xarray as xr
from fastapi import HTTPException
from pyproj import CRS

from bowser.lite import colormaps, geo, png, tiles, warp

# --- png ---------------------------------------------------------------------------


def test_png_round_trips_through_pillow():
    pil = pytest.importorskip("PIL.Image")
    rgba = np.random.default_rng(0).integers(0, 256, (7, 5, 4), dtype=np.uint8)
    data = png.encode_rgba(rgba)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert np.array_equal(np.asarray(pil.open(io.BytesIO(data)).convert("RGBA")), rgba)


def test_png_chunks_are_well_formed():
    data = png.encode_rgba(np.zeros((2, 3, 4), np.uint8))
    pos, kinds = 8, []
    while pos < len(data):
        n = int.from_bytes(data[pos : pos + 4], "big")
        kind, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + n]
        assert int.from_bytes(data[pos + 8 + n : pos + 12 + n], "big") == zlib.crc32(
            kind + body
        )
        kinds.append(kind)
        pos += 12 + n
    assert kinds == [b"IHDR", b"IDAT", b"IEND"]
    # every scanline starts with filter type 0
    raw = zlib.decompress(data[8 + 25 + 8 : -12])
    assert raw[0] == 0 and raw[1 + 3 * 4] == 0


def test_png_rejects_non_rgba():
    with pytest.raises(ValueError, match="h, w, 4"):
        png.encode_rgba(np.zeros((4, 4, 3), np.uint8))


# --- colormaps -----------------------------------------------------------------------

UI_COLORMAPS = [
    "rdbu",
    "brbg",
    "rdylbu",
    "puor",
    "piyg",
    "spectral",
    "coolwarm",
    "viridis",
    "plasma",
    "inferno",
    "magma",
    "cividis",
    "gray",
    "blues",
    "greens",
    "reds",
    "oranges",
    "purples",
    "ylorrd",
    "ylgnbu",
    "ylgn",
    "pubu",
    "rdpu",
    "bugn",
    "twilight",
    "hsv",
    "turbo",
    "jet",
    "gist_earth",
    "ocean",
    "terrain",
    "cfastie",
    "rplumbo",
    "schwarzwald",
]  # fmt: skip — src/utils/colormaps.ts


def test_every_ui_colormap_and_its_reverse_has_a_table():
    known = set(colormaps.names())
    missing = [
        n for base in UI_COLORMAPS for n in (base, f"{base}_r") if n not in known
    ]
    assert not missing
    lut = colormaps.get_lut("RdBu_r")  # case-insensitive
    assert lut.shape == (256, 4) and lut.dtype == np.uint8
    assert np.array_equal(
        colormaps.get_lut("cfastie_r"), colormaps.get_lut("cfastie")[::-1]
    )


def test_tables_match_rio_tiler():
    pytest.importorskip("rio_tiler")
    from rio_tiler.colormap import cmap, make_lut

    for name in ("viridis", "rdbu_r", "twilight", "gist_earth"):
        assert np.array_equal(colormaps.get_lut(name), make_lut(cmap.get(name)))


def test_unknown_colormap_raises_keyerror():
    with pytest.raises(KeyError, match="nope"):
        colormaps.get_lut("nope")


def test_colorbar_is_the_gradient():
    img = colormaps.colorbar_rgba("viridis", width=256, height=4)
    assert img.shape == (4, 256, 4)
    assert np.array_equal(img[0, :, :3], colormaps.get_lut("viridis")[:, :3])
    assert (img[..., 3] == 255).all()


# --- geometry ------------------------------------------------------------------------


def test_resolve_crs_sources():
    assert geo.resolve_crs({"proj:code": "EPSG:32611"}, None).to_epsg() == 32611
    wkt = CRS.from_epsg(32615).to_wkt()
    assert geo.resolve_crs({"proj:wkt2": wkt}, None).to_epsg() == 32615
    assert geo.resolve_crs({}, {"crs_wkt": wkt}).to_epsg() == 32615
    assert geo.resolve_crs({}, {"spatial_ref": wkt}).to_epsg() == 32615
    with pytest.raises(ValueError, match="No CRS"):
        geo.resolve_crs({}, {})


def test_grid_bounds_follow_rioxarray():
    rioxarray = pytest.importorskip("rioxarray")  # noqa: F841
    x = 761345.0 + 10.0 * np.arange(30)
    y = 3852695.0 - 10.0 * np.arange(20)
    da = xr.DataArray(
        np.zeros((20, 30)), dims=("y", "x"), coords={"y": y, "x": x}
    ).rio.write_crs("EPSG:32615")
    assert geo.grid_bounds(x, y) == pytest.approx(da.rio.bounds())
    # A cached GeoTransform wins over the coordinate spacing (rio.bounds(recalc=False)).
    gt = {"GeoTransform": "761340.0 20.0 0.0 3852700.0 0.0 -20.0"}
    da = da.rio.write_transform(
        da.rio.transform().__class__(20.0, 0, 761340.0, 0, -20.0, 3852700.0)
    )
    assert geo.grid_bounds(x, y, gt) == pytest.approx(da.rio.bounds())


@pytest.mark.parametrize(
    "epsg,w,h,left,top,res",
    [
        (32611, 48, 48, 436950.0, 3758490.0, 30.0),
        (32615, 564, 605, 761340.0, 3852700.0, 10.0),
        (32633, 2730, 1733, 489167.0, 2164778.0, 90.0),
        (32756, 900, 1200, 300000.0, 7000000.0, 30.0),
    ],
)
def test_suggested_warp_output_matches_gdal(epsg, w, h, left, top, res):
    rw = pytest.importorskip("rasterio.warp")
    from rasterio.crs import CRS as RCRS

    bounds = (left, top - h * res, left + w * res, top)
    for dst in (4326, 3857):
        a, W, H = rw.calculate_default_transform(
            RCRS.from_epsg(epsg), RCRS.from_epsg(dst), w, h, *bounds
        )
        (pa, _, pc, _, pe, pf), pw, ph = geo.suggested_warp_output(
            CRS.from_epsg(epsg), CRS.from_epsg(dst), w, h, bounds
        )
        assert (pw, ph) == (W, H)
        assert (pa, pc, pe, pf) == pytest.approx(
            (a.a, a.c, a.e, a.f), rel=1e-9, abs=abs(a.a) * 1e-6
        )


def test_transform_bounds_matches_rasterio():
    rw = pytest.importorskip("rasterio.warp")
    b = (436950.0, 3757050.0, 438390.0, 3758490.0)
    want = rw.transform_bounds("EPSG:32611", "EPSG:4326", *b)
    assert geo.transform_bounds(CRS.from_epsg(32611), geo.WGS84, b) == pytest.approx(
        want, rel=1e-12
    )


def test_tiles_and_zooms_match_morecantile():
    morecantile = pytest.importorskip("morecantile")
    tms = morecantile.tms.get("WebMercatorQuad")
    for x, y, z in ((0, 0, 0), (2840, 6528, 14), (1022, 1625, 12)):
        assert geo.tile_bounds(x, y, z) == pytest.approx(
            tuple(tms.xy_bounds(morecantile.Tile(x, y, z))), abs=1e-6
        )
    for res in (0.5, 9.9, 30.0, 33.5, 150.0, 5000.0, 156543.0339):
        assert geo.zoom_for_res(res) == tms.zoom_for_res(res)


def test_dataset_zoom_range_matches_rio_tiler():
    pytest.importorskip("rio_tiler")
    pytest.importorskip("rioxarray")
    from rio_tiler.io.xarray import XarrayReader

    x = 761345.0 + 10.0 * np.arange(564)
    y = 3852695.0 - 10.0 * np.arange(605)
    da = xr.DataArray(
        np.zeros((605, 564), "float32"), dims=("y", "x"), coords={"y": y, "x": x}
    )
    da = da.rio.write_crs("EPSG:32615")
    with XarrayReader(da) as r:
        want = (r.minzoom, r.maxzoom)
    assert (
        geo.dataset_zoom_range(CRS.from_epsg(32615), 564, 605, geo.grid_bounds(x, y))
        == want
    )


def test_tile_intersects():
    crs, b = CRS.from_epsg(32611), (436950.0, 3757050.0, 438390.0, 3758490.0)
    assert geo.tile_intersects(2836, 6546, 14, crs, b)
    assert not geo.tile_intersects(2840, 6528, 14, crs, b)


# --- warp ----------------------------------------------------------------------------


def test_approx_rows_is_exact_for_affine_maps():
    def affine(px, py):
        return 3.0 + 0.5 * px - 0.1 * py, 7.0 + 0.2 * px + 0.9 * py

    sx, sy = warp.approx_rows(affine, 256, 4)
    gx, gy = np.meshgrid(np.arange(256) + 0.5, np.arange(4) + 0.5)
    ex, ey = affine(gx, gy)
    assert np.allclose(sx, ex) and np.allclose(sy, ey)


def test_approx_rows_stays_within_the_tolerance():
    def bent(px, py):
        return px + 2e-4 * (px - 128) ** 2, py + 1e-4 * px**2

    sx, sy = warp.approx_rows(bent, 256, 3, max_error=0.125)
    gx, gy = np.meshgrid(np.arange(256) + 0.5, np.arange(3) + 0.5)
    ex, ey = bent(gx, gy)
    assert np.abs(sx - ex).max() + np.abs(sy - ey).max() <= 0.25
    assert not np.allclose(sx, ex)  # it did interpolate


def test_approx_rows_handles_failed_transforms():
    def half_nan(px, py):
        return np.where(px > 100, np.nan, px), py

    sx, _ = warp.approx_rows(half_nan, 256, 2)
    assert np.isnan(sx[:, 200]).all() and np.allclose(sx[:, :100], np.arange(100) + 0.5)


# --- tiles: algorithms and rendering -----------------------------------------------


def _masked(seed=0, shape=(1, 8, 8), complex_=False):
    rng = np.random.default_rng(seed)
    data = rng.normal(0, 0.01, shape).astype("float32")
    if complex_:
        data = (data + 1j * rng.normal(0, 0.01, shape)).astype("complex64")
    mask = rng.random(shape) < 0.2
    return np.ma.MaskedArray(data, mask=mask)


@pytest.mark.parametrize(
    "name,params",
    [
        ("shift", {"shift": 0.001}),
        ("shift", {"shift": 0}),
        ("shift", {}),
        (
            "rewrap",
            {
                "shift": 0.001,
                "scale_factor": 4 * math.pi / 0.0555,
                "wrap_range": 2 * math.pi,
            },
        ),
        ("rewrap", {"wrap_range": 0.02}),
    ],
)
def test_algorithms_match_bowser_titiler(name, params):
    pytest.importorskip("titiler.core")
    from rio_tiler.models import ImageData

    from bowser import titiler as full

    cls = {"shift": full.Shift, "rewrap": full.Rewrap}[name]
    arr = _masked()
    want = cls(**params)(ImageData(arr.copy())).array
    got = tiles.ALGORITHMS[name](arr.copy(), **params)
    assert got.dtype == want.dtype
    assert np.array_equal(np.ma.getmaskarray(got), np.ma.getmaskarray(want))
    assert np.allclose(got.filled(0), want.filled(0))


@pytest.mark.parametrize("name", ["phase", "amplitude", "rewrap"])
def test_complex_algorithms_match_bowser_titiler(name):
    pytest.importorskip("titiler.core")
    from rio_tiler.models import ImageData

    from bowser import titiler as full

    cls = {"phase": full.Phase, "amplitude": full.Amplitude, "rewrap": full.Rewrap}[
        name
    ]
    arr = _masked(complex_=True)
    want = cls()(ImageData(arr.copy())).array
    got = tiles.ALGORITHMS[name](arr.copy())
    assert np.array_equal(np.ma.getmaskarray(got), np.ma.getmaskarray(want))
    assert np.allclose(got.filled(0), want.filled(0))


def test_rescale_matches_rio_tiler():
    pytest.importorskip("rio_tiler")
    from rio_tiler.models import ImageData

    arr = _masked()
    want = ImageData(arr.copy()).rescale([(-0.01, 0.01)]).array
    got = tiles.rescale(arr.copy(), [(-0.01, 0.01)])
    assert got.dtype == np.uint8
    assert np.array_equal(got.data, want.data) and np.array_equal(got.mask, want.mask)


def test_render_png_colours_and_masks():
    pil = pytest.importorskip("PIL.Image")
    arr = np.ma.MaskedArray(
        np.array([[[-1.0, 0.0], [1.0, 5.0]]]), mask=[[[False, False], [False, True]]]
    )
    q = tiles.TileQuery(variable="v", rescale=[(-1.0, 1.0)], colormap_name="viridis")
    img = np.asarray(pil.open(io.BytesIO(tiles.render_png(arr, q))).convert("RGBA"))
    lut = colormaps.get_lut("viridis")
    assert np.array_equal(img[0, 0, :3], lut[0, :3]) and np.array_equal(
        img[1, 0, :3], lut[255, :3]
    )
    assert np.array_equal(img[0, 1, :3], lut[127, :3])
    assert img[1, 1, 3] == 0 and (img[0, :, 3] == 255).all()
    gray = np.asarray(
        pil.open(
            io.BytesIO(
                tiles.render_png(arr, tiles.TileQuery("v", rescale=[(-1.0, 1.0)]))
            )
        ).convert("RGBA")
    )
    assert tuple(gray[1, 0]) == (255, 255, 255, 255)


def test_parse_algorithm_and_rescale():
    assert tiles.parse_algorithm(None, None) == (None, {})
    assert tiles.parse_algorithm("shift", json.dumps({"shift": 1, "junk": 2})) == (
        "shift",
        {"shift": 1.0},
    )
    with pytest.raises(HTTPException) as e:
        tiles.parse_algorithm("hillshade", None)
    assert e.value.status_code == 422
    with pytest.raises(HTTPException):
        tiles.parse_algorithm("shift", "{not json")
    assert tiles.parse_rescale(["-0.01,0.01", "[0, 1]"]) == [(-0.01, 0.01), (0.0, 1.0)]
    with pytest.raises(HTTPException):
        tiles.parse_rescale(["1,2,3"])


def test_clip_window_matches_rioxarray_clip_box():
    pytest.importorskip("rioxarray")
    x = 761345.0 + 10.0 * np.arange(564)
    y = 3852695.0 - 10.0 * np.arange(605)
    da = xr.DataArray(
        np.zeros((605, 564), "float32"), dims=("y", "x"), coords={"y": y, "x": x}
    ).rio.write_crs("EPSG:32615")
    grid = (761340.0, 3852700.0, 10.0, -10.0)
    crs = CRS.from_epsg(32615)
    for tile in (
        (1022, 1625, 12),
        (2044, 3251, 13),
        (8178, 13008, 15),
        (16360, 26010, 16),
    ):
        tb = geo.tile_bounds(*tile)
        try:
            clipped = da.rio.clip_box(*tb, crs="EPSG:3857")
        except Exception:  # noqa: BLE001 — rioxarray gives up on one-pixel windows
            continue
        c0, c1, r0, r1 = warp.clip_window(
            geo.transform_bounds(geo.WEB_MERCATOR, crs, tb), grid, (605, 564)
        )
        assert (clipped.x.values[0], clipped.x.values[-1]) == (x[c0], x[c1 - 1]), tile
        assert (clipped.y.values[0], clipped.y.values[-1]) == (y[r0], y[r1 - 1]), tile


def test_chunks_split_sparse_and_big_blocks():
    def shifted(px, py):  # the output maps onto source pixels offset by (dx, dy)
        return px + shifted.dx, py + shifted.dy

    shifted.dx = shifted.dy = 0.0
    (one,) = warp.chunks(shifted, 256, 256, (256, 256), 33, 33)
    assert (one.width, one.height, one.src_x1, one.src_y1) == (256, 256, 256, 256)
    # Three quarters of the tile is off the source: GDAL halves it until blocks
    # are mostly inside.
    shifted.dx = shifted.dy = -192.0
    parts = warp.chunks(shifted, 256, 256, (256, 256), 33, 33)
    assert len(parts) > 1 and sum(c.width * c.height for c in parts) == 256 * 256
    assert all(c.width <= 128 or c.height <= 128 for c in parts)
    # A source too large for the warp memory limit is split too.
    shifted.dx = shifted.dy = 0.0
    big = warp.chunks(
        lambda px, py: (px * 60, py * 60), 256, 256, (15360, 15360), 65, 65
    )
    assert len(big) > 1


def test_approx_rows_with_offsets_matches_the_whole_block():
    def affine(px, py):
        return 2.0 * px + 1.0, 0.5 * py - 3.0

    sx, sy = warp.approx_rows(affine, 64, 32, x_off=64, y_off=128)
    assert np.allclose(sx[0], 2.0 * (64 + np.arange(64) + 0.5) + 1.0)
    assert np.allclose(sy[:, 0], 0.5 * (128 + np.arange(32) + 0.5) - 3.0)
