# Native polygon statistics API

The full server and bowser-lite provide `POST /polygon_timeseries` for read-only summaries of
stored GeoZarr or single-band GeoTIFF values inside one WGS84 GeoJSON Polygon
or MultiPolygon. The time-series chart uses it for areas (see below); the
polygons come from the existing drawing and file-import tools.

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

## Optional bounded pixel histories (API)

Summary-only behavior is the default. API clients can opt in
with `curve_mode: "sample"` (and `sample_count`, default 200) or `curve_mode: "all"`.
`curve_mode: "none"` is the default and preserves the earlier response and read
behavior. The chart has a separate, explicit opt-in preview described below.

For example, add these fields to the request above:

```json
"curve_mode": "sample",
"sample_count": 50
```

The extra `pixel_curves` object reports the mode, `eligible_pixels`,
`plotted_pixels`, whether this is a subset (`sampled`), the fixed sample seed
(42 for sample mode), and a `curves` array. Each curve includes `row`, `col`,
`x`, `y` and `values`. Values align exactly to the response `labels`, retain
source units and the stored reference, and use `null` for missing support.
A finite zero is a valid measurement. No zero-valued reference epoch or
interpolation across gaps is invented.

Rows/columns index the **returned grid**, and X/Y are pixel-center coordinates
in `grid.crs`, not automatically latitude/longitude. The lightweight server can
normalize a reversed axis; its reported grid describes that normalization.

Selection uses the same native centers, polygon parts/holes and explicit quality
masks as the summaries. With `common` support, candidates must be valid at every
epoch. With `per_date`, candidates are the union of pixels valid on at least one
epoch, retaining gaps on other dates. The preview does not establish connected-
component compatibility; the existing warning still applies.

Sample mode selects without replacement using the fixed seed from the eligible
row-major native pixels. It is a reproducible visualization preview for the same
input/grid and dependency environment, not an estimator or a guarantee of spatial
representativeness. Summary counts, medians, means, percentiles and spread always
use **all eligible pixels** under the chosen support policy, never just the sample.

At most 500 curves and 100,000 curve values (`curves × epochs`) may be returned.
`sample_count` must be an integer from 1 to 500. An oversized all-pixel or value-
budget request is refused with 422; Bowser does not silently truncate it or change
the summary/support. Use a smaller explicit sample or summaries only. The sample
is collected during the existing second pass; it adds no full-raster read or
extra processing/inversion. General polygon pixel-epoch limits still apply.

Uploaded/configured masks and reference transformations retain the limitations
described below. This option does not create new scientific defaults or apply
any mask/reference that the existing polygon API cannot support.

## Choosing area pixels

**Area pixels** is shared by area charts and the Stats panel and is saved with
projects. **Automatic** retains the existing behavior: the same valid pixels at
every date without quality masks, or each date's available pixels when any
quality mask is active. It is the default.

Choose **Same pixels at every date** for a comparable footprint through time;
missing observations or masks at any date can reduce coverage. Choose
**Available pixels on each date** to retain more observations; changing spatial
membership can itself change the apparent history. Neither option interpolates
missing measurements or changes the stored data. Explicit choices also apply to
optional pixel histories, including configured and uploaded masks. A support
change cancels obsolete requests; a server that cannot confirm the requested
support produces a visible error rather than a different curve.

## In the time-series chart

The chart's **+ Area** button lists the polygons on the map (drawn with the
Draw tools or read from vector files) and adds the one picked; with none, it
starts drawing a polygon and uses the finished shape. Each area is drawn in one
colour: the median as a line, the mean dashed, and the p10–p90 band shaded.
The band is the middle 80 % of the pixels: it is centred on the median like
the median itself, does not assume a symmetric spread, and is not widened by a
few outlying (for example unwrapping-error) pixels as mean ± spatial standard
deviation would be. It is spatial spread, not measurement uncertainty.

When the viewer's reference is on for the layer, the chart subtracts the same
reference value per date that the map and the point series use, so areas and
points can be compared ("relative to the reference" in the tooltip). The
named quality masks from Main > Masking are sent explicitly to the polygon API.
The chart and Stats tab share each native summary. Changing a layer mask, its
threshold or comparison clears the old summaries immediately and requests new
ones; clearing masks restores the unmasked stored support. The Stats tab's
**Usable pixels** reports the pixels contributing to the current summary.

Superseded requests are aborted and late responses cannot restore an older
curve or a removed area. Queued work for superseded settings is not started.
Changing the source, loading a project or editing the area's geometry also
invalidates the summaries. Reference, reference-date, styling and date-slider
changes reuse the native summary; the existing reference calculation is applied
once in the chart, not again in the API.

The server must confirm that requested quality masks were applied. A failed,
empty or unconfirmed mask response clears the old curve and displays an error;
there is no fallback to unmasked data for the masks chosen in Main > Masking.

