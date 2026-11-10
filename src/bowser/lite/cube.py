"""Opening GeoZarr cubes for bowser-lite, and the per-dataset registry.

Mirrors ``bowser.state`` (``_open_md``, ``PyramidLevel``, ``BowserState``,
``DatasetRegistry``) and ``bowser.geozarr`` (multiscales layout, CRS lookup), but
reads the CRS and grid straight from the Zarr metadata with pyproj instead of
rioxarray, and opens arrays without dask (``chunks=None``): xarray then reads
only the chunks an index touches.
"""

from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import xarray as xr
from pyproj import CRS, Transformer
from xarray.backends.zarr import ZarrBackendEntrypoint

from ..catalog import CatalogEntry, load_catalog
from ..constants import TILE_SIZE
from . import geo

if (
    TYPE_CHECKING
):  # imported for annotations only: bowser.config reads settings on import
    from ..config import Settings

logger = logging.getLogger("bowser")

#: Web Mercator map circumference at the equator (metres).
_WEB_MERCATOR_EQUATOR_M = 40075016.686


def storage_options_for(uri: str | Path) -> dict[str, Any] | None:
    """Return the fsspec ``storage_options`` for ``uri``.

    S3 is anonymous unless ``BOWSER_S3_ANON=0``.

    Same rule as ``bowser.geozarr.storage_options_for``; ``None`` for local paths,
    because zarr refuses unused storage options.
    """
    if str(uri).startswith("s3://"):
        anon = os.environ.get("BOWSER_S3_ANON", "1").lower() not in ("0", "false", "no")
        return {"anon": anon}
    return None


def _open_group(uri: str, group: str | None = None) -> xr.Dataset:
    """Open one Zarr group lazily, without dask (every read touches only its chunks).

    Same as ``xr.open_zarr(uri, group, consolidated=False, chunks=None)``, but
    names the zarr backend class directly: given the engine as a string, xarray
    loads every installed backend plugin first, and rioxarray's imports rasterio.
    """
    return xr.open_dataset(
        uri,
        engine=ZarrBackendEntrypoint,
        group=group,
        consolidated=False,
        chunks=None,
        storage_options=storage_options_for(uri),
    )


def multiscales_layout(attrs: dict) -> list[dict] | None:
    """Return a store's ``multiscales.layout`` root attr (None for a flat store)."""
    ms = attrs.get("multiscales")
    if not isinstance(ms, dict):
        return None
    layout = ms.get("layout")
    if not isinstance(layout, list) or not layout:
        return None
    return layout


@dataclass
class Level:
    """One level of a multiscale pyramid (``bowser.state.PyramidLevel``)."""

    asset: str
    dataset: xr.Dataset
    pixel_size_m: float

    @classmethod
    def from_dataset(cls, asset: str, ds: xr.Dataset) -> "Level":
        """Wrap a dataset; the pixel size is the mean x/y coordinate spacing."""
        dx = abs(float(ds.x[1] - ds.x[0])) if ds.sizes["x"] > 1 else 0.0
        dy = abs(float(ds.y[1] - ds.y[0])) if ds.sizes["y"] > 1 else 0.0
        return cls(asset=asset, dataset=ds, pixel_size_m=(dx + dy) / 2.0)


def _normalise(ds: xr.Dataset) -> xr.Dataset:
    """Make a level look like the full server's after ``rio.write_crs``.

    ``spatial_ref`` becomes a scalar coordinate (its first time step when it has
    a time dim), and ``grid_mapping`` moves out of the spatial variables' attrs,
    as rioxarray does.
    """
    if "spatial_ref" in ds.data_vars:
        ds = ds.set_coords("spatial_ref")
    if "spatial_ref" in ds.variables and ds["spatial_ref"].dims:
        dim = ds["spatial_ref"].dims[0]
        ds = ds.assign_coords(
            spatial_ref=ds["spatial_ref"].isel({dim: 0}).drop_vars(dim)
        )
    for name, var in ds.data_vars.items():
        if {"x", "y"}.issubset(var.dims) and "grid_mapping" in var.attrs:
            attrs = dict(var.attrs)
            attrs.pop("grid_mapping")
            ds[name].attrs = attrs
    return ds


def spatial_ref_attrs(ds: xr.Dataset | xr.DataArray) -> dict | None:
    """Attributes of the ``spatial_ref`` coordinate, or None."""
    if "spatial_ref" in ds.coords:
        return dict(ds.coords["spatial_ref"].attrs)
    return None


