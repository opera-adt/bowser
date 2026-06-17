"""GeoZarr convention helpers for bowser.

Thin wrapper around ``geozarr-toolkit`` for reading and writing the
``spatial:``, ``proj:``, and ``multiscales`` Zarr conventions on the stores
bowser opens in MD mode.

References
----------
- spatial:     https://github.com/zarr-conventions/spatial
- proj:        https://github.com/zarr-experimental/geo-proj
- multiscales: https://github.com/zarr-conventions/multiscales

"""

from __future__ import annotations

import logging
import os
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
import xarray as xr
from rasterio.crs import CRS

BloscCname = Literal["lz4", "lz4hc", "blosclz", "snappy", "zlib", "zstd"]

__all__ = [
    "resolve_crs",
    "annotate_store",
    "build_pyramid",
    "data_group_name",
    "load_pyramid_levels",
    "shard_encoding",
    "storage_options_for",
    "ZarrWriteConfig",
]


def storage_options_for(uri: str | Path) -> dict[str, Any]:
    """Return fsspec ``storage_options`` for opening ``uri``.

    For ``s3://`` URIs we default to *anonymous* (unsigned) access. A bucket
    being "public" only means its policy permits unsigned requests; the client
    still signs every request unless told otherwise, so boto3 walks the AWS
    credential chain and fails with a ``NoCredentialsError`` (often masked by
    the aiobotocore ContextVar bug, see ``_multiscales_layout``) when no keys
    are configured. Passing ``anon=True`` selects botocore's ``UNSIGNED``
    signer, which is what public buckets actually want.

    Set ``BOWSER_S3_ANON=0`` (or ``false``) to use the normal credential chain
    for private buckets.

    Parameters
    ----------
    uri : str or Path
        The store URI. Non-``s3://`` URIs get empty options.

    Returns
    -------
    dict
        ``{"anon": bool}`` for S3 URIs, ``{}`` otherwise.

    """
    if str(uri).startswith("s3://"):
        anon = os.environ.get("BOWSER_S3_ANON", "1").lower() not in ("0", "false", "no")
        return {"anon": anon}
    return {}

# Defaults tuned for DISP-S1-sized cubes on S3: 256×256 chunks keep random-access
# tile reads cheap, and 4× shard factor on every dim means one HTTP GET per
# shard covers a 1024×1024 tile block (or 4 timesteps for timeseries reads).
# Pair of references: opera-utils uses `(4, 256, 256)` chunks × `(1, 4, 4)`
# shard_factors; we keep time chunk = 1 because bowser tile renders hit one
# timestep at a time, and we want shard time = 4 so timeseries `/point` reads
# bundle 4 timesteps per HTTP GET.
DEFAULT_CHUNK = 256
DEFAULT_SHARD_FACTOR = 4
# lz4 + clevel 5 = zarr's own default. ~6× faster to compress than zstd-6 at
# only ~10% worse ratio, and sharding already collapses the file count, so the
# extra bytes don't cost us HTTP round-trips. Users who want smaller stores
# can override with `shard_encoding(..., compression_name="zstd", ...)`.
DEFAULT_COMPRESSION_NAME: "BloscCname" = "lz4"
DEFAULT_COMPRESSION_LEVEL = 5

# Default quantize targets: variables whose values are inherently noisy and
# carry only a few bits of real information per sample (coherence-like
# quality layers). Quantize zeroes low mantissa bits before compression —
# adjacent pixels then share more bit patterns, so Blosc finds longer runs.
# On DISP-S1 temporal coherence the on-disk size drops ~40% with no
# visual or analytic impact on the ~1 bit of real signal per pixel.
DEFAULT_QUANTIZE_PATTERNS: tuple[str, ...] = (
    "coherence",
    "similarity",
    "dispersion",
)

logger = logging.getLogger("bowser")


