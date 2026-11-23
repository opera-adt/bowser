"""Make the small demo cube from a multiscale OPERA DISP-S1 GeoZarr cube.

Takes one resolution level of the source (a coarser one keeps the file small), every
``--step``-th date and the main layers, and writes an ordinary single-level GeoZarr
cube that Bowser opens like any other:

    python demo/make_demo_cube.py SOURCE.zarr hawaii_demo.zarr --level 3 --step 6

The Hawaii demo uses OPERA L3 DISP-S1 frame 23211 (descending), 2016-2026, at level 3
(240 m) with every sixth date.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import xarray as xr
import zarr

#: Layers kept: displacement over time, its quality mask, and the 2-D summaries.
LAYERS = (
    "displacement",
    "short_wavelength_displacement",
    "recommended_mask",
    "velocity",
    "velocity_stderr",
    "average_temporal_coherence",
    "water_mask",
    "valid_epochs",
)


def make(source: str, output: Path, level: str, step: int) -> Path:
    """Write the demo cube to ``output`` and return it."""
    root = dict(zarr.open_group(source, mode="r").attrs)
    ds = xr.open_zarr(source, group=level, consolidated=False)
    keep = [v for v in LAYERS if v in ds]
    out = ds[keep].isel(time=slice(None, None, step))
    out = out.drop_vars([c for c in out.coords if "ministack" in c])
    # Averaged into the coarser levels, the mask holds fractions; float32 is plenty.
    if "recommended_mask" in out:
        out["recommended_mask"] = out["recommended_mask"].astype(np.float32)
    attrs = {
        k: v
        for k, v in root.items()
        if k not in ("multiscales", "zarr_conventions", "job_id")
    }
    attrs.update(ds.attrs)  # the level's own grid: spatial:transform, shape, bbox
    times = out.time.values
    attrs["time_range"] = [str(times[0])[:10], str(times[-1])[:10]]
    attrs["demo"] = json.dumps(
        {"level": level, "date_step": step, "dates": int(times.size)}
    )
    out.attrs = attrs
    for v in out.variables.values():
        v.encoding = {}
    chunks = {"time": 8, "y": 256, "x": 256}
    out = out.chunk({k: c for k, c in chunks.items() if k in out.dims})
    out.to_zarr(output, mode="w", zarr_format=3, consolidated=True)
    return output


def main() -> None:
    """Parse the command line and write the cube."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("source")
    p.add_argument("output", type=Path)
    p.add_argument("--level", default="3", help="resolution level (group) to take")
    p.add_argument("--step", type=int, default=6, help="keep every n-th date")
    a = p.parse_args()
    print(make(a.source, a.output, a.level, a.step))


if __name__ == "__main__":
    main()
