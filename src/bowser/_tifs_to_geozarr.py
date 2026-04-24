"""Convert a ``bowser_rasters.json`` set of GeoTIFFs into a single GeoZarr store.

Invoked via the ``bowser tifs-to-geozarr`` CLI subcommand (see
``bowser.cli``). Lives as its own module rather than inside ``cli.py`` so
heavy scientific-stack imports (numpy/xarray/rasterio/pandas/opera_utils)
stay out of ``bowser --help`` — ``cli.py`` imports this module lazily
inside the command body.

Produces one consolidated zarr with:

- one variable per group (2D for single-file groups; 3D for multi-file groups)
- a ``time`` dim when all files share a common reference date (linear time series)
- a ``pair`` integer index + ``reference_date_*`` / ``secondary_date_*`` /
  ``pair_label_*`` coords for groups that are inherently date-pairs without a
  shared ref (e.g. ``unwrapped``)
- GeoZarr ``spatial:`` / ``proj:`` / ``zarr_conventions`` root attributes
- optional multiscale pyramid: levels written to ``/0``, ``/1``, ``/2``, …
  subgroups; root carries the ``multiscales`` convention attrs

Read path: a ``ThreadPoolExecutor`` pool of readers, each using plain
``rasterio.open(f).read(1)`` into a pre-allocated numpy stack. Threads (not
processes) because rasterio releases the GIL during reads and a process pool
would double peak RSS by pickling multi-GB result arrays back through IPC.

Streaming write: readers also compute the 2×2-mean pyramid levels in-worker,
and the main thread drains futures via ``as_completed`` and writes each
variable to every level group before dropping its arrays. Only a bounded
number of groups are in flight at a time, so peak memory ≈
``(n_workers + 1) × (4/3) × largest_group`` instead of the full stack.
"""

from __future__ import annotations

import itertools
import json
import logging
import time
import warnings
from collections.abc import Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd
import rasterio
import xarray as xr
from opera_utils import get_dates

from .geozarr import ZarrWriteConfig, annotate_store, shard_encoding

logger = logging.getLogger(__name__)


@contextmanager
def _timed(label: str):
    """Log elapsed wall time for a named phase. Runs at INFO level (-v)."""
    t0 = time.perf_counter()
    yield
    logger.info("%s: %.2fs", label, time.perf_counter() - t0)