The full server also applies an uploaded mask (`custom_mask_path`) and the
selected GeoTIFF layer's configured mask (`primary_mask: true`, optional
`mask_min_value`). The chart forwards these options automatically when active and uses per-date
support, matching its existing named-quality-mask policy. The direct API retains
its explicit common/per-date choice and unchanged default.
Summaries use the resulting native support. Individual-pixel preview histories
are a separate contribution, not part of this summary-only API.
Missing, unreadable or unconfirmed masks clear the affected result; no unmasked
fallback is drawn. `mask_min_value` without `primary_mask: true` is refused (422),
as on the point/radius charts. Bowser-lite answers 501 to any of these options,
like its charts; the page leaves the uploaded mask out of lite areas, as it does
for points, and says "Uploaded mask not applied" in the chart and the Stats tab.

Configured masks preserve the existing GeoTIFF convention: finite, nonzero and
at least the configured threshold. Valid zero displacement is independent of a
zero mask flag. Uploaded masks use the existing source-specific convention:
GeoZarr keeps values greater than zero; GeoTIFF keeps values greater than 0.5.
Mask nodata and outside coverage are invalid. These conventions are reported in
the response rather than silently harmonized.

A mask on the layer's exact native grid is read only in the selected window. A
mask on another grid is aligned exactly as the map aligns it, so an area keeps
the pixels the map shows: the **mask only** (never the displacement) is warped
to the whole native grid with nearest-neighbour sampling (GeoZarr: the map's
cached warp, also used by the point/radius charts; GeoTIFF: the warp the map's
masked layer uses), and the area's window is taken from that warp. A windowed
warp would flip a few edge pixels compared with the map. The warp is cached per
file and grid; a dynamic configured mask on another grid warps one whole file
per date. Static windows are cached for the request; dynamic configured masks require a
complete list matching the source count and are indexed without clamping. All
mask work counts toward the existing polygon pixel-epoch budget. Configured and
uploaded filenames are not returned in the statistics metadata.

With a quality mask on, each date uses the pixels that pass the mask on that
date (`support: per_date`), as the map shows them; without masks the same
pixels are used at every date (`common`). A mask that changes with date, such
as `recommended_mask`, leaves few pixels, or none, passing on every date. A
date on which no pixel of the area passes is drawn as an unfilled marker with a
dashed outline in the area's colour, on the line between its neighbours ("fully
masked"), and the rest of the series is drawn.
The chart's footnote says which rule is in use, and the Stats tab's Usable
pixels gives the count for the date shown.

