# Configured and uploaded point/radius chart masks

The full server's `POST /multi_point` and `POST /buffer_timeseries` accept:

- `primary_mask: true`: apply the selected GeoTIFF group's configured mask;
- `mask_min_value`: a finite override, only with `primary_mask: true`;
- `custom_mask_path`: an uploaded single-band GeoTIFF mask. GeoTIFF charts require
  its native grid; GeoZarr charts also accept the map's cross-grid warp.

The data-chart client forwards the configured mask and threshold per layer,
and an active uploaded mask. Zero thresholds are retained. Mask changes clear
old curves and refresh point/radius requests. Failed/unsupported requests clear
old data and show a message. Existing request revisions prevent old replies
from restoring earlier settings. Reference previews/values do not silently
inherit these additional display masks.

## Validity and references

Configured GeoTIFF masks keep finite, nonzero values `>=` their threshold,
matching the existing map rule, including at a zero threshold. Native exports
now also reject configured-mask zero at that threshold. This is separate from
valid zero **displacement**, which remains a measurement.

Uploaded masks preserve existing conventions: GeoTIFF keeps values `> 0.5`,
full GeoZarr keeps `> 0`. Normal binary masks agree. Nodata, intrinsic validity
and nonfinite mask samples are excluded. All active masks combine with source
validity and named quality masks. A single configured mask is reused for every
GeoTIFF date on both maps and charts. Incomplete configured lists are rejected
by charts rather than guessing associations.

Additional display masks do not redefine the reference datum. The existing
GeoTIFF stored-before-mask policy and existing GeoZarr named-mask reference
behavior are retained; uploaded/configured display masks are not silently
applied to the reference. No scientific parameters, estimates or inputs change.

## Bounds and limitations

Native-grid mask windows are read only for the point or selected buffer window.
GeoZarr masks in another CRS, resolution or origin use the same cached 2-D warp
as the map, then select the requested pixel/window. This never warps or loads
the displacement time cube. The shared cache is bounded by the map's existing
byte budget. GeoTIFF charts still require matching CRS, shape and affine grid.
Missing or multiband masks fail explicitly, with the cause in the API response.
GeoZarr sources require regular rectilinear coordinates and existing
buffer-window geometry. There is no new temporal mapping or measurement resampling.

The lightweight server explicitly returns 501 for direct external/configured
chart requests, while keeping its supported named GeoZarr masks. The page checks
/config before forwarding an uploaded project mask. When geotiff_upload is false
or support cannot be checked, it omits unsupported options and visibly warns
that the uploaded mask is not applied; remaining quality masks still apply. Polygon statistics
retain upstream’s warning that uploaded/configured masks are not applied; this
does not extend that API or suppress that warning. Legacy
GET chart/trend routes, GNSS analysis and reference-preview enhancements remain
separate. Arbitrary GeoZarr temporal axes and general geographic-CRS metric
buffers are not validated by this extension.

Synthetic tests cover native support, zeros, signed/primary/upload combinations,
reference invariance, read windows/budgets, unsupported modes and invalid masks.
Actual browser tests upload an all-zero GeoTIFF, check empty point/radius data,
then clear it and verify restoration. No stored raster or processing default is
modified. This is viewer validity/compatibility work, not scientific validation
of the underlying displacement measurements.