def convert(
    config: str,
    output: str,
    chunk: int,
    shard_factor: int,
    compression: str,
    compression_level: int,
    quantize_digits: int,
    quantize_patterns: str,
    workers: int,
    pyramid: bool,
    min_pyramid_size: int,
    los_dir: str | None,
    verbose: int,
) -> list[str]:
    """Run the conversion. Returns the list of variable names written."""
    logging.basicConfig(level=logging.INFO if verbose else logging.WARNING)
    groups_cfg = [g for g in json.loads(Path(config).read_text()) if g.get("file_list")]
    assert groups_cfg, f"No non-empty raster groups in {config}"

    # Spatial reference comes from the first file of the first group — all groups
    # are assumed to be co-registered (the converter would break silently otherwise,
    # so fail loudly on shape/CRS mismatch inside the worker).
    ref = _load_spatial_ref(groups_cfg[0]["file_list"][0])

    write_cfg = ZarrWriteConfig(
        chunk=chunk,
        shard_factor=shard_factor,
        compression_name=compression,  # type: ignore[arg-type]
        compression_level=compression_level,
        quantize_digits=quantize_digits if quantize_digits > 0 else None,
        quantize_patterns=tuple(
            p.strip() for p in quantize_patterns.split(",") if p.strip()
        ),
    )

    level_coords = (
        _pyramid_level_coords(ref, min_pyramid_size)
        if pyramid
        else [(ref.y_coords, ref.x_coords)]
    )
    # Default to 4 threads, not cpu_count. Each reader holds a whole variable
    # in RAM (+ its pyramid levels) until the writer drains it, so peak memory
    # scales as ``(n_workers + 1) × largest_group``. On a 12-core machine with
    # multi-GB 3D stacks (unwrapped, filtered_time_series), cpu_count was
    # driving peak RSS to 90+ GB. Rasterio reads are mostly I/O-bound and
    # release the GIL, so 4 threads already saturate typical disk bandwidth;
    # going higher trades little wall time for a lot of memory. Callers with
    # small variables and plenty of RAM can override via ``--workers N``.
    n_workers = workers or min(len(groups_cfg), 4)
    logger.info(
        "Loading %d variables with %d threads, %d pyramid level(s)",
        len(groups_cfg),
        n_workers,
        len(level_coords),
    )

    # 1. Write skeleton (y, x, spatial_ref) to each level group. Variables are
    #    appended afterwards with mode="a", which is why y/x/spatial_ref must
    #    already exist when we stream per-variable writes in.
    with _timed("write skeletons"):
        for i, (y, x) in enumerate(level_coords):
            group = str(i) if pyramid else None
            _write_skeleton(output, group, y, x, ref.crs_wkt)

    # 2. Stream: readers produce (lv, levels) tuples in completion order; main
    #    thread writes each variable to every level group and drops its arrays
    #    before pulling the next result.
    loader = partial(_load_and_coarsen, ref=ref, n_levels=len(level_coords))
    total_bytes = 0
    written: list[str] = []
    max_in_flight = n_workers + 1
    with _timed("read + coarsen + write (streaming)"):
        if n_workers == 1:
            stream: Iterable[tuple[_Loaded, list[np.ndarray]]] = (
                loader(g) for g in groups_cfg
            )
            for lv, levels in stream:
                total_bytes += lv.array.nbytes
                _write_variable_to_all_levels(output, lv, levels, pyramid, write_cfg)
                written.append(lv.name)
                del lv, levels
        else:
            with ThreadPoolExecutor(max_workers=n_workers) as pool:
                for lv, levels in _bounded_in_flight(
                    pool, loader, groups_cfg, max_in_flight
                ):
                    total_bytes += lv.array.nbytes
                    _write_variable_to_all_levels(
                        output, lv, levels, pyramid, write_cfg
                    )
                    written.append(lv.name)
                    del lv, levels
    logger.info(
        "Streamed %.2f GiB (level-0) across %d vars", total_bytes / 2**30, len(written)
    )

    with _timed("annotate_store"):
        if pyramid:
            multiscales_levels = [{"asset": "0"}] + [
                {
                    "asset": str(i),
                    "derived_from": str(i - 1),
                    "transform": {"scale": [2.0, 2.0]},
                }
                for i in range(1, len(level_coords))
            ]
            annotate_store(
                output, data_group="0", multiscales_levels=multiscales_levels
            )
        else:
            annotate_store(output)

    if los_dir:
        _write_los_attrs(output, Path(los_dir))

    return sorted(written)


def _write_los_attrs(zarr_path: str, los_dir: Path) -> None:
    """Merge ``heading_angle.json`` + ``los_enu.json`` from ``los_dir`` into root attrs.

    Keys written match the DISP-S1 JSON schema so the bowser backend can read
    them verbatim from ``ds.attrs`` (see ``_los_metadata_from_attrs`` in
    ``bowser/main.py``).
    """
    import zarr  # noqa: PLC0415

    attrs: dict[str, Any] = {}
    heading = los_dir / "heading_angle.json"
    if heading.exists():
        attrs["heading_angle_deg"] = json.loads(heading.read_text())[
            "heading_angle_deg"
        ]
    los = los_dir / "los_enu.json"
    if los.exists():
        data = json.loads(los.read_text())
        attrs["incidence_angle_deg"] = data["incidence_angle_deg"]
        attrs["los_enu_ground_to_satellite"] = data["los_enu_ground_to_satellite"]
        # azimuth_angle_deg is present but not used by the UI — copy through anyway
        if "azimuth_angle_deg" in data:
            attrs["azimuth_angle_deg"] = data["azimuth_angle_deg"]

    if not attrs:
        logger.warning("No LOS JSON files found in %s", los_dir)
        return

    root = zarr.open_group(zarr_path, mode="r+")
    root.attrs.update(attrs)
    # Pyramid stores are opened by xarray at the data subgroup (e.g. /0); mirror
    # the attrs there so ds.attrs sees them regardless of how it's opened.
    for name in list(root.group_keys()):
        if name.isdigit():
            root[name].attrs.update(attrs)
    logger.info("Stashed LOS metadata in %s: %s", zarr_path, sorted(attrs))


