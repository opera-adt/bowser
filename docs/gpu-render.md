# GPU rendering (experimental)

By default the map draws the data layer from **server tiles**: for every date,
colormap, range or reference change, the server renders new PNG tiles
(`/md/tiles/...`). The experimental **GPU renderer** instead reads the cube's
zarr chunks once (`/zarr/...`) and colours them in the browser's GPU, so
stepping or playing through dates, changing the colormap or the range, and
moving the reference date take a frame instead of a round trip to the server.

It is off unless you ask for it in the page's address:

| Address | What draws the data layer |
| --- | --- |
| `/` or `?render=tiles` | Server tiles (the default; nothing changes). |
| `?render=gpu` | The GPU, whatever the browser's GPU is (for testing). |
| `?render=auto` | The GPU when the browser has a capable hardware GPU, else tiles. |

`auto` refuses: no WebGL2, a software renderer (SwiftShader, llvmpipe,
Microsoft Basic Render Driver, ...), a context that only exists with a "major
performance caveat", no float textures, too few texture units or array layers,
and a GPU slower than the budget on a short colormap benchmark. The probe runs
once per browser session.

Example: `http://127.0.0.1:8000/?render=auto`, or with a catalog,
`http://127.0.0.1:8000/?dataset=my-cube&render=gpu`.

`?gpu_mb=` sets the GPU memory the layer may keep chunks in (see below), for
example `?render=gpu&gpu_mb=256`.

## What the GPU path draws, and what stays on tiles

The GPU path draws the same picture the tiles show, from the same parameters
the page would send to the tile server:

- any layer of a GeoZarr cube in a UTM projection (EPSG 326xx/327xx), stored
  as zarr v3 (sharded or not, with the usual compressors: blosc, zstd, gzip) on the
  computer that runs the server, with or without a pyramid (the same pyramid
  level as tiles at each zoom);
- the date, the reference date (*ref: date*), the reference point's shift, one
  threshold layer mask (such as *recommended_mask* or a coherence threshold),
  the colormap, the range and the opacity;
- fill values, `scale_factor` and `add_offset` decoded as the servers decode
  them.

Anything else is drawn with server tiles while it lasts, and the GPU takes over
again afterwards:

- rewrapping, phase or amplitude display of complex layers;
- more than one layer mask, or an uploaded custom mask;
- 3D terrain (the GPU layer is flat);
- a COG (GeoTIFF stack) dataset, a cube on S3 or HTTP, a cube that is not
  zarr v3, or a cube not in UTM;
- the right side of split screen, which always uses tiles.

When the GPU path fails it switches to server tiles for the rest of the page
visit, without a reload: the WebGL context is lost, the decoder workers can't
start or stop working, chunks fail to load three times in a row, the layer's
drawing throws, or (in `auto` only) five frames in a row take longer than
250 ms.

Where pixels are only partly covered (edges of masked areas, a zoomed-out view)
the two renderers can differ by a pixel, since the tiles are resampled once
more by the map; the value drawn at a cube pixel is the same.

## How chunks are read and kept

- **Off the main thread.** Up to four Web Workers (one less than the
  processor's cores, at most four) fetch each chunk from `/zarr/`, decompress
  it, apply the CF decoding and, where allowed, round it to float16. The
  finished buffer is handed to the page without a copy, and the page only
  uploads it to the GPU (at most four chunks per frame). The decompressor a
  cube uses (zstd, blosc, ...) is loaded the first time a `zarr.json` names
  it, in the worker; a cube that uses none, or only gzip, loads none.
- **Half floats.** Displacement and other layers in metres (or m/yr, mm) are
  kept as 16-bit floats (half the GPU memory of 32-bit ones) when every value
  of the chunk rounds to float16 within **0.1 mm**. A float16 value keeps 11
  significant bits, so that holds for chunks whose values stay within
  ±0.25 m (then the largest value alone proves it, and the values aren't
  checked one by one); chunks with larger values are checked, and stay 32-bit
  when one rounds by more. 0.1 mm is 50 times below OPERA DISP-S1's 5 mm
  accuracy requirement and below one colour step for
  any colour range wider than ±13 mm (±26 mm with a reference date, which
  subtracts two rounded values). Masks (coherence, similarity, ...) and
  layers in other units always stay 32-bit, so a threshold compares exactly
  as on the server. Nodata stays nodata.
- **Memory cap.** Chunks already on the GPU are kept for going back and forth
  in time, up to a budget: 96 MB per GB of the device's memory, between 128
  and 768 MB (768 MB on a computer with 8 GB or more, 384 MB where the browser
  doesn't say), or `?gpu_mb=` (64 to 2048 MB). As 16-bit floats, 768 MB holds
  all 269 dates of a 30 m frame in a 1100×800 view, so a second play-through
  or going back draws from memory without fetching or decoding again. Above
  the budget, chunks away from the view are dropped first, then the view's
  other dates, the least recently used first, down to 80% of the budget. What the current frame draws is always kept, so a very large view
  can go over the budget by that much. Chunks the view stopped needing while
  still queued (dates played past, places panned away from) are not fetched;
  those already on their way are still uploaded, after the view's own, so
  coming back to them needs no second fetch.

## Which renderer is drawing

- **Label**: with `?render=` in the address, a small label at the bottom of
  the map says *GPU render* or *Server tiles*, and why (for example
  `auto: software renderer (...)` or `fell back to tiles: WebGL context lost`).
  For the GPU it adds the chunk memory in use and the budget, and how many
  chunks are 16-bit and 32-bit (`42/384 MB · 30 f16, 2 f32`).
- **Console**: one line, `[bowser] data layer: GPU — render=gpu (forced)` or
  `[bowser] data layer: tiles — ...`, and a warning when it falls back.
- **Network tab**: the GPU path reads `/zarr/...` (`zarr.json` and chunk
  files, often as `206` byte ranges), from the `bowser-gpu-decoder` workers;
  server tiles are `/md/tiles/...` PNGs.

## The `/zarr/` route

`GET /zarr/{path}` (and `HEAD`) serves the files of the cube the page has open:
the server's own cube, or the catalog entry named by `?dataset=` (the page adds
it). Both the full server and bowser-lite serve it, the same way. It is
read-only and serves only `zarr.json` metadata and chunk files of a store on the
server's disk: any other file of the folder, hidden files, paths that lead out
of the store (`..`, absolute paths, encoded forms, symlinks pointing out) and
remote stores answer 404; a request from another web site answers 403.

The route serves nothing the data API does not already give (`/point` returns
the same values), but it does let a client read a whole cube quickly. A server
that should send rendered tiles only can turn it off with
`BOWSER_ZARR_FILES=false`; the page then draws tiles.