@dataclass(frozen=True)
class ZarrWriteConfig:
    """Encoding knobs for a sharded zarr v3 write.

    Bundles the chunk / shard / compression / quantize parameters that
    ``shard_encoding`` and ``build_pyramid`` both consume. Construct one at
    CLI-parse time and hand it around — saves threading six kwargs through
    every call site.

    Attributes
    ----------
    chunk : int
        Square chunk edge (pixels) along y and x.
    shard_factor : int
        Shard shape = chunk × factor on every dim. 1 disables sharding.
    compression_name, compression_level : str, int
        Blosc sub-codec and clevel.
    quantize_digits : int or None
        If set, matching float variables get a ``Quantize`` filter before
        compression that rounds to this many significant digits. ``None``
        means no quantization.
    quantize_patterns : tuple of str
        Substring patterns matched against variable names (case-insensitive)
        to decide whether a variable gets the quantize filter. Integer-dtype
        variables are always skipped regardless of name.
    """

    chunk: int = DEFAULT_CHUNK
    shard_factor: int = DEFAULT_SHARD_FACTOR
    compression_name: BloscCname = DEFAULT_COMPRESSION_NAME
    compression_level: int = DEFAULT_COMPRESSION_LEVEL
    quantize_digits: int | None = None
    quantize_patterns: tuple[str, ...] = field(
        default_factory=lambda: DEFAULT_QUANTIZE_PATTERNS
    )


def resolve_crs(ds: xr.Dataset) -> CRS:
    """Resolve a CRS from a Dataset, preferring GeoZarr ``proj:`` attrs.

    Parameters
    ----------
    ds : xr.Dataset
        A Dataset that may carry ``proj:code`` / ``proj:wkt2`` on its root
        attributes (GeoZarr ``proj`` convention), or a CF-conventions
        ``spatial_ref`` variable with a ``crs_wkt`` attribute (rioxarray).

    Returns
    -------
    rasterio.crs.CRS

    Raises
    ------
    ValueError
        If no CRS source is present.

    """
    code = ds.attrs.get("proj:code")
    if code:
        return CRS.from_string(code)
    wkt2 = ds.attrs.get("proj:wkt2")
    if wkt2:
        return CRS.from_wkt(wkt2)
    if "spatial_ref" in ds.variables:
        return CRS.from_wkt(ds.spatial_ref.crs_wkt)
    raise ValueError(
        "No CRS found on dataset. Expected GeoZarr 'proj:code'/'proj:wkt2' "
        "root attrs or a CF 'spatial_ref' variable with 'crs_wkt'."
    )


def shard_encoding(
    ds: xr.Dataset,
    config: ZarrWriteConfig | None = None,
) -> dict[str, dict]:
    """Build per-variable ``encoding`` dict with chunks + shards + compression.

    Produces a zarr v3 encoding dict ready to hand to
    ``xr.Dataset.to_zarr(..., encoding=...)``. Every spatial data variable
    gets:

    - ``chunks`` = 1 on non-spatial dims, ``config.chunk`` on y/x
    - ``shards`` = chunks × ``config.shard_factor`` on every dim (when > 1)
    - ``filters`` = one ``Quantize`` codec if the variable name matches a
      configured pattern and the dtype is floating-point
    - ``compressors`` = one ``BloscCodec``

    Parameters
    ----------
    ds : xr.Dataset
        Dataset whose data_vars will be written. Variables with ndim < 2 are
        skipped (chunks/shards only make sense for gridded arrays).
    config : ZarrWriteConfig, optional
        Encoding knobs. Defaults to ``ZarrWriteConfig()`` (chunks=256,
        shard_factor=4, Blosc/lz4/5, no quantization).

    Returns
    -------
    dict[str, dict]
        Mapping from variable name to its per-variable encoding dict.

    """
    from zarr.codecs import BloscCodec  # noqa: PLC0415 — optional runtime dep

    cfg = config or ZarrWriteConfig()
    assert cfg.chunk >= 1 and cfg.shard_factor >= 1
    encoding: dict[str, dict] = {}
    for name, da in ds.data_vars.items():
        if da.ndim < 2:
            continue
        # Match by literal dim name rather than da.rio.x_dim/y_dim, which
        # requires a set CRS and fails on freshly-opened coarsened levels
        # inside build_pyramid.
        chunks = tuple(
            min(cfg.chunk, da.sizes[d]) if d in ("x", "y") else 1 for d in da.dims
        )
        var_enc: dict = {
            "chunks": chunks,
            "compressors": [
                BloscCodec(cname=cfg.compression_name, clevel=cfg.compression_level)
            ],
        }
        quantize = _quantize_codec_for(str(name), da.dtype, cfg)
        if quantize is not None:
            var_enc["filters"] = [quantize]
        # shard_factor=1 means "don't wrap chunks in a shard" — dask chunks can
        # stay small, each dask task writes exactly one chunk, parallelism is
        # maximum. Useful when write time dominates (local disk, small cubes).
        if cfg.shard_factor > 1:
            shards = tuple(c * cfg.shard_factor for c in chunks)
            assert all(s % c == 0 for s, c in zip(shards, chunks))
            var_enc["shards"] = shards
        encoding[str(name)] = var_enc
    return encoding