@dataclass
class _SpatialRef:
    """Geospatial reference captured from the first tif in the first group.

    Every subsequent file must match ``shape`` and ``crs`` exactly — the worker
    asserts this inside ``_load_group`` so a miscalibrated config fails loud
    rather than producing a silently-corrupt cube.
    """

    height: int
    width: int
    crs_wkt: str
    transform: tuple[float, ...]  # 6-element rasterio affine
    x_coords: np.ndarray
    y_coords: np.ndarray


@dataclass
class _Loaded:
    """A single materialized raster group, ready to hand to xarray."""

    name: str
    display_name: str
    array: np.ndarray  # (N, H, W) for 3D groups; (H, W) for single-file groups
    dim_name: str | None  # None for 2D
    coords: dict[str, tuple[str, np.ndarray]]  # {coord_name: (dim, values)}
    # GDAL ``Unit Type`` from the first file in the group (``src.units[0]``).
    # Empty/unset on GeoTIFFs with no unit declared. Written as ``units`` attr
    # on the xarray DataArray so the bowser colorbar can label the scale.
    units: str | None = None


def _load_spatial_ref(path: str) -> _SpatialRef:
    with rasterio.open(path) as src:
        t = src.transform
        # Pixel-center coordinates: (ix + 0.5, iy + 0.5) * transform. Same
        # convention rioxarray uses on open_rasterio.
        x = (np.arange(src.width) + 0.5) * t.a + t.c
        y = (np.arange(src.height) + 0.5) * t.e + t.f
        return _SpatialRef(
            height=src.height,
            width=src.width,
            crs_wkt=src.crs.to_wkt() if src.crs else "",
            transform=tuple(t)[:6],
            x_coords=x.astype(np.float64),
            y_coords=y.astype(np.float64),
        )


def _load_group(rg: dict, ref: _SpatialRef) -> _Loaded:
    """Read every file in a RasterGroup into one numpy array.

    Runs inside a worker thread — rasterio releases the GIL during ``read``,
    so N threads overlap I/O without the process-pool IPC doubling.
    """
    file_list: list[str] = rg["file_list"]
    name = _sanitize(rg["name"])
    display_name = rg["name"]
    fmt = rg.get("file_date_fmt") or "%Y%m%d"

    # Dtype: float16 tifs are unusable downstream (GDAL reprojection + titiler
    # both choke), so upcast at read time. Everything else flows through
    # unchanged. Also grab the GDAL Unit Type from band 1 — rasterio returns
    # ``('',)`` on files with no unit set, which we normalise to ``None``.
    with rasterio.open(file_list[0]) as src0:
        src_dtype = src0.dtypes[0]
        band_units = src0.units or ()
    out_dtype = np.dtype("float32" if src_dtype == "float16" else src_dtype)
    units = band_units[0] if band_units and band_units[0] else None

    if len(file_list) == 1:
        arr = _read_one(file_list[0], ref, out_dtype)
        return _Loaded(
            name=name,
            display_name=display_name,
            array=arr,
            dim_name=None,
            coords={},
            units=units,
        )

    # 3D: pre-allocate (N, H, W) once, then fill per file — avoids the
    # (concat N arrays) memory bump that stacking would cause.
    stack = np.empty((len(file_list), ref.height, ref.width), dtype=out_dtype)
    for i, f in enumerate(file_list):
        stack[i] = _read_one(f, ref, out_dtype)

    # Dim + coord choice mirrors the original xarray-backed code: single ref
    # date → linear time series; multiple refs → integer pair index + date
    # labels; single date per file → plain time series.
    dates_per_file = [get_dates(f, fmt=fmt) for f in file_list]
    pair_dim = f"pair_{name}"
    time_dim = f"time_{name}"

    if all(len(d) >= 2 for d in dates_per_file):
        pairs = [(d[0], d[1]) for d in dates_per_file]
        ref_dates = {p[0] for p in pairs}
        if len(ref_dates) == 1:
            sec = pd.to_datetime([p[1] for p in pairs])
            order = np.argsort(sec).tolist()
            stack = stack[order]
            return _Loaded(
                name=name,
                display_name=display_name,
                array=stack,
                dim_name=time_dim,
                coords={time_dim: (time_dim, sec[order].to_numpy())},
                units=units,
            )
        order = sorted(range(len(pairs)), key=lambda i: pairs[i])
        stack = stack[order]
        pairs = [pairs[i] for i in order]
        # dtype=object (variable-length strings) rather than default `<U21`
        # fixed-length — the latter has no zarr v3 spec and triggers a loud
        # UnstableSpecificationWarning on every write. Object maps to zarr's
        # VLenUTF8 codec, which *is* standardised.
        labels = np.array(
            [f"{p[0].strftime('%Y-%m-%d')}_{p[1].strftime('%Y-%m-%d')}" for p in pairs],
            dtype=object,
        )
        return _Loaded(
            name=name,
            display_name=display_name,
            array=stack,
            dim_name=pair_dim,
            coords={
                pair_dim: (pair_dim, np.arange(len(pairs))),
                f"reference_date_{name}": (
                    pair_dim,
                    pd.to_datetime([p[0] for p in pairs]).to_numpy(),
                ),
                f"secondary_date_{name}": (
                    pair_dim,
                    pd.to_datetime([p[1] for p in pairs]).to_numpy(),
                ),
                f"pair_label_{name}": (pair_dim, labels),
            },
            units=units,
        )
    if all(len(d) == 1 for d in dates_per_file):
        t = pd.to_datetime([d[0] for d in dates_per_file])
        order = np.argsort(t).tolist()
        stack = stack[order]
        return _Loaded(
            name=name,
            display_name=display_name,
            array=stack,
            dim_name=time_dim,
            coords={time_dim: (time_dim, t[order].to_numpy())},
            units=units,
        )
    raise ValueError(
        f"Group {display_name!r}: inconsistent filename date structure "
        f"({[len(d) for d in dates_per_file]})"
    )


