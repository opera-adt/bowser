"""bowser-lite: the Bowser server for GeoZarr, without GDAL, rio-tiler or matplotlib.

``bowser.lite.main:app`` answers the same HTTP requests the web UI makes of
``bowser.main:app`` in MD (GeoZarr) mode, using only numpy, xarray, zarr and pyproj,
so the desktop app can ship a small Python environment.
"""
