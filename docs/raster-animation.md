# Raster GIF export

On the **full server**, open **Project → Export → Raster animation (GIF)**.
Choose the first and last saved epochs, playback speed, and whether to crop to
the current map view. Set the layer's color limits beforehand: the same limits
and palette apply to every frame. Downloading does not advance the map slider
or change the current reference.

This first contribution exports an **opaque scalar raster**, not a screenshot
of the map. It does not include basemaps, terrain backgrounds, vector overlays,
annotations, opacity blending, a colorbar graphic or a synchronized chart.
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

The image uses nearest-neighbor display resizing and 254 fixed data colors;
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
