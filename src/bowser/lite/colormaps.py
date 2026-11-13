"""Colormap lookup tables for bowser-lite, read from the bundled ``colormaps.npz``.

The tables are generated once by ``scripts/build_lite_colormaps.py`` from rio-tiler
(the same tables the full server colours tiles with), so lite never imports
rio-tiler or matplotlib.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

import numpy as np

TABLE_FILE = Path(__file__).with_name("colormaps.npz")


@cache
def _tables() -> dict[str, np.ndarray]:
    with np.load(TABLE_FILE, allow_pickle=False) as f:
        loaded = {str(name): lut for name, lut in zip(f["names"], f["luts"])}
    from ..scientific_colormaps import tables

    loaded.update(tables())
    return loaded


def names() -> list[str]:
    """Every colormap name lite knows (lowercase, sorted)."""
    return sorted(_tables())


def get_lut(name: str) -> np.ndarray:
    """Return the ``(256, 4)`` uint8 RGBA table for ``name`` (case-insensitive).

    Raises
    ------
    KeyError
        If no table has that name.

    """
    try:
        return _tables()[name.lower()]
    except KeyError:
        raise KeyError(f"unknown colormap {name!r}") from None


def colorbar_rgba(name: str, width: int = 512, height: int = 32) -> np.ndarray:
    """Return a horizontal gradient of ``name`` as ``(height, width, 4)`` RGBA."""
    lut = get_lut(name)
    idx = np.round(np.linspace(0, 255, width)).astype(np.intp)
    row = lut[idx].copy()
    row[:, 3] = 255
    return np.broadcast_to(row, (height, width, 4)).copy()