def _quantize_codec_for(name: str, dtype: np.dtype, cfg: ZarrWriteConfig):
    """Return a ``Quantize`` codec for this variable, or ``None`` to skip.

    Integer dtypes always skip (quantize is a float-only codec). Floats are
    quantized when ``cfg.quantize_digits`` is set and the variable name
    contains any of ``cfg.quantize_patterns`` (case-insensitive).
    """
    if cfg.quantize_digits is None:
        return None
    if not np.issubdtype(dtype, np.floating):
        return None
    lname = name.lower()
    if not any(pat.lower() in lname for pat in cfg.quantize_patterns):
        return None
    from zarr.codecs.numcodecs import Quantize  # noqa: PLC0415 — optional dep

    return Quantize(digits=cfg.quantize_digits, dtype=str(dtype))


def _multiscales_layout(path: str | Path) -> list[dict] | None:
    """Return the multiscales.layout list from the root group's attrs, or None.

    ``consolidated=False`` is important: pyramidal stores written by
    ``build_pyramid`` only consolidate the root and per-level sub-groups,
    so the parent root's consolidation may be absent, and more importantly
    ``zarr.open_consolidated`` against an S3 URI triggers an aiobotocore
    ContextVar conflict on our pixi runtime. Reading without consolidation
    is a few extra HTTP HEADs and side-steps the issue.
    """
    ds = xr.open_zarr(
        str(path), consolidated=False, storage_options=storage_options_for(path)
    )
    ms = ds.attrs.get("multiscales")
    if not isinstance(ms, dict):
        return None
    layout = ms.get("layout")
    if not isinstance(layout, list) or not layout:
        return None
    return layout


def load_pyramid_levels(path: str | Path):
    """Open every level of a pyramidal store into a ``list[PyramidLevel]``."""
    from .state import PyramidLevel  # noqa: PLC0415 — avoid cycle

    layout = _multiscales_layout(path)
    if not layout:
        raise ValueError(f"{path} has no multiscales layout")
    so = storage_options_for(path)
    out = []
    for level in layout:
        asset = str(level["asset"])
        ds = xr.open_zarr(path, group=asset, consolidated=False, storage_options=so)
        out.append(PyramidLevel.from_dataset(asset, ds))
    return out


def data_group_name(path: str | Path) -> str | None:
    """Return the subgroup name containing level-0 data for a pyramidal store.

    Returns ``None`` for flat (non-pyramid) stores.
    """
    layout = _multiscales_layout(path)
    if not layout:
        return None
    asset = layout[0].get("asset") if isinstance(layout[0], dict) else None
    return str(asset) if asset else None


