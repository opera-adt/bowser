"""Values along a drawn line (``POST /profile``), as ``bowser.main.extract_profile``."""

from __future__ import annotations

from typing import Callable

import numpy as np
from pyproj import Geod

from .sampling import quiet

ReadOne = Callable[[float, float], "float | None"]
ReadMany = Callable[[np.ndarray, np.ndarray], np.ndarray]


class Line:
    """A lon/lat polyline with geodesic distances along it."""

    def __init__(self, coords: list[list[float]]) -> None:
        """Measure the segments of ``coords`` (``[[lon, lat], ...]``)."""
        self.lons = [c[0] for c in coords]
        self.lats = [c[1] for c in coords]
        self.geod = Geod(ellps="WGS84")
        self.seg_dists = [0.0]
        for i in range(1, len(self.lons)):
            _, _, d = self.geod.inv(
                self.lons[i - 1], self.lats[i - 1], self.lons[i], self.lats[i]
            )
            self.seg_dists.append(self.seg_dists[-1] + float(d))
        self.total = self.seg_dists[-1]

    def at(self, sd: float) -> tuple[float, float, float]:
        """``(lon, lat, bearing_deg)`` at distance ``sd`` along the line."""
        lons, lats, seg = self.lons, self.lats, self.seg_dists
        i = int(np.clip(np.searchsorted(seg, sd, side="right") - 1, 0, len(lons) - 2))
        frac = (sd - seg[i]) / max(seg[i + 1] - seg[i], 1e-9)
        slon = lons[i] + frac * (lons[i + 1] - lons[i])
        slat = lats[i] + frac * (lats[i + 1] - lats[i])
        az, _, _ = self.geod.inv(lons[i], lats[i], lons[i + 1], lats[i + 1])
        return float(slon), float(slat), float(az)

    def offset(
        self, lons: np.ndarray, lats: np.ndarray, bearings: np.ndarray, off: float
    ) -> tuple[np.ndarray, np.ndarray]:
        """Points ``off`` metres to the right (perpendicular) of each centre point."""
        o_lon, o_lat, _ = self.geod.fwd(
            lons, lats, bearings + 90.0, np.full_like(lons, off)
        )
        return np.asarray(o_lon, dtype=float), np.asarray(o_lat, dtype=float)


def binned_profile(
    line: Line,
    read_many: ReadMany,
    sampling_interval: float,
    radius: float,
    n_random: int,
) -> dict:
    """Median per ``sampling_interval`` bin of the centre line and ``radius`` buffer."""
    half = sampling_interval / 2.0
    bin_centres = np.arange(half, line.total, sampling_interval)
    if len(bin_centres) == 0:
        bin_centres = np.array([line.total / 2.0])
    along_step = max(min(sampling_interval / 5.0, sampling_interval), 1.0)
    if radius > 0:
        perp_step = max(radius / 5.0, 1.0)
        dense = np.arange(-radius, radius + perp_step * 0.5, perp_step)
        dense = dense[np.abs(dense) > 1e-3]
    else:
        dense = np.empty(0)
    n_display = max(1, min(n_random, 5)) if radius > 0 else 0
    display = np.linspace(-radius, radius, n_display) if n_display > 0 else np.empty(0)

    centre: list[dict] = []
    median: list[dict] = []
    samples: list[list[dict]] = [[] for _ in range(n_display)]
    for bc in bin_centres:
        along = np.arange(bc - half, bc + half + along_step * 0.5, along_step)
        along = along[(along >= 0) & (along <= line.total)]
        if along.size == 0:
            continue
        positions = [line.at(ad) for ad in along]
        clons = np.array([p[0] for p in positions])
        clats = np.array([p[1] for p in positions])
        bearings = np.array([p[2] for p in positions])
        lon_chunks, lat_chunks = [clons], [clats]
        if radius > 0 and dense.size > 0:
            for off in dense:
                o_lon, o_lat = line.offset(clons, clats, bearings, off)
                lon_chunks.append(o_lon)
                lat_chunks.append(o_lat)
        starts: list[int] = []
        for off in display:
            starts.append(sum(c.size for c in lon_chunks))
            if abs(off) < 1e-3:
                lon_chunks.append(clons)
                lat_chunks.append(clats)
            else:
                o_lon, o_lat = line.offset(clons, clats, bearings, off)
                lon_chunks.append(o_lon)
                lat_chunks.append(o_lat)
        vals = read_many(np.concatenate(lon_chunks), np.concatenate(lat_chunks))
        n_along = clons.size
        n_dense = dense.size if radius > 0 else 0
        c_vals = vals[:n_along]
        c_vals = c_vals[np.isfinite(c_vals)]
        w_vals = vals[: n_along + n_along * n_dense]
        w_vals = w_vals[np.isfinite(w_vals)]
        if c_vals.size > 0:
            centre.append({"dist": float(bc), "value": float(np.nanmedian(c_vals))})
        if w_vals.size > 0:
            median.append({"dist": float(bc), "value": float(np.nanmedian(w_vals))})
        for k, start in enumerate(starts):
            s = vals[start : start + n_along]
            s = s[np.isfinite(s)]
            if s.size > 0:
                samples[k].append({"dist": float(bc), "value": float(np.nanmedian(s))})
    return {
        "centre": centre,
        "median": median,
        "samples": samples,
        "binned": True,
        "bin_width": float(sampling_interval),
    }


def point_profile(
    line: Line, read_one: ReadOne, n_samples: int, radius: float, n_random: int
) -> list[dict] | dict:
    """``n_samples`` evenly spaced values.

    Adds random perpendicular lines when ``radius > 0``.
    """
    positions = [
        (float(sd), *line.at(sd)) for sd in np.linspace(0, line.total, n_samples)
    ]
    if radius <= 0:
        out = []
        for sd, slon, slat, _ in positions:
            v = read_one(slon, slat)
            if v is not None:
                out.append({"dist": sd, "value": v})
        return out

    rng = np.random.default_rng(42)
    offsets = rng.uniform(-radius, radius, size=n_random)
    lines: list[list[float | None]] = [[] for _ in range(1 + n_random)]
    for sd, slon, slat, bearing in positions:
        lines[0].append(read_one(slon, slat))
        for j, off in enumerate(offsets):
            if off == 0:
                o_lon, o_lat = slon, slat
            else:
                o_lon, o_lat, _ = line.geod.fwd(slon, slat, bearing + 90.0, off)
            lines[j + 1].append(read_one(o_lon, o_lat))
    arr = np.array([[v if v is not None else np.nan for v in ln] for ln in lines])
    with quiet():
        median_vals = np.nanmedian(arr, axis=0)

    def series(row: np.ndarray) -> list[dict]:
        return [
            {"dist": float(positions[i][0]), "value": float(v)}
            for i, v in enumerate(row)
            if np.isfinite(v)
        ]

    return {
        "centre": series(arr[0]),
        "median": series(median_vals),
        "samples": [series(arr[j + 1]) for j in range(n_random)],
    }
