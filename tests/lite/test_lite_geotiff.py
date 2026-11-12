"""bowser-lite's GeoTIFF writer (``bowser.lite.geotiff``), read back without GDAL.

The file is parsed here with ``struct`` and ``zlib`` only: header, directory,
georeferencing keys, metadata and pixels, for a strip and a tiled layout, in
classic TIFF and BigTIFF. Reading the same files with rasterio (values, CRS,
transform, nodata, tags, no GDAL warning) runs when rasterio is installed.
"""

from __future__ import annotations

import struct
import zlib

import numpy as np
import pytest
from pyproj import CRS

from bowser.lite import geotiff

TRANSFORM = (30.0, 0.0, 436950.0, 0.0, -30.0, 3758490.0)
TAGS = {"BOWSER_EXPORT_LAYER": "displacement", "units": "meters", "n": 3}
#: struct formats of the TIFF field types the writer uses.
TYPES = {2: "c", 3: "H", 4: "I", 12: "d", 16: "Q"}


def parse(raw: bytes) -> dict:
    """Return ``{tag: values}`` of a little-endian TIFF's first directory.

    ``"big"`` says whether it is a BigTIFF. ASCII values come back as ``str``
    without the terminating NUL.
    """
    assert raw[:2] == b"II"
    magic = struct.unpack_from("<H", raw, 2)[0]
    assert magic in (42, 43)
    big = magic == 43
    if big:
        assert struct.unpack_from("<HH", raw, 4) == (8, 0)
        (offset,) = struct.unpack_from("<Q", raw, 8)
        (count,) = struct.unpack_from("<Q", raw, offset)
        entry, size, inline, pointer = offset + 8, 20, 8, "<Q"
    else:
        (offset,) = struct.unpack_from("<I", raw, 4)
        (count,) = struct.unpack_from("<H", raw, offset)
        entry, size, inline, pointer = offset + 2, 12, 4, "<I"
    fields: dict = {"big": big}
    order = []
    for k in range(count):
        at = entry + k * size
        tag, kind = struct.unpack_from("<HH", raw, at)
        (n,) = struct.unpack_from("<Q" if big else "<I", raw, at + 4)
        fmt = f"<{n}{TYPES[kind]}"
        where = at + size - inline
        if struct.calcsize(fmt) > inline:
            (where,) = struct.unpack_from(pointer, raw, where)
            assert where % 2 == 0, "values start on a word boundary"
        values = struct.unpack_from(fmt, raw, where)
        if kind == 2:
            assert values[-1] == b"\0"
            fields[tag] = b"".join(values[:-1]).decode()
        else:
            fields[tag] = list(values)
        order.append(tag)
    assert order == sorted(order), "directory entries are sorted by tag"
    (following,) = struct.unpack_from(pointer, raw, entry + count * size)
    assert following == 0  # one image, no overviews
    return fields