def annotate_store(
    path: str | Path,
    *,
    variable: str | None = None,
    data_group: str | None = None,
    multiscales_levels: list[dict] | None = None,
    consolidate: bool = False,
) -> None:
    """Write GeoZarr attrs to a zarr store.

    Always writes ``spatial:`` / ``proj:`` / ``zarr_conventions`` at the group
    that actually holds the level-0 data (``data_group`` if given, else root).
    When ``data_group`` is provided *or* ``multiscales_levels`` is given, also
    writes the ``multiscales`` attribute at the root.

    Parameters
    ----------
    path : str or Path
        Path to an existing zarr store.
    variable : str, optional
        Which data variable to inspect for CRS/transform. Default: first 2+ D.
    data_group : str, optional
        Zarr sub-group path where the level-0 data lives (e.g. ``"0"``). If
        ``None``, data is read from root.
    multiscales_levels : list[dict], optional
        ``multiscales.layout`` entries for a pyramid. When not given but
        ``data_group`` is set, a single-level layout pointing at ``data_group``
        is written.
    consolidate : bool, default False
        Re-consolidate metadata at root (and at the data group). Off by
        default because (a) bowser opens every store with
        ``consolidated=False`` to work around the aiobotocore ContextVar bug
        on S3, so ``.zmetadata`` is never read, and (b) zarr v3 hasn't
        standardized consolidated metadata yet — leaving it on emits a
        ``ZarrUserWarning`` on every write.

    """
    import zarr
    from geozarr_toolkit import create_zarr_conventions, from_rioxarray
    from geozarr_toolkit.conventions import (
        MultiscalesConventionMetadata,
        ProjConventionMetadata,
        SpatialConventionMetadata,
    )
    from geozarr_toolkit.helpers.metadata import create_multiscales_layout

    # 1. Write spatial:/proj:/zarr_conventions on the data group.
    # consolidated=False: we don't write .zmetadata (see the consolidate kwarg
    # above), so asking zarr to look for it just produces a fallback warning.
    ds = (
        xr.open_zarr(path, group=data_group, consolidated=False)
        if data_group
        else xr.open_zarr(path, consolidated=False)
    )
    crs = resolve_crs(ds)
    ds = ds.rio.write_crs(crs)

    if variable is None:
        variable = next(name for name, v in ds.data_vars.items() if v.ndim >= 2)
    da = ds[variable]
    non_spatial = [d for d in da.dims if d not in (da.rio.x_dim, da.rio.y_dim)]
    if non_spatial:
        da = da.isel({d: 0 for d in non_spatial})

    geo_attrs = from_rioxarray(da)
    conventions = [SpatialConventionMetadata(), ProjConventionMetadata()]

    data_node = zarr.open_group(str(path), mode="r+", path=data_group)
    data_node.attrs.update(geo_attrs)
    data_node.attrs["zarr_conventions"] = create_zarr_conventions(*conventions)

    # 2. Write multiscales at the root (if applicable).
    if data_group or multiscales_levels:
        levels = multiscales_levels or [{"asset": data_group or "0"}]
        ms_attrs = create_multiscales_layout(levels, resampling_method="average")
        root = zarr.open_group(str(path), mode="r+")
        root.attrs.update(ms_attrs)
        # Duplicate spatial/proj on root too — lets non-multiscales-aware readers
        # discover the CRS without descending into /0.
        root.attrs.update(geo_attrs)
        root.attrs["zarr_conventions"] = create_zarr_conventions(
            *conventions, MultiscalesConventionMetadata()
        )

    if consolidate:
        zarr.consolidate_metadata(str(path))
        if data_group:
            zarr.consolidate_metadata(str(path), path=data_group)


