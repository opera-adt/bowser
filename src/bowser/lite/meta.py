"""What ``/datasets`` says about a cube: layers, date labels, bounds, LOS geometry.

Pure functions copied from ``bowser.main`` (which cannot be imported here: it pulls in
rasterio, titiler and matplotlib), so the lite server describes a cube exactly as
the full one does.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
import xarray as xr

from ..utils import _uses_spatial_reference
from . import geo
from .cube import Cube, spatial_ref_attrs

logger = logging.getLogger("bowser")

_SPATIAL_DIMS = ("x", "y")
MASK_VARS = ("temporal_coherence", "phase_similarity", "recommended_mask")


def non_spatial_dim(da: xr.DataArray) -> str | None:
    """Return the single non-spatial dim of a DataArray, or None if it is purely 2-D."""
    non = [d for d in da.dims if d not in _SPATIAL_DIMS]
    if not non:
        return None
    assert len(non) == 1, f"{da.name!r}: expected 0 or 1 non-spatial dim, got {non}"
    return str(non[0])


def dim_labels(da: xr.DataArray, dim: str) -> list[str]:
    """Display labels for a non-spatial dim (pair labels, dates, date pairs, or str)."""
    for c in da.coords:
        if str(c).startswith("pair_label_") and da[c].dims == (dim,):
            return [str(v) for v in da[c].values]
    vals = da.coords[dim].values
    if np.issubdtype(vals.dtype, np.datetime64):
        return pd.to_datetime(vals).strftime("%Y-%m-%d").tolist()
    ref = [
        c
        for c in da.coords
        if str(c).startswith("reference_date_") and da[c].dims == (dim,)
    ]
    sec = [
        c
        for c in da.coords
        if str(c).startswith("secondary_date_") and da[c].dims == (dim,)
    ]
    if ref and sec:
        r = pd.to_datetime(da[ref[0]].values)
        s = pd.to_datetime(da[sec[0]].values)
        return [
            f"{a.strftime('%Y-%m-%d')}_{b.strftime('%Y-%m-%d')}" for a, b in zip(r, s)
        ]
    return [str(v) for v in vals]


def labels_for(da: xr.DataArray) -> list[str]:
    """Labels of a variable's non-spatial dim, or ``[]`` for a 2-D variable."""
    dim = non_spatial_dim(da)
    return dim_labels(da, dim) if dim is not None else []


def reference_date(labels: list[str], dim: str) -> str | None:
    """Return the shared reference date if every pair label has the same first date."""
    if not dim.startswith("pair_") or not labels:
        return None
    refs = {lbl.split("_")[0] for lbl in labels if "_" in lbl}
    return refs.pop() if len(refs) == 1 else None


def _enu(d: Any) -> dict | None:
    if isinstance(d, dict) and {"east", "north", "up"}.issubset(d):
        return {
            "east": float(d["east"]),
            "north": float(d["north"]),
            "up": float(d["up"]),
        }
    return None


def los_metadata(attrs: dict) -> dict | None:
    """LOS geometry from cube attrs (legacy scalar or per-swath near/center/far)."""
    heading = attrs.get("heading_angle_deg")
    incidence = attrs.get("incidence_angle_deg")
    if heading is None or incidence is None:
        return None
    if isinstance(incidence, dict) and "center" in incidence:
        inc_center = float(incidence["center"])
        inc_near = float(incidence["near"]) if "near" in incidence else None
        inc_far = float(incidence["far"]) if "far" in incidence else None
    else:
        inc_center = float(incidence)
        inc_near = inc_far = None
    result: dict = {"heading_deg": float(heading), "incidence_deg": inc_center}
    if inc_near is not None:
        result["incidence_deg_near"] = inc_near
    if inc_far is not None:
        result["incidence_deg_far"] = inc_far
    los = attrs.get("los_enu_ground_to_satellite") or attrs.get("los_enu_ground_to_sat")
    if isinstance(los, dict):
        if "center" in los:
            for key, part in (("", "center"), ("_near", "near"), ("_far", "far")):
                vec = _enu(los.get(part))
                if vec is not None:
                    result[f"los_enu_ground_to_sat{key}"] = vec
        elif (flat := _enu(los)) is not None:
            result["los_enu_ground_to_sat"] = flat
    return result


