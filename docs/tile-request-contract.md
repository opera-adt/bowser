# Map tile dimensions and regression images

The browser requests `tilesize=256` for data layers (both MD and COG) and
uploaded raster overlays. This matches the map sources' 256-pixel tile grid
without depending on the server's default. It controls the rendered web image,
not the processing resolution, native data grid, displacement values or exports.

TiTiler 2 changed TileJSON's default from 256 to 512 pixels and replaced
`tile_scale`/`@Nx` with a `tilesize` query parameter. See its
[migration guide](https://developmentseed.org/titiler/migrations/v2_migration/).
The full server retains TiTiler's own API defaults; the browser supplies its
size explicitly. Third-party clients should do the same when comparing servers.

The lite server accepts a positive integer `tilesize` on both TileJSON and tile
endpoints. TileJSON emits modern, unsuffixed tile URLs with the resolved size
in the query string. Existing lite clients can still use `tile_scale` and `@Nx`;
an explicit `tilesize` takes priority. Lite's default remains 256 pixels.

## Deterministic image checks

The API regression scenarios explicitly request 256-pixel PNG tiles. Automatic
format selection can choose JPEG for fully opaque images, making exact decoded
pixel fingerprints depend on the lossy codec build. On the synthetic z16 tile,
the full and lite servers produce identical PNG pixels; the full server's
automatic JPEG has differences of up to 24 RGB levels compared with that PNG.

Only the z16 golden entry changes when selecting PNG: its mean colors and exact
decoded-pixel fingerprint. The partially transparent z14 tile already used PNG
and its entire golden entry remains unchanged. All numerical API goldens and
the existing pixel-agreement thresholds remain unchanged. The separate parity
replay uses unsuffixed `.png` URLs, supported by both TiTiler generations,
instead of TiTiler 1's removed `@1x.png` URL convention.
