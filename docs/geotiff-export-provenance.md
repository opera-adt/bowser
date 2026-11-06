# GeoTIFF export provenance

The full server exports native raster values with the requested masks. The
GeoTIFF contains a versioned JSON tag, `BOWSER_EXPORT_PROVENANCE`, plus searchable
`BOWSER_SOURCE_*`, `BOWSER_TIME_*`, and `BOWSER_EXPORT_*` tags. The browser uses the
server's filename so its dates and `_masked` suffix describe the actual export.

Typical names are `displacement_20260101-20260201_masked.tif`,
`displacement_20260201.tif`, and `velocity.tif`. Detailed thresholds belong in
metadata rather than very long filenames. Numeric slice indices are only a
fallback for an otherwise unlabeled time axis.

## What is recorded

- **Source:** explicit product/product ID, product and processing versions,
  sensor, platform, track, frame, burst, orbit direction, polarization, units,
  sign convention, and velocity estimator, where supplied. Missing values are
  JSON `null`; a recognizable layer name does not establish these facts. Layer
  attributes override root attributes with the same key.
- **Time:** the actual clamped slice index and display label, original GeoZarr
  coordinate, and available dated record bounds. Explicit `reference_date`
  establishes a temporal reference; explicit `velocity_fit_start` and
  `velocity_fit_end` establish a fit interval. Filenames containing two parsed
  dates retain that pair as a label, without asserting its scientific meaning.
  Available record bounds do **not** establish velocity-fit dates, a cumulative
  datum, or the method used to estimate velocity. Unknown fit periods remain
  unknown even when the cube has other dated layers.
- **Masks:** AND combination, each applied layer/primary/custom mask, the exact
  existing comparison operator and threshold, and per-layer selected time
  index/label. Custom masks identify their basename and nearest-neighbor
  resampling, without copying the server's directory path. Invalid requests
  fail instead of claiming that an ignored mask was applied.
- **Nodata:** intrinsic source and exported nodata. Disabling optional masks
  cannot recover source-invalid pixels. Valid zero-valued measurements remain
  valid.
- **Reference:** `stored` means no additional spatial shift was applied. When
  used with Bowser's reference-aware export implementation, the tags record
  the shift **already applied**, WGS84 longitude/latitude, reference statistic,
  support, radius, offset in source units, and UTM easting/northing and CRS.
  Polar positions outside standard UTM coverage retain WGS84 coordinates and
  explicitly have no UTM position. Metadata generation never subtracts a
  reference itself, so it cannot apply the shift twice.

The exporter does not infer sensor geometry, convert units, fit a new velocity,
apply a display colormap, or rewrap values. This contribution does not add
interactive referencing where unsupported; that functionality is separate.
Bowser-lite still does not support GeoTIFF export.

## Existing masking differences

The established export routines use these comparisons; this contribution
records them without changing their numerical definitions:

| Mask | GeoZarr | Direct GeoTIFF |
| --- | --- | --- |
| Primary | `> threshold` | `>= threshold` |
| Layer, min | `>= threshold` | `> threshold` |
| Layer, max | `<= threshold` | Unsupported; export returns 422 |
| Custom | `> 0` | `> 0.5` |

Malformed/unknown layer masks, nonfinite thresholds, negative time indices,
and unavailable/unreadable custom masks return 422. This validation applies
to export; it does not change tile rendering or scientific processing.

## Read the metadata

```python
import json
import rasterio

with rasterio.open("displacement_20260101-20260201_masked.tif") as src:
    provenance = json.loads(src.tags()["BOWSER_EXPORT_PROVENANCE"])
    print(provenance["time"])
    print(provenance["masks"])
    print(provenance["reference"])
```

Source provenance uses an identifier allowlist rather than copying arbitrary
root history, credentials, signed URLs, or local paths. Existing producer band
attributes still follow the normal rioxarray export path; this feature is not
a general sanitizer of producer metadata. It does not hash or download remote
source assets to describe an export. Synthetic tests exercise the full-server
GeoZarr and direct-GeoTIFF endpoints, metadata and native values together, plus
browser download naming. The reference-aware integration adds numerical
point/median reference checks.