def _as_lonlat(v: Any) -> list[float] | None:
    try:
        return [float(v[0]), float(v[1])]
    except (TypeError, ValueError, IndexError):
        return None


def reference_lonlat(ds: xr.Dataset) -> list[float] | None:
    """``[lon, lat]`` of the product's spatial reference point, if set and valid."""
    candidate: list[float] | None = None
    if "reference_point" in ds.variables:
        a = ds["reference_point"].attrs
        lons, lats = a.get("longitudes"), a.get("latitudes")
        try:
            if lons is not None and lats is not None and len(lons) and len(lats):
                candidate = [float(lons[0]), float(lats[0])]
        except (TypeError, ValueError):
            pass
    a = ds.attrs
    if candidate is None:
        v = a.get("reference_point") or a.get("reference_lonlat")
        if isinstance(v, (list, tuple)) and len(v) == 2:
            candidate = _as_lonlat(v)
    if candidate is None:
        rlon, rlat = a.get("reference_lon"), a.get("reference_lat")
        if rlon is not None and rlat is not None:
            candidate = _as_lonlat((rlon, rlat))
    if candidate is None:
        return None
    lon, lat = candidate
    if abs(lon) > 180 or abs(lat) > 90:
        logger.warning("Ignoring reference point %s: not a valid lon/lat.", candidate)
        return None
    return candidate


def latlon_bounds(cube: Cube) -> geo.Bounds:
    """Lon/lat bounds as the full server computes them for ``/datasets``.

    That is: the first 2-D+ variable subsampled every 10th pixel, warped to
    EPSG:4326 the way GDAL would, and the bounds of that output grid.
    """
    ds = cube.dataset
    if cube.crs == geo.WGS84:
        return cube.bounds()
    first = next(v for v in ds.data_vars.values() if v.ndim >= 2)
    x = np.asarray(first[first.dims[-1]].values)[::10]
    y = np.asarray(first[first.dims[-2]].values)[::10]
    try:
        sub_bounds = geo.grid_bounds(x, y, spatial_ref_attrs(first))
    except ValueError:
        # Under 11 pixels wide: the subsample is one pixel and has no resolution
        # (the full server answers 500 here); the plain bounds transform will do.
        return cube.lonlat_bounds()
    return geo.warp_output_bounds(cube.crs, geo.WGS84, x.size, y.size, sub_bounds)


def dataset_info(cube: Cube, use_spatial_reference: bool) -> dict:
    """Return the ``/datasets`` body: one entry per variable with x and y dims."""
    ds = cube.dataset
    bounds = list(cube.bounds())
    ll_bounds = list(latlon_bounds(cube))
    los = los_metadata(dict(ds.attrs))
    ref_ll = reference_lonlat(ds)
    available_masks = [v for v in MASK_VARS if v in ds.data_vars]
    info = {}
    for name, var in ds.data_vars.items():
        if not {"x", "y"}.issubset(set(var.dims)):
            continue
        moving_ref = _uses_spatial_reference(str(name), var) and use_spatial_reference
        dim = non_spatial_dim(var)
        labels = dim_labels(var, dim) if dim is not None else []
        n = len(labels) if dim is not None else 1
        attrs = dict(var.attrs)
        info[name] = {
            "name": name,
            "file_list": (
                [f"variable:{name}:{dim}:{i}" for i in range(n)]
                if dim is not None
                else [f"variable:{name}"]
            ),
            "mask_file_list": [],
            "mask_min_value": 0.1,
            "nodata": None,
            "uses_spatial_ref": moving_ref,
            "algorithm": "shift" if moving_ref else None,
            "bounds": bounds,
            "latlon_bounds": ll_bounds,
            "x_values": labels,
            "reference_date": reference_date(labels, dim) if dim else None,
            "available_mask_vars": available_masks,
            "label": attrs.get("long_name", name),
            "unit": attrs.get("units", ""),
            "los_metadata": los,
            "reference_lonlat": ref_ll,
        }
    return info
