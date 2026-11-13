"""Pinned, licensed Scientific colour maps shared by full, lite and GPU views."""

import hashlib
import json
from functools import cache
from io import BytesIO
from pathlib import Path

import numpy as np

DIRECTORY = Path(__file__).with_name("palettes") / "crameri"


@cache
def tables() -> dict[str, np.ndarray]:
    """Return 256-entry opaque RGBA tables; reversals use the same bytes."""
    sources = json.loads((DIRECTORY / "SOURCES.json").read_text())
    out = {}
    for original, source in sources["files"].items():
        content = (DIRECTORY / f"{original}.txt").read_bytes()
        if hashlib.sha256(content).hexdigest() != source["sha256"]:
            raise ValueError(f"Scientific colormap checksum mismatch: {original}")
        rgb = np.loadtxt(BytesIO(content))
        if (
            rgb.shape != (256, 3)
            or not np.isfinite(rgb).all()
            or np.any((rgb < 0) | (rgb > 1))
        ):
            raise ValueError(f"Invalid scientific colormap: {original}")
        rgba = np.column_stack(
            (np.rint(rgb * 255).astype("uint8"), np.full(256, 255, "uint8"))
        )
        name = "cmc_" + original.lower()
        out[name] = rgba
        out[name + "_r"] = rgba[::-1].copy()
    return out


def register() -> None:
    """Register before TiTiler freezes allowed names; lite need not import this."""
    import matplotlib as mpl
    from matplotlib.colors import ListedColormap
    from rio_tiler.colormap import cmap

    for name, rgba in tables().items():
        if name in cmap.list():
            existing = np.asarray([cmap.get(name)[i] for i in range(256)])
            if not np.array_equal(existing, rgba):
                raise ValueError(f"Scientific colormap name collision: {name}")
        else:
            cmap.data[name] = {i: tuple(map(int, row)) for i, row in enumerate(rgba)}
        if name in mpl.colormaps:
            existing = np.rint(mpl.colormaps[name](np.arange(256)) * 255).astype(
                "uint8"
            )
            if not np.array_equal(existing, rgba):
                raise ValueError(
                    f"Scientific matplotlib colormap name collision: {name}"
                )
        else:
            mpl.colormaps.register(ListedColormap(rgba / 255, name=name), name=name)