While a mask slider is dragged the area requests are spaced: the first change
asks at once, then at most once per 250 ms, always ending on the value the
slider stopped at.
Bowser-lite has the same button and gives the same numbers (see
[Bowser-lite](#bowser-lite)).

## Pixel histories in the chart

In a time-series window containing an area, **Pixels** starts **Off**. Choose
**Sample** to show up to 50 individual native pixel histories by default. The
sample size is adjustable from 1 to 500. Choose one of the window's visible
areas and plotted layers; only one preview is active per window. **All (bounded)**
requests every eligible pixel, subject to 500 curves and 100,000 values. Oversized
requests show a warning; choose a smaller explicit sample. Nothing is silently
truncated. Turning the control off removes only the preview.

The thin lines are individual pixels, not additional summary estimates or an
uncertainty band. The median, mean, spatial spread and numeric Assistant summary
continue to use all eligible pixels. Sampled lines do not enter trend fits or
numeric exports. Pixel-history export is outside this feature's scope. Settings
and raw previews are session-only and are not saved in projects.

The API's native values are reused when the spatial reference, reference date,
units or displayed date interval changes. The chart applies the same spatial
subtraction and then temporal subtraction as the area summaries, exactly once.
A missing reference or temporal baseline leaves a gap; valid zeros stay valid.
Lines do not bridge missing dates. Masks, geometry and source revisions trigger
new requests and clear old curves immediately. Invalid, outdated or unsupported
responses show an error while preserving the area summaries.

The selection count reports eligible and selected pixels, not measurement
accuracy. Common support requires validity throughout the record; named quality
masks use per-date support, retaining gaps. Component compatibility remains
unverified. Uploaded/configured polygon-mask limitations above still apply.
A bounded preview is not a claim that disconnected motion is comparable or that
any apparent displacement is real ground motion.

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

## Explicit quality masks

Add `layer_masks` to the JSON request to summarize only qualifying native
pixels, for example:

```json
{"layer_masks": [{"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}]}
```

The threshold is in the named layer's stored units. Up to ten masks are combined
with AND, in addition to intrinsic source validity. GeoZarr (full and lite)
supports inclusive `min` (`>=`) and `max` (`<=`). Direct GeoTIFF masks preserve
the map reader's strict `min` (`>`) convention and support inclusive `max` (`<=`).
These are signed comparisons, not absolute-value bounds.
Mask nodata, undecoded fill sentinels and nonfinite values are always excluded,
even when a sentinel would satisfy the threshold. A legitimate displacement of
zero remains valid if it passes the masks.

Static two-dimensional masks are reused at every date. Dynamic GeoZarr masks
must have the exact same non-spatial dimension name and coordinate values as
the selected variable. Dynamic GeoTIFF groups must match its configured labels
and file count. All masks must match the exact native grid and CRS. Unknown
layers, mismatched dates/grids, multiband masks and unsupported comparisons
return 422. There is no date clamping, nearest-date matching, inferred ministack
mapping, mask reprojection or automatic resampling. Use a suitable static
quality summary when a dynamic mask has a different axis.

Masks apply before `common` support is intersected across dates, or before each
`per_date` summary. The reported `valid_per_date`, `common_pixels` and row counts
describe the resulting support. An all-invalid mask gives zero counts and null
statistics, without falling back to unmasked values. The response records the
actual named layers, thresholds, comparison operators and temporal support in
`masks`, and sets `optional_masks_applied` to true. Omitting masks or specifying
an empty list preserves the original stored summary.

## Reference and remaining scope

This endpoint summarizes **stored values**. It does not apply a moved viewer
reference or a connected-component screen. With no explicit masks the response
retains:

```json
{"reference": "stored", "optional_masks_applied": false,
 "component_compatibility": "unverified"}
```

It therefore does not claim to reproduce a dynamically referenced/masked map.
Reference coordinates remain unsupported request fields. External mask options
are explicit opt-ins on the full server as described above. The chart
already subtracts its reference from stored summaries; no second reference
subtraction is introduced here. The chart sends supported named masks explicitly
and invalidates old summaries when they change. Disconnected offsets can be
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
The pixel-epoch budget includes the source plus each requested mask and is
checked before reading raster values: a mask along the dates counts one frame
per date, a static mask one frame, since its window is read once and kept.
Masks along the dates are read in blocks of their time chunks (at most
4,000,000 values per mask at a time). Two spatially bounded
passes determine common support and then exact summaries, retaining one frame
at a time. Percentiles use all eligible pixels rather than a sampled preview.
The budget covers each pass; two passes can read the same source window twice.

GeoTIFF reads use a raster window. Lazy GeoZarr reads evaluate only intersecting
native chunks, though compressed chunk/block transfers can be larger than the
polygon window. No claim of arbitrary byte-level subsetting is made.

On the full server no package pins or installed environments change: Shapely
is already required by its existing `opera-utils` dependency. This module uses
it to validate topology rather than repairing or simplifying a user's geometry.

## Bowser-lite

Bowser-lite (and so the desktop app) answers the same request with the same
response, for GeoZarr cubes, without GDAL or Shapely
(`bowser.lite.polygon`): the request model, limits, statistics, warnings and
error messages are the full server's code, and three steps are redone with
pyproj and numpy:

- the polygon's vertices are reprojected to the cube's CRS with pyproj;
- validity is checked with the OGC rules Shapely applies (rings that cross or
  touch themselves, holes outside their exterior or inside one another,
  overlapping parts, two rings of a polygon touching at more than one point).
  The check uses plain floating point, so it can differ from Shapely for rings
  that touch within rounding, and it does not look for an interior cut in two
  by a chain of three or more touching rings;
- the pixels are selected by a scanline fill that follows GDAL's
  (`all_touched=False`): a pixel is in when its centre is inside, even-odd over
  all rings. Centres exactly on an edge follow GDAL's rule as built for Linux
  x86-64: on a north-up grid a centre on a left edge is out and one on a right
  edge is in, and rows of centres on a horizontal edge are in. Lite computes
  this with plain double arithmetic, so its answer for given vertices is the
  same on every platform (the desktop app on a Mac included). GDAL's own answer
  for such ties can differ by platform and build (its arm64 builds round the
  pixel coordinates differently), so on those the full server may differ from
  lite in pixels whose centre lies on an edge, and only in those.

Only the polygon's window is read, in blocks of time steps that follow the
cube's time chunks (at most 16 million values at once), each block once per
pass. The request runs in a worker thread, so the page stays responsive. The
tests compare both servers on every kind of polygon (convex, concave, holes,
several parts, partly outside, inside one pixel, on the grid's edge, edges
through pixel centres) and compare the fill with rasterio on random polygons.

## Validation

Synthetic tests cover known summaries and support, stationary zero values,
nodata and missing-value sentinels, holes, multiple polygon parts, reversed and
transposed axes, clipping, absent data, mixed units/grids, unsupported fields,
lazy GeoZarr chunk reads, windowed GeoTIFF reads, explicit mask/date/grid support,
agreement with actual masked GeoTIFF exports, catalog isolation, actual
HTTP responses, lite dependency isolation and the equality of bowser-lite's
answers with the full server's. They require no real data.


Pixel-preview lines are excluded from index-mode tooltips, so dense previews do
not create hundreds of tooltip rows. The preview reports both selected pixels
and curves actually drawn; missing reference dates can hide selected histories.
The support choice is available in both the chart and Stats tab and is shared
between them. Choosing common support with an uploaded mask explicitly retains
only pixels valid across every date. Spatial then temporal display referencing
uses the same helper for area summaries and optional pixel previews.
