"""A small deterministic GeoZarr cube with every layer the UI touches.

UTM 11N, 30 m, 48x48 pixels, 6 dates. ``displacement`` is a known east-west ramp
growing linearly in time plus a bump in the middle (a "dam"), so point, chart,
trend, buffer, profile and tile responses all carry real structure.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import xarray as xr

NT, NY, NX = 6, 48, 48
X0, Y0, DX = 436950.0, 3758490.0, 30.0
EPSG = 32611
# Points used by the scenarios: inside the cube, off the reference.
CENTER_LONLAT = (-117.67462, 33.95859)
REF_LONLAT = (-117.67984, 33.96289)
EDGE_LONLAT = (-117.66939, 33.95429)
LOS = {
    "heading_angle_deg": 345.5,
    "incidence_angle_deg": {"near": 35.8, "center": 35.9, "far": 36.1},
    "los_enu_ground_to_satellite": {
        "near": {"east": 0.566, "north": 0.146, "up": 0.811},
        "center": {"east": 0.568, "north": 0.147, "up": 0.810},
        "far": {"east": 0.570, "north": 0.147, "up": 0.808},
    },
}


def make_cube(
    path: Path, title: str = "Regression Dam (CA) · NISAR ASC 000_A_000 · 2026"
) -> Path:
    import rioxarray  # noqa: F401

    t = np.datetime64("2026-01-01") + np.arange(NT) * np.timedelta64(12, "D")
    x = X0 + DX * (np.arange(NX) + 0.5)
    y = Y0 - DX * (np.arange(NY) + 0.5)
    yy, xx = np.meshgrid(np.linspace(-1, 1, NY), np.linspace(-1, 1, NX), indexing="ij")
    k = np.arange(NT, dtype="float32")[:, None, None]
    ramp = 0.002 * xx[None] * k
    bump = -0.003 * k * np.exp(-((xx**2 + yy**2) / 0.05))[None]
    disp = (ramp + bump).astype("float32")
    disp[:, :2, :2] = np.nan  # a nodata corner
    tcoh = np.clip(0.95 - 0.5 * np.abs(xx), 0, 1).astype("float32")
    sim = np.clip(0.9 - 0.4 * np.abs(yy), 0, 1).astype("float32")
    g = {"grid_mapping": "spatial_ref"}
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                disp,
                {**g, "units": "meters", "long_name": "LOS displacement"},
            ),
            "temporal_coherence": (("time", "y", "x"), np.repeat(tcoh[None], NT, 0), g),
            "phase_similarity": (("time", "y", "x"), np.repeat(sim[None], NT, 0), g),
            "recommended_mask": (
                ("time", "y", "x"),
                np.repeat((tcoh > 0.6)[None], NT, 0).astype("float32"),
                g,
            ),
            "velocity": (
                ("y", "x"),
                (0.002 * xx * 365.25 / 12).astype("float32"),
                {**g, "units": "m/yr"},
            ),
            "amplitude_dispersion": (
                ("y", "x"),
                (0.3 + 0.2 * np.abs(yy)).astype("float32"),
                g,
            ),
        },
        coords={"time": t.astype("datetime64[ns]"), "y": y, "x": x},
        attrs={"title": title, "reference_lonlat": list(REF_LONLAT), **LOS},
    ).rio.write_crs(f"EPSG:{EPSG}")
    ds.to_zarr(path, mode="w", consolidated=False)
    return path