def _coarsen_2x2_numpy(ds: xr.Dataset) -> xr.Dataset:
    """Coarsen every (..., y, x) variable by 2×2 mean, in pure numpy.

    A pyramidal write step needs roughly 1 s of real work per level (reshape
    + mean + compress). Doing it via ``xr.Dataset.coarsen().mean()`` is
    ~100× slower in practice because coarsen is lazy and defers to dask,
    which rebuilds a graph referencing the previous level's on-disk zarr
    and re-traverses it every level. This helper assumes every spatial
    variable has dims ending in ``(y, x)`` (the converter's output layout)
    and does the whole level in-memory.
    """
    assert "y" in ds.dims and "x" in ds.dims, "expected y/x dims on the dataset"
    new_vars: dict[str, xr.DataArray] = {}
    for name, da in ds.data_vars.items():
        if "y" not in da.dims or "x" not in da.dims:
            # Non-spatial var (e.g. scalar spatial_ref), carry over unchanged.
            new_vars[str(name)] = da
            continue
        assert da.dims[-2:] == (
            "y",
            "x",
        ), f"{name}: expected dims to end in (y, x), got {da.dims}"
        arr = np.asarray(da.values)
        ny = (arr.shape[-2] // 2) * 2
        nx = (arr.shape[-1] // 2) * 2
        arr = arr[..., :ny, :nx]
        # Reshape last two axes to (ny//2, 2, nx//2, 2), mean the two "2" axes.
        reshaped = arr.reshape(arr.shape[:-2] + (ny // 2, 2, nx // 2, 2))
        if np.issubdtype(arr.dtype, np.floating):
            # nanmean rather than mean: plain mean propagates NaN so any 2×2
            # block touching a NaN becomes NaN and the coarsened tile is
            # effectively masked out (visible as black/transparent tiles at
            # zoom). Coherence-like masked layers have enough NaNs that
            # propagating them destroys the pyramid. All-NaN blocks
            # legitimately stay NaN; suppress the RuntimeWarning those raise.
            with np.errstate(invalid="ignore"), warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore", r"Mean of empty slice", RuntimeWarning
                )
                coarse = np.nanmean(reshaped, axis=(-3, -1), dtype=np.float32).astype(
                    arr.dtype, copy=False
                )
        else:
            # Integer dtypes don't have NaN; use plain mean. Cast back to
            # original dtype after (mean upcasts to float64 otherwise).
            coarse = reshaped.mean(axis=(-3, -1), dtype=np.float32).astype(
                arr.dtype, copy=False
            )
        new_vars[str(name)] = xr.DataArray(coarse, dims=da.dims, attrs=dict(da.attrs))

    y_old = np.asarray(ds.y.values)
    x_old = np.asarray(ds.x.values)
    ny = (len(y_old) // 2) * 2
    nx = (len(x_old) // 2) * 2
    y_new = y_old[:ny].reshape(-1, 2).mean(axis=1)
    x_new = x_old[:nx].reshape(-1, 2).mean(axis=1)

    coords: dict[str, Any] = {"y": y_new, "x": x_new}
    for cname, c in ds.coords.items():
        if cname in ("y", "x"):
            continue
        coords[str(cname)] = c

    return xr.Dataset(new_vars, coords=coords, attrs=dict(ds.attrs))


def build_pyramid(
    path: str | Path,
    *,
    level0: str = "0",
    min_size: int = 256,
    max_levels: int = 6,
    config: ZarrWriteConfig | None = None,
    level_0_ds: xr.Dataset | None = None,
) -> list[dict]:
    """Build a coarsened multiscale pyramid for data already written at ``path/level0``.

    Writes sibling subgroups ``"1"``, ``"2"``, … each at 2× coarser spatial
    resolution than the previous, stopping when ``min(y, x) < min_size`` or
    after ``max_levels`` levels. Uses 2×2 mean resampling in numpy — see
    ``_coarsen_2x2_numpy`` for why we sidestep xarray's lazy coarsen.

    Every level is written with the same chunk + shard encoding as level 0
    (see ``shard_encoding``), so pyramid levels don't undo the small-file
    consolidation won by sharding.

    Parameters
    ----------
    path : str or Path
        Zarr store path. Level-0 data must already exist at ``path/<level0>``.
    level0 : str
        Subgroup name where level-0 data lives.
    min_size : int
        Stop building once either spatial dim drops below this.
    max_levels : int
        Safety cap on the number of coarsened levels.
    config : ZarrWriteConfig, optional
        Encoding config forwarded to ``shard_encoding`` for every level.
    level_0_ds : xr.Dataset, optional
        If provided, used as the starting point instead of re-reading level
        0 from disk. The converter passes its in-memory numpy-backed
        Dataset directly — saves both the disk read and the full dask
        re-traversal that the old implementation did on every pyramid level.

    Returns
    -------
    list[dict]
        ``multiscales.layout`` entries ready to hand to ``annotate_store``.

    """
    cfg = config or ZarrWriteConfig()
    if level_0_ds is not None:
        ds = level_0_ds
    else:
        # Eagerly load — we're about to traverse the whole thing multiple
        # times for mean-coarsen, and 4 GB fits in RAM on any dev machine.
        ds = xr.open_zarr(path, group=level0, consolidated=False).load()

    levels: list[dict[str, Any]] = [{"asset": level0}]
    prev = ds
    for i in range(1, max_levels + 1):
        y_sz = prev.sizes["y"] // 2
        x_sz = prev.sizes["x"] // 2
        if y_sz < min_size or x_sz < min_size:
            break
        logger.info("Coarsening level %d → %d × %d (y × x)", i, y_sz, x_sz)
        coarse = _coarsen_2x2_numpy(prev)
        # Drop the stale GeoTransform attribute carried over from level 0; if
        # we left it, rioxarray would report the original full-res pixel size
        # for coarsened levels, and tile reads would use the wrong affine.
        if "spatial_ref" in coarse.variables:
            coarse["spatial_ref"].attrs.pop("GeoTransform", None)
        # Clear any inherited encoding hints that would conflict with the
        # freshly-shaped arrays.
        for v in list(coarse.variables):
            coarse[v].encoding.clear()
        encoding = shard_encoding(coarse, cfg)
        coarse.to_zarr(
            path, group=str(i), mode="w", consolidated=False, encoding=encoding
        )
        levels.append(
            {
                "asset": str(i),
                "derived_from": str(i - 1),
                "transform": {"scale": [2.0, 2.0]},
            }
        )
        prev = coarse

    return levels
