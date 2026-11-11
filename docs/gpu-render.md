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
visit, without a reload: the WebGL context is lost, chunks fail to load three
times in a row, the layer's drawing throws, or (in `auto` only) five frames in
a row take longer than 250 ms.

Where pixels are only partly covered (edges of masked areas, a zoomed-out view)
the two renderers can differ by a pixel, since the tiles are resampled once
more by the map; the value drawn at a cube pixel is the same.

## Which renderer is drawing

- **Label**: with `?render=` in the address, a small label at the bottom of
  the map says *GPU render* or *Server tiles*, and why (for example
  `auto: software renderer (...)` or `fell back to tiles: WebGL context lost`).
- **Console**: one line, `[bowser] data layer: GPU — render=gpu (forced)` or
  `[bowser] data layer: tiles — ...`, and a warning when it falls back.
- **Network tab**: the GPU path reads `/zarr/...` (`zarr.json` and chunk
  files, often as `206` byte ranges); server tiles are `/md/tiles/...` PNGs.

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
