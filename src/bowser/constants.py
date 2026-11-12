"""Constants shared by the converter and both servers (no heavy imports)."""

#: Edge, in pixels, of the Web Mercator map tiles bowser serves and the client
#: asks for. The pyramid builder stops coarsening at this size
#: (``tifs-to-geozarr --min-pyramid-size``) and the level pickers
#: (``dataset_for_tile_zoom``) assume it, so a level is never smaller than one
#: tile. Change them together.
TILE_SIZE = 256

#: How long a browser may keep a data tile. Its URL names everything it is drawn
#: from, so going back to a date already seen needs no request. The lifetime of
#: the cube's zarr files (``zarr_files.py``); private, as a server may be behind
#: a login.
TILE_CACHE_CONTROL = "private, max-age=600"
