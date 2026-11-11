"""Per-date histograms for the colour scale: cheap, cached, never on the event loop.

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
- **Cached** per opened dataset, layer, date and bin count (:class:`Service`).
- **One computation at a time**, in a worker thread. Identical requests share
  one computation; a queued one whose every client has gone (the page aborts the
  request of a date it has moved past) is dropped before it starts.
- **Every date in the background** (:func:`start_warm_up`): the first request
  for a layer without the attribute starts a one-pass computation of all dates at
  the same level, kept on disk next to the reference finder's statistics
  (``bowser.refstats``: same folder, fingerprint and limits), so a restarted
  server has them at once. It waits until the server is idle and pauses while
  any request is in flight, like the reference finder's warm-up.

Environment: ``BOWSER_HISTOGRAM_MAX_PIXELS`` (4 000 000) the valid pixels to aim
for, ``0`` for full resolution; ``BOWSER_HISTOGRAM_WARMUP`` (``1``) ``0`` turns
the background computation off. The warm-up's delays, guard and disk cache
follow the ``BOWSER_REFSTATS_*`` settings.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import threading
import time
import weakref
from collections import OrderedDict
from collections.abc import Callable, Hashable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio.to_thread
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


def warm_up_enabled() -> bool:
    """Whether to compute every date in the background: ``BOWSER_HISTOGRAM_WARMUP``."""
    v = os.environ.get("BOWSER_HISTOGRAM_WARMUP", "1")
    return v.lower() not in ("0", "false", "no")


# --- one date ----------------------------------------------------------------------


def summarize(values: np.ndarray, nbins: int = NBINS, level: int = 0) -> dict[str, Any]:
    """Return the histogram, min, max and percentiles of the finite ``values``.

    The order of ``values`` does not matter, so a date read in pieces gives the
    same result as read whole. Only NaN and infinities are dropped: 0 is a value
    of categorical and mask layers (``ps_mask``, ``recommended_mask``).
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


# --- disk cache ---------------------------------------------------------------------


def disk_key(source: Source | None, name: str, level: int, nbins: int) -> str | None:
    """Return the disk cache key of a layer's histograms (None: cache off)."""
    key = refstats.disk_key(source, name, stride=1)
    if key is None:
        return None
    d = json.loads(key)
    d.update({"v": 1, "kind": "histogram", "level": int(level), "nbins": int(nbins)})
    d.pop("stride", None)
    return json.dumps(d, sort_keys=True)


def _path_for(key: str) -> Path | None:
    root = refstats.cache_dir()
    if root is None:
        return None
    return root / f"{hashlib.sha256(key.encode()).hexdigest()[:40]}.json"


def load_cached(key: str | None) -> list[dict] | None:
    """Return the histograms stored under ``key``, or None."""
    path = _path_for(key) if key else None
    if path is None or not path.exists():
        return None
    try:
        doc = json.loads(path.read_text())
        if doc.get("key") != key or not isinstance(doc.get("histograms"), list):
            return None
        os.utime(path)  # used: the size limit removes the least recently used
        return doc["histograms"]
    except Exception as e:  # noqa: BLE001 - a bad file is a cache miss
        logger.warning(f"histogram: ignoring unreadable cache file {path}: {e}")
        return None


def save_cached(key: str | None, histograms: list[dict]) -> None:
    """Store histograms under ``key`` atomically, then apply the cache limits."""
    path = _path_for(key) if key else None
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.stem}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps({"key": key, "histograms": histograms}))
        tmp.replace(path)
    except OSError as e:
        logger.warning(f"histogram: could not write the cache file {path}: {e}")
        return
    refstats.prune()


# --- serving ---------------------------------------------------------------------


@dataclass
class _Loop:
    """What one event loop's requests share: the slot and the computations."""

    slot: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))
    flights: dict[Hashable, asyncio.Future] = field(default_factory=dict)
    waiters: dict[Hashable, int] = field(default_factory=dict)


