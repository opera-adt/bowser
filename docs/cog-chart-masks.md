# GeoTIFF point and radius chart masks

`POST /multi_point` and `POST /buffer_timeseries` apply their existing
`layer_masks` fields to native GeoTIFF samples. A signed `min` keeps mask values
strictly greater than the threshold (the existing GeoTIFF map convention);
`max` keeps values less than or equal to it. Multiple masks combine with AND.
Source/mask nodata, intrinsic GDAL validity and nonfinite samples are excluded.
Valid zero measurements remain valid; an explicitly configured zero nodata
value is still excluded. A masked-out date is omitted, never replaced by zero.

```json
{"dataset_name":"displacement",
 "points":[{"id":"a","lon":10.01,"lat":45.01}],
 "layer_masks":[{"dataset":"quality","threshold":0.5,"mode":"min"}]}
```

Masks must be static (one file) or have exactly the selected layer's file count
and configured labels/order. Every read uses the same native affine grid and
CRS. There is no reprojection, resampling, date clamping for masks, inferred
ministack association or fallback to unmasked data for an invalid mask. Unknown
layers, mismatched grids/axes, unsupported mask types, unreadable inputs and
invalid thresholds produce 422. At most ten named masks are accepted.

Sampling reads band one, preserving the existing GeoTIFF point convention.
A point reads one containing pixel per date; a selected-date point reads values
only for that date. Source GDAL masks are also respected without quality masks.
A radius uses native pixel centers inside a circle with the complete affine
transform, including rotated/reversed grids. Metric circles require projected
axes in meters; geographic degrees or feet are not silently treated as meters.
Outside buffers or circles containing no source centers return 404. Work is
checked against existing native pixel/window budgets before reading values.

## Reference behavior

GeoTIFF references sample **stored source support before display quality
masks**, as map references and native GeoTIFF exports do. Changing a display
threshold must not silently select a new datum. Zero reference radius samples
one containing pixel; positive `ref_buffer_m` now honors the requested circle
and existing median instead of falling back to the center pixel. Source nodata
and GDAL validity still apply. GeoZarr reference behavior is unchanged.

The existing median, random sample seed, response format, labels, units and
trend calculations are retained. Buffer `n_pixels` is the union of locations
with usable measurements across time, not a guarantee of common support or
connected-component compatibility. These repairs do not validate reference
stability, quality thresholds or ground motion.

## Scope

This is named-mask and source-validity API handling, not universal viewer mask
parity. `GET /point` continues to return stored values for reference/hover use;
it does not add new display-mask request fields. Configured primary/uploaded
chart-mask forwarding and frontend error/race feedback remain separate.
Map/export upper bounds have their own repair. A masked map alone cannot
certify point/radius, polygon, configured-mask or temporal-axis parity.

Tests use synthetic rasters and actual HTTP calls, native masked exports where
supported, known-truth samples, source hashes, exact support counts, valid zeros,
GDAL masks, static/dynamic masks, point/area references, affine geometry, invalid
axes/CRSs and read budgets. No scientific processing, velocity fitting defaults,
source pixels or installed packages are changed.
