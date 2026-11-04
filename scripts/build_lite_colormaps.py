"""Build the colormap tables bowser-lite ships (``src/bowser/lite/colormaps.npz``).

bowser-lite colours tiles without rio-tiler or matplotlib, so the 256-entry RGBA
tables are generated once here, from the full environment, and committed. Every
rio-tiler colormap is included (that is what the full server's tiler accepts as
``colormap_name``), plus bowser's reversed ``cfastie_r`` / ``rplumbo_r`` /
``schwarzwald_r`` registered by :func:`bowser.utils.register_custom_colormaps`.

Run with the full env::

    PYTHONPATH=src .pixi/envs/test/bin/python scripts/build_lite_colormaps.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

DEFAULT_OUT = (
    Path(__file__).resolve().parents[1] / "src" / "bowser" / "lite" / "colormaps.npz"
)


def build_tables() -> tuple[list[str], np.ndarray]:
    """Return ``(names, luts)``: sorted lowercase names, ``(n, 256, 4)`` uint8 LUTs."""
    from rio_tiler.colormap import cmap, make_lut  # noqa: PLC0415

    from bowser.utils import register_custom_colormaps  # noqa: PLC0415

    register_custom_colormaps()
    names = sorted(cmap.list())
    luts = np.stack([make_lut(cmap.get(name)) for name in names]).astype(np.uint8)
    return names, luts


def main() -> None:
    """Write the tables to ``--out`` (default: next to the lite package)."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    names, luts = build_tables()
    np.savez_compressed(args.out, names=np.array(names), luts=luts)
    print(
        f"Wrote {len(names)} colormaps to {args.out} "
        f"({args.out.stat().st_size / 1024:.0f} KiB)"
    )


if __name__ == "__main__":
    main()