class Service:
    """Cached histograms, computed one at a time off the event loop.

    Entries are kept per ``owner`` (the opened dataset, held weakly, so a closed
    cube's entries never match a new one at the same address) and ``key``
    (anything hashable naming the layer, date and parameters).
    """

    def __init__(self, size: int = CACHE_SIZE) -> None:  # noqa: D107
        self._size = size
        self._lock = threading.Lock()
        self._cache: OrderedDict[Hashable, tuple[weakref.ref, dict]] = OrderedDict()
        self._loops: weakref.WeakKeyDictionary[
            asyncio.AbstractEventLoop, _Loop
        ] = weakref.WeakKeyDictionary()
        #: Computations run and dropped (for tests and logs).
        self.computed = 0
        self.skipped = 0

    def cached(self, owner: object, key: Hashable) -> dict | None:
        """Return the cached histogram, or None."""
        with self._lock:
            hit = self._cache.get((id(owner), key))
            if hit is None or hit[0]() is not owner:
                return None
            self._cache.move_to_end((id(owner), key))
            return hit[1]

    def store(self, owner: object, key: Hashable, value: dict) -> None:
        """Keep ``value``, dropping the least recently used beyond the size."""
        with self._lock:
            self._cache[(id(owner), key)] = (weakref.ref(owner), value)
            self._cache.move_to_end((id(owner), key))
            while len(self._cache) > self._size:
                self._cache.popitem(last=False)

    def clear(self) -> None:
        """Forget every cached histogram."""
        with self._lock:
            self._cache.clear()

    def _loop(self) -> _Loop:
        loop = asyncio.get_running_loop()
        state = self._loops.get(loop)
        if state is None:
            state = self._loops[loop] = _Loop()
        return state

    async def get(
        self, owner: object, key: Hashable, compute: Callable[[], dict]
    ) -> dict:
        """Return the histogram for ``key``: cached, shared or computed.

        ``compute`` runs in a worker thread, one at a time per event loop. A
        request for a computation already queued or running waits for it. When
        every request waiting for a queued computation has gone (cancelled, as
        on a client disconnect), it is dropped before it starts.
        """
        state = self._loop()
        k = (id(owner), key)
        while True:
            hit = self.cached(owner, key)
            if hit is not None:
                return hit
            task = state.flights.get(k)
            if task is None or task.done():
                task = asyncio.ensure_future(self._run(state, owner, key, compute))
                state.flights[k] = task
                task.add_done_callback(lambda t: _finish(state, k, t))
            state.waiters[k] = state.waiters.get(k, 0) + 1
            try:
                value = await asyncio.shield(task)
            finally:
                state.waiters[k] -= 1
                if not state.waiters[k]:
                    del state.waiters[k]
            if value is not None:
                return value

    async def _run(
        self, state: _Loop, owner: object, key: Hashable, compute: Callable[[], dict]
    ) -> dict | None:
        async with state.slot:
            hit = self.cached(owner, key)
            if hit is not None:
                return hit
            if not state.waiters.get((id(owner), key)):
                self.skipped += 1
                return None  # nobody waits for it any more
            self.computed += 1
            value = await anyio.to_thread.run_sync(compute)
            self.store(owner, key, value)
            return value


def _finish(state: _Loop, k: Hashable, task: asyncio.Future) -> None:
    if state.flights.get(k) is task:
        del state.flights[k]
    if not task.cancelled():
        task.exception()  # retrieved, so an error nobody awaited is not logged


#: The process-wide service both servers use.
SERVICE = Service()


# --- what the endpoints call ------------------------------------------------------

_levels_lock = threading.Lock()
_levels: dict[tuple[int, str], tuple[weakref.ref, int]] = {}