def _read_one(path: str, ref: _SpatialRef, out_dtype: np.dtype) -> np.ndarray:
    """Read band 1 of a single tif as a 2D numpy array, asserting shape match."""
    with rasterio.open(path) as src:
        assert (src.height, src.width) == (
            ref.height,
            ref.width,
        ), f"{path}: shape {(src.height, src.width)} != ref {(ref.height, ref.width)}"
        arr = src.read(1)
    return arr.astype(out_dtype, copy=False)


def _pyramid_level_coords(
    ref: _SpatialRef, min_size: int, max_levels: int = 6
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Return ``(y, x)`` coord pairs for each pyramid level, starting with level 0.

    2×2 mean resampling on both dims — matches ``bowser.geozarr._coarsen_2x2_numpy``
    so consumer code that interprets the coarsened transforms keeps working.
    """
    levels = [(ref.y_coords, ref.x_coords)]
    for _ in range(max_levels):
        y, x = levels[-1]
        if len(y) // 2 < min_size or len(x) // 2 < min_size:
            break
        ny = (len(y) // 2) * 2
        nx = (len(x) // 2) * 2
        levels.append(
            (
                y[:ny].reshape(-1, 2).mean(axis=1),
                x[:nx].reshape(-1, 2).mean(axis=1),
            )
        )
    return levels


def _coarsen_2x2(arr: np.ndarray) -> np.ndarray:
    """2×2-mean coarsen the last two axes.

    See ``bowser.geozarr._coarsen_2x2_numpy``.
    """
    ny = (arr.shape[-2] // 2) * 2
    nx = (arr.shape[-1] // 2) * 2
    sub = arr[..., :ny, :nx]
    reshaped = sub.reshape(sub.shape[:-2] + (ny // 2, 2, nx // 2, 2))
    if np.issubdtype(arr.dtype, np.floating):
        # nanmean: plain mean propagates NaN so any 2×2 block touching a NaN
        # becomes NaN, wiping coarsened tiles for masked layers. All-NaN blocks
        # legitimately stay NaN — suppress the RuntimeWarning those raise.
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.filterwarnings("ignore", r"Mean of empty slice", RuntimeWarning)
            return np.nanmean(reshaped, axis=(-3, -1), dtype=np.float32).astype(
                arr.dtype, copy=False
            )
    return reshaped.mean(axis=(-3, -1), dtype=np.float32).astype(arr.dtype, copy=False)


def _load_and_coarsen(
    rg: dict, ref: _SpatialRef, n_levels: int
) -> tuple[_Loaded, list[np.ndarray]]:
    """Reader-thread entry point: load a group and produce every pyramid level.

    Coarsening happens inside the reader thread so the numpy reductions overlap
    with other readers' I/O; if it lived in the main thread it would stall
    subsequent writes behind each coarsen.
    """
    lv = _load_group(rg, ref)
    levels = [lv.array]
    for _ in range(1, n_levels):
        levels.append(_coarsen_2x2(levels[-1]))
    return lv, levels


def _write_skeleton(
    output: str, group: str | None, y: np.ndarray, x: np.ndarray, crs_wkt: str
) -> None:
    """Initialise a zarr group with y/x/spatial_ref only.

    Variables are appended afterwards.
    """
    skel = xr.Dataset(coords={"y": y, "x": x})
    if crs_wkt:
        import rioxarray  # noqa: F401, PLC0415

        skel = skel.rio.write_crs(crs_wkt)
    skel.to_zarr(output, group=group, mode="w", consolidated=False)


def _write_variable_to_all_levels(
    output: str,
    lv: _Loaded,
    levels: list[np.ndarray],
    pyramid: bool,
    write_cfg: ZarrWriteConfig,
) -> None:
    """Append one variable (all pyramid levels) into existing skeleton groups."""
    for i, arr in enumerate(levels):
        group = str(i) if pyramid else None
        if lv.dim_name is None:
            da = xr.DataArray(arr, dims=("y", "x"), name=lv.name)
        else:
            da = xr.DataArray(arr, dims=(lv.dim_name, "y", "x"), name=lv.name)
        # Normally stamped by ds.rio.write_crs() on the full Dataset; we
        # deliberately exclude y/x/spatial_ref here (they live in the skeleton)
        # so do the one attr that GeoZarr readers still need by hand.
        da.attrs["grid_mapping"] = "spatial_ref"
        # CF conventions: ``long_name`` → colorbar title, ``units`` →
        # colorbar unit label in the bowser UI. long_name comes from the
        # RasterGroup's display name (e.g. "Velocity") so the UI doesn't
        # have to show the sanitized zarr variable name ("velocity").
        da.attrs["long_name"] = lv.display_name
        if lv.units:
            da.attrs["units"] = lv.units
        coords = dict(lv.coords.items())
        ds_var = xr.Dataset({lv.name: da}, coords=coords)
        ds_var.to_zarr(
            output,
            group=group,
            mode="a",
            consolidated=False,
            encoding=shard_encoding(ds_var, write_cfg),
        )


def _bounded_in_flight(
    pool: ThreadPoolExecutor,
    fn: Callable[[Any], Any],
    items: Iterable[Any],
    max_in_flight: int,
) -> Iterator[Any]:
    """Yield ``fn(item)`` results in completion order.

    Caps the number of outstanding submissions at ``max_in_flight``.

    Without the cap, readers would race ahead of the main-thread writer and
    pile every loaded variable into memory — defeating the whole point of
    streaming. With the cap, a new submission is only made after a previous
    result is consumed.
    """
    it = iter(items)
    in_flight = set()
    for item in itertools.islice(it, max_in_flight):
        in_flight.add(pool.submit(fn, item))
    while in_flight:
        done, _pending = wait(in_flight, return_when=FIRST_COMPLETED)
        for fut in done:
            in_flight.remove(fut)
            yield fut.result()
            nxt = next(it, None)
            if nxt is not None:
                in_flight.add(pool.submit(fn, nxt))


def _sanitize(name: str) -> str:
    """Normalize a raster group name to a valid zarr variable name."""
    out = name.lower()
    for c in " .-/()":
        out = out.replace(c, "_")
    return "_".join(filter(None, out.split("_")))
