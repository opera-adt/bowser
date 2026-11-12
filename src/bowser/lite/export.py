"""GeoTIFF export without GDAL: the raster and tags of ``GET /export/geotiff``.

Follows ``bowser.main.export_geotiff`` for a GeoZarr cube step by step, with the
same xarray expressions, so the values, their type, the nodata value, the
provenance tags and the filename are the full server's:

1. validate the masks and describe them (``_export_mask_provenance``);
2. select the time step, subtract the reference date's step, apply the masks
   (``_build_masked_md_dataarray``);
3. subtract the spatial reference's value (``bowser.reference``);
4. describe the export (``bowser.export_provenance``) and write it as
   rioxarray's ``to_raster`` does: the stored type when the values were not
   changed, the attributes as tags, ``long_name`` as the band's description.

The file itself is written by :mod:`bowser.lite.geotiff`. Not supported here: a
custom mask GeoTIFF (reading one needs GDAL).
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import xarray as xr
from fastapi import HTTPException
from xarray.conventions import encode_cf_variable

from ..export_provenance import export_provenance
from ..reference import SourceGrid, reference_offset
from ..utils import _uses_spatial_reference
from . import geo, geotiff
from .cube import Cube, spatial_ref_attrs
from .meta import dim_labels, non_spatial_dim
from .sampling import _mask_frame
from .tiles import minus_reference_step

#: Attributes rioxarray does not write as tags (they have their own place).
_NOT_TAGS = (
    "nodatavals",
    "is_tiled",
    "res",
    "_FillValue",
    "missing_value",
    "fill_value",
    "nodata",
    "crs",
    "transform",
    "scales",
    "scale_factor",
    "add_offset",
    "offsets",
    "grid_mapping",
)
_FILL_NAMES = ("_FillValue", "missing_value", "fill_value", "nodata")


def _clamp(index: int | None, size: int) -> int:
    return max(0, min(index or 0, size - 1))


def _attr_nodata(da: xr.DataArray) -> Any:
    """Return the nodata value named in the attributes, or None."""
    return next((da.attrs[k] for k in _FILL_NAMES if k in da.attrs), None)


def decoded_nodata(da: xr.DataArray) -> Any:
    """Return the value marking missing pixels in memory (``DataArray.rio.nodata``).

    NaN when the stored fill value was decoded to NaN, else the attribute.
    """
    if da.encoding.get("_FillValue") is not None:
        return np.nan
    return _attr_nodata(da)


def _source_nodata(da: xr.DataArray) -> Any:
    """Return the stored fill value, else the decoded one (the provenance's source)."""
    encoded = da.encoding.get("_FillValue")
    return encoded if encoded is not None else decoded_nodata(da)


def time_context(ds: xr.Dataset, variable: str, time_idx: int | None) -> dict:
    """Labels and nodata of a layer (``bowser.main._export_time_context``)."""
    source = ds[variable]
    dim = non_spatial_dim(source)
    labels = dim_labels(source, dim) if dim else []
    idx = _clamp(time_idx, len(labels)) if labels else None
    return {
        "root_attrs": ds.attrs,
        "available_labels": labels,
        "selected_label": labels[idx] if idx is not None else None,
        "selected_index": idx,
        "selected_coordinate": str(source[dim].values[idx])
        if idx is not None
        else None,
        "source_nodata": _source_nodata(source),
    }


def reference_step(
    ds: xr.Dataset, variable: str, ref_time_idx: int | None
) -> dict | None:
    """Return the step an export is relative to (``_export_reference_step``)."""
    if ref_time_idx is None:
        return None
    if variable not in ds.data_vars:
        raise HTTPException(status_code=404, detail=f"Unknown layer: {variable}")
    source = ds[variable]
    dim = non_spatial_dim(source)
    if dim is None:
        raise HTTPException(
            status_code=422, detail=f"{variable} has no time axis for ref_time_idx"
        )
    labels = dim_labels(source, dim)
    idx = _clamp(ref_time_idx, source.sizes[dim])
    return {
        "index": idx,
        "label": labels[idx] if idx < len(labels) else None,
        "coordinate": str(source[dim].values[idx]),
    }


def mask_provenance(
    ds: xr.Dataset,
    variable: str,
    time_idx: int | None,
    mask_variable: str | None,
    mask_min_value: float | None,
    layer_masks: str | None,
) -> tuple[list[dict], list[dict]]:
    """Validate the mask request (``_export_mask_provenance``).

    Returns
    -------
    details : list of dict
        What each mask does, for the provenance.
    parsed : list of dict
        The layer masks to apply.

    """
    if variable not in ds.data_vars:
        raise HTTPException(status_code=404, detail=f"Unknown layer: {variable}")
    details: list[dict] = []

    def add(name: str, threshold: float, operator: str, kind: str) -> None:
        if name not in ds.data_vars:
            raise ValueError(f"Unknown mask layer: {name}")
        if not np.isfinite(threshold):
            raise ValueError("Mask thresholds must be finite")
        context = time_context(ds, name, time_idx)
        details.append(
            {
                "kind": kind,
                "layer": name,
                "operator": operator,
                "threshold": threshold,
                "time_index": context["selected_index"],
                "time_label": context["selected_label"],
                "threshold_units": ds[name].attrs.get("units"),
            }
        )

    try:
        if mask_variable is not None:
            threshold = 0.1 if mask_min_value is None else mask_min_value
            add(mask_variable, threshold, ">", "primary")
        parsed = json.loads(layer_masks) if layer_masks else []
        if not isinstance(parsed, list):
            raise ValueError("layer_masks must be a JSON list")
        for mask in parsed:
            if not isinstance(mask, dict):
                raise ValueError("Each layer mask must be an object")
            mode = mask.get("mode", "min")
            if mode not in ("min", "max"):
                raise ValueError("Mask mode must be min or max")
            name = mask.get("dataset")
            if not isinstance(name, str) or not name:
                raise ValueError("Each layer mask needs a dataset name")
            add(
                name,
                float(mask.get("threshold", 0.5)),
                ">=" if mode == "min" else "<=",
                "layer",
            )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return details, parsed


def masked_slice(
    ds: xr.Dataset,
    variable: str,
    time_idx: int | None,
    mask_variable: str | None,
    mask_min_value: float,
    layer_masks: list[dict],
    ref_time_idx: int | None,
) -> xr.DataArray:
    """Return the 2-D slice to export (``_build_masked_md_dataarray``).

    Only the slices that are needed are read: the full server builds the same
    expressions on the whole variable and takes the slice afterwards (lazily,
    with dask), which gives the same pixels.
    """
    da = ds[variable]
    dim = non_spatial_dim(da)
    if dim is not None:
        full = da
        da = da.isel({dim: _clamp(time_idx, da.sizes[dim])})
        if time_idx is not None and ref_time_idx is not None:
            ref = full.isel({dim: _clamp(ref_time_idx, full.sizes[dim])}, drop=True)
            da = minus_reference_step(da, ref)
    if mask_variable is not None:
        mask = ds[mask_variable]
        mdim = non_spatial_dim(mask)
        if mdim is not None:
            mask = mask.isel({mdim: _clamp(time_idx, mask.sizes[mdim])})
        da = da.where(mask > mask_min_value)
    for m in layer_masks:
        mask = _mask_frame(ds[m["dataset"]], time_idx)
        threshold = float(m.get("threshold", 0.5))
        keep = mask <= threshold if m.get("mode", "min") == "max" else mask >= threshold
        da = da.where(keep)
    return da.transpose("y", "x")


def _reference(
    cube: Cube,
    variable: str,
    time_idx: int | None,
    step: dict | None,
    lon: float,
    lat: float,
    buffer_m: float,
    allowed: bool,
) -> tuple[float, dict[str, str]]:
    """Return the value a spatial reference subtracts, and its tags."""
    full = cube.dataset[variable]
    dim = non_spatial_dim(full)
    source = (
        full if dim is None else full.isel({dim: _clamp(time_idx, full.sizes[dim])})
    )
    if not allowed:
        raise ValueError("This layer does not use an interactive spatial reference")

    def offset_of(da: xr.DataArray) -> tuple[float, dict[str, str]]:
        grid = SourceGrid(cube.crs, cube.bounds(da), decoded_nodata(da))
        return reference_offset(da, lon, lat, buffer_m, grid=grid)

    offset, tags = offset_of(source)
    if step is not None and dim is not None:
        # The map's shift for another reference date: the reference's value on
        # the shown date minus its value on that date.
        at_ref, ref_tags = offset_of(full.isel({dim: step["index"]}))
        offset -= at_ref
        tags["BOWSER_REFERENCE_VALUE"] = str(offset)
        tags["BOWSER_REFERENCE_VALID_PIXELS"] = str(
            min(
                int(tags["BOWSER_REFERENCE_VALID_PIXELS"]),
                int(ref_tags["BOWSER_REFERENCE_VALID_PIXELS"]),
            )
        )
    return offset, tags


def _transform(cube: Cube, da: xr.DataArray) -> tuple[float, ...]:
    """Affine coefficients from the coordinates (``.rio.transform(recalc=True)``)."""
    x, y = np.asarray(da.x.values), np.asarray(da.y.values)
    res_x, res_y = geo.grid_resolution(x, y, spatial_ref_attrs(cube.dataset), True)
    return (
        res_x,
        0.0,
        float(x[0]) - res_x / 2.0,
        0.0,
        res_y,
        float(y[0]) - res_y / 2.0,
    )


def export_layer(
    cube: Cube,
    *,
    variable: str,
    time_idx: int | None = None,
    mask_variable: str | None = None,
    mask_min_value: float | None = None,
    layer_masks: str | None = None,
    ref_lon: float | None = None,
    ref_lat: float | None = None,
    ref_buffer_m: float = 0.0,
    ref_time_idx: int | None = None,
    use_spatial_reference: bool = True,
) -> tuple[list[bytes], str]:
    """Build the GeoTIFF of one layer and step.

    Parameters are those of ``GET /export/geotiff``; ``use_spatial_reference``
    is the server's ``BOWSER_USE_SPATIAL_REFERENCE_DISP`` setting.

    Returns
    -------
    parts : list of bytes
        The file, in order (:func:`bowser.lite.geotiff.encode`).
    filename : str
        The download's name (``bowser.export_provenance``).

    Raises
    ------
    fastapi.HTTPException
        404 for an unknown layer, 422 for a mask or reference that cannot be
        applied, 500 when the values cannot be written, as the full server.

    """
    ds = cube.dataset
    reference_requested = (
        ref_lon is not None or ref_lat is not None or ref_buffer_m != 0
    )
    if reference_requested and (ref_lon is None or ref_lat is None):
        raise HTTPException(status_code=422, detail="Supply both ref_lon and ref_lat")
    step = reference_step(ds, variable, ref_time_idx)
    applied, parsed = mask_provenance(
        ds, variable, time_idx, mask_variable, mask_min_value, layer_masks
    )
    da = masked_slice(
        ds,
        variable,
        time_idx,
        mask_variable,
        0.1 if mask_min_value is None else mask_min_value,
        parsed,
        None if step is None else step["index"],
    ).copy()
    da.attrs = {k: v for k, v in da.attrs.items() if not k.startswith("BOWSER_")}
    da.attrs.pop("_FillValue", None)
    da.encoding.pop("_FillValue", None)
    if reference_requested:
        assert ref_lon is not None and ref_lat is not None
        allowed = use_spatial_reference and _uses_spatial_reference(
            variable, ds[variable]
        )
        try:
            offset, tags = _reference(
                cube, variable, time_idx, step, ref_lon, ref_lat, ref_buffer_m, allowed
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        attrs = dict(da.attrs)
        da = da - offset
        da.attrs = {**attrs, **tags}
    # NaN marks masked and missing pixels of floating layers; an integer layer
    # keeps its type and the nodata its attributes name, if any.
    nodata = np.nan if np.issubdtype(da.dtype, np.floating) else _attr_nodata(da)
    tags, filename = export_provenance(
        variable,
        da.attrs,
        masks=applied,
        export_nodata=nodata,
        reference_step=step,
        **time_context(ds, variable, time_idx),
    )
    da.attrs.update(tags)
    try:
        # As rioxarray's ``to_raster``: the stored type (kept by the encoding
        # only while the values are the stored ones), CF-encoded.
        dtype = np.dtype(da.encoding.get("dtype", da.dtype))
        if (unsigned := da.encoding.get("_Unsigned")) is not None:
            kind = "u" if unsigned == "true" else "i"
            if dtype.kind in "iu":
                dtype = np.dtype(f"{kind}{dtype.itemsize}")
        if nodata is not None and not np.issubdtype(dtype, np.complexfloating):
            nodata = dtype.type(float(nodata))
        data = encode_cf_variable(da.variable).values.astype(dtype)
        long_name = da.attrs.get("long_name")
        skip = _NOT_TAGS if isinstance(long_name, str) else (*_NOT_TAGS, "long_name")
        parts = geotiff.encode(
            data,
            transform=_transform(cube, da),
            crs=cube.crs,
            nodata=nodata,
            tags={k: v for k, v in da.attrs.items() if k not in skip},
            description=(long_name if isinstance(long_name, str) else None)
            or (str(da.name) if da.name else None),
            scale=da.attrs.get("scale_factor", da.encoding.get("scale_factor")),
            offset=da.attrs.get("add_offset", da.encoding.get("add_offset")),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"GeoTIFF export failed: {exc}"
        ) from exc
    return parts, filename
