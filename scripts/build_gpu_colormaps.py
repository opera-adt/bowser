"""Write src/map/gpu/colormapLuts.json from bowser-lite's colormap tables.

The GPU renderer colours in the browser with the same 256-entry RGBA tables the
servers colour tiles with (lite's ``colormaps.npz`` is generated from rio-tiler).
Only the picker's colormaps (src/utils/colormaps.ts) and their ``_r`` forms are
written; matplotlib resamples ``_r``, so it is not always the exact reverse.
Run it after adding a colormap to the picker; tests/test_gpu_colormaps.py and
src/map/gpu/params.test.ts check the tables.
"""

import base64
import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    """Write the picker's colormap tables, base64 per name."""
    picker = (ROOT / "src/utils/colormaps.ts").read_text()
    groups = picker.split("COLORMAP_GROUPS")[1].split("COLORMAP_OPTIONS")[0]
    words = {m.lower() for m in re.findall(r"'([A-Za-z_]+)'", groups)}
    from bowser.lite.colormaps import get_lut
    from bowser.lite.colormaps import names as table_names

    tables = {name: get_lut(name) for name in table_names()}
    # The group labels (Diverging, ...) are words too; keep the colormaps.
    names = sorted(n for n in words if n in tables)
    out = {
        k: base64.b64encode(tables[k].astype(np.uint8).tobytes()).decode()
        for n in names
        for k in (n, f"{n}_r")
    }
    path = ROOT / "src/map/gpu/colormapLuts.json"
    path.write_text(json.dumps(out, indent=0) + "\n")
    print(f"{len(out)} tables -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
