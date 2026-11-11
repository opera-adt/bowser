"""The GPU renderer's colormap tables are the ones the servers colour tiles with.

``src/map/gpu/colormapLuts.json`` (written by scripts/build_gpu_colormaps.py) holds
256 RGBA entries per colormap; they must equal bowser-lite's ``colormaps.npz`` and
the full server's rio-tiler colormaps, or the GPU and tile renderers would show the
same value in different colours.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
LUTS = json.loads((ROOT / "src/map/gpu/colormapLuts.json").read_text())


def _table(name: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(LUTS[name]), dtype=np.uint8).reshape(256, 4)


def test_tables_equal_lites():
    with np.load(ROOT / "src/bowser/lite/colormaps.npz") as f:
        lite = {str(n): lut for n, lut in zip(f["names"], f["luts"])}
    assert len(LUTS) >= 60
    for name in LUTS:
        np.testing.assert_array_equal(_table(name), lite[name], err_msg=name)


def test_tables_equal_the_full_servers():
    cmap = pytest.importorskip("rio_tiler.colormap").cmap
    for name in LUTS:
        # The full server adds these _r forms itself (register_custom_colormaps).
        own = name.endswith("_r") and name[:-2] in ("cfastie", "rplumbo", "schwarzwald")
        table = cmap.get(name[:-2] if own else name)
        full = np.array([table[i] for i in range(256)], dtype=np.uint8)
        np.testing.assert_array_equal(_table(name), full[::-1] if own else full, name)
