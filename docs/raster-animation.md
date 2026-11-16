# Raster GIF export

On the **full server**, open **Project → Export → Raster animation (GIF)**.
Choose the first and last saved epochs, playback speed, and whether to crop to
the current map view. Set the layer's color limits beforehand: the same limits
and palette apply to every frame. Downloading does not advance the map slider
or change the current reference.

This first contribution exports an **opaque scalar raster**, not a screenshot
of the map. It does not include basemaps, terrain backgrounds, text labels,
style/opacity compositing or a colorbar graphic. Optional native-pixel histories
and geometry-only vector outlines are described below.
Dates and numerical color limits appear on each frame. Large labels or narrow
frames can truncate that visible text; complete labels and settings remain in
the GIF comment metadata. GIFs are display products, not georeferenced numeric
measurements. Use GeoTIFF export for those.

## Values, masks and references

The exporter reuses native GeoTIFF preparation. Explicit named quality masks,
intrinsic nodata, and supported point/area and epoch references are applied to
the measurements before rendering. Reference offsets use the existing native
export policy; quality masks do not redefine the reference sample. Masks use the same strict preparation and saved-epoch handling as GeoTIFF
export; GIF export does not impose a separate mask-selection policy. On saved
pyramids, the requested quality layers must also exist on that display grid.
COG display windows use the native exporter’s nearest-neighbor mask alignment.

Uploaded masks and configured primary GeoTIFF masks are **not supported yet**;
the controls disable export and the API rejects these settings. Rewrapped and
complex-valued layers are also unsupported. No missing observation is replaced
with zero. An all-invalid epoch remains an empty, dated frame. Existing source
files and native GeoTIFF export behavior are unchanged.

The image uses nearest-neighbor display resizing and 254 fixed data colors
without point plots, or 248 with plots (the remaining colors mark the selected
points, plot cursor, text and invalid support);
white marks invalid data and white/black are also used for text. Values beyond
the chosen limits receive the end colors. Frames have equal playback durations,
even when acquisition intervals differ. No smoothing, interpolation, velocity
fitting, baseline adjustment or inferred initial epoch is added.

## Limits and provenance

- Two to 90 consecutive saved epochs on a north-up georeferenced grid.
- At most two million pixels in the selected read window and 50 million
  pixel-epochs including named-mask and native-reference work. Cropping a large
  source reads only the intersecting window. For larger views, compatible saved
  GeoZarr pyramids or COG overviews are used when available; the exporter does
  not generate a new pyramid. Unsupported large views fail before pixel reads.
- Point/area reference offsets are always evaluated on the original native
  grid, with their own bounded footprint, even when the display is coarser.
- Output width 64–1024 pixels, height at most 1024 raster pixels, and at most
  24 million display pixel-epochs including the text headers/footers. Limits
  are checked before preparing any frame. They do not bound physical storage
  chunk decoding, remote latency or concurrent browser requests.
- One render per server process; a second concurrent request receives HTTP 409.
  Rendering checks a 120-second deadline between frames, not during blocked IO
  or GIF encoding. The budgets bound array/display work, not remote IO latency.
- Stopping a download aborts the browser request; it does not promise immediate
  cancellation of a render already executing on the server.

The GIF comment contains JSON with layer, saved indices/labels, units, limits,
palette, requested speed, encoded duration, crop bounds, masks, selected display
level/read dimensions, valid display pixel counts (and native counts only for
native reads), reference coordinates/epoch/offsets and display limitations.
The filename includes the layer and first/last saved labels. Local source paths
and credentials are not included by this exporter.

`GET /config` reports `raster_animation`; unsupported clients hide the controls.
`GET /export/animation` retains the capability response for older clients.
`POST /export/animation/plan` accepts the same request as rendering and returns
metadata-only dimensions, frame count and selected level. The UI checks this
plan before enabling download, reports elapsed time, and offers Cancel.
Pillow is a declared direct dependency.

`POST /export/animation` accepts JSON:

```json
{
  "variable": "displacement",
  "start_index": 0,
  "end_index": 2,
  "vmin": -0.05,
  "vmax": 0.05,
  "colormap": "rdbu_r",
  "fps": 2,
  "width": 512,
  "layer_masks": [
    {"dataset": "temporal_coherence", "mode": "min", "threshold": 0.5}
  ]
}
```