def pixels(raw: bytes, dtype: str) -> np.ndarray:
    """Decode the image of a TIFF written by the writer."""
    f = parse(raw)
    width, height = f[256][0], f[257][0]
    assert f[259] == [8]  # Deflate
    if 324 in f:
        tile_w, tile_h = f[322][0], f[323][0]
        assert tile_w % 16 == 0 and tile_h % 16 == 0
        across, down = -(-width // tile_w), -(-height // tile_h)
        assert len(f[324]) == len(f[325]) == across * down
        full = np.empty((down * tile_h, across * tile_w), dtype=dtype)
        for k, (offset, size) in enumerate(zip(f[324], f[325])):
            tile = np.frombuffer(zlib.decompress(raw[offset : offset + size]), dtype)
            row, col = divmod(k, across)
            full[
                row * tile_h : (row + 1) * tile_h, col * tile_w : (col + 1) * tile_w
            ] = tile.reshape(tile_h, tile_w)
        return full[:height, :width]
    assert f[278] == [height] and len(f[273]) == 1
    data = zlib.decompress(raw[f[273][0] : f[273][0] + f[279][0]])
    return np.frombuffer(data, dtype).reshape(height, width)


def _field(seed: int, shape: tuple[int, int], dtype: str = "float32") -> np.ndarray:
    rng = np.random.default_rng(seed)
    data = (rng.normal(size=shape) * 50).astype(dtype)
    if data.dtype.kind == "f":
        data[:2, :3] = np.nan
    return data


def _encode(data: np.ndarray, **kwargs) -> bytes:
    kwargs = {
        "transform": TRANSFORM,
        "crs": CRS.from_epsg(32611),
        "nodata": np.nan if data.dtype.kind == "f" else None,
        **kwargs,
    }
    parts = geotiff.encode(data, **kwargs)
    assert all(isinstance(part, bytes) for part in parts)
    return b"".join(parts)


@pytest.mark.parametrize("bigtiff", [False, True])
@pytest.mark.parametrize("shape", [(48, 60), (600, 700), (512, 513), (1, 1)])
def test_pixels_round_trip_in_strips_and_tiles(shape, bigtiff):
    data = _field(1, shape)
    raw = _encode(data, bigtiff=bigtiff, tags=TAGS)
    f = parse(raw)
    assert f["big"] is bigtiff
    assert (f[256], f[257]) == ([shape[1]], [shape[0]])
    assert f[258] == [32] and f[339] == [3] and f[277] == [1]
    tiled = max(shape) > geotiff.TILE
    assert (324 in f) is tiled and (273 in f) is not tiled
    assert np.array_equal(pixels(raw, "<f4"), data, equal_nan=True)
    # The pixel data follows the directory, block after block, to the end.
    offsets, sizes = (f[324], f[325]) if tiled else (f[273], f[279])
    assert offsets[-1] + sizes[-1] == len(raw)
    assert all(a + n == b for a, n, b in zip(offsets, sizes, offsets[1:]))


@pytest.mark.parametrize(
    ("dtype", "sample_format"),
    [
        ("uint8", 1),
        ("uint16", 1),
        ("int16", 2),
        ("int32", 2),
        ("uint64", 1),
        ("float64", 3),
        ("complex64", 6),
    ],
)
def test_sample_types(dtype, sample_format):
    data = _field(2, (20, 30), dtype)
    raw = _encode(data)
    f = parse(raw)
    assert f[339] == [sample_format] and f[258] == [data.dtype.itemsize * 8]
    little = data.dtype.newbyteorder("<")
    assert np.array_equal(pixels(raw, little.str), data, equal_nan=True)


def test_booleans_are_bytes_and_big_endian_input_is_swapped():
    mask = np.arange(12).reshape(3, 4) % 3 == 0
    assert np.array_equal(pixels(_encode(mask), "u1"), mask.astype("u1"))
    data = _field(3, (5, 6)).astype(">f4")
    assert np.array_equal(pixels(_encode(data), "<f4"), data, equal_nan=True)


def test_georeferencing_of_a_north_up_utm_grid():
    f = parse(_encode(_field(4, (10, 12))))
    assert f[33550] == [30.0, 30.0, 0.0]  # pixel scale
    assert f[33922] == [0.0, 0.0, 0.0, 436950.0, 3758490.0, 0.0]  # tiepoint
    assert 34264 not in f
    keys = f[34735]
    assert keys[:4] == [1, 1, 0, (len(keys) - 4) // 4]
    entries = {keys[k]: tuple(keys[k + 1 : k + 4]) for k in range(4, len(keys), 4)}
    assert list(entries) == sorted(entries)
    assert entries[1024] == (0, 1, 1)  # projected
    assert entries[1025] == (0, 1, 1)  # pixel is area
    assert entries[3072] == (0, 1, 32611)
    assert entries[2054] == (0, 1, 9102)  # degrees
    assert entries[3076] == (0, 1, 9001)  # metres
    assert 2048 not in entries  # the projected code names its geographic CRS
    assert f[34737] == "WGS 84 / UTM zone 11N|WGS 84|"
    assert entries[1026] == (34737, 22, 0) and entries[2049] == (34737, 7, 22)


def test_georeferencing_of_other_grids():
    lonlat = (0.001, 0.0, -117.5, 0.0, -0.001, 34.5)
    f = parse(_encode(_field(5, (4, 4)), transform=lonlat, crs=CRS.from_epsg(4326)))
    keys = f[34735]
    entries = {keys[k]: keys[k + 3] for k in range(4, len(keys), 4)}
    assert entries[1024] == 2 and entries[2048] == 4326 and 3072 not in entries
    assert f[33550] == [0.001, 0.001, 0.0]
    # South-up (y increasing): a matrix instead of scale and tiepoint.
    south_up = (30.0, 0.0, 436950.0, 0.0, 30.0, 3758490.0)
    f = parse(_encode(_field(5, (4, 4)), transform=south_up))
    assert 33550 not in f and 33922 not in f
    assert f[34264] == [30.0, 0.0, 0.0, 436950.0, 0.0, 30.0, 0.0, 3758490.0] + [
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
    ]
    # US survey feet have their own unit code.
    f = parse(_encode(_field(5, (4, 4)), crs=CRS.from_epsg(2227)))
    keys = f[34735]
    assert keys[keys.index(3076) + 3] == 9003


@pytest.mark.parametrize("code", [5498, 4978])
def test_a_crs_geotiff_keys_cannot_name_is_refused(code):
    with pytest.raises(ValueError, match="projected or geographic"):
        geotiff.geokeys(CRS.from_epsg(code))


def test_a_crs_without_an_epsg_code_is_refused():
    crs = CRS.from_proj4("+proj=tmerc +lat_0=12.3 +lon_0=45.6 +ellps=WGS84")
    with pytest.raises(ValueError, match="EPSG code"):
        _encode(_field(6, (4, 4)), crs=crs)


def test_metadata_and_nodata_are_written_as_gdal_reads_them():
    tags = {"plain": "a b", "markup": 'x<&>"y', "ctrl": "a\x01b", "n": 3.5}
    raw = _encode(_field(7, (4, 4)), tags=tags, description="LOS", scale=0.5, offset=2)
    f = parse(raw)
    assert f[42113] == "nan"
    assert f[42112] == (
        "<GDALMetadata>\n"
        '  <Item name="plain">a b</Item>\n'
        '  <Item name="markup">x&amp;lt;&amp;amp;&amp;gt;&amp;quot;y</Item>\n'
        '  <Item name="ctrl">ab</Item>\n'
        '  <Item name="n">3.5</Item>\n'
        '  <Item name="OFFSET" sample="0" role="offset">2</Item>\n'
        '  <Item name="SCALE" sample="0" role="scale">0.5</Item>\n'
        '  <Item name="DESCRIPTION" sample="0" role="description">LOS</Item>\n'
        "</GDALMetadata>\n"
    )
    assert 42113 not in parse(_encode(_field(7, (4, 4)), nodata=None))
    for value, text in ((-9999.0, "-9999"), (0.5, "0.5"), (np.float32(3), "3")):
        assert parse(_encode(_field(7, (4, 4)), nodata=value))[42113] == text


def test_bigtiff_is_chosen_only_past_four_gigabytes(monkeypatch):
    data = _field(8, (40, 40))
    assert parse(_encode(data))["big"] is False
    monkeypatch.setattr(geotiff, "CLASSIC_LIMIT", 2000)
    raw = _encode(data)
    assert parse(raw)["big"] is True
    assert np.array_equal(pixels(raw, "<f4"), data, equal_nan=True)
    with pytest.raises(ValueError, match="classic TIFF holds 4 GB"):
        _encode(data, bigtiff=False)


@pytest.mark.parametrize(
    "bad", [np.zeros((2, 3, 4)), np.zeros((0, 4)), np.array([["a"]])]
)
def test_arrays_a_band_cannot_hold_are_refused(bad):
    with pytest.raises(ValueError):
        _encode(bad, nodata=None)


def _gdal_wkt(rasterio, epsg: int, tmp_path) -> str:
    """WKT GDAL reads back from a GeoTIFF it wrote itself for ``EPSG:epsg``."""
    path = tmp_path / "gdal.tif"
    profile = {"driver": "GTiff", "width": 2, "height": 2, "count": 1}
    with rasterio.open(
        path,
        "w",
        dtype="uint8",
        crs=f"EPSG:{epsg}",
        transform=rasterio.Affine(*TRANSFORM),
        **profile,
    ) as dst:
        dst.write(np.zeros((1, 2, 2), "uint8"))
    with rasterio.open(path) as src:
        return src.crs.to_wkt()


@pytest.mark.parametrize(
    ("shape", "dtype", "bigtiff", "epsg", "transform"),
    [
        ((48, 60), "float32", False, 32611, TRANSFORM),
        ((48, 60), "float32", True, 32611, TRANSFORM),
        ((700, 1100), "float32", False, 32611, TRANSFORM),
        ((700, 1100), "float64", True, 26911, TRANSFORM),
        ((70, 513), "uint16", False, 3857, TRANSFORM),
        ((30, 40), "int32", False, 4326, (0.001, 0.0, -117.5, 0.0, -0.001, 34.5)),
        (
            (30, 40),
            "float32",
            False,
            32611,
            (30.0, 0.0, 436950.0, 0.0, 30.0, 3758490.0),
        ),
        ((30, 40), "float32", False, 2227, TRANSFORM),
    ],
)
def test_gdal_reads_the_same_raster(shape, dtype, bigtiff, epsg, transform, tmp_path):
    rasterio = pytest.importorskip("rasterio")
    import io
    import logging
    import warnings

    data = _field(9, shape, dtype)
    nodata = np.nan if data.dtype.kind == "f" else 0
    tags = {"A": 'x<&>"y', "B": 3, "text": "µm é", "lines": "one\ntwo"}
    raw = _encode(
        data,
        transform=transform,
        crs=CRS.from_epsg(epsg),
        nodata=nodata,
        tags=tags,
        description="A band",
        bigtiff=bigtiff,
    )
    records: list[logging.LogRecord] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Collect(level=logging.WARNING)
    logging.getLogger("rasterio").addHandler(handler)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with rasterio.open(io.BytesIO(raw)) as src:
                got = src.read(1)
                assert src.count == 1 and src.driver == "GTiff"
                assert got.dtype == data.dtype
                assert np.array_equal(got, data, equal_nan=True)
                assert tuple(src.transform)[:6] == transform
                assert src.crs == rasterio.crs.CRS.from_epsg(epsg)
                assert src.crs.to_epsg() == epsg
                assert src.crs.to_wkt() == _gdal_wkt(rasterio, epsg, tmp_path)
                assert src.nodata == nodata or (np.isnan(src.nodata) and nodata != 0)
                assert src.tags() == {
                    **{k: str(v) for k, v in tags.items()},
                    "AREA_OR_POINT": "Area",
                }
                assert src.descriptions == ("A band",)
                assert src.profile["compress"] == "deflate"
                assert src.overviews(1) == []
                if max(shape) > geotiff.TILE:
                    assert src.block_shapes == [(512, 512)]
    finally:
        logging.getLogger("rasterio").removeHandler(handler)
    assert not records, [r.getMessage() for r in records]
