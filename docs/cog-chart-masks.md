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

Mask specifications use the same `PolygonMask` validation and `raster_masks`
reader as polygon statistics, including exact-grid checks and request-local
static-window caching. Upper bounds (`<=`) are now shared too, matching the
merged GeoTIFF map/export repair. Multiple masks combine with AND.

A requested mask must be static (one file) or have the selected layer's exact
file count and configured labels/order. An unavailable/empty layer or a mask
with another temporal axis is **not applied**, matching the map's compatibility
behavior. The API returns a `warnings` list naming each omitted mask and why;
the chart displays it. Other applicable masks still apply. This is not evidence
of quality-screened support: do not interpret the curve as having passed an
omitted mask. No dates are guessed, clamped or reordered. A readable mask with
a mismatched grid/CRS, complex or multi-band data, unreadable input, or invalid
specification still gives 422. Polygon endpoints retain their strict missing-
mask policy. At most ten explicit chart masks are accepted.

Sampling reads band one, preserving the existing GeoTIFF point convention.
Point data reads use three workers, including unmasked charts; a selected-date
hover reads only that date. Source GDAL masks are respected with or without
quality masks. Static mask windows are read once per sampler/window rather
than once per acquisition. The shared reader's work accounting charges static
masks once when checking budgets.

A buffer uses native pixel centers and the complete affine transform, including
rotated/reversed grids. On rectilinear projected meter grids it reuses
`reference.select_circle`. That helper needs separable metric coordinates;
rotated grids therefore use full-affine center distances. Geographic grids and
projected feet use distances in a local WGS84 azimuthal equidistant CRS centered
on the requested point, without resampling source data. Geographic degrees are
never treated as meters. These are regional circles, not a global/dateline
selection tool. Outside observation buffers and circles without source centers
return 404; oversized observation reads return 422 before pixel reads.

`GET /datasets` includes `chart_buffer_max_m` for GeoTIFF layers. The UI bounds
its radius controls by the smallest advertised layer limit (including comparison
layers), shows the limit, and clamps a restored larger radius visibly. This
conservative bound allows all dates and ten dynamic masks; small grids that fit
in full retain the existing 5,000 m UI maximum. Exact clipped-window budgets
remain authoritative on each request. No sampling/striding is introduced to
make a large request fit.

## Reference behavior

GeoTIFF references sample **stored source support before display quality
masks**, as map references and native GeoTIFF exports do. Changing a display
threshold must not silently select a new datum. Zero reference radius samples
one containing pixel; positive `ref_buffer_m` now honors the requested circle
and existing median. If the circle has no native centers or exceeds the
read budget, charts fall back to the containing point and return/display a
warning. Invalid CRS/input and unreadable rasters are not swallowed. An
all-nodata circle stays missing rather than silently changing its datum.
Source nodata and GDAL validity still apply. GeoZarr reference behavior is
unchanged: its chart reference currently applies explicit display masks,
whereas GeoTIFF charts/maps/exports deliberately use stored reference support.
This PR does not reconcile those policies or claim reference stability.

The existing median, random sample seed, labels, units and trend calculations
are retained. Responses add `warnings` only when needed; unaffected GeoZarr
response bodies remain unchanged. Real-valued samples use float64 so nodata
can be NaN; fitted trend values may differ slightly from the prior float32
reader due to precision, not a changed fit model. Buffer `n_pixels` is the union of locations
with usable measurements across time, not a guarantee of common support or
connected-component compatibility. These repairs do not validate reference
stability, quality thresholds or ground motion.

## Scope

This is named-mask and source-validity API handling, not universal viewer mask
parity. `GET /point` continues to return stored values for reference/hover use;
it does not add new display-mask request fields. Configured primary/uploaded
chart-mask forwarding and frontend error/race feedback remain separate.
Map/export upper bounds were repaired upstream. A masked map alone cannot
certify point/radius, polygon, configured-mask or temporal-axis parity.

Tests use synthetic rasters and actual HTTP calls, native masked exports where
supported, known-truth samples, source hashes, exact support counts, valid zeros,
GDAL masks, static/dynamic masks, point/area references, affine geometry, invalid
axes/CRSs and read budgets. No scientific processing, velocity fitting defaults,
source pixels or installed packages are changed.
