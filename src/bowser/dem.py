"""Elevation models (DEMs): recognising one among the rasters added to the map.

A DEM, such as a USGS 3DEP 1 m lidar tile, is drawn as a hillshade and/or colour
relief by the ``/overlay`` tiler (``algorithm=dem``, see ``titiler.DemRender``),
from the COG ``bowser.convert`` makes of it like any other raster. A raster this
module takes for a DEM is styled as one when it is added; any single-band raster
can still be made one with "Use as DEM".
"""

from __future__ import annotations

import os
from pathlib import Path

import rasterio

_ELEVATION_WORDS = (
    "dem",
    "dtm",
    "dsm",
    "elev",
    "height",
    "lidar",
    "srtm",
    "3dep",
    "topo",
    "bathy",
    "terrain",
)


def looks_like_dem(path: str | os.PathLike, name: str = "") -> bool:
    """Return whether a raster looks like an elevation model.

    One band, and either a name, description or unit that says elevation, or a
    float/int16 band whose values look like heights in metres: no more than 2 %
    below zero (a velocity or difference map is centred on zero), at least 2 m of
    relief, and nothing above 9000 m. Used to mark an upload as a DEM at once; any
    single-band raster can still be made one with "Use as DEM".
    """
    with rasterio.open(path) as src:
        if src.count != 1 or src.colorinterp[0].name == "palette":
            return False
        dtype = src.dtypes[0]
        words = " ".join(
            [
                name,
                Path(str(path)).name,
                src.descriptions[0] or "",
                " ".join(src.tags(1).values()),
            ]
        ).lower()
        if any(w in words for w in _ELEVATION_WORDS):
            return True
        if not (dtype.startswith("float") or dtype == "int16"):
            return False
        # A coarse overview (or decimated read) is enough to judge the range.
        factor = max(1, max(src.width, src.height) // 512)
        arr = src.read(
            1,
            masked=True,
            out_shape=(max(1, src.height // factor), max(1, src.width // factor)),
        )
    values = arr.compressed()
    values = values[values == values]  # drop NaN
    if values.size == 0:
        return False
    import numpy as np  # noqa: PLC0415

    p2, p98 = np.percentile(values, [2, 98])
    return bool(p2 >= 0 and p98 - p2 >= 2 and values.max() <= 9000)
