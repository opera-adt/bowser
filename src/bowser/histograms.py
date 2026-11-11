"""Per-date histograms for the colour scale, one date or every date in one pass.

``GET /histogram/{layer}?time_index=t`` is asked on every date change. Cubes made
by ``bowser`` carry every date's histogram in the layer's ``bowser_histogram``
attribute (:func:`compute_histograms`
writes it). Without it, the servers used to read the date at full
resolution: on a DISP-S1 frame (7733 x 9464, chunks of 8 dates x 256 x 256) about
5 s of CPU on the full server and 2 s on bowser-lite, because the read decodes
the 8 dates of every chunk and the percentiles sort ~11 M values. Now:

- **A coarse pyramid level.** :func:`pick_level` chooses, once per cube and
  layer, the finest level expected to hold at most :func:`max_pixels` valid
  pixels (level 0 when the cube is small or has no pyramid, so small cubes are
  unchanged). On that frame it is level 1 (3.5 M valid pixels, 0.6 s of CPU).
  Levels are 2x2 averages, which narrows the distribution a little: against full
  resolution, over six dates, p2/p98 moved by at most 2.5 mm (1.3 % of their
  range) and p16/p84 by at most 6.2 mm. A strided sample of level 0 is exact
  but costs as much as the full read, since every chunk must still be decoded.

Environment: ``BOWSER_HISTOGRAM_MAX_PIXELS`` (4 000 000) the valid pixels to aim
for, ``0`` for full resolution.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import xarray as xr

from . import refstats
from .refstats import Source, read_lazy

logger = logging.getLogger("bowser")

#: The percentiles returned, by key: 2/98, 1 and 2 sigma of a normal distribution.
PERCENTILES = (
    ("p2", 2.0),
    ("p98", 98.0),
    ("p16", 16.0),
    ("p84", 84.0),
    ("p23", 2.275),
    ("p977", 97.725),
)
#: Bins of the stored histograms (and of the UI's requests).
NBINS = 100
#: Histograms kept in memory (a few KB each).
CACHE_SIZE = 8192
#: Bytes of one read of the one-pass computation (as ``refstats.READ_BYTES``).
READ_BYTES = refstats.READ_BYTES
_SPATIAL = ("y", "x")


def max_pixels() -> int:
    """Return the valid pixels to aim for: ``BOWSER_HISTOGRAM_MAX_PIXELS`` (4e6).

    ``0`` (or less) always reads full resolution.
    """
    try:
        return int(float(os.environ.get("BOWSER_HISTOGRAM_MAX_PIXELS", 4e6)))
    except ValueError:
        return 4_000_000


# --- one date ----------------------------------------------------------------------


def summarize(values: np.ndarray, nbins: int = NBINS, level: int = 0) -> dict[str, Any]:
    """Return the histogram, min, max and percentiles of the finite ``values``.

    The order of ``values`` does not matter, so a date read in pieces gives the
    same result as read whole.
    """
    v = np.asarray(values).ravel()
    v = v[np.isfinite(v)].astype(np.float64, copy=False)
    if v.size == 0:
        # An empty view returns an empty histogram at 200 rather than 204:
        # HTTP 204 must have an empty body, which breaks clients calling .json().
        return dict.fromkeys(("min", "max", *(k for k, _ in PERCENTILES)), 0.0) | {
            "bins": [],
            "counts": [],
            "level": level,
        }
    counts, edges = np.histogram(v, bins=nbins)
    pct = np.percentile(v, [q for _, q in PERCENTILES])
    return (
        {
            "bins": edges.tolist(),
            "counts": counts.tolist(),
            "min": float(v.min()),
            "max": float(v.max()),
        }
        | {k: float(p) for (k, _), p in zip(PERCENTILES, pct)}
        | {"level": level}
    )


def stored(da: xr.DataArray, index: int) -> dict | None:
    """Return the histogram stored in the cube for step ``index``, if any."""
    entries = da.attrs.get("bowser_histogram")
    if isinstance(entries, list) and 0 <= index < len(entries):
        entry = entries[index]
        if isinstance(entry, dict) and "bins" in entry and "counts" in entry:
            return entry
    return None


def _step(da: xr.DataArray, t: int) -> xr.DataArray:
    extra = [d for d in da.dims if d not in _SPATIAL]
    return da.isel({extra[0]: t}) if extra else da


def _pixels(da: xr.DataArray) -> int:
    return int(da.sizes.get("y", 1) * da.sizes.get("x", 1))


def _nsteps(da: xr.DataArray) -> int:
    extra = [d for d in da.dims if d not in _SPATIAL]
    return int(da.sizes[extra[0]]) if extra else 1


def layers(levels: Sequence[xr.Dataset], name: str) -> list[xr.DataArray]:
    """Return the layer at each level, finest first, up to one without it."""
    out: list[xr.DataArray] = []
    for ds in levels:
        if name not in ds.data_vars:
            break
        da = ds[name]
        if out and da.shape[:-2] != out[0].shape[:-2]:
            break  # not the same dates
        out.append(da)
    return out


def _read(da: xr.DataArray, t: int, source: Source | None = None) -> np.ndarray:
    """Read step ``t`` of ``da``: directly through zarr when that gives the same values.

    (``refstats.direct_array``: the full server's dask-backed arrays read several
    times slower through dask, even with its synchronous scheduler.)
    """
    raw = refstats.direct_array(da, source)
    if raw is not None:
        return np.asarray(raw[t] if da.ndim == 3 else raw[...])
    return read_lazy(_step(da, t))


def pick_level(
    levels: Sequence[xr.Dataset],
    name: str,
    limit: int | None = None,
    sources: Sequence[Source | None] | None = None,
) -> int:
    """Return the level to summarise layer ``name`` at, for every date.

    The finest level expected to hold at most ``limit`` (:func:`max_pixels`)
    valid pixels. A level with at most ``limit`` pixels in all is safe; finer
    ones are estimated on the middle date from the valid pixels of that level and
    of the next coarser one (their ratio, at most the ratio of their sizes),
    extrapolated level by level. It depends only on the cube, so both servers,
    every date and the background computation agree. ``sources``: where each
    level was read from, to read it directly.
    """
    limit = max_pixels() if limit is None else limit
    das = layers(levels, name)
    if limit <= 0 or len(das) <= 1 or _pixels(das[0]) <= limit:
        return 0
    safe = next((i for i, d in enumerate(das) if _pixels(d) <= limit), len(das) - 1)
    t = _nsteps(das[0]) // 2

    def src(i: int) -> Source | None:
        return sources[i] if sources and i < len(sources) else None

    n_safe = int(np.isfinite(_read(das[safe], t, src(safe))).sum())
    ratio = _pixels(das[safe - 1]) / _pixels(das[safe]) if safe > 0 else 1.0
    growth = ratio
    if safe + 1 < len(das):
        n_coarse = int(np.isfinite(_read(das[safe + 1], t, src(safe + 1))).sum())
        if n_coarse:
            growth = min(max(n_safe / n_coarse, 1.0), ratio)
    level, estimate = safe, float(n_safe)
    while level > 0 and estimate * growth <= limit:
        estimate *= growth
        level -= 1
    return level


def compute_one(
    da: xr.DataArray,
    t: int,
    nbins: int = NBINS,
    level: int = 0,
    source: Source | None = None,
) -> dict:
    """Summarise step ``t`` of ``da`` (one level of a layer, read from ``source``)."""
    return summarize(_read(da, t, source), nbins, level)


# --- every date in one pass ----------------------------------------------------------


def _blocks(shape: tuple[int, int, int], chunks: tuple[int, int, int]) -> list:
    """Chunk-aligned ``(y, x)`` windows of about :data:`READ_BYTES` per time block."""
    nt, ny, nx = shape
    ct, cy, cx = chunks
    per_col = max(1, READ_BYTES // max(1, 4 * min(ct, nt) * cy * cx))
    wx = cx * per_col
    return [
        (slice(y0, min(ny, y0 + cy)), slice(x0, min(nx, x0 + wx)))
        for y0 in range(0, ny, cy)
        for x0 in range(0, nx, wx)
    ]


def compute_histograms(
    da: xr.DataArray,
    nbins: int = NBINS,
    *,
    level: int = 0,
    source: Source | None = None,
    workers: int = 1,
    pause: Callable[[], object] | None = None,
    on_block: Callable[[int, list[dict]], None] | None = None,
) -> list[dict]:
    """Return every step's histogram of ``da`` in one pass over its chunks.

    The format of the ``bowser_histogram`` attribute: one :func:`summarize` dict
    per step (one for a 2-D layer), equal to summarising each step on its own.
    The stack is read one time chunk at a time (all of its dates together), in
    chunk-aligned windows by ``workers`` threads (directly through zarr when
    that gives the same values, see ``refstats.direct_array``). ``pause`` runs
    before each read (the background warm-up yields there); ``on_block`` gets
    ``(first step, its histograms)`` after each time chunk.
    """
    if da.ndim == 2:
        one = [summarize(read_lazy(da.transpose("y", "x")), nbins, level)]
        if on_block:
            on_block(0, one)
        return one
    da = refstats.as_tyx(da)
    raw = refstats.direct_array(da, source)
    ct, cy, cx = refstats._chunks(da)
    nt = da.shape[0]
    windows = _blocks(da.shape, (ct, cy, cx))

    def read(t0: int, t1: int, w: tuple[slice, slice]) -> list[np.ndarray]:
        if pause is not None:
            pause()
        ys, xs = w
        block = (
            np.asarray(raw[t0:t1, ys, xs])
            if raw is not None
            else read_lazy(da[t0:t1, ys, xs])
        )
        block = block.reshape(t1 - t0, -1)
        return [b[np.isfinite(b)] for b in block]

    out: list[dict] = []
    with ThreadPoolExecutor(max(1, workers)) as pool:
        for t0 in range(0, nt, ct):
            t1 = min(nt, t0 + ct)
            parts = list(pool.map(lambda w, a=t0, b=t1: read(a, b, w), windows))
            block = [
                summarize(
                    np.concatenate([p[i] for p in parts])
                    if parts
                    else np.empty(0, da.dtype),
                    nbins,
                    level,
                )
                for i in range(t1 - t0)
            ]
            out.extend(block)
            if on_block:
                on_block(t0, block)
    return out
