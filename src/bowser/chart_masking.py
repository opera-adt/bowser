"""Bounded external-mask support for full-server GeoZarr charts."""

import numpy as np
from rasterio.windows import Window

from .cog_sampling import read_native_mask
from .polygon import MAX_WINDOW_PIXELS, NativeGrid


def custom_keep(source, path, x, y, radius=None, *, warp=None):
    """Select the source's native rows/columns, never mask a full time cube."""
    for axis in (source.x.values, source.y.values):
        delta = np.diff(axis)
        if (
            len(delta) < 1
            or not np.isfinite(axis).all()
            or delta[0] == 0
            or not np.allclose(delta, delta[0], rtol=1e-7, atol=1e-8)
        ):
            raise ValueError("Uploaded masks require regular finite x/y pixel centers")
    if radius is None:
        cols = source.get_index("x").get_indexer([x], method="nearest")
        rows = source.get_index("y").get_indexer([y], method="nearest")
    else:
        dx = float(abs(source.x[1] - source.x[0]))
        dy = float(abs(source.y[1] - source.y[0]))
        xs = source.x.sel(x=slice(x - radius - dx, x + radius + dx))
        ys = source.y.sel(y=slice(y + radius + dy, y - radius - dy))
        cols = source.get_index("x").get_indexer(xs.values)
        rows = source.get_index("y").get_indexer(ys.values)
    if not len(rows) or not len(cols):
        return np.zeros((len(rows), len(cols)), dtype=bool)
    if len(rows) * len(cols) > MAX_WINDOW_PIXELS:
        raise ValueError("Custom chart mask exceeds the native pixel budget")
    grid = NativeGrid(
        source.rio.crs,
        source.rio.transform(recalc=True),
        source.sizes["x"],
        source.sizes["y"],
    )
    if grid.crs is None or grid.transform.b != 0 or grid.transform.d != 0:
        raise ValueError(
            "Uploaded GeoZarr masks require an explicit rectilinear CRS/grid"
        )
    try:
        values = read_native_mask(
            path, grid, Window(int(cols[0]), int(rows[0]), len(cols), len(rows))
        )
    except ValueError:
        if warp is None:
            raise
        # Cross-grid masks follow the map's cached 2-D warp. Never warp/read
        # the displacement time cube or resample the measurements themselves.
        keep = warp(source, path)
        return np.asarray(keep.isel(y=rows, x=cols).values, dtype=bool)
    # Preserve the full-server GeoZarr uploaded-mask > 0 convention.
    return np.isfinite(values) & (values > 0)