@dataclass
class Cube:
    """An opened GeoZarr cube: level-0 dataset, its CRS and all pyramid levels."""

    uri: str
    dataset: xr.Dataset
    crs: CRS
    levels: list[Level]
    transformer_from_lonlat: Transformer = field(repr=False)

    @property
    def mode(self) -> str:
        """Always ``"md"``: lite serves GeoZarr cubes only."""
        return "md"

    def dataset_for_tile_zoom(self, z: int, tile_size: int = TILE_SIZE) -> xr.Dataset:
        """Return the coarsest level whose pixel fits in a tile pixel at zoom ``z``."""
        if len(self.levels) <= 1:
            return self.dataset
        tile_pixel_m = _WEB_MERCATOR_EQUATOR_M / ((1 << z) * tile_size)
        chosen = self.levels[0]
        for lvl in self.levels:
            if lvl.pixel_size_m <= tile_pixel_m:
                chosen = lvl
        return chosen.dataset

    def bounds(self, ds: xr.Dataset | xr.DataArray | None = None) -> geo.Bounds:
        """Return the native-CRS bounds of ``ds`` (default: level 0), as rioxarray."""
        ds = self.dataset if ds is None else ds
        return geo.grid_bounds(
            np.asarray(ds["x"].values),
            np.asarray(ds["y"].values),
            spatial_ref_attrs(ds),
        )

    def lonlat_bounds(self) -> geo.Bounds:
        """Level-0 bounds in lon/lat (as ``transform_bounds``, 21 points per edge)."""
        return geo.transform_bounds(self.crs, geo.WGS84, self.bounds())


def open_cube(uri: str) -> Cube:
    """Open a GeoZarr store (flat, or a multiscales pyramid) at a path or URL."""
    logger.info(f"Loading MD dataset from {uri}")
    root = _open_group(uri)
    layout = multiscales_layout(dict(root.attrs))
    if layout:
        datasets = [
            (str(lv["asset"]), _open_group(uri, str(lv["asset"]))) for lv in layout
        ]
        ds = datasets[0][1]
        # Pyramid data lives in a subgroup; root attrs (LOS geometry etc.) still count.
        ds.attrs = {**dict(root.attrs), **ds.attrs}
    else:
        datasets = [("", root)]
        ds = root
    ds = _normalise(ds)
    crs = geo.resolve_crs(dict(ds.attrs), spatial_ref_attrs(ds))
    levels = [Level.from_dataset(datasets[0][0], ds)]
    levels += [Level.from_dataset(asset, _normalise(lv)) for asset, lv in datasets[1:]]
    if len(levels) > 1:
        logger.info(
            f"Pyramid detected: {len(levels)} level(s), "
            f"px(m): {[round(lv.pixel_size_m, 3) for lv in levels]}"
        )
    tr = Transformer.from_crs(4326, crs, always_xy=True)
    return Cube(uri=uri, dataset=ds, crs=crs, levels=levels, transformer_from_lonlat=tr)


def load_default(settings: Settings) -> Cube | None:
    """Return the cube named by ``BOWSER_STACK_DATA_FILE`` (None in catalog-only mode).

    Raises
    ------
    ValueError
        When there is neither a stack file nor a catalog (COG mode is not part of lite).

    """
    if settings.BOWSER_STACK_DATA_FILE:
        return open_cube(settings.BOWSER_STACK_DATA_FILE)
    if settings.BOWSER_CATALOG_FILE:
        logger.info("Catalog-only startup. Every request must carry ?dataset=<id>.")
        return None
    raise ValueError(
        "No data files specified — bowser-lite needs BOWSER_STACK_DATA_FILE "
        "(one GeoZarr cube) or BOWSER_CATALOG_FILE (a catalog). "
        "COG mode (a rasters JSON) needs the full server: `bowser run`."
    )


@dataclass
class Registry:
    """Catalog id -> opened :class:`Cube`, loaded lazily, LRU-evicted.

    The lite ``DatasetRegistry``.
    """

    catalog: dict[str, CatalogEntry] = field(default_factory=dict)
    maxsize: int = 4
    _cache: "OrderedDict[str, Cube]" = field(default_factory=OrderedDict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @classmethod
    def from_settings(cls, settings: Settings) -> "Registry":
        """Return a registry over ``BOWSER_CATALOG_FILE``; empty if unset."""
        if not settings.BOWSER_CATALOG_FILE:
            return cls()
        return cls(
            catalog={e.id: e for e in load_catalog(settings.BOWSER_CATALOG_FILE)}
        )

    def get(self, dataset_id: str) -> Cube:
        """Return the cube for ``dataset_id``, opened on first access."""
        if dataset_id not in self.catalog:
            raise KeyError(
                f"unknown dataset id {dataset_id!r}; catalog has {sorted(self.catalog)}"
            )
        with self._lock:
            cached = self._cache.get(dataset_id)
            if cached is not None:
                self._cache.move_to_end(dataset_id)
                return cached
        cube = open_cube(self.catalog[dataset_id].uri)
        with self._lock:
            if dataset_id in self._cache:
                self._cache.move_to_end(dataset_id)
                return self._cache[dataset_id]
            self._insert(dataset_id, cube)
        return cube

    def register(self, entry: CatalogEntry, cube: Cube | None = None) -> None:
        """Add (or replace) an entry at runtime, with its cube if already open."""
        with self._lock:
            self.catalog[entry.id] = entry
            if cube is not None:
                self._insert(entry.id, cube)

    def _insert(self, dataset_id: str, cube: Cube) -> None:
        self._cache[dataset_id] = cube
        self._cache.move_to_end(dataset_id)
        while len(self._cache) > self.maxsize:
            evicted, _ = self._cache.popitem(last=False)
            logger.info(f"Registry evicted {evicted!r}")

    def ids(self) -> list[str]:
        """Return the catalog ids."""
        return list(self.catalog)
