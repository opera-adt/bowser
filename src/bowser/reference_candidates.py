"""Find stable reference-point candidates in a displacement cube.

One server-side analysis answers "where should I put the reference?":

1. **Per pixel, over the whole stack:** the median and standard deviation over
   time of temporal coherence (``tcoh``) and of phase similarity (``ps``).
   Water (``water_mask == 0``) and, with ``use_masks``, pixels outside the
   recommended mask on most dates are excluded.
2. **Pixel score and viability.** A pixel is *viable* when

   ``median(tcoh) >= t_coh`` and ``median(ps) >= t_ps``

   where ``t_coh`` and ``t_ps`` default to the ``quantile`` (0.95: the top 5 %)
   of the stack's own distribution of each median over valid pixels, so the
   rule adapts to a cube's overall quality instead of a fixed number that
   suits one area and rejects another. Its *pixel score* rewards high medians
   and penalises fluctuation through time::

       pixel_score = ((med_tcoh - k * std_tcoh) + (med_ps - k * std_ps)) / 2

   with ``k = 1``: a pixel whose coherence swings by 0.1 over the stack loses
   as much as one whose median is 0.1 lower. Both terms lie on comparable
   scales (coherence 0..1, similarity -1..1, both near 1 for good pixels), so
   they are averaged with equal weight.
3. **Neighbourhood** (a circle of ``radius_m``, the pixels the viewer's "Sample
   around ref marker" averages, selected with :func:`bowser.reference.select_circle`):

   - ``viable_fraction``: viable pixels / pixels of the full circle (pixels off
     the grid or masked count as not viable, so edges and shores are penalised);
   - ``mean_score``: the mean pixel score of the valid pixels in the circle;
   - ``neighbourhood_score = viable_fraction * mean_score``.

   The centre must itself be viable. A lone bright pixel in a noisy area has a
   small viable fraction and loses to a coherent patch.
4. **Spacing and displacement check.** Centres are picked greedily by
   neighbourhood score, each at least ``min_separation_m`` (default 3 x radius)
   from those already picked (non-maximum suppression), into a shortlist of
   ``max(3n, n + 10)``. For each shortlisted centre the displacement inside its
   circle is read: ``displacement_scatter`` is the median over the circle's
   pixels of the standard deviation through time of (pixel - circle median).
   Low means the circle moves together, which is what a reference averaged
   over that circle needs. The final ranking is::

       score = neighbourhood_score * s0 / (s0 + displacement_scatter)

   with ``s0 = 5 mm``: a 5 mm scatter halves the score. Without a displacement
   layer, ``score = neighbourhood_score``.

The per-pixel reductions are independent of the reference and of every other
parameter, so they are cached per opened dataset and layer.

Large cubes are screened on a coarser pyramid level (the finest whose grid has
at most ``max_screen_pixels`` pixels); each shortlisted centre is then refined
at full resolution within its coarse pixel. Thresholds and the distribution
summary then describe the screening level.

Coherence is not stability: a coherent pixel can still be moving steadily (a
building on compacting ground, a dam). Check the candidates' velocity and what
is on the ground before trusting one as a zero-motion reference.

Only numpy, xarray and pyproj are used, so the full server and bowser-lite
call the same code and give the same answer.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
import xarray as xr
from fastapi import HTTPException, Query
from pyproj import CRS, Transformer

from . import api_models as api
from .reference import select_circle
from .refstats import (
    STATS_CACHE,
    LayerShapeError,
    Source,
    as_tyx,
    nan_median_std,
    read_workers,
    selected_dates,
    stack_median_std,
    start_warm_up,
    warm_up_enabled,
)

logger = logging.getLogger("bowser")

#: Percentiles reported for the stack's distribution of each median.
PERCENTILES = (5, 25, 50, 75, 95, 99)
#: Automatic date stride: screen every date while the screening level holds at
#: most this many values per layer (Arkabutla: 82 million; a 30 m DISP-S1 frame
#: at full resolution: 13 billion), else the smallest stride that fits.
AUTO_STRIDE_VALUES = 4_000_000_000


def _quiet() -> Any:
    """Silence numpy's floating-point warnings (thread-safe, unlike ``warnings``)."""
    return np.errstate(all="ignore")


class CandidateError(ValueError):
    """The analysis cannot run on this cube with these parameters."""


