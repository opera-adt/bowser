"""Write one band as a GeoTIFF with numpy, zlib and struct: no GDAL.

The file is a baseline TIFF 6.0 (or BigTIFF past 4 GB) that libtiff-based
readers open as GDAL's own: little-endian, Deflate (compression 8) without a
predictor, 512-pixel tiles (one strip when the image fits in a tile), the image
directory first and the pixel data after it. Georeferencing is GeoTIFF 1.0 keys
from an EPSG code, with ``ModelPixelScale`` + ``ModelTiepoint`` for a north-up
grid and ``ModelTransformation`` otherwise. Tags and the band's description,
scale and offset go in ``GDAL_METADATA``, the nodata value in ``GDAL_NODATA``.

There are no overviews: this is a plain GeoTIFF, as the full server's export.
"""

from __future__ import annotations

import struct
import zlib
from typing import Any, Iterator, Mapping, Sequence
from xml.sax.saxutils import escape, quoteattr

import numpy as np
from pyproj import CRS

#: Tile edge in pixels (a multiple of 16, as TIFF requires).
TILE = 512
#: Bytes a classic TIFF can address; larger files are written as BigTIFF.
CLASSIC_LIMIT = 2**32 - 1

# TIFF field types: (code, struct format)
_SHORT, _LONG, _DOUBLE, _LONG8, _ASCII = (
    (3, "H"),
    (4, "I"),
    (12, "d"),
    (16, "Q"),
    (2, "s"),
)
#: numpy kind -> TIFF SampleFormat.
_SAMPLE_FORMAT = {"u": 1, "i": 2, "f": 3, "c": 6}
#: pyproj axis unit name -> GeoTIFF linear unit code.
_LINEAR_UNITS = {"metre": 9001, "meter": 9001, "foot": 9002, "US survey foot": 9003}
#: Characters XML 1.0 cannot carry.
_XML_INVALID: dict[int, None] = dict.fromkeys(
    c for c in range(0x20) if c not in (0x09, 0x0A, 0x0D)
)


def geokeys(crs: CRS) -> tuple[list[int], str]:
    """Return the GeoKey directory and ASCII parameters naming ``crs`` by EPSG code.

    Raises
    ------
    ValueError
        If the CRS is not a projected or geographic CRS with an EPSG code
        (GeoTIFF keys hold a code of at most 65535, not a full definition).

    """
    code = crs.to_epsg()
    if code is None or not 0 < code <= 0xFFFF:
        raise ValueError(
            "GeoTIFF export needs a CRS with an EPSG code; this cube's has none"
        )
    if not (crs.is_projected or crs.is_geographic) or crs.is_compound:
        raise ValueError(
            "GeoTIFF export needs a projected or geographic CRS "
            f"(EPSG:{code} is neither)"
        )
    ascii_params = ""
    keys: list[tuple[int, int, int, int]] = []

    def text(key: int, value: str) -> None:
        nonlocal ascii_params
        value = value.replace("|", " ") + "|"
        keys.append((key, 34737, len(value), len(ascii_params)))
        ascii_params += value

    # GTModelType (1 projected, 2 geographic), GTRasterType (1: pixel is area).
    keys.append((1024, 0, 1, 1 if crs.is_projected else 2))
    keys.append((1025, 0, 1, 1))
    text(1026, crs.name)
    # The keys GDAL writes for a CRS with a code, so it reads back the same
    # definition: the geographic CRS's code only for a geographic CRS, its name
    # and angular unit (degrees), then the projected code and linear unit.
    geodetic = crs.geodetic_crs
    if crs.is_geographic:
        keys.append((2048, 0, 1, code))
    if geodetic is not None:
        text(2049, geodetic.name)
    keys.append((2054, 0, 1, 9102))
    if crs.is_projected:
        keys.append((3072, 0, 1, code))
        units = {axis.unit_name for axis in crs.axis_info[:2]}
        unit_code = _LINEAR_UNITS.get(units.pop()) if len(units) == 1 else None
        if unit_code:
            keys.append((3076, 0, 1, unit_code))
    directory = [1, 1, 0, len(keys)]
    for key in sorted(keys):
        directory.extend(key)
    return directory, ascii_params


