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
export policy; quality masks do not redefine the reference sample. Masks must
have the same grid and compatible saved-epoch labels. There is no mask
resampling or inference of a matching ministack.

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
- At most two million source pixels and 50 million source pixel-epochs. Viewport
  cropping does not bypass the native-source budget.
- Output width 64–1024 pixels, height at most 1024 raster pixels, and at most
  24 million display pixel-epochs, plus small text headers/footers.
- One render per server process; a second concurrent request receives HTTP 409.
  Rendering checks a 120-second deadline between frames, not during blocked IO
  or GIF encoding. The budgets bound array/display work, not remote IO latency.
- Stopping a download aborts the browser request; it does not promise immediate
  cancellation of a render already executing on the server.

The GIF comment contains JSON with layer, saved indices/labels, units, limits,
palette, requested speed, encoded duration, crop bounds, masks, valid native
pixel counts, reference coordinates/epoch/offsets and display limitations.
The filename includes the layer and first/last saved labels. Local source paths
and credentials are not included by this exporter.

`GET /export/animation` reports capability. `POST /export/animation` accepts JSON:

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
