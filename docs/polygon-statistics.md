# Native polygon statistics API

The full server provides `POST /polygon_timeseries` for read-only summaries of
stored GeoZarr or single-band GeoTIFF values inside one WGS84 GeoJSON Polygon
or MultiPolygon. The endpoint is the backend foundation for polygon charts;
this contribution does not add or replace drawing tools, import controls, or
chart UI. Upstream already supports drawing and importing geographic features.

```python
import requests

response = requests.post(
    "http://localhost:8000/polygon_timeseries",
    # Add params={"dataset": "catalog-id"} for a catalog entry.
    json={
        "variable": "displacement",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[10.01, 45.01], [10.07, 45.01],
                             [10.07, 45.07], [10.01, 45.07], [10.01, 45.01]]],
        },
        "support": "common",
        "percentiles": [10, 90],
    },
)
response.raise_for_status()
result = response.json()
print(result["labels"], [row["median"] for row in result["statistics"]])
```

## Selection and calculations

- Pixel centers on the native level-zero grid are selected using rasterio's
  standard `all_touched=False` polygon rasterization. Holes are excluded and
  separate polygon parts are retained. No pyramid, interpolation, filtering,
  unwrapping, time-series inversion, motion projection or new velocity fit is
  used. A static velocity layer receives a spatial summary of its saved values.
- `common` is the default: every epoch summarizes the same pixels that are
  source-valid throughout the selected layer's entire record. `per_date`
  summarizes each date's source-valid pixels and explicitly warns that changing
  membership can change the apparent history.
- Each row contains count, unweighted mean, median, population spatial standard
  deviation, minimum, maximum and requested linear percentiles. Calculations
  use Float64. Canonical percentile keys are `"10"`, `"90"`, or, for example,
  `"2.5"`, consistently for default and explicit requests.
- Intrinsic nodata, nonfinite values and explicit undecoded missing-value
  sentinels are excluded. Valid zeros remain measurements. Empty support yields
  count zero and JSON `null` statistics, with a warning. It never creates a
  measured zero or interpolates across an unsupported date.
- Source units and labels are retained. Unknown units remain unknown. Known
  angular fields and complex values are rejected because linear summaries
  would not provide circular statistics or an explicit complex conversion.

The result reports `polygon_pixels`, `valid_per_date` (before a common-support
intersection), `common_pixels`, per-row counts, geometry, grid, labels, units,
and scientific limitations. Source filenames and local directory paths are not
included in the result. The result contains no implicit temporal zero datum.

## Explicit initial scope

This endpoint summarizes **stored values**. It does not apply a moved viewer
reference, optional quality masks, or a connected-component screen. These
limits are always present in the response:

```json
{"reference": "stored", "optional_masks_applied": false,
 "component_compatibility": "unverified"}
```

It therefore does not claim to reproduce a dynamically referenced/masked map.
Reference/mask fields are rejected as unsupported request arguments rather
than silently ignored. Future chart wiring must preserve this distinction or
add separately tested reference/mask support first. Disconnected offsets can be
ambiguous; component numbers are never assumed comparable between pairs or
dates. Spatial spread is not measurement uncertainty, and an apparent history
does not establish reference stability or ground motion.

The full server supports explicit, regular rectilinear GeoZarr x/y coordinate
grids and at most one
non-spatial axis. Single-band GeoTIFF groups must share the exact grid, CRS and
identical units, including whether units are missing. Rotated GeoTIFF grids
can use the raster's affine; rotated GeoZarr grids are rejected. Polygons
outside the grid or containing no native pixel centers return 422. Partial
coverage is summarized only on-grid and explicitly warned. Invalid topology,
unclosed rings and antimeridian-spanning polygons are rejected.

To bound memory and work, requests allow at most 10,000 vertices, a bounding
window of 2,000,000 native pixels, and 50,000,000 bounding-window pixel-epochs.
These budgets are checked before reading raster values. Two spatially bounded
passes determine common support and then exact summaries, retaining one frame
at a time. Percentiles use all eligible pixels rather than a sampled preview.
The budget covers each pass; two passes can read the same source window twice.

GeoTIFF reads use a raster window. Lazy GeoZarr reads evaluate only intersecting
native chunks, though compressed chunk/block transfers can be larger than the
polygon window. No claim of arbitrary byte-level subsetting is made.

Bowser-lite explicitly returns 501 and does not import the full-server
geometry/raster stack. No package pins or installed environments change:
Shapely is already required by the full server's existing `opera-utils`
dependency. This module uses it to validate topology rather than repairing or
simplifying a user's geometry.

## Validation

Synthetic tests cover known summaries and support, stationary zero values,
nodata and missing-value sentinels, holes, multiple polygon parts, reversed and
transposed axes, clipping, absent data, mixed units/grids, unsupported fields,
lazy GeoZarr chunk reads, windowed GeoTIFF reads, catalog isolation, actual
HTTP responses and lite dependency isolation. They require no real data.