def _nodata_text(value: Any) -> str:
    """Return a nodata value as GDAL reads it back (``nan``, ``-9999``, ...)."""
    number = float(value)
    if number != number:
        return "nan"
    if number in (float("inf"), float("-inf")):
        return "inf" if number > 0 else "-inf"
    return str(int(number)) if number == int(number) else format(number, ".17g")


def gdal_metadata(
    tags: Mapping[str, Any],
    description: str | None = None,
    scale: float | None = None,
    offset: float | None = None,
) -> str:
    """Return the ``GDAL_METADATA`` XML: dataset tags, then the band's items.

    Written as GDAL's GeoTIFF driver writes it, so GDAL reads the same values
    back: text is XML-escaped twice, control characters are dropped and leading
    white space is not kept.
    """

    def item(name: str, value: str, band: str = "") -> str:
        text = value.translate(_XML_INVALID).lstrip(" \t\r\n")
        text = escape(escape(text, {'"': "&quot;"}))
        return f"  <Item name={quoteattr(name)}{band}>{text}</Item>\n"

    items = [item(str(key), str(value)) for key, value in tags.items()]
    for name, value in (
        ("OFFSET", None if offset is None else format(float(offset), ".17g")),
        ("SCALE", None if scale is None else format(float(scale), ".17g")),
        ("DESCRIPTION", description),
    ):
        if value is not None:
            items.append(item(name, value, f' sample="0" role="{name.lower()}"'))
    return "<GDALMetadata>\n" + "".join(items) + "</GDALMetadata>\n"


def _blocks(data: np.ndarray, fill: Any) -> Iterator[np.ndarray]:
    """Yield the image's tiles (padded to full size), or the image as one strip."""
    height, width = data.shape
    if height <= TILE and width <= TILE:
        yield data
        return
    for row in range(0, height, TILE):
        for col in range(0, width, TILE):
            tile = data[row : row + TILE, col : col + TILE]
            if tile.shape != (TILE, TILE):
                full = np.full((TILE, TILE), fill, dtype=data.dtype)
                full[: tile.shape[0], : tile.shape[1]] = tile
                tile = full
            yield tile


def _field(
    tag: int, kind: tuple[int, str], values: Sequence[Any] | bytes
) -> tuple[int, int, int, bytes]:
    """Return ``(tag, type code, count, payload)`` of one directory entry."""
    code, fmt = kind
    if fmt == "s":
        payload = bytes(values) + b"\0"
        return tag, code, len(payload), payload
    return tag, code, len(values), struct.pack(f"<{len(values)}{fmt}", *values)


def _directory(fields: list[tuple[int, int, int, bytes]], big: bool) -> bytes:
    """Return header + image directory + the values that do not fit in an entry."""
    header = struct.pack("<2sHHHQ", b"II", 43, 8, 0, 16) if big else b"II*\0\x08\0\0\0"
    count_fmt, entry_fmt, inline = ("<Q", "<HHQ", 8) if big else ("<H", "<HHI", 4)
    size = len(header) + struct.calcsize(count_fmt)
    size += len(fields) * (struct.calcsize(entry_fmt) + inline) + inline
    entries, extra = [], b""
    for tag, code, count, payload in sorted(fields):
        if len(payload) <= inline:
            value = payload.ljust(inline, b"\0")
        else:
            value = struct.pack("<Q" if big else "<I", size + len(extra))
            extra += payload + b"\0" * (len(payload) % 2)
        entries.append(struct.pack(entry_fmt, tag, code, count) + value)
    return (
        header
        + struct.pack(count_fmt, len(fields))
        + b"".join(entries)
        + b"\0" * inline  # no further directory
        + extra
    )


