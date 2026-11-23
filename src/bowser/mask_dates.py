"""A dated mask combined over its dates, for layers without dates.

On a layer without dates (a velocity, a coherence summary) a dated mask keeps a
pixel only where it passes on every date. That is one comparison against the
pixel's lowest or highest value over the dates:

- ``>=`` / ``>`` on every date: the lowest value passes;
- ``<=`` on every date: the highest value passes;
- ``|value| >=``: the smallest magnitude over the dates passes;
- ``|value| <=``: the largest magnitude (from the lowest and highest) passes.

A date with a missing, nonfinite or fill value makes both NaN, so the pixel
fails, as the date-by-date comparison (``mask_condition``) does.

The lowest and highest values are read one block (a storage chunk of the map) at
a time, over all dates, and kept in a size-limited cache: moving the map or the
threshold reuses them instead of reading every date again. The same blocks back
the server's tiles and exports (``date_range``) and the GPU path, which reads
them as two virtual arrays of the ``/zarr/`` route (``virtual_file``):
``<mask>@lowest_over_dates`` and ``<mask>@highest_over_dates``.
"""

from __future__ import annotations

import json
import re
import threading
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr
from xarray.backends import BackendArray
from xarray.core import indexing

#: The virtual arrays' suffixes, and which end of the range each holds.
LOWEST, HIGHEST = "lowest_over_dates", "highest_over_dates"
_WHICH = {LOWEST: 0, HIGHEST: 1}
#: Block size when the mask declares no storage chunks.
_DEFAULT_BLOCK = 256
#: Memory kept for computed blocks (both ends), across all masks and levels.
_BUDGET_BYTES = 256 * 1024 * 1024
_FILL_KEYS = ("_FillValue", "missing_value", "fill_value", "nodata")


