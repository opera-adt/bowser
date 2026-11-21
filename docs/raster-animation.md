# Raster GIF export

On the **full server**, open **Project → Export → Raster animation (GIF)**.
Choose the first and last saved epochs, playback speed, and whether to crop to
the current map view. Set the layer's color limits beforehand: the same limits
and palette apply to every frame. Downloading does not advance the map slider
or change the current reference.

By default this exports an opaque scalar raster, not a screenshot of the
browser. Optional native-pixel histories, vector outlines, captured background
layers with opacity, and geographic text labels are described below. A colorbar
graphic is not currently drawn; numerical color limits and units are shown.
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

Uploaded and configured primary GeoTIFF masks are supported, with bounded
reads and strict error handling as described below. Rewrapped and complex-valued
layers remain unsupported. Missing observations are never replaced with zero.
An all-invalid epoch remains dated and reveals the background if one is included.
Source files and native GeoTIFF export behavior are unchanged.

The image uses nearest-neighbor display resizing and 254 fixed data colors
without point plots, or 248 with plots (the remaining colors mark the selected
points, plot cursor, text and invalid support);
Without a background, white marks invalid data; with a background, it shows
through. White/black are also used for text. Backgrounds use a shared palette
including blended display colors, as described below. Values beyond
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
Point histories use individual native pixels. Backgrounds and text labels are
independent options below; buffer/polygon animation plots and video are not claimed.


## Optional vector outlines

Enable **Include visible vector outlines (black)** to include one to five
visible, ready vector layers already imported or drawn in Bowser. Layers with
zero opacity are excluded. Supported GeoJSON geometry types are Point,
MultiPoint, LineString, MultiLineString, Polygon and MultiPolygon. Polygon holes
and multipart boundaries are retained. GeometryCollection, invalid/open rings,
nonfinite/non-WGS84 coordinates and antimeridian-spanning shapes are rejected
rather than repaired or silently skipped. Each layer may have at most 100
features (geometries), and all layers together at most 5,000 vertices; prepare a
smaller vector subset externally if needed. Nothing is simplified. The page
counts both before sending anything and names the layer that is over; any other
rejection shows the server's reason.

Large files that Bowser draws from server tiles (vector PMTiles, used for files
over 20 MB or 50,000 features) are not in the page as features, so they are not
included in outlines. With the option ticked, the page names each such visible
layer as not included.

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
Vector outlines do not make basemap requests or include source file paths or
feature properties. The optional browser background capture is separate. The GIF comment records bounded layer display names, normalized XY
geometry, style and the number of visible clipped primitives. Layer names and
geometry are deliberately included in the exported file.

The API accepts optional `outlines`: a list of objects with `name` and
`geometries`, where each geometry contains only `type` and `coordinates` in
WGS84. The same fixed GIF palette is used; white/black annotation colors are
already reserved, so enabling outlines does not change data color quantization.
No extra runtime dependency is introduced: it reuses the full server's existing
Shapely and PyProj support. Lite still explicitly rejects GIF rendering.


## Backgrounds, opacity and text annotations

**Include background and its opacity** captures the loaded map layers below the
active raster, including static terrain/hillshade overlays. It requires Crop to
current view, one flat north-up map, and loaded tiles. Leaflet and MapLibre are
supported. The raster's opacity is captured when the download begins. Moving the
view or changing capture settings requires retrying; cancellation restores map
layer visibility. The viewer's date slider is not advanced by the export.

The background is a single static snapshot, limited to 1024 pixels per side.
It is aligned to the chosen raster display grid; only the display image is warped.
Measurement values, references, masks and native point histories are unchanged.
Nodata reveals the background without becoming a displacement observation.
Every frame uses one shared GIF palette, including colors blended at the chosen
opacity. GIF color quantization is display-only. GeoTIFF exports retain numeric
measurements without background composition.

Visible-source attribution is included in the image and metadata. Source URLs,
credentials, PNG bytes and feature properties are not embedded in GIF metadata.
Attribution longer than 280 characters is refused rather than silently truncated.
Leaflet reuses only visible loaded tiles (at most 128), fetching them with browser
CORS restrictions; inaccessible/provider-restricted tiles fail visibly. MapLibre
captures its already rendered background. There is no server-side tile crawler,
remote URL fetching or new satellite download. Tilted terrain, wrapping views and
split-screen background composition are rejected explicitly.

**Include text annotations** adds up to 20 labels, at their WGS84 positions, with
stored text, color and font size. Labels are clipped to the raster extent and do
not become data or masks. Their font uses Matplotlib's existing bundled DejaVuSans;
no font package is installed. Vector outlines and synchronized native point
histories remain separate optional controls and can be combined with backgrounds.

Configured and uploaded masks are now supported by full-server GIF export. They
use the same source-specific conventions as native exports: configured GeoTIFF
mask flags must be finite, nonzero and meet the threshold; uploaded GeoTIFF masks
use >0.5, and GeoZarr uploaded masks use >0. Measurement zeros remain valid.
External masks count toward read budgets, and missing/unreadable masks reject
rather than falling back to unmasked imagery. Aligned masks are read in bounded windows. A different mask grid reuses the
map's nearest-neighbor mask warp on the full selected saved grid before cropping;
this preserves exact map membership at crop edges. That two-dimensional mask
warp must fit the configured cache budget or the export is refused. Source
measurements remain windowed and are never resampled for mask evaluation.
Configured masks must be static or complete for the saved record, with no temporal
clamping. Metadata records external-mask use without exposing file paths.

A regression also fixes Leaflet's initial viewport publication: cropped exports
can be planned before the user first pans the map. Its regression fails before
repair and passes after; map centering and measurement values are unchanged.


Export preflight names overlong annotations and refuses missing local masks before
capturing a background. A background requires Crop to current view. Completely
transparent MapLibre captures are refused rather than producing a misleading blank
background. Label colors use the shared GIF palette and may be approximate; a
contrasting halo improves readability. Cross-grid regression uses a 560-pixel grid
and a cropped-warp negative control, exposing GDAL chunk-boundary differences.