def level_for(
    levels: Sequence[xr.Dataset],
    name: str,
    sources: Sequence[Source | None] | None = None,
) -> int:
    """:func:`pick_level`, remembered per opened dataset and layer."""
    owner = levels[0]
    k = (id(owner), name)
    with _levels_lock:
        hit = _levels.get(k)
        if hit is not None and hit[0]() is owner:
            return hit[1]
    level = pick_level(levels, name, sources=sources)
    with _levels_lock:
        _levels[k] = (weakref.ref(owner), level)
    return level


async def histogram(
    levels: Sequence[xr.Dataset],
    name: str,
    t: int,
    nbins: int = NBINS,
    *,
    sources: Sequence[Source | None] | None = None,
    workers: int | None = None,
) -> dict:
    """Return the histogram of step ``t`` of layer ``name`` of a cube's levels.

    The stored attribute when present; otherwise cached or computed on demand at
    :func:`level_for`, and every date is started in the background.
    """
    da = levels[0][name]
    hit = stored(da, t if da.ndim > 2 else 0)
    if hit is not None:
        return hit
    owner = levels[0]

    def compute() -> dict:
        level = level_for(levels, name, sources)
        if nbins == NBINS:
            start_warm_up(levels, name, level, sources=sources, workers=workers)
        source = sources[level] if sources and level < len(sources) else None
        return compute_one(layers(levels, name)[level], t, nbins, level, source)

    return await SERVICE.get(owner, (name, t, nbins), compute)


# --- every date in the background -------------------------------------------------

_warm_lock = threading.Lock()
_warming: dict[tuple[int, str], weakref.ref] = {}
#: Background computations finished (for tests).
WARM_DONE: dict[tuple[int, str], str] = {}


def start_warm_up(
    levels: Sequence[xr.Dataset],
    name: str,
    level: int,
    *,
    sources: Sequence[Source | None] | None = None,
    workers: int | None = None,
) -> bool:
    """Compute every date of a layer at ``level`` in a background thread, once.

    Loads them from the disk cache when there; otherwise waits for the start
    delay and an idle server, then reads with ``workers`` threads (default
    ``refstats.read_workers()``; bowser-lite passes 1) at low CPU priority,
    pausing before each read while a request is in flight (the reference
    finder's guard, ``bowser.refstats``). Each finished time chunk goes into
    :data:`SERVICE`, then all of them to disk. Returns whether it started.
    """
    if not warm_up_enabled():
        return False
    owner = levels[0]
    k = (id(owner), name)
    with _warm_lock:
        ref = _warming.get(k)
        if ref is not None and ref() is owner:
            return False
        _warming[k] = weakref.ref(owner)
    da = layers(levels, name)[level]
    source = sources[level] if sources and level < len(sources) else None
    n_workers = refstats.read_workers() if workers is None else workers
    opened = time.monotonic()

    def publish(t0: int, block: list[dict]) -> None:
        for i, h in enumerate(block):
            SERVICE.store(owner, (name, t0 + i, NBINS), h)

    def run() -> None:
        try:
            key = disk_key(source, name, level, NBINS)
            done = load_cached(key)
            how = "disk"
            if done is None:
                refstats.lower_priority()
                refstats.wait_until_idle(opened)
                t0 = time.perf_counter()
                done = compute_histograms(
                    da,
                    NBINS,
                    level=level,
                    source=source,
                    workers=n_workers,
                    pause=refstats.pause_for_requests,
                    on_block=publish,
                )
                how = "computed"
                logger.info(
                    f"histogram: every date of {name} (level {level}) "
                    f"in {time.perf_counter() - t0:.1f} s"
                )
                save_cached(key, done)
            else:
                publish(0, done)
            WARM_DONE[k] = how
        except Exception as e:  # noqa: BLE001 - never takes the server down
            logger.warning(f"histogram: background computation of {name} failed: {e}")
            WARM_DONE[k] = "failed"

    threading.Thread(target=run, name="bowser-histogram-warmup", daemon=True).start()
    return True
