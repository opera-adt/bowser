# GeoTIFF export provenance

Both servers export native raster values with the requested masks. The
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
- **Reference date:** with `ref_time_idx` (the date chosen in the viewer's
  "ref: <date>" menu; GeoZarr layers with a time axis only), each pixel is
  `value(selected) - value(reference)`, as on the map's tiles, before masks.
  `time.reference_index`, `reference_label`, `reference_coordinate` and
  `reference_operation` record the (clamped) step subtracted; `reference_date`
  becomes that date and the cube's own one moves to `stored_reference_date`.
  They are also written as `BOWSER_TIME_REFERENCE_*` and
  `BOWSER_TIME_STORED_REFERENCE_DATE` tags, and the filename carries both
  dates (`displacement_20260113-20260125.tif`). A spatial reference then
  subtracts the reference's own change between the two dates: its value (point
  or circle median) on the selected date minus its value on the reference
  date, recorded as `BOWSER_REFERENCE_VALUE`, with `BOWSER_REFERENCE_VALID_PIXELS`
  the smaller of the two counts. A layer without a time axis, a direct-GeoTIFF
  dataset, or a negative index returns 422 rather than ignoring the date.
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

## Bowser-lite

Bowser-lite (and so the desktop app) exports GeoZarr layers without GDAL: the
same parameters, values, type, nodata, tags, band description and filename as
the full server, built by the same expressions (`bowser.lite.export`) and
written by a small GeoTIFF writer (`bowser.lite.geotiff`, numpy + zlib). The
tests read both servers' files with rasterio and require them to be equal.

The file is a plain GeoTIFF, as the full server's (no overviews):

- little-endian TIFF 6.0, or BigTIFF when the file would pass 4 GB;
- Deflate without a predictor; one strip when the image fits in 512 x 512
  pixels, 512-pixel tiles otherwise (the full server's GDAL writes strips, so
  the sizes are close but not equal);
- GeoKeys as GDAL writes them for an EPSG code, with `ModelPixelScale` and
  `ModelTiepoint` (or `ModelTransformation` for a grid that is not north-up);
- tags, band description, scale and offset in `GDAL_METADATA`, nodata in
  `GDAL_NODATA`.

Two limits: the cube's CRS must be a projected or geographic CRS with an EPSG
code (GeoTIFF keys name a code, not a full definition; otherwise HTTP 500 with
the reason), and a custom mask GeoTIFF (`custom_mask_path`) cannot be applied
(HTTP 501), since lite cannot read one. The export runs in a worker thread and
is sent block by block with its `Content-Length`, so the page shows progress
and stays responsive.

## Existing masking differences

The established export routines use these comparisons; this contribution
records them without changing their numerical definitions:

| Mask | GeoZarr | Direct GeoTIFF |
| --- | --- | --- |
| Primary | `> threshold` | `>= threshold` |
| Layer, min | `>= threshold` | `> threshold` |
| Layer, max | `<= threshold` | Unsupported; export returns 422 |
| Custom | `> 0` | `> 0.5` |

Malformed/unknown layer masks, nonfinite thresholds, negative time indices
(including `ref_time_idx`), and unavailable/unreadable custom masks return 422. This validation applies
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
