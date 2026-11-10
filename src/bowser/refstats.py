"""Per-pixel median and std through time of a cube's layers, read fast and kept.

The reference finder (:mod:`bowser.reference_candidates`) needs, for every pixel,
the median and standard deviation over the whole stack of temporal coherence and
phase similarity. They do not depend on the reference or on any search
parameter, so they are computed once per cube and layer and kept:

- **in memory**, per opened dataset (:data:`STATS_CACHE`); a computation in
  progress is shared, so a request arriving during the background warm-up waits
  for it instead of starting a second one;
- **on disk**, as ``.npz`` files under :func:`cache_dir`, keyed by the store, the
  pyramid level, the layer, the date stride and a fingerprint of the layer's files
  (names, sizes, modification times), so a restarted server reuses them and a
  rewritten layer is recomputed. Old and least recently used files are removed
  beyond an age and a total size.

Reading is chunk-aligned and parallel (:func:`read_workers` threads), each
thread reusing one buffer: on a loaded machine, fresh large allocations (page
faults) cost more than decompressing the data.

Environment (read when used, so tests and servers can change them):

``BOWSER_REFSTATS_CACHE_DIR``
    Folder of the disk cache (default ``$XDG_CACHE_HOME/bowser/refstats``, i.e.
    ``~/.cache/bowser/refstats``, next to the DEM cache ``~/.cache/bowser/dem``).
``BOWSER_REFSTATS_CACHE``
    ``0`` turns the disk cache off.
``BOWSER_REFSTATS_CACHE_MAX_MB`` / ``BOWSER_REFSTATS_CACHE_MAX_AGE_DAYS``
    Limits of the disk cache (default 2048 MB, 30 days).
``BOWSER_REFSTATS_WORKERS``
    Reader threads (default 2).
``BOWSER_REFSTATS_WARMUP``
    ``1``/``0``: compute the reductions in the background when a cube is opened.
    Default on for the full server, off for bowser-lite (see
    :func:`warm_up_enabled`).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import weakref
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr

logger = logging.getLogger("bowser")

#: Bytes of one worker's read buffer (a chunk-aligned block, all selected dates).
BLOCK_BYTES = 128 * 1024**2
#: Bytes of one read call: zarr allocates its output, and allocations above
#: glibc's 32 MB mmap ceiling page-fault afresh every time.
READ_BYTES = 16 * 1024**2
#: Values reduced at a time (about 1 MB of float32: stays in the CPU cache).
TILE_ELEMENTS = 2**18

ProgressFn = Callable[[int, int], None]


class LayerShapeError(ValueError):
    """A layer is not ``(time, y, x)`` or ``(y, x)``."""


# --- settings ----------------------------------------------------------------------


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def cache_dir() -> Path | None:
    """Return the disk cache folder, or None when the disk cache is off.

    ``BOWSER_REFSTATS_CACHE_DIR`` when set, else ``$XDG_CACHE_HOME/bowser/refstats``
    (``~/.cache/bowser/refstats``), as the DEM cache (``~/.cache/bowser/dem``).
    """
    if os.environ.get("BOWSER_REFSTATS_CACHE", "1").lower() in ("0", "false", "no"):
        return None
    root = os.environ.get("BOWSER_REFSTATS_CACHE_DIR")
    if root:
        return Path(root)
    xdg = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(xdg) / "bowser" / "refstats"


def read_workers() -> int:
    """Reader threads: ``BOWSER_REFSTATS_WORKERS`` (default 2).

    Measured on Arkabutla (240 x 605 x 564, sharded Blosc zstd) on a shared,
    loaded 224-core machine, both layers, median of 5: 1 thread 6.9 s, 2 threads
    6.2 s, 4 threads 7.3 s, 8 threads 11.9 s. Decoding and the reductions hold
    the GIL often enough, and fresh buffers page-fault, so more threads contend.
    """
    return max(1, int(_env_float("BOWSER_REFSTATS_WORKERS", 2)))


def warm_up_enabled(default: bool) -> bool:
    """Whether to warm up on cube open: ``BOWSER_REFSTATS_WARMUP``, else ``default``.

    The full server defaults to on. bowser-lite defaults to off: it is the
    desktop app's server, often on a laptop, where reading every date of two
    layers (CPU, disk, battery, a few hundred MB of buffers) each time a cube is
    opened, whether or not the user ever asks for a reference, costs more than
    the one-time wait, which the disk cache then removes.
    """
    v = os.environ.get("BOWSER_REFSTATS_WARMUP")
    if v is None or v == "":
        return default
    return v.lower() not in ("0", "false", "no")


# --- the reduction ----------------------------------------------------------------


def nan_median_std(
    block: np.ndarray, dtype: Any = np.float32
) -> tuple[np.ndarray, ...]:
    """Return the NaN-ignoring median and population std of ``block`` along axis 0.

    The values of ``np.nanmedian`` and ``np.nanstd``, from one sort, and without
    numpy's warnings (``warnings.catch_warnings`` is not thread-safe, and this
    runs in reader threads). All-NaN pixels give NaN.
    """
    a = np.sort(block, axis=0)  # NaN sorts last
    nt = a.shape[0]
    with np.errstate(all="ignore"):
        if nt and not np.isnan(a[-1]).any():
            # No NaN in the tile (the usual case): fixed order statistics, and
            # the same arithmetic as below with every value valid.
            med = 0.5 * (a[(nt - 1) // 2].astype(np.float64) + a[nt // 2])
            z = a.astype(np.float64)
            d = z - z.sum(axis=0) / nt
            std = np.sqrt((d * d).sum(axis=0) / nt)
            return med.astype(dtype), std.astype(dtype)
        n = np.count_nonzero(~np.isnan(a), axis=0)
        lo = np.maximum((n - 1) // 2, 0)[None]
        hi = np.maximum(n // 2, 0)[None]
        med = 0.5 * (
            np.take_along_axis(a, lo, 0)[0].astype(np.float64)
            + np.take_along_axis(a, hi, 0)[0]
        )
        med[n == 0] = np.nan
        valid = np.arange(nt).reshape((-1,) + (1,) * (a.ndim - 1)) < n
        z = np.where(valid, a, 0).astype(np.float64)
        d = np.where(valid, z - z.sum(axis=0) / n, 0.0)
        std = np.sqrt((d * d).sum(axis=0) / n)
    return med.astype(dtype), std.astype(dtype)


def _reduce_in_tiles(block: np.ndarray, med: np.ndarray, std: np.ndarray) -> None:
    """Reduce ``block`` into ``med``/``std`` a cache-sized tile at a time.

    A ``(time, y, x)`` block reduced along time in one go strides through
    memory; reducing tiles of about :data:`TILE_ELEMENTS` values is an order
    of magnitude faster (0.3 s instead of 7 s for 240 x 256 x 564).
    """
    nt, ny, nx = block.shape
    cols = max(1, min(nx, TILE_ELEMENTS // max(nt, 1)))
    rows = max(1, TILE_ELEMENTS // max(nt * cols, 1))
    for r in range(0, ny, rows):
        for c in range(0, nx, cols):
            m, s = nan_median_std(block[:, r : r + rows, c : c + cols])
            med[r : r + rows, c : c + cols] = m
            std[r : r + rows, c : c + cols] = s


def as_tyx(da: xr.DataArray) -> xr.DataArray:
    """``da`` as ``(t, y, x)``: a 2-D layer gets a length-1 leading axis."""
    if da.ndim == 2:
        return da.transpose("y", "x").expand_dims("_t")
    if da.ndim != 3 or not {"y", "x"}.issubset(da.dims):
        raise LayerShapeError(f"Layer {da.name} must be (time, y, x) or (y, x)")
    return da.transpose(..., "y", "x")


def _chunks(da: xr.DataArray) -> tuple[int, int, int]:
    """Return the chunk sizes of a ``(t, y, x)`` array (t: 1, y/x: 512 if unknown)."""
    pref = da.encoding.get("preferred_chunks") or {}
    chunks = da.encoding.get("chunks")
    out = []
    for i, dim in enumerate(da.dims):
        size = pref.get(dim)
        if size is None and chunks is not None and len(chunks) == da.ndim:
            size = chunks[i]
        out.append(int(size) if size else (1 if i == 0 else 512))
    return out[0], out[1], out[2]


def selected_dates(da: xr.DataArray, stride: int) -> list[tuple[int, int]]:
    """Date ranges of every ``stride``-th whole time chunk, as ``(start, stop)``.

    Stride 1 is every date. Whole chunks only, so a subset reads less data
    instead of decoding chunks for dates it then drops.
    """
    da = as_tyx(da)
    nt = da.shape[0]
    ct = _chunks(da)[0]
    stride = max(1, int(stride)) if nt > 1 else 1
    return [(t0, min(t0 + ct, nt)) for t0 in range(0, nt, ct * stride)]


def read_lazy(x: xr.DataArray) -> np.ndarray:
    """Read a lazy selection: dask in this thread, else through the backend."""
    data = x.data
    if hasattr(data, "compute") and not isinstance(data, np.ndarray):
        # The caller's threads give the parallelism; dask's own pool would
        # oversubscribe the machine (one task per chunk on every core).
        return np.asarray(data.compute(scheduler="synchronous"))
    return np.asarray(x.values)


def direct_array(da: xr.DataArray, source: Source | None) -> Any:
    """Return the layer's zarr array when reading it directly gives the same values.

    xarray funnels reads through a path that does not run concurrently, while
    zarr's own reads do (on Arkabutla, reading alone, 4 threads were 3x faster
    than 1). Only for local
    stores, ``(t, y, x)`` or ``(y, x)`` float layers stored in that order, with no
    scale, offset or non-NaN fill value: then the raw values are exactly what
    xarray would return. None otherwise (the caller reads through xarray).
    """
    if source is None or "://" in source.uri:
        return None
    enc = da.encoding
    if any(k in enc or k in da.attrs for k in ("scale_factor", "add_offset")):
        return None
    if not np.issubdtype(da.dtype, np.floating):
        return None
    fill = enc.get("_FillValue", np.nan)
    if fill is not None and not (isinstance(fill, float) and np.isnan(fill)):
        return None
    if tuple(da.dims[-2:]) != ("y", "x"):
        return None
    try:
        import zarr  # noqa: PLC0415

        path = "/".join(p for p in (source.asset, str(da.name)) if p)
        arr = zarr.open_array(store=source.uri, path=path, mode="r")
    except Exception:  # noqa: BLE001 - fall back to xarray
        return None
    if tuple(arr.shape) != tuple(da.shape) or np.dtype(arr.dtype) != np.dtype(da.dtype):
        return None
    return arr


def stack_median_std(
    da: xr.DataArray,
    rows: slice | None = None,
    cols: slice | None = None,
    *,
    stride: int = 1,
    workers: int = 1,
    progress: ProgressFn | None = None,
    source: Source | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel median and std over time of ``da`` (or a window of it).

    Reads chunk-aligned blocks with ``workers`` threads, each reusing a buffer of
    at most :data:`BLOCK_BYTES` and reading at most :data:`READ_BYTES` per call,
    so memory stays bounded (about ``workers x BLOCK_BYTES``) and a full DISP-S1
    frame never has to fit in memory. ``stride`` keeps every stride-th time
    chunk (:func:`selected_dates`). The result does not depend on ``workers``.
    """
    raw = direct_array(da, source)
    flat = da.ndim == 2
    da = as_tyx(da)
    r_off = (rows or slice(None)).indices(da.shape[1])[0]
    c_off = (cols or slice(None)).indices(da.shape[2])[0]
    if rows is not None or cols is not None:
        da = da.isel(y=rows or slice(None), x=cols or slice(None))
    _, ny, nx = da.shape
    dates = selected_dates(da, stride)
    n_sel = sum(b - a for a, b in dates)
    _, cy, cx = _chunks(da)
    by, bx = min(ny, cy), min(nx, cx)
    while n_sel * by * bx * 4 > BLOCK_BYTES and (by > 1 or bx > 1):
        if bx >= by:
            bx = max(1, bx // 2)
        else:
            by = max(1, by // 2)
    # Dates per read call, in whole chunks.
    ct = max(1, dates[0][1] - dates[0][0])
    per_call = max(1, READ_BYTES // max(by * bx * 4 * ct, 1))
    calls: list[tuple[int, int, int]] = []  # (src start, src stop, buffer offset)
    off = 0
    for i in range(0, len(dates), per_call):
        group = dates[i : i + per_call]
        for a, b in _merge(group):
            calls.append((a, b, off))
            off += b - a

    med = np.empty((ny, nx), np.float32)
    std = np.empty((ny, nx), np.float32)
    blocks = [(r, c) for r in range(0, ny, by) for c in range(0, nx, bx)]
    local = threading.local()
    done = [0]
    lock = threading.Lock()

    def work(block: tuple[int, int]) -> None:
        r, c = block
        h, w = min(by, ny - r), min(bx, nx - c)
        buf = getattr(local, "buf", None)
        if buf is None:
            buf = local.buf = np.empty((n_sel, by, bx), np.float32)
        out = buf[:, :h, :w]
        if raw is not None:
            ys = slice(r_off + r, r_off + r + h)
            xs = slice(c_off + c, c_off + c + w)
            for a, b, o in calls:
                out[o : o + b - a] = raw[ys, xs][None] if flat else raw[a:b, ys, xs]
        else:
            sub = da.isel(y=slice(r, r + h), x=slice(c, c + w))
            dim = sub.dims[0]
            for a, b, o in calls:
                out[o : o + b - a] = read_lazy(sub.isel({dim: slice(a, b)}))
        _reduce_in_tiles(out, med[r : r + h, c : c + w], std[r : r + h, c : c + w])
        if progress is not None:
            with lock:
                done[0] += 1
                progress(done[0], len(blocks))

    if workers <= 1 or len(blocks) == 1:
        for blk in blocks:
            work(blk)
    else:
        with ThreadPoolExecutor(min(workers, len(blocks))) as pool:
            list(pool.map(work, blocks))
    return med, std


def _merge(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for a, b in ranges:
        if out and out[-1][1] == a:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


# --- disk cache --------------------------------------------------------------------


@dataclass(frozen=True)
class Source:
    """Where a dataset (one pyramid level) was read from, for the disk cache key."""

    uri: str
    asset: str = ""


def layer_fingerprint(source: Source, name: str) -> str | None:
    """Return a cheap fingerprint of a layer's files, or None if it cannot be had.

    The relative path, size and modification time of every file of the layer
    (its metadata and chunks or shards): rewriting the layer changes it. Local
    stores are walked; remote ones are listed with fsspec when it is installed.
    """
    uri = source.uri
    if uri.startswith("file://"):
        uri = uri[len("file://") :]
    parts = [p for p in (source.asset, name) if p]
    try:
        if "://" not in uri:
            root = Path(uri).joinpath(*parts)
            if not root.is_dir():
                return None
            entries = []
            for dirpath, _, files in os.walk(root):
                for f in files:
                    p = Path(dirpath) / f
                    st = p.stat()
                    entries.append(
                        (str(p.relative_to(root)), st.st_size, st.st_mtime_ns)
                    )
        else:
            import fsspec  # noqa: PLC0415

            fs, path = fsspec.core.url_to_fs(uri)
            root_s = "/".join([path.rstrip("/"), *parts])
            found = fs.find(root_s, detail=True)
            if not found:
                return None
            entries = [
                (  # type: ignore[misc]
                    k[len(root_s) :],
                    v.get("size"),
                    str(v.get("mtime") or v.get("LastModified") or v.get("ETag")),
                )
                for k, v in found.items()
            ]
    except Exception as e:  # noqa: BLE001 - no fingerprint means no disk cache
        logger.debug(f"refstats: no fingerprint for {uri} {name}: {e}")
        return None
    entries.sort()
    return hashlib.sha256(json.dumps(entries).encode()).hexdigest()


def disk_key(source: Source | None, name: str, stride: int) -> str | None:
    """Return the disk cache key of one reduction (None: no source/fingerprint)."""
    if source is None or cache_dir() is None:
        return None
    fp = layer_fingerprint(source, name)
    if fp is None:
        return None
    uri = source.uri
    if "://" not in uri:
        uri = str(Path(uri).resolve())
    return json.dumps(
        {
            "v": 1,
            "uri": uri,
            "asset": source.asset,
            "layer": name,
            "stride": int(stride),
            "files": fp,
        },
        sort_keys=True,
    )


def _path_for(key: str) -> Path | None:
    root = cache_dir()
    if root is None:
        return None
    return root / f"{hashlib.sha256(key.encode()).hexdigest()[:40]}.npz"


def load_cached(key: str) -> tuple[np.ndarray, np.ndarray] | None:
    """Return the reduction stored under ``key``, or None (missing or unreadable)."""
    path = _path_for(key)
    if path is None or not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as z:
            if str(z["key"]) != key:
                return None
            med, std = np.array(z["median"]), np.array(z["std"])
        os.utime(path)  # used: the size limit removes the least recently used
        return med, std
    except Exception as e:  # noqa: BLE001 - a bad file is a cache miss
        logger.warning(f"refstats: ignoring unreadable cache file {path}: {e}")
        return None


def save_cached(key: str, med: np.ndarray, std: np.ndarray) -> None:
    """Store a reduction under ``key`` atomically, then apply the size/age limits."""
    path = _path_for(key)
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.stem}.{os.getpid()}.{threading.get_ident()}.tmp")
        with open(tmp, "wb") as f:
            np.savez(f, median=med, std=std, key=np.array(key))
        tmp.replace(path)
    except OSError as e:
        logger.warning(f"refstats: could not write the cache file {path}: {e}")
        return
    prune()


def prune(now: float | None = None) -> None:
    """Remove cache files older than the age limit, then the least recently used.

    Limits: ``BOWSER_REFSTATS_CACHE_MAX_AGE_DAYS`` (30) and
    ``BOWSER_REFSTATS_CACHE_MAX_MB`` (2048). Leftover temporary files older than
    an hour go too.
    """
    root = cache_dir()
    if root is None or not root.is_dir():
        return
    now = time.time() if now is None else now
    max_age = _env_float("BOWSER_REFSTATS_CACHE_MAX_AGE_DAYS", 30) * 86400
    max_bytes = _env_float("BOWSER_REFSTATS_CACHE_MAX_MB", 2048) * 1024**2
    files = []
    for p in root.iterdir():
        try:
            st = p.stat()
        except OSError:
            continue
        if p.name.startswith(".") and p.suffix == ".tmp":
            if now - st.st_mtime > 3600:
                p.unlink(missing_ok=True)
            continue
        if p.suffix != ".npz":
            continue
        if now - st.st_mtime > max_age:
            p.unlink(missing_ok=True)
            continue
        files.append((st.st_mtime, st.st_size, p))
    files.sort()
    total = sum(s for _, s, _ in files)
    for _, size, p in files:
        if total <= max_bytes:
            break
        p.unlink(missing_ok=True)
        total -= size


# --- memory cache with shared in-flight computations -------------------------------


@dataclass
class _Entry:
    done: threading.Event = field(default_factory=threading.Event)
    result: tuple[np.ndarray, np.ndarray] | None = None
    error: BaseException | None = None
    progress: float = 0.0
    origin: str = "computing"  # computing | computed | disk


class StatsCache:
    """Per-dataset, per-(layer, stride) reductions, shared between threads.

    Keyed by the opened ``xr.Dataset`` object (its ``id``, dropped when the
    dataset is garbage collected, e.g. evicted from a catalog registry). The
    first caller for a key reads the disk cache or computes; later callers, the
    background warm-up included, wait for that result instead of computing again.
    """

    def __init__(self) -> None:  # noqa: D107
        self._data: dict[int, dict[tuple[str, int], _Entry]] = {}
        self._lock = threading.Lock()
        self.computed = 0  # reductions computed from the data (tests read it)
        self.loaded = 0  # reductions read from the disk cache

    def get(
        self,
        ds: xr.Dataset,
        name: str,
        *,
        stride: int = 1,
        source: Source | None = None,
        workers: int | None = None,
    ) -> tuple[tuple[np.ndarray, np.ndarray], bool]:
        """Return ``((median, std), reused)`` for layer ``name`` of ``ds``.

        ``reused`` is False only when this call computed it from the data.
        """
        if ds[name].ndim < 3:
            stride = 1
        k = (name, int(stride))
        with self._lock:
            per_ds = self._data.get(id(ds))
            if per_ds is None:
                per_ds = self._data[id(ds)] = {}
                weakref.finalize(ds, self._data.pop, id(ds), None)
            entry = per_ds.get(k)
            owner = entry is None
            if owner:
                entry = per_ds[k] = _Entry()
        assert entry is not None
        if not owner:
            entry.done.wait()
            if entry.error is not None:
                raise entry.error
            assert entry.result is not None
            return entry.result, True
        try:
            key = disk_key(source, name, stride)
            stats = load_cached(key) if key else None
            if stats is not None and stats[0].shape != ds[name].shape[-2:]:
                stats = None
            reused = stats is not None
            if stats is not None:
                entry.origin = "disk"
                self.loaded += 1
            else:
                t0 = time.perf_counter()

                def report(done: int, total: int) -> None:
                    entry.progress = done / total

                stats = stack_median_std(
                    ds[name],
                    stride=stride,
                    workers=read_workers() if workers is None else workers,
                    progress=report,
                    source=source,
                )
                self.computed += 1
                entry.origin = "computed"
                logger.info(
                    f"refstats: median/std of {name} {ds[name].shape} "
                    f"(stride {stride}) in {time.perf_counter() - t0:.1f} s"
                )
                if key:
                    save_cached(key, *stats)
            entry.result = stats
            entry.progress = 1.0
            return stats, reused
        except BaseException as e:
            entry.error = e
            with self._lock:
                per_ds.pop(k, None)
            raise
        finally:
            entry.done.set()

    def state(self, ds: xr.Dataset, name: str, stride: int = 1) -> tuple[str, float]:
        """``("ready"|"running"|"idle", progress)`` of one reduction."""
        if name in ds.data_vars and ds[name].ndim < 3:
            stride = 1
        with self._lock:
            entry = self._data.get(id(ds), {}).get((name, int(stride)))
        if entry is None:
            return "idle", 0.0
        if entry.done.is_set():
            return ("ready", 1.0) if entry.result is not None else ("idle", 0.0)
        return "running", float(entry.progress)

    def clear(self) -> None:
        """Forget every reduction held in memory (the disk cache stays)."""
        with self._lock:
            self._data.clear()


#: The process-wide cache both servers use.
STATS_CACHE = StatsCache()


# --- background warm-up ------------------------------------------------------------

_warm_lock = threading.Lock()
_warming: set[int] = set()


def _lower_priority() -> None:
    """Make this thread (and the reader threads it starts) yield the CPU."""
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
    except (AttributeError, OSError):  # not Linux, or not allowed
        pass


def start_warm_up(
    ds: xr.Dataset,
    layers: Sequence[tuple[str, int]],
    source: Source | None,
) -> bool:
    """Compute ``(layer, stride)`` reductions of ``ds`` in a background thread.

    At low CPU priority, one layer after another; requests that need a layer meanwhile
    wait for it (:class:`StatsCache`). Started once per dataset; returns whether
    this call started it. Errors are logged, never raised.
    """
    with _warm_lock:
        if id(ds) in _warming:
            return False
        _warming.add(id(ds))
        weakref.finalize(ds, _warming.discard, id(ds))

    def run() -> None:
        _lower_priority()
        t0 = time.perf_counter()
        for name, stride in layers:
            try:
                STATS_CACHE.get(ds, name, stride=stride, source=source)
            except Exception as e:  # noqa: BLE001 - a warm-up never takes the server down
                logger.warning(f"refstats: warm-up of {name} failed: {e}")
        logger.info(f"refstats: warm-up done in {time.perf_counter() - t0:.1f} s")

    threading.Thread(target=run, name="bowser-refstats-warmup", daemon=True).start()
    return True
