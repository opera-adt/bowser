"""Helpers for the lite-vs-full parity tests: request lists, replays, comparisons."""

from __future__ import annotations

import io
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPLAY = HERE / "replay.py"

#: Relative tolerance for numbers in JSON responses.
REL_TOL = 1e-6
#: Tiles: share of opaque pixels whose RGB must agree within one step per channel.
MIN_RGB_AGREEMENT = 0.99


def tiles_over(bounds: list[float], z: int) -> list[tuple[int, int, int]]:
    """Every WebMercator tile at zoom ``z`` touching a lon/lat box."""
    w, s, e, n = bounds
    k = 2**z

    def tx(lon: float) -> int:
        return int((lon + 180.0) / 360.0 * k)

    def ty(lat: float) -> int:
        return int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * k)

    return [(z, x, y) for x in range(tx(w), tx(e) + 1) for y in range(ty(n), ty(s) + 1)]


#: Tile parameter sets for the synthetic regression cube: what the UI sends for
#: the common layer styles (moving reference shift, rewrap, masks, a 2-D layer,
#: a step relative to another date).
REGRESSION_TILE_PARAMS = {
    "ui_shift": {
        "variable": "displacement",
        "time_idx": 3,
        "rescale": "-0.01,0.01",
        "colormap_name": "rdbu_r",
        "algorithm": "shift",
        "algorithm_params": json.dumps({"shift": 0.001}),
    },
    "plain": {
        "variable": "displacement",
        "time_idx": 5,
        "rescale": "-0.02,0.01",
        "colormap_name": "viridis",
    },
    "shift_zero": {
        "variable": "displacement",
        "time_idx": 4,
        "rescale": "-0.01,0.01",
        "colormap_name": "rdylbu",
        "algorithm": "shift",
        "algorithm_params": json.dumps({"shift": 0}),
    },
    "rewrap": {
        "variable": "displacement",
        "time_idx": 5,
        "rescale": "-3.14159,3.14159",
        "colormap_name": "twilight",
        "algorithm": "rewrap",
        "algorithm_params": json.dumps(
            {
                "shift": 0.001,
                "scale_factor": 4 * math.pi / 0.0555,
                "wrap_range": 2 * math.pi,
            }
        ),
    },
    "layer_masks": {
        "variable": "displacement",
        "time_idx": 2,
        "rescale": "-0.01,0.01",
        "colormap_name": "cfastie_r",
        "layer_masks": json.dumps(
            [
                {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"},
                {"dataset": "phase_similarity", "threshold": 0.8, "mode": "max"},
            ]
        ),
    },
    "velocity_mask_var": {
        "variable": "velocity",
        "time_idx": 2,
        "rescale": "-0.06,0.06",
        "colormap_name": "rdbu",
        "mask_variable": "recommended_mask",
        "mask_min_value": 0.5,
    },
    "ref_time": {
        "variable": "displacement",
        "time_idx": 5,
        "ref_time_idx": 1,
        "rescale": "-0.01,0.01",
        "colormap_name": "rdbu_r",
        "algorithm": "shift",
        "algorithm_params": json.dumps({"shift": 0.001}),
        "layer_masks": json.dumps(
            [{"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}]
        ),
    },
    "gray_2d": {
        "variable": "amplitude_dispersion",
        "rescale": "0.3,0.5",
        "colormap_name": "gray",
    },
}


def regression_requests(bounds: list[float], zooms=range(12, 18)) -> list[dict]:
    """Tile requests for every parameter set and every tile over the cube."""
    specs = []
    for label, params in REGRESSION_TILE_PARAMS.items():
        for z in zooms:
            for zz, x, y in tiles_over(bounds, z):
                specs.append(
                    {
                        "name": f"{label}_{zz}_{x}_{y}",
                        "tile": [zz, x, y],
                        "params": params,
                    }
                )
    return specs


def run_replay(
    which: str,
    out: Path,
    env_extra: dict,
    requests: list[dict] | None = None,
    scenarios: bool = True,
) -> subprocess.Popen:
    """Start ``replay.py`` for one server in a subprocess.

    Settings are read at import, so each server needs its own process.
    """
    out = out.resolve()
    env = {
        **os.environ,
        # Each server its own reference-statistics cache and no warm-up, so both
        # compute their first answer themselves and report it the same way.
        "BOWSER_REFSTATS_CACHE_DIR": str(out / "refstats"),
        "BOWSER_REFSTATS_WARMUP": "0",
        **env_extra,
        "SCENARIOS": "1" if scenarios else "0",
    }
    for key in ("BOWSER_STACK_DATA_FILE", "BOWSER_CATALOG_FILE"):
        if key not in env_extra:
            env.pop(key, None)
    args = [sys.executable, str(REPLAY), which, str(out)]
    if requests:
        out.mkdir(parents=True, exist_ok=True)
        (out / "requests_in.json").write_text(json.dumps(requests))
        args.append(str(out / "requests_in.json"))
    return subprocess.Popen(
        args,
        env=env,
        cwd=out.parent,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def wait(proc: subprocess.Popen) -> None:
    """Wait for a replay; fail with its stderr if it failed."""
    _, err = proc.communicate()
    assert proc.returncode == 0, err[-4000:]


def json_diffs(a, b, path: str = "", rel: float = REL_TOL) -> list[str]:
    """Where two JSON values differ (numbers compared to a relative tolerance)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return [] if a == b else [f"{path}: {a!r} != {b!r}"]
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a == b or math.isclose(a, b, rel_tol=rel, abs_tol=1e-12):
            return []
        return [f"{path}: {a!r} != {b!r}"]
    if isinstance(a, dict) and isinstance(b, dict):
        out = [f"{path}.{k}: missing on one side" for k in sorted(set(a) ^ set(b))]
        for k in sorted(set(a) & set(b)):
            out += json_diffs(a[k], b[k], f"{path}.{k}", rel)
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} != {len(b)}"]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += json_diffs(x, y, f"{path}[{i}]", rel)
        return out
    return [] if a == b else [f"{path}: {a!r} != {b!r}"]


def decode_png(content: bytes) -> np.ndarray:
    """RGBA pixels of a PNG (Pillow is a test-only dependency)."""
    from PIL import Image

    return np.asarray(Image.open(io.BytesIO(content)).convert("RGBA"))


def tile_agreement(full: bytes, lite: bytes) -> dict:
    """Compare two tiles: alpha-mask mismatches and RGB agreement where both opaque."""
    a, b = decode_png(full).astype(int), decode_png(lite).astype(int)
    assert a.shape == b.shape, (a.shape, b.shape)
    opaque_a, opaque_b = a[..., 3] > 0, b[..., 3] > 0
    both = opaque_a & opaque_b
    close = (np.abs(a[..., :3] - b[..., :3]) <= 1).all(axis=-1)
    n = int(both.sum())
    return {
        "pixels": int(a.shape[0] * a.shape[1]),
        "alpha_mismatch": int((opaque_a != opaque_b).sum()),
        "opaque": n,
        "rgb_close": int((close & both).sum()),
        "rgb_exact": int(((a[..., :3] == b[..., :3]).all(axis=-1) & both).sum()),
    }


def real_cube_requests(bounds: list[float], zooms=range(10, 16)) -> list[dict]:
    """Requests for a real DISP cube: metadata, series at its centre, tiles over it."""
    w, s, e, n = bounds
    lon, lat = (w + e) / 2, (s + n) / 2
    ref = (w + 0.3 * (e - w), s + 0.3 * (n - s))
    masks = [{"dataset": "temporal_coherence", "threshold": 0.6, "mode": "min"}]
    specs: list[dict] = [
        {"name": "datasets", "path": "/datasets"},
        {"name": "variables", "path": "/variables"},
        {"name": "time_bounds", "path": "/datasets/displacement/time_bounds"},
        {"name": "dataset_range", "path": "/dataset_range/velocity"},
        {
            "name": "histogram",
            "path": "/histogram/displacement",
            "params": {"time_index": 120, "nbins": 50},
        },
        {"name": "histogram_velocity", "path": "/histogram/velocity"},
        {"name": "reference_candidates", "path": "/reference_candidates"},
        {
            "name": "point",
            "path": "/point",
            "params": {"dataset_name": "displacement", "lon": lon, "lat": lat},
        },
        {
            "name": "point_t",
            "path": "/point",
            "params": {
                "dataset_name": "displacement",
                "lon": lon,
                "lat": lat,
                "time_idx": 77,
            },
        },
        {
            "name": "multi_point",
            "method": "POST",
            "path": "/multi_point",
            "json": {
                "points": [
                    {"id": "a", "lon": lon, "lat": lat, "name": "centre"},
                    {"id": "b", "lon": ref[0] + 0.01, "lat": ref[1]},
                ],
                "dataset_name": "displacement",
                "ref_lon": ref[0],
                "ref_lat": ref[1],
                "calculate_trends": True,
                "layer_masks": masks,
                "ref_buffer_m": 100,
            },
        },
        {
            "name": "buffer",
            "method": "POST",
            "path": "/buffer_timeseries",
            "json": {
                "lon": lon,
                "lat": lat,
                "dataset_name": "displacement",
                "buffer_m": 120,
                "n_samples": 5,
                "ref_lon": ref[0],
                "ref_lat": ref[1],
                "layer_masks": masks,
            },
        },
        {
            "name": "profile_binned",
            "method": "POST",
            "path": "/profile",
            "json": {
                "coords": [[w + 0.01, s + 0.01], [e - 0.01, n - 0.01]],
                "dataset_name": "velocity",
                "time_index": 0,
                "n_samples": 200,
                "radius": 50,
                "n_random": 5,
                "sampling_interval": 200,
            },
        },
        {
            "name": "tilejson",
            "path": "/md/WebMercatorQuad/tilejson.json",
            "params": {
                "variable": "displacement",
                "time_idx": 120,
                "rescale": "-0.05,0.05",
                "colormap_name": "rdbu_r",
            },
        },
    ]
    tile_params = {
        "disp_shift": {
            "variable": "displacement",
            "time_idx": 120,
            "rescale": "-0.05,0.05",
            "colormap_name": "rdbu_r",
            "algorithm": "shift",
            "algorithm_params": json.dumps({"shift": 0.002}),
        },
        "velocity": {
            "variable": "velocity",
            "rescale": "-0.02,0.02",
            "colormap_name": "rdbu",
        },
        "disp_ref_time": {
            "variable": "displacement",
            "time_idx": 200,
            "ref_time_idx": 60,
            "rescale": "-0.05,0.05",
            "colormap_name": "rdbu_r",
            "algorithm": "shift",
            "algorithm_params": json.dumps({"shift": 0.002}),
        },
        "disp_masked": {
            "variable": "displacement",
            "time_idx": 239,
            "rescale": "-0.08,0.08",
            "colormap_name": "viridis",
            "layer_masks": json.dumps(masks),
        },
    }
    for label, params in tile_params.items():
        for z in zooms:
            for zz, x, y in tiles_over(bounds, z):
                specs.append(
                    {
                        "name": f"{label}_{zz}_{x}_{y}",
                        "tile": [zz, x, y],
                        "params": params,
                    }
                )
    return specs


def polygon_bodies(
    variable: str, x0: float, y0: float, dx: float, nx: int, ny: int, epsg: int
) -> dict[str, dict]:
    """``POST /polygon_timeseries`` bodies covering a north-up grid's cases.

    The grid has ``nx`` x ``ny`` cells of ``dx`` from the corner ``(x0, y0)`` in
    ``EPSG:epsg``; shapes are given in cell units and sent in lon/lat. Convex,
    concave, with a hole, two parts (one with a hole), partly and wholly
    outside, larger than the grid, inside one cell (with and without its
    centre), over the grid's edges, and one that crosses itself. None of these
    has a cell centre on an edge when the cells are the grid's pixels.

    The ``tie_*`` shapes do: edges through cell centres or along the grid's own
    edges (:func:`polygon_ties`). Which side such a centre falls on depends on
    the last bit of the arithmetic, and GDAL's differs between platforms.
    """
    from pyproj import Transformer

    back = Transformer.from_crs(epsg, 4326, always_xy=True)

    def ring(points: list[tuple[float, float]]) -> list[list[float]]:
        pts = [list(back.transform(x0 + dx * c, y0 - dx * r)) for c, r in points]
        return pts + pts[:1]

    def poly(*rings: list[tuple[float, float]]) -> dict:
        return {"type": "Polygon", "coordinates": [ring(r) for r in rings]}

    cx, cy = nx / 2, ny / 2
    star = [
        (
            cx + (0.4 if k % 2 else 0.15) * min(nx, ny) * math.cos(k * math.pi / 7),
            cy + (0.4 if k % 2 else 0.15) * min(nx, ny) * math.sin(k * math.pi / 7),
        )
        for k in range(14)
    ]
    shapes = {
        "convex": poly(
            [(cx - 9.3, cy - 7.1), (cx + 8.7, cy - 5.2), (cx + 11.2, cy + 6.4)]
            + [(cx - 4.4, cy + 9.9)]
        ),
        "concave": poly(star),
        "hole": poly(
            [(4.2, 4.3), (nx - 5.1, 5.2), (nx - 4.4, ny - 6.3), (5.5, ny - 4.1)],
            [(cx - 6.2, cy - 5.1), (cx - 5.7, cy + 6.3), (cx + 7.1, cy + 5.8)]
            + [(cx + 6.6, cy - 6.4)],
        ),
        "multi": {
            "type": "MultiPolygon",
            "coordinates": [
                [ring([(3.1, 3.2), (12.7, 4.1), (11.2, 13.6), (2.4, 11.9)])],
                [
                    ring(
                        [(cx + 3.3, cy + 2.2), (nx - 3.6, cy + 4.9)]
                        + [(nx - 6.1, ny - 2.7), (cx + 1.2, ny - 4.4)]
                    ),
                    ring(
                        [(cx + 6.3, cy + 6.2), (cx + 9.6, cy + 6.9)]
                        + [(cx + 8.1, cy + 10.7)]
                    ),
                ],
            ],
        },
        "partly_outside": poly(
            [(-7.5, -3.3), (9.4, 2.2), (6.1, ny + 8.8), (-11.2, ny / 2)]
        ),
        "covers_all": poly([(-3, -3), (nx + 3, -3), (nx + 3, ny + 3), (-3, ny + 3)]),
        "tiny_hit": poly(
            [(cx + 0.3, cy + 0.3), (cx + 0.7, cy + 0.35), (cx + 0.6, cy + 0.72)]
            + [(cx + 0.31, cy + 0.66)]
        ),
        "tiny_miss": poly(
            [(cx + 0.05, cy + 0.05), (cx + 0.3, cy + 0.07), (cx + 0.2, cy + 0.3)]
        ),
        "edge": poly([(-0.4, -0.4), (nx + 0.4, -0.4), (nx + 0.4, 3.3), (-0.4, 3.3)]),
        "edge_right": poly(
            [(nx - 2.3, 5.2), (nx + 0.6, 5.2), (nx + 0.6, ny + 0.7)]
            + [(nx - 2.3, ny + 0.7)]
        ),
        # Ties: edges through cell centres and along the grid's own edges.
        "tie_edge": poly([(0, 0), (nx, 0), (nx, 3.5), (0, 3.5)]),
        "tie_right": poly([(nx - 2.5, 5), (nx, 5), (nx, ny), (nx - 2.5, ny)]),
        "tie_centres": poly([(5.5, 5.5), (15.5, 5.5), (15.5, 12.5), (5.5, 12.5)]),
        "outside": poly([(nx + 5, 2), (nx + 9, 2), (nx + 9, 7), (nx + 5, 7)]),
        "bowtie": poly([(5, 5), (15, 15), (15, 5), (5, 15)]),
    }
    bodies = {k: {"variable": variable, "geometry": g} for k, g in shapes.items()}
    bodies["per_date"] = {
        **bodies["hole"],
        "support": "per_date",
        "percentiles": [5, 50, 97.5],
    }
    return bodies


def polygon_ties(nx: int, ny: int) -> dict[str, tuple[int, int]]:
    """Pixel counts of the ``tie_*`` shapes of :func:`polygon_bodies`.

    ``{name: (certain, ties)}`` when the cells are the grid's pixels: the
    pixels whose centre is strictly inside, and those whose centre is on an
    edge. Any correct fill selects the certain ones and no pixel beyond the
    ties.
    """
    return {
        # Rows 0..2 are inside; the centres of row 3 are on the lower edge.
        "tie_edge": (3 * nx, nx),
        # The last two columns from row 5 down; the third-last is on the edge.
        "tie_right": (2 * (ny - 5), ny - 5),
        # Centres 6.5..14.5 x 6.5..11.5 inside; the frame of the 11 x 8 block
        # of centres 5.5..15.5 x 5.5..12.5 is on the edges.
        "tie_centres": (9 * 6, 11 * 8 - 9 * 6),
    }