class MissingLayerError(CandidateError, KeyError):
    """A layer the analysis needs is not in the cube."""

    def __str__(self) -> str:  # KeyError would quote the message
        return str(self.args[0])


@dataclass(frozen=True)
class CandidateParams:
    """Parameters of :func:`find_reference_candidates` (see the module docstring)."""

    radius_m: float = 100.0
    n: int = 5
    min_separation_m: float | None = None
    quantile: float = 0.95
    coherence_min: float | None = None
    similarity_min: float | None = None
    k_std: float = 1.0
    scatter_scale_m: float = 0.005
    use_masks: bool = False
    coherence_layer: str = "temporal_coherence"
    similarity_layer: str = "phase_similarity"
    displacement_layer: str = "displacement"
    velocity_layer: str = "velocity"
    water_mask_layer: str = "water_mask"
    mask_layers: tuple[str, ...] = ("recommended_mask",)
    max_screen_pixels: int = 16_000_000
    screen_stride: int | None = None

    @property
    def separation_m(self) -> float:
        """The minimum distance between candidates actually used."""
        if self.min_separation_m is not None:
            return float(self.min_separation_m)
        return 3.0 * max(self.radius_m, 0.0)

    def check(self) -> None:
        """Raise :class:`CandidateError` for out-of-range values."""
        if not (math.isfinite(self.radius_m) and self.radius_m >= 0):
            raise CandidateError("radius_m must be finite and >= 0")
        if self.n < 1:
            raise CandidateError("n must be at least 1")
        if not (0 < self.quantile < 1):
            raise CandidateError("quantile must be between 0 and 1")
        if not (math.isfinite(self.separation_m) and self.separation_m >= 0):
            raise CandidateError("min_separation_m must be finite and >= 0")
        if not (math.isfinite(self.k_std) and self.k_std >= 0):
            raise CandidateError("k_std must be finite and >= 0")
        if self.screen_stride is not None and self.screen_stride < 1:
            raise CandidateError("screen_stride must be at least 1")


# --- circles ---------------------------------------------------------------------