def encode(
    data: np.ndarray,
    *,
    transform: Sequence[float],
    crs: CRS,
    nodata: Any = None,
    tags: Mapping[str, Any] | None = None,
    description: str | None = None,
    scale: float | None = None,
    offset: float | None = None,
    bigtiff: bool | None = None,
    level: int = 6,
) -> list[bytes]:
    """Encode a 2-D array as a GeoTIFF.

    Parameters
    ----------
    data : numpy.ndarray
        ``(height, width)`` of an integer, floating or complex type, first row
        first. Booleans are written as ``uint8``.
    transform : sequence of float
        Affine coefficients ``(a, b, c, d, e, f)``: ``x = a*col + b*row + c``,
        ``y = d*col + e*row + f`` for the outer corner of pixel ``(col, row)``.
    crs : pyproj.CRS
        Must have an EPSG code (:func:`geokeys`).
    nodata : float, optional
        Written to ``GDAL_NODATA``.
    tags : mapping, optional
        Dataset metadata; values are written with ``str``.
    description, scale, offset : optional
        The band's description, scale and offset.
    bigtiff : bool, optional
        Force BigTIFF or classic TIFF. By default BigTIFF only when the file
        would not fit in 4 GB.
    level : int
        zlib compression level.

    Returns
    -------
    list of bytes
        The file in order: the header and directory, then each compressed
        block. Their total length is the file size.

    Raises
    ------
    ValueError
        For an array that is not 2-D, an unsupported type, a CRS without an
        EPSG code, or ``bigtiff=False`` for a file over 4 GB.

    """
    data = np.asarray(data)
    if data.ndim != 2 or 0 in data.shape:
        raise ValueError("A GeoTIFF band needs a non-empty 2-D array")
    if data.dtype == np.bool_:
        data = data.astype(np.uint8)
    if data.dtype.kind not in _SAMPLE_FORMAT:
        raise ValueError(f"Cannot write {data.dtype} to a GeoTIFF")
    data = np.ascontiguousarray(data, dtype=data.dtype.newbyteorder("<"))
    height, width = data.shape
    a, b, c, d, e, f = (float(v) for v in transform)
    keys, ascii_params = geokeys(crs)
    fill = 0 if nodata is None or data.dtype.kind in "ui" else nodata
    blocks = [zlib.compress(t.tobytes(), level) for t in _blocks(data, fill)]
    sizes = [len(block) for block in blocks]
    tiled = len(blocks) > 1 or height > TILE or width > TILE

    def fields(big: bool, start: int) -> list[tuple[int, int, int, bytes]]:
        where = _LONG8 if big else _LONG
        offsets = (start + np.cumsum([0, *sizes[:-1]])).tolist()
        out = [
            _field(256, _LONG, [width]),
            _field(257, _LONG, [height]),
            _field(258, _SHORT, [data.dtype.itemsize * 8]),
            _field(259, _SHORT, [8]),  # Deflate
            _field(262, _SHORT, [1]),  # min is black
            _field(277, _SHORT, [1]),
            _field(284, _SHORT, [1]),
            _field(339, _SHORT, [_SAMPLE_FORMAT[data.dtype.kind]]),
            _field(34735, _SHORT, keys),
            _field(34737, _ASCII, ascii_params.encode("ascii", "replace")),
            _field(
                42112,
                _ASCII,
                gdal_metadata(tags or {}, description, scale, offset).encode(),
            ),
        ]
        if tiled:
            out += [
                _field(322, _LONG, [TILE]),
                _field(323, _LONG, [TILE]),
                _field(324, where, offsets),
                _field(325, where, sizes),
            ]
        else:
            out += [
                _field(273, where, offsets),
                _field(278, _LONG, [height]),
                _field(279, where, sizes),
            ]
        if b == 0 and d == 0 and a > 0 and e < 0:
            out += [
                _field(33550, _DOUBLE, [a, -e, 0.0]),
                _field(33922, _DOUBLE, [0.0, 0.0, 0.0, c, f, 0.0]),
            ]
        else:
            matrix = [
                a,
                b,
                0.0,
                c,
                d,
                e,
                0.0,
                f,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
            ]
            out.append(_field(34264, _DOUBLE, matrix))
        if nodata is not None:
            out.append(_field(42113, _ASCII, _nodata_text(nodata).encode()))
        return out

    # The directory's length does not depend on the offsets it holds, so lay it
    # out once to learn where the pixel data starts.
    total = 0
    for big in (False, True) if bigtiff is None else (bigtiff,):
        head = _directory(fields(big, 0), big)
        head = _directory(fields(big, len(head)), big)
        total = len(head) + sum(sizes)
        if big or total <= CLASSIC_LIMIT:
            return [head, *blocks]
    raise ValueError(
        f"The GeoTIFF would be {total / 2**30:.1f} GB; a classic TIFF holds 4 GB"
    )