Optional `bounds` are WGS84 `[west, south, east, north]` without antimeridian
wrapping. Reference fields are `ref_lon`, `ref_lat`, `ref_buffer_m` and
`ref_time_idx`; both coordinates are required for spatial referencing. Catalog
selection uses the existing `?dataset=...` query parameter. Unsupported inputs
receive explicit errors. Bowser-lite reports `supported: false` and returns
HTTP 501 for rendering without importing the full plotting/GDAL stack.


## Optional synchronized point histories

Enable **Include point histories** to export one to five visible point locations
with a plot beneath the raster. This uses the containing level-zero native
pixel at each point, using the same strict mask/reference preparation as the
raster. Separate one-pixel native windows retain this meaning even when the
display uses a pyramid. Planning includes those reads and repeated reference
work; it does not load a full native frame to sample points.
It does not copy a cached chart response, average a point buffer/polygon, clamp
an outside location to the grid, smooth or fit a new history. An outside-source
point is rejected. Source-grid points outside the crop remain in the plot but
have no map marker. Numbered markers identify sampled pixel centers, including
on dates when their measurement is missing: a marker is a location, not proof
of usable data.

The plot uses actual elapsed acquisition time, requires explicit increasing ISO
date/time labels, and covers only the exported saved-epoch range. Axes remain
fixed throughout the animation. A cursor and highlighted observed sample follow
the current frame. Missing values stay null/gaps; lines connect only consecutive
valid samples and do not bridge missing epochs. No temporal rebaselining is
introduced; histories retain the same reference and units as the raster.
Playback still uses equal GIF frame durations even for irregular acquisitions.

Plot width must be at least 320 pixels and there is an additional 240-pixel
plot below the raster. Combined raster/plot area counts against the display
budget. GIF metadata records point IDs/names/colors, coordinates, native rows/
columns, exact numeric histories with null missing values, fixed plot limits and
sampling/time-axis policies. Display colors are quantized; numeric metadata is
not. Without the option, existing raster-only frame rendering is retained.

The POST request accepts optional `points`, each with `id`, `name`, `lon`, `lat`
and a six-digit hex `color`. IDs must be unique; at most five points are allowed.
Names and coordinates are included intentionally in the exported GIF metadata.
This is a follow-up contribution to the raster foundation, not basemap/context
compositing, general styled annotation export, buffer plots, polygon plots or video.


## Optional vector outlines

Enable **Include visible vector outlines (black)** to include one to five
visible, ready vector layers already imported or drawn in Bowser. Layers with
zero opacity are excluded. Supported GeoJSON geometry types are Point,
MultiPoint, LineString, MultiLineString, Polygon and MultiPolygon. Polygon holes
and multipart boundaries are retained. GeometryCollection, invalid/open rings,
nonfinite/non-WGS84 coordinates and antimeridian-spanning shapes are rejected
rather than repaired or silently skipped. A total 5,000-vertex limit bounds work;
prepare a smaller vector subset externally if needed. Nothing is simplified.

Outlines are static over the exported dates. They use black strokes with a white
halo, no polygon fill and no text labels; original vector colors, styling,
opacity/order and attribute-based classifications are not reproduced. This is
geometry annotation, not a map screenshot. Point symbols indicate locations,
not valid measurements on every date. Outlines draw above the raster and below
selected-history point markers, without changing masks, reference sampling,
measurement values or statistics. Altitude coordinates are ignored for this
2D display and omitted from the exported geometry copy; original inputs remain
unchanged.

The server projects WGS84 geometry into the raster CRS and clips the actual
boundary segments to the exported window. It does not draw a newly created
crop-box edge or fill holes. Clipping/projection are prepared once per export.
There are no basemap requests, source file paths or feature properties in this
option. The GIF comment records bounded layer display names, normalized XY
geometry, style and the number of visible clipped primitives. Layer names and
geometry are deliberately included in the exported file.

The API accepts optional `outlines`: a list of objects with `name` and
`geometries`, where each geometry contains only `type` and `coordinates` in
WGS84. The same fixed GIF palette is used; white/black annotation colors are
already reserved, so enabling outlines does not change data color quantization.
No extra runtime dependency is introduced: it reuses the full server's existing
Shapely and PyProj support. Lite still explicitly rejects GIF rendering.
