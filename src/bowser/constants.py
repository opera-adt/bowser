"""Constants shared by the converter and both servers (no heavy imports)."""

#: Edge, in pixels, of the Web Mercator map tiles bowser serves and the client
#: asks for. The pyramid builder stops coarsening at this size
#: (``tifs-to-geozarr --min-pyramid-size``) and the level pickers
#: (``dataset_for_tile_zoom``) assume it, so a level is never smaller than one
#: tile. Change them together.
TILE_SIZE = 256