def block_range(
    values: np.ndarray, attrs: dict | None = None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return the lowest value, highest value and smallest magnitude over axis 0.

    Each is NaN where any date is invalid.

    Parameters
    ----------
    values
        ``(dates, rows, cols)`` mask values.
    attrs
        The mask's attributes: values equal to a declared fill are invalid.

    Returns
    -------
    tuple of np.ndarray
        ``(lowest, highest, smallest magnitude)``, each ``(rows, cols)``, float32
        for float32 masks and float64 otherwise (integers need NaN).

    """
    raw = np.ma.getdata(values)
    dtype = np.float32 if raw.dtype == np.float32 else np.float64
    valid = ~np.ma.getmaskarray(values) & np.isfinite(raw)
    for key in _FILL_KEYS:
        fill = (attrs or {}).get(key)
        if fill is not None:
            for value in np.atleast_1d(fill):
                valid &= raw != value
    clean = np.where(valid, raw, np.nan).astype(dtype, copy=False)
    if clean.shape[0] == 0:
        empty = np.full(clean.shape[1:], np.nan, dtype)
        return empty, empty.copy(), empty.copy()
    # np.min/np.max propagate NaN: one invalid date invalidates the pixel.
    return clean.min(axis=0), clean.max(axis=0), np.abs(clean).min(axis=0)


def keep_from_range(
    lowest: Any, highest: Any, threshold: float, operator: str, smallest: Any = None
) -> Any:
    """Return where every date passes ``operator threshold``, from the date range.

    ``smallest`` (the smallest magnitude) is needed for ``|value| >=`` only.
    """
    if not np.isfinite(threshold):
        raise ValueError("Mask thresholds must be finite")
    if operator.startswith("|value|") and threshold < 0:
        raise ValueError("Absolute mask thresholds must be nonnegative")
    if operator == ">=":
        return lowest >= threshold
    if operator == ">":
        return lowest > threshold
    if operator == "<=":
        return highest <= threshold
    if operator == "|value| >=":
        if smallest is None:
            raise ValueError("|value| >= needs the smallest magnitude")
        return smallest >= threshold
    if operator == "|value| <=":
        largest = np.maximum(abs(lowest), abs(highest))
        return largest <= threshold
    raise ValueError("Unsupported mask comparison")


class _Blocks:
    """Computed blocks, least recently used dropped first, within a memory budget."""

    def __init__(self, budget: int = _BUDGET_BYTES) -> None:
        self.budget = budget
        self.used = 0
        self.items: OrderedDict[tuple, tuple[np.ndarray, ...]] = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key: tuple, compute) -> tuple[np.ndarray, ...]:
        with self.lock:
            if key in self.items:
                self.items.move_to_end(key)
                return self.items[key]
        value = compute()  # outside the lock: other blocks compute meanwhile
        size = sum(part.nbytes for part in value)
        with self.lock:
            if key not in self.items:
                self.items[key] = value
                self.used += size
                while self.used > self.budget and len(self.items) > 1:
                    _, old = self.items.popitem(last=False)
                    self.used -= sum(part.nbytes for part in old)
            return self.items[key]

    def drop(self, owner: int) -> None:
        """Forget the blocks of the mask registered as ``owner``."""
        with self.lock:
            for key in [k for k in self.items if k[:2] == ("variable", owner)]:
                old = self.items.pop(key)
                self.used -= sum(part.nbytes for part in old)

    def clear(self) -> None:
        with self.lock:
            self.items.clear()
            self.used = 0


BLOCKS = _Blocks()


def _block_shape(mask: xr.DataArray) -> tuple[int, int]:
    chunks = mask.encoding.get("preferred_chunks") or {}
    shape = mask.encoding.get("chunks")
    by = chunks.get("y")
    bx = chunks.get("x")
    if (by is None or bx is None) and shape and len(shape) == mask.ndim:
        sizes = dict(zip(mask.dims, shape))
        by, bx = sizes.get("y"), sizes.get("x")
    return int(by or _DEFAULT_BLOCK), int(bx or _DEFAULT_BLOCK)


class _RangeArray(BackendArray):
    """One end of a mask's date range as a lazily read ``(y, x)`` array."""

    def __init__(self, mask: xr.DataArray, which: int, key: tuple) -> None:
        self.mask = mask  # (date, y, x)
        self.which = which
        self.key = key
        self.shape = (mask.sizes["y"], mask.sizes["x"])
        self.dtype = np.dtype(np.float32 if mask.dtype == np.float32 else np.float64)
        self.block = _block_shape(mask)

    def __getitem__(self, key):
        return indexing.explicit_indexing_adapter(
            key, self.shape, indexing.IndexingSupport.BASIC, self._read
        )

    def _block(self, row: int, col: int) -> tuple[np.ndarray, ...]:
        by, bx = self.block

        def compute():
            part = self.mask.isel(
                y=slice(row * by, (row + 1) * by), x=slice(col * bx, (col + 1) * bx)
            )
            return block_range(np.asarray(part.values), self.mask.attrs)

        return BLOCKS.get((*self.key, row, col), compute)

    def _read(self, key: tuple) -> np.ndarray:
        # Integers or slices (BASIC indexing): read the blocks covering them.
        picks = [np.atleast_1d(np.arange(size)[k]) for k, size in zip(key, self.shape)]
        (ys, xs), (by, bx) = picks, self.block
        if not ys.size or not xs.size:
            return np.empty((ys.size, xs.size), self.dtype)[
                tuple(
                    0 if isinstance(k, (int, np.integer)) else slice(None) for k in key
                )
            ]
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        out = np.empty((y1 - y0, x1 - x0), self.dtype)
        for row in range(y0 // by, (y1 - 1) // by + 1):
            for col in range(x0 // bx, (x1 - 1) // bx + 1):
                block = self._block(row, col)[self.which]
                r0, c0 = row * by, col * bx
                r = slice(max(y0, r0), min(y1, r0 + block.shape[0]))
                c = slice(max(x0, c0), min(x1, c0 + block.shape[1]))
                out[r.start - y0 : r.stop - y0, c.start - x0 : c.stop - x0] = block[
                    r.start - r0 : r.stop - r0, c.start - c0 : c.stop - c0
                ]
        out = out[np.ix_(ys - y0, xs - x0)]
        return out[
            tuple(0 if isinstance(k, (int, np.integer)) else slice(None) for k in key)
        ]


# The masks whose blocks are cached, by id. Each is kept alive while registered,
# so its id cannot be reused; one leaving the register takes its blocks along.
_OWNERS: OrderedDict[int, Any] = OrderedDict()
_MAX_OWNERS = 32
_OWNERS_LOCK = threading.Lock()


def _register(owner: Any) -> int:
    with _OWNERS_LOCK:
        _OWNERS[id(owner)] = owner
        _OWNERS.move_to_end(id(owner))
        dropped = []
        while len(_OWNERS) > _MAX_OWNERS:
            dropped.append(_OWNERS.popitem(last=False)[0])
    for old in dropped:
        BLOCKS.drop(old)
    return id(owner)


def date_range(
    mask: xr.DataArray, dim: str
) -> tuple[xr.DataArray, xr.DataArray, xr.DataArray]:
    """Return ``mask``'s lowest, highest and smallest-magnitude values over ``dim``.

    Each is a ``(y, x)`` array.

    Values are read only where the arrays are indexed, a block at a time, and
    the blocks are kept (``BLOCKS``) for the next request on the same mask.
    """
    ordered = mask.transpose(dim, "y", "x")
    key = ("variable", _register(mask.variable), mask.dims)
    coords = {
        name: coord
        for name, coord in mask.coords.items()
        if dim not in coord.dims and set(coord.dims) <= {"y", "x"}
    }
    ends = []
    for which in (0, 1, 2):
        data = indexing.LazilyIndexedArray(_RangeArray(ordered, which, key))
        ends.append(xr.DataArray(xr.Variable(("y", "x"), data), coords=coords))
    return ends[0], ends[1], ends[2]


# --- The GPU path: the same blocks as virtual arrays of ``/zarr/``. ---

_VIRTUAL = re.compile(
    r"^(?P<base>(?:[^/@]+/)*)(?P<var>[^/@]+)@(?P<which>"
    + LOWEST
    + "|"
    + HIGHEST
    + r")/(?P<key>zarr\.json|c/(?P<row>\d+)/(?P<col>\d+))$"
)


@lru_cache(maxsize=8)
def _open_level(root: str, group: str | None) -> xr.Dataset:
    from .lite.cube import _open_group  # noqa: PLC0415

    return _open_group(root, group)


def _spatial_chunks(meta: dict) -> list[int]:
    for codec in meta.get("codecs", []):
        if codec.get("name") == "sharding_indexed":
            return list(codec["configuration"]["chunk_shape"][-2:])
    return list(meta["chunk_grid"]["configuration"]["chunk_shape"][-2:])


def virtual_file(root: Path, path: str, resolve) -> tuple[bytes, str] | None:
    """Return a virtual array's file as ``(content, media type)``, or None.

    Parameters
    ----------
    root
        The store's folder.
    path
        The requested key, e.g. ``recommended_mask@lowest_over_dates/c/0/1``.
    resolve
        ``resolve_inside(root, rel)``: the real file, or a 404.

    Returns
    -------
    tuple or None
        None when ``path`` does not name a virtual array (the caller serves the
        real file).

    Raises
    ------
    LookupError
        The mask is not ``(date, y, x)``, or the chunk is outside the array.

    """
    match = _VIRTUAL.match(path)
    if match is None:
        return None
    base, var, which = match["base"], match["var"], match["which"]
    meta_path = resolve(root, f"{base}{var}/zarr.json")
    meta = json.loads(meta_path.read_text())
    names = meta.get("dimension_names") or []
    if len(meta.get("shape", [])) != 3 or list(names[-2:]) != ["y", "x"]:
        raise LookupError("Not a dated mask")
    rows, cols = meta["shape"][-2:]
    cy, cx = _spatial_chunks(meta)
    float32 = meta.get("data_type") == "float32"
    if match["key"] == "zarr.json":
        doc = {
            "zarr_format": 3,
            "node_type": "array",
            "shape": [rows, cols],
            "data_type": "float32" if float32 else "float64",
            "chunk_grid": {
                "name": "regular",
                "configuration": {"chunk_shape": [cy, cx]},
            },
            "chunk_key_encoding": {
                "name": "default",
                "configuration": {"separator": "/"},
            },
            "fill_value": "NaN",
            "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
            "dimension_names": ["y", "x"],
            "attributes": {
                "long_name": f"{var}: {which.replace('_', ' ')}",
                "bowser_combined_dates": names[0],
            },
        }
        return json.dumps(doc).encode(), "application/json"
    row, col = int(match["row"]), int(match["col"])
    if row * cy >= rows or col * cx >= cols:
        raise LookupError("Chunk outside the array")
    group = base.rstrip("/") or None
    mask = _open_level(str(root), group)[var].transpose(names[0], "y", "x")

    def compute():
        part = mask.isel(
            y=slice(row * cy, (row + 1) * cy), x=slice(col * cx, (col + 1) * cx)
        )
        return block_range(np.asarray(part.values), mask.attrs)

    block = BLOCKS.get(("store", str(root), base, var, cy, cx, row, col), compute)
    out = np.full((cy, cx), np.nan, "<f4" if float32 else "<f8")
    values = block[_WHICH[which]]
    out[: values.shape[0], : values.shape[1]] = values
    return out.tobytes(), "application/octet-stream"