def disc_offsets(ds: xr.Dataset, radius_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Row and column offsets of the pixels a reference circle selects.

    The circle is the one :func:`bowser.reference.select_circle` draws for the
    viewer's "Sample around ref marker" (margin window, ``sqrt`` distance),
    centred on a pixel in the middle of the grid; the grid is regular, so the
    offsets hold everywhere. Radius 0 is the centre pixel only.
    """
    if radius_m <= 0:
        return np.zeros(1, int), np.zeros(1, int)
    x, y = ds["x"].values, ds["y"].values
    res = max(abs(float(x[1] - x[0])) if x.size > 1 else 1.0, 1e-12)
    res_y = max(abs(float(y[1] - y[0])) if y.size > 1 else 1.0, 1e-12)
    rx = int(math.ceil(radius_m / res)) + 2
    ry = int(math.ceil(radius_m / res_y)) + 2
    i0 = y.size // 2
    j0 = x.size // 2
    rows = np.arange(max(i0 - ry, 0), min(i0 + ry + 1, y.size))
    cols = np.arange(max(j0 - rx, 0), min(j0 + rx + 1, x.size))
    # The window's values are the offsets themselves, so the selection says
    # which offsets fall inside.
    dy, dx = np.meshgrid(rows - i0, cols - j0, indexing="ij")
    grid = xr.DataArray(
        np.stack([dy, dx]).astype(float),
        dims=("offset", "y", "x"),
        coords={"y": y[rows], "x": x[cols]},
    )
    found = select_circle(
        grid,
        float(x[j0]),
        float(y[i0]),
        radius_m,
        margin_window=True,
        sqrt_distance=True,
    )
    if found is None:  # an ascending-y grid: the exact window instead
        found = select_circle(grid, float(x[j0]), float(y[i0]), radius_m)
    assert found is not None
    off = found.values[:, found.inside].astype(int)
    return off[0], off[1]


def _row_runs(dy: np.ndarray, dx: np.ndarray) -> list[tuple[int, int, int]]:
    """Return the disc as ``(dy, first dx, last dx)`` row runs (a disc is convex)."""
    return [
        (int(r), int(dx[dy == r].min()), int(dx[dy == r].max())) for r in np.unique(dy)
    ]


def focal_sum(a: np.ndarray, runs: list[tuple[int, int, int]]) -> np.ndarray:
    """Sum of ``a`` over the disc around every pixel; off-grid pixels count 0.

    Row-wise cumulative sums make each disc row one subtraction, so the cost
    is (rows of the disc) x (pixels) rather than (pixels of the disc) x (pixels).
    """
    ny, nx = a.shape
    cs = np.zeros((ny, nx + 1))
    np.cumsum(a, axis=1, out=cs[:, 1:])
    jj = np.arange(nx)
    out = np.zeros((ny, nx))
    for dy, lo, hi in runs:
        seg = cs[:, np.clip(jj + hi + 1, 0, nx)] - cs[:, np.clip(jj + lo, 0, nx)]
        if dy >= 0:
            out[: ny - dy] += seg[dy:]
        else:
            out[-dy:] += seg[: ny + dy]
    return out


# --- the analysis ----------------------------------------------------------------


@dataclass
class _Screen:
    """Per-pixel fields of one grid (the screening level or a refine window)."""

    med_c: np.ndarray
    std_c: np.ndarray
    med_p: np.ndarray
    std_p: np.ndarray
    valid: np.ndarray
    score: np.ndarray = field(init=False)
    viable: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.valid = self.valid & np.isfinite(self.med_c) & np.isfinite(self.med_p)

    def finish(self, k: float, t_c: float, t_p: float) -> None:
        """Compute the pixel score and the viable mask for thresholds t_c, t_p."""
        with _quiet():
            sc = np.nan_to_num(self.std_c.astype(np.float64), nan=0.0)
            sp = np.nan_to_num(self.std_p.astype(np.float64), nan=0.0)
            self.score = 0.5 * ((self.med_c - k * sc) + (self.med_p - k * sp))
            self.viable = self.valid & (self.med_c >= t_c) & (self.med_p >= t_p)

    def neighbourhood(
        self, runs: list[tuple[int, int, int]], disc_size: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Viable fraction, mean score, valid count and the neighbourhood score."""
        n_viable = focal_sum(self.viable.astype(np.float64), runs)
        n_valid = focal_sum(self.valid.astype(np.float64), runs)
        sum_score = focal_sum(np.where(self.valid, self.score, 0.0), runs)
        with _quiet():
            frac = n_viable / disc_size
            mean = np.where(n_valid > 0, sum_score / np.maximum(n_valid, 1), np.nan)
            nscore = np.where(self.viable, frac * mean, -np.inf)
        return frac, mean, n_valid, nscore


def _layer(ds: xr.Dataset, name: str | None, *, required: bool) -> str | None:
    if name and name in ds.data_vars and {"y", "x"}.issubset(ds[name].dims):
        return name
    if required:
        raise MissingLayerError(f"Variable {name} not found")
    return None


def _keep_mask(
    ds: xr.Dataset, layers: dict[str, Any], stride: int, source: Source | None
) -> tuple[np.ndarray | None, bool]:
    """Pixels not excluded by the water mask and (``use_masks``) the masks.

    The water mask follows OPERA DISP-S1: 0 is water, 1 land; NaN (no
    information) is kept. A time-varying mask (the recommended mask) keeps a
    pixel when its median over the stack is >= 0.5, i.e. good on most dates.
    """
    keep: np.ndarray | None = None
    cached_all = True
    water = layers["water_mask"]
    if water is not None:
        (wmed, _), cached = STATS_CACHE.get(ds, water, source=source)
        cached_all &= cached
        keep = wmed != 0
    for name in layers["masks"]:
        (mmed, _), cached = STATS_CACHE.get(ds, name, stride=stride, source=source)
        cached_all &= cached
        good = mmed >= 0.5
        keep = good if keep is None else keep & good
    return keep, cached_all


def _window_keep(
    ds: xr.Dataset, layers: dict[str, Any], rows: slice, cols: slice
) -> np.ndarray | None:
    keep = None
    names = ([layers["water_mask"]] if layers["water_mask"] else []) + layers["masks"]
    for name in names:
        med, _ = stack_median_std(ds[name], rows, cols)
        good = (med != 0) if name == layers["water_mask"] else (med >= 0.5)
        keep = good if keep is None else keep & good
    return keep


def _screen(
    ds: xr.Dataset, layers: dict[str, Any], stride: int, source: Source | None
) -> tuple[_Screen, bool]:
    get = STATS_CACHE.get
    (mc, sc), c1 = get(ds, layers["coherence"], stride=stride, source=source)
    (mp, sp), c2 = get(ds, layers["similarity"], stride=stride, source=source)
    keep, c3 = _keep_mask(ds, layers, stride, source)
    valid = np.ones(mc.shape, bool) if keep is None else keep
    return _Screen(mc, sc, mp, sp, valid), c1 and c2 and c3


def _pick_spaced(
    order: np.ndarray, xs: np.ndarray, ys: np.ndarray, sep: float, limit: int
) -> list[int]:
    """Greedy non-maximum suppression: indices into ``order``'s arrays, best first."""
    picked: list[int] = []
    alive = np.ones(order.size, bool)
    while len(picked) < limit:
        rest = np.flatnonzero(alive)
        if rest.size == 0:
            break
        i = int(rest[0])
        picked.append(i)
        alive[i] = False
        if sep > 0:
            d2 = (xs[rest] - xs[i]) ** 2 + (ys[rest] - ys[i]) ** 2
            alive[rest[d2 < sep**2]] = False
    return picked


def _units_to_m(units: str | None) -> float:
    u = (units or "m").strip().lower()
    if u in ("mm", "millimeter", "millimeters", "millimetre", "millimetres"):
        return 1e-3
    if u in ("cm", "centimeter", "centimeters", "centimetre", "centimetres"):
        return 1e-2
    return 1.0


def displacement_scatter(
    ds: xr.Dataset, name: str, cx: float, cy: float, radius_m: float
) -> tuple[float | None, int]:
    """Median over a circle's pixels of std_t(pixel - circle median), in metres.

    The circle is the viewer's reference circle (:func:`select_circle`), all of
    whose non-NaN pixels a buffered reference averages. Returns
    ``(scatter, n_pixels)``; ``None`` with radius 0 or fewer than 2 pixels.
    """
    if radius_m <= 0:
        return None, 1
    da = as_tyx(ds[name])
    found = select_circle(da, cx, cy, radius_m, margin_window=True, sqrt_distance=True)
    if found is None:
        found = select_circle(da, cx, cy, radius_m)
    if found is None:
        return None, 0
    vals = np.asarray(found.values, np.float64)[:, found.inside]  # (t, n)
    vals = vals[:, ~np.all(np.isnan(vals), axis=0)]
    if vals.shape[1] < 2:
        return None, int(vals.shape[1])
    with _quiet():
        circle_median, _ = nan_median_std(vals.T, np.float64)  # per date
        _, per_pixel = nan_median_std(vals - circle_median[:, None], np.float64)
        scatter = float(nan_median_std(per_pixel[:, None], np.float64)[0][0])
    if not math.isfinite(scatter):
        return None, int(vals.shape[1])
    return scatter * _units_to_m(ds[name].attrs.get("units")), int(vals.shape[1])


def _pct(a: np.ndarray) -> dict[str, float]:
    if a.size == 0:
        return {f"p{p}": float("nan") for p in PERCENTILES}
    v = np.percentile(a.astype(np.float64), PERCENTILES)
    return {f"p{p}": float(x) for p, x in zip(PERCENTILES, v)}


def _choose_level(levels: Sequence[xr.Dataset], max_pixels: int) -> int:
    for i, lv in enumerate(levels):
        if lv.sizes["y"] * lv.sizes["x"] <= max_pixels:
            return i
    return len(levels) - 1


def _pixel_size(ds: xr.Dataset) -> float:
    x, y = ds["x"].values, ds["y"].values
    dx = abs(float(x[1] - x[0])) if x.size > 1 else 0.0
    dy = abs(float(y[1] - y[0])) if y.size > 1 else 0.0
    return (dx + dy) / 2.0


def _f(v: Any) -> float | None:
    v = float(v)
    return v if math.isfinite(v) else None


def find_reference_candidates(
    levels: Sequence[xr.Dataset],
    crs: Any,
    params: CandidateParams | None = None,
    *,
    sources: Sequence[Source | None] | None = None,
) -> dict:
    """Rank stable reference-point candidates (see the module docstring).

    Parameters
    ----------
    levels : sequence of xarray.Dataset
        The cube's pyramid, full resolution first (one dataset for a flat
        store). Layers have ``y``/``x`` pixel-centre coordinates.
    crs : pyproj.CRS or anything ``CRS.from_user_input`` takes
        The grid's CRS: projected, in metres.
    params : CandidateParams
        Radius, count, spacing, thresholds and layer names.
    sources : sequence of refstats.Source, optional
        Where each level was read from, to keep the per-pixel reductions in the
        disk cache across restarts (memory only without it).

    Returns
    -------
    dict
        The ``GET /reference_candidates`` body (``api_models.ReferenceCandidates``).

    Raises
    ------
    MissingLayerError
        When the coherence or similarity layer is missing.
    CandidateError
        For a geographic CRS or invalid parameters.

    """
    params = params or CandidateParams()
    params.check()
    t_start = time.perf_counter()
    crs = CRS.from_user_input(crs)
    if not crs.is_projected or any(
        a.unit_conversion_factor != 1.0 for a in crs.axis_info[:2]
    ):
        raise CandidateError("Reference candidates need a projected CRS in metres")
    li, layers, stride = plan(levels, params)
    full = levels[0]
    ds = levels[li]
    source = sources[li] if sources is not None else None
    screen_px = _pixel_size(ds)
    full_px = _pixel_size(full)
    n_dates = sum(b - a for a, b in selected_dates(ds[layers["coherence"]], stride))

    scr, cached = _screen(ds, layers, stride, source)
    t_stats = time.perf_counter()
    mc_valid = scr.med_c[scr.valid]
    mp_valid = scr.med_p[scr.valid]
    if mc_valid.size == 0:
        raise CandidateError("No valid pixels: everything is masked or NaN")
    t_c = (
        float(params.coherence_min)
        if params.coherence_min is not None
        else float(np.quantile(mc_valid.astype(np.float64), params.quantile))
    )
    t_p = (
        float(params.similarity_min)
        if params.similarity_min is not None
        else float(np.quantile(mp_valid.astype(np.float64), params.quantile))
    )
    k = params.k_std
    scr.finish(k, t_c, t_p)

    # Screening radius: at least the centre pixel on a coarse level.
    dy, dx = disc_offsets(ds, params.radius_m)
    runs = _row_runs(dy, dx)
    frac, mean, n_valid, nscore = scr.neighbourhood(runs, dy.size)

    sep = params.separation_m
    n_short = max(3 * params.n, params.n + 10)
    order = np.argsort(-nscore, axis=None, kind="stable")
    order = order[np.isfinite(nscore.ravel()[order])]
    rr, cc = np.unravel_index(order, nscore.shape)
    xv, yv = ds["x"].values, ds["y"].values
    picks = _pick_spaced(order, xv[cc], yv[rr], sep, n_short)
    t_nbhd = time.perf_counter()

    # A coarse level or a date subset only screens: the shortlist is then
    # recomputed at full resolution with every date.
    refined = li != 0 or stride > 1
    if refined:
        fdy, fdx = disc_offsets(full, params.radius_m)
        fruns = _row_runs(fdy, fdx)
        full_disc = fdy.size
        # Search the coarse pixel's footprint; on level 0, the pixel itself.
        half = screen_px / 2.0 if li != 0 else 0.0

    def evaluate(p: int) -> dict[str, Any] | None:
        r, c = int(rr[p]), int(cc[p])
        stats: dict[str, Any] | None
        if not refined:
            stats = {
                "row": r,
                "col": c,
                "x": float(xv[c]),
                "y": float(yv[r]),
                "mc": scr.med_c[r, c],
                "sc": scr.std_c[r, c],
                "mp": scr.med_p[r, c],
                "sp": scr.std_p[r, c],
                "score": scr.score[r, c],
                "frac": frac[r, c],
                "mean": mean[r, c],
                "nscore": nscore[r, c],
            }
        else:
            stats = _refine(
                full,
                layers,
                float(xv[c]),
                float(yv[r]),
                half,
                full_px,
                params,
                k,
                t_c,
                t_p,
                fruns,
                full_disc,
            )
        if stats is None:
            return None
        scatter = None
        if layers["displacement"] is not None:
            scatter, _ = displacement_scatter(
                full, layers["displacement"], stats["x"], stats["y"], params.radius_m
            )
        s0 = params.scatter_scale_m
        final = stats["nscore"] * (s0 / (s0 + scatter) if scatter is not None else 1.0)
        stats["scatter"] = scatter
        stats["final"] = float(final)
        return stats

    to_lonlat = Transformer.from_crs(crs, 4326, always_xy=True)
    # Each shortlisted circle reads its own window of every date: in parallel.
    workers = min(read_workers(), max(len(picks), 1))
    if workers > 1:
        with ThreadPoolExecutor(workers) as pool:
            evaluated = list(pool.map(evaluate, picks))
    else:
        evaluated = [evaluate(p) for p in picks]
    rows_out: list[dict] = [e for e in evaluated if e is not None]

    if refined:  # refined centres moved: keep the spacing
        rows_out.sort(key=lambda s: -s["nscore"])
        keep = _pick_spaced(
            np.arange(len(rows_out)),
            np.array([s["x"] for s in rows_out]),
            np.array([s["y"] for s in rows_out]),
            sep,
            len(rows_out),
        )
        rows_out = [rows_out[i] for i in keep]
    rows_out.sort(key=lambda s: -s["final"])  # stable: ties keep NMS order
    rows_out = rows_out[: params.n]

    vel = layers["velocity"]
    vel_da = full[vel] if vel is not None and full[vel].ndim == 2 else None
    candidates = []
    for rank, s in enumerate(rows_out, start=1):
        lon, lat = to_lonlat.transform(s["x"], s["y"])
        v = None
        if vel_da is not None:
            v = _f(vel_da.isel(y=s["row"], x=s["col"]).values)
        cand = {
            "rank": rank,
            "lon": float(lon),
            "lat": float(lat),
            "radius_m": float(params.radius_m),
            "x": s["x"],
            "y": s["y"],
            "row": s["row"],
            "col": s["col"],
            "temporal_coherence_median": _f(s["mc"]),
            "temporal_coherence_std": _f(s["sc"]),
            "phase_similarity_median": _f(s["mp"]),
            "phase_similarity_std": _f(s["sp"]),
            "pixel_score": _f(s["score"]),
            "viable_fraction": _f(s["frac"]),
            "mean_score": _f(s["mean"]),
            "neighbourhood_score": _f(s["nscore"]),
            "displacement_scatter_m": s["scatter"],
            "score": _f(s["final"]),
            "velocity": v,
        }
        cand["reason"] = _reason(cand, params, t_c, t_p)
        candidates.append(cand)

    t_end = time.perf_counter()
    logger.info(
        "reference candidates: stats %.2f s (cached=%s), neighbourhood %.2f s, "
        "candidates %.2f s, total %.2f s",
        t_stats - t_start,
        cached,
        t_nbhd - t_stats,
        t_end - t_nbhd,
        t_end - t_start,
    )
    return {
        "recommended": candidates[0] if candidates else None,
        "candidates": candidates,
        "thresholds": {
            "temporal_coherence_median_min": t_c,
            "phase_similarity_median_min": t_p,
            "from_quantile": {
                "temporal_coherence": params.coherence_min is None,
                "phase_similarity": params.similarity_min is None,
            },
            "quantile": params.quantile,
            "k_std": k,
            "scatter_scale_m": params.scatter_scale_m,
        },
        "distribution": {
            "temporal_coherence_median": _pct(mc_valid),
            "phase_similarity_median": _pct(mp_valid),
            "n_valid_pixels": int(scr.valid.sum()),
            "n_viable_pixels": int(scr.viable.sum()),
        },
        "parameters": {
            "radius_m": float(params.radius_m),
            "min_separation_m": float(sep),
            "n": int(params.n),
            "use_masks": bool(params.use_masks),
        },
        "layers": {
            "temporal_coherence": layers["coherence"],
            "phase_similarity": layers["similarity"],
            "displacement": layers["displacement"],
            "velocity": vel,
            "water_mask": layers["water_mask"],
            "masks": list(layers["masks"]),
        },
        "screening": {
            "level": li,
            "pixel_size_m": screen_px,
            "full_pixel_size_m": full_px,
            "refined": refined,
            "circle_pixels": int(dy.size),
            "date_stride": int(stride),
            "dates_screened": int(n_dates),
        },
        "cached": bool(cached),
    }


def plan(
    levels: Sequence[xr.Dataset], params: CandidateParams
) -> tuple[int, dict[str, Any], int]:
    """Return the screening level, the layers and the date stride of a search."""
    full = levels[0]
    layers: dict[str, Any] = {
        "coherence": _layer(full, params.coherence_layer, required=True),
        "similarity": _layer(full, params.similarity_layer, required=True),
        "displacement": _layer(full, params.displacement_layer, required=False),
        "velocity": _layer(full, params.velocity_layer, required=False),
        "water_mask": _layer(full, params.water_mask_layer, required=False),
        "masks": [
            m
            for m in (params.mask_layers if params.use_masks else ())
            if _layer(full, m, required=False)
        ],
    }
    usable = [
        i
        for i, lv in enumerate(levels)
        if all(
            n is None or n in lv.data_vars
            for n in (
                layers["coherence"],
                layers["similarity"],
                layers["water_mask"],
                *layers["masks"],
            )
        )
    ]
    li = usable[_choose_level([levels[i] for i in usable], params.max_screen_pixels)]
    stride = params.screen_stride
    if stride is None:  # automatic: every date unless the screening read is huge
        ds = levels[li]
        nt = ds[layers["coherence"]].size // (ds.sizes["y"] * ds.sizes["x"])
        pixels = ds.sizes["y"] * ds.sizes["x"]
        stride = 1
        while nt / stride * pixels > AUTO_STRIDE_VALUES and stride < nt:
            stride += 1
    return li, layers, int(stride)


def _warm_layers(levels: Sequence[xr.Dataset], params: CandidateParams):
    li, layers, stride = plan(levels, params)
    names = [(layers["coherence"], stride), (layers["similarity"], stride)]
    if layers["water_mask"]:
        names.append((layers["water_mask"], 1))
    names += [(m, stride) for m in layers["masks"]]
    return li, names


def warm_up(
    levels: Sequence[xr.Dataset],
    *,
    sources: Sequence[Source | None] | None = None,
    default: bool = True,
    params: CandidateParams | None = None,
) -> bool:
    """Start computing a cube's default reductions in the background.

    Off when ``BOWSER_REFSTATS_WARMUP`` says so (or ``default`` is False and it is
    unset), and for cubes without coherence and similarity. Returns whether a
    warm-up started. Never raises.
    """
    if not warm_up_enabled(default) or not levels:
        return False
    try:
        li, names = _warm_layers(levels, params or CandidateParams())
    except (CandidateError, KeyError):
        return False
    except Exception as e:  # noqa: BLE001 - opening a cube must not fail on this
        logger.warning(f"reference candidates: no warm-up: {e}")
        return False
    return start_warm_up(levels[li], names, sources[li] if sources else None)


def status(levels: Sequence[xr.Dataset], params: CandidateParams | None = None) -> dict:
    """Progress of the reductions a default search needs (``GET .../status``)."""
    params = params or CandidateParams()
    try:
        li, names = _warm_layers(levels, params)
    except (CandidateError, KeyError) as e:
        return {"state": "unavailable", "progress": 0.0, "layers": {}, "detail": str(e)}
    ds = levels[li]
    out: dict[str, dict[str, Any]] = {}
    for name, stride in names:
        state, prog = STATS_CACHE.state(ds, name, stride)
        out[name] = {"state": state, "progress": prog}
    states = {v["state"] for v in out.values()}
    overall = (
        "ready" if states == {"ready"} else "running" if "running" in states else "idle"
    )
    progress = sum(v["progress"] for v in out.values()) / max(len(out), 1)
    return {"state": overall, "progress": progress, "layers": out, "detail": None}


def _refine(
    full: xr.Dataset,
    layers: dict[str, Any],
    x0: float,
    y0: float,
    half: float,
    full_px: float,
    params: CandidateParams,
    k: float,
    t_c: float,
    t_p: float,
    runs: list[tuple[int, int, int]],
    disc_size: int,
) -> dict | None:
    """Best full-resolution centre within ``half`` of ``(x0, y0)``, all dates."""
    xv, yv = full["x"].values, full["y"].values
    reach = half + params.radius_m + 2 * full_px
    cols = np.flatnonzero(np.abs(xv - x0) <= reach)
    rows = np.flatnonzero(np.abs(yv - y0) <= reach)
    if cols.size == 0 or rows.size == 0:
        return None
    rs = slice(int(rows[0]), int(rows[-1]) + 1)
    cs = slice(int(cols[0]), int(cols[-1]) + 1)
    mc, sc = stack_median_std(full[layers["coherence"]], rs, cs)
    mp, sp = stack_median_std(full[layers["similarity"]], rs, cs)
    keep = _window_keep(full, layers, rs, cs)
    win = _Screen(mc, sc, mp, sp, np.ones(mc.shape, bool) if keep is None else keep)
    win.finish(k, t_c, t_p)
    frac, mean, _, nscore = win.neighbourhood(runs, disc_size)
    wx, wy = xv[cs], yv[rs]
    inner = (np.abs(wy - y0)[:, None] <= half) & (np.abs(wx - x0)[None, :] <= half)
    nscore = np.where(inner, nscore, -np.inf)
    best = int(np.argmax(nscore))
    r, c = np.unravel_index(best, nscore.shape)
    if not np.isfinite(nscore[r, c]):
        return None
    return {
        "row": int(rs.start + r),
        "col": int(cs.start + c),
        "x": float(wx[c]),
        "y": float(wy[r]),
        "mc": mc[r, c],
        "sc": sc[r, c],
        "mp": mp[r, c],
        "sp": sp[r, c],
        "score": win.score[r, c],
        "frac": frac[r, c],
        "mean": mean[r, c],
        "nscore": nscore[r, c],
    }


def _reason(c: dict, params: CandidateParams, t_c: float, t_p: float) -> str:
    """One line on why a candidate ranks where it does."""
    parts = [
        f"coherence median {c['temporal_coherence_median']:.2f} (>= {t_c:.2f}), "
        f"similarity median {c['phase_similarity_median']:.2f} (>= {t_p:.2f})"
    ]
    if params.radius_m > 0:
        parts.append(
            f"{100 * (c['viable_fraction'] or 0):.0f}% of the "
            f"{params.radius_m:g} m circle viable"
        )
    if c["displacement_scatter_m"] is not None:
        parts.append(
            f"displacement scatter {1000 * c['displacement_scatter_m']:.1f} mm"
        )
    return "; ".join(parts)


def candidate_query(
    radius_m: float = Query(100.0, ge=0, le=5000, **api.PARAMS["radius_m"]),
    n: int = Query(5, ge=1, le=50, **api.PARAMS["n_candidates"]),
    min_separation_m: Optional[float] = Query(
        None, ge=0, **api.PARAMS["min_separation_m"]
    ),
    use_masks: bool = Query(False, **api.PARAMS["use_masks"]),
    coherence_min: Optional[float] = Query(None, **api.PARAMS["coherence_min"]),
    similarity_min: Optional[float] = Query(None, **api.PARAMS["similarity_min"]),
    quantile: float = Query(0.95, gt=0, lt=1, **api.PARAMS["quantile"]),
    k_std: float = Query(1.0, ge=0, **api.PARAMS["k_std"]),
    coherence_layer: str = Query("temporal_coherence", **api.PARAMS["coherence_layer"]),
    similarity_layer: str = Query("phase_similarity", **api.PARAMS["similarity_layer"]),
    displacement_layer: str = Query("displacement", **api.PARAMS["displacement_layer"]),
    screen_stride: Optional[int] = Query(
        None, ge=1, le=64, **api.PARAMS["screen_stride"]
    ),
) -> CandidateParams:
    """FastAPI dependency: the ``GET /reference_candidates`` query, for both servers."""
    return CandidateParams(
        radius_m=radius_m,
        n=n,
        min_separation_m=min_separation_m,
        use_masks=use_masks,
        coherence_min=coherence_min,
        similarity_min=similarity_min,
        quantile=quantile,
        k_std=k_std,
        coherence_layer=coherence_layer,
        similarity_layer=similarity_layer,
        displacement_layer=displacement_layer,
        screen_stride=screen_stride,
    )


def run_or_http_error(
    levels: Sequence[xr.Dataset],
    crs: Any,
    params: CandidateParams,
    sources: Sequence[Source | None] | None = None,
) -> dict:
    """:func:`find_reference_candidates`, with its errors as HTTP 404 / 400."""
    try:
        return find_reference_candidates(levels, crs, params, sources=sources)
    except MissingLayerError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except (CandidateError, LayerShapeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


__all__ = [
    "CandidateError",
    "CandidateParams",
    "MissingLayerError",
    "STATS_CACHE",
    "Source",
    "candidate_query",
    "plan",
    "status",
    "warm_up",
    "find_reference_candidates",
    "run_or_http_error",
]
