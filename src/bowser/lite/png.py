"""A minimal PNG encoder (RGBA, 8 bit, no interlace) on top of :mod:`zlib`."""

from __future__ import annotations

import struct
import zlib

import numpy as np

_SIGNATURE = b"\x89PNG\r\n\x1a\n"
#: PNG colour type 6: truecolour with alpha.
_COLOR_RGBA = 6


def _chunk(kind: bytes, data: bytes) -> bytes:
    """One PNG chunk: length, type, data, CRC of type + data."""
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)


def encode_rgba(rgba: np.ndarray, level: int = 6) -> bytes:
    """Encode an ``(height, width, 4)`` uint8 array as PNG bytes.

    Every scanline uses filter type 0 (none); zlib does the rest.
    """
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError(f"expected an (h, w, 4) array, got shape {rgba.shape}")
    height, width = rgba.shape[:2]
    pixels = np.ascontiguousarray(rgba, dtype=np.uint8).reshape(height, width * 4)
    rows = np.zeros((height, width * 4 + 1), dtype=np.uint8)  # leading 0 = filter none
    rows[:, 1:] = pixels
    header = struct.pack(">IIBBBBB", width, height, 8, _COLOR_RGBA, 0, 0, 0)
    return b"".join(
        (
            _SIGNATURE,
            _chunk(b"IHDR", header),
            _chunk(b"IDAT", zlib.compress(rows.tobytes(), level)),
            _chunk(b"IEND", b""),
        )
    )
