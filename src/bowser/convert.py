"""Make added data fast to draw: rasters as COGs, large vectors as PMTiles, once.

A file added to the map (an upload, a server path, or ``bowser run --overlay``) is
drawn by the server's tilers or, for vectors, by the page:

- a raster is tiled by ``/overlay``, which needs a Cloud-Optimized GeoTIFF to be
  fast: internal tiles, so a map tile reads only the blocks it covers, and
  overviews, so a zoomed-out tile does not read the whole file. A COG is used where
  it is; anything else GDAL reads is converted once (``convert_to_cog``);
- a small vector becomes one GeoJSON in WGS84 (``convert_to_geojson``) that the
  page holds whole, as it does a GeoJSON file read in the browser, so Identify,
  zonal stats and chart areas work on it;
- a large vector (``is_large_vector``: over ``PMTILES_MIN_MB`` or
  ``PMTILES_MIN_FEATURES``) becomes a PMTiles archive of Mapbox Vector Tiles
  (``convert_to_pmtiles``, GDAL's PMTiles driver) that the page reads with HTTP
  range requests, a few tiles at a time, keeping every attribute.

Every conversion runs once in a background thread (GDAL releases the GIL while it
works), so the server keeps answering, and its result is cached. The cache key is
the source's resolved path, size and modification time, and the output format
(``cache_key``): instant even for files of many GB on a network disk, and any
rewrite of the file changes its mtime and so its key. Its state is kept on disk next
to the output (a ``.lock`` while it runs, an ``.error`` when it failed, a ``.json``
describing it), so any worker, or a server restarted later, sees the same state.

An upload is converted next to the upload (``prepare(..., folder=<upload dir>)``),
so both are swept together after the upload retention time. A server path's output
lives in ``cache_dir()`` (``BOWSER_CONVERT_CACHE_DIR``, default
``~/.cache/bowser/convert``), which is kept under ``BOWSER_CONVERT_CACHE_MAX_GB``
(default 20) and ``BOWSER_CONVERT_CACHE_MAX_DAYS`` (default 30) by ``prune``: the
least recently used outputs go first.

Full server only: it needs GDAL (rasterio for rasters; the ``osgeo`` bindings,
with the PMTiles driver for large vectors).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
from pathlib import Path
from typing import Any, Literal

import rasterio
import rasterio.shutil

logger = logging.getLogger("bowser")

#: Environment variables: the cache folder for server paths, and its limits.
CACHE_ENV = "BOWSER_CONVERT_CACHE_DIR"
MAX_GB_ENV = "BOWSER_CONVERT_CACHE_MAX_GB"
MAX_DAYS_ENV = "BOWSER_CONVERT_CACHE_MAX_DAYS"
DEFAULT_MAX_GB = 20.0
DEFAULT_MAX_DAYS = 30.0

#: A vector over this many MB, or with more features than ``PMTILES_MIN_FEATURES``,
#: is tiled instead of being sent to the page whole. The page parses a GeoJSON file
#: on its main thread and keeps every feature in memory twice (its state and
#: MapLibre's worker): about 20 MB, some 50 000 simple polygons, is where adding a
#: layer starts to freeze the page for seconds and panning stutters, while a tiled
#: archive is drawn at any size. The page sends larger uploads here
#: (``/config`` ``data_conversion.pmtiles_min_mb``).
PMTILES_MIN_MB = 20
PMTILES_MIN_FEATURES = 50_000
#: Tiles are made down to this zoom (~10 m pixels); MapLibre overzooms past it.
PMTILES_MAX_ZOOM = 14

#: Creation options for the COG: DEFLATE with the floating-point predictor (2 for
#: integers; GDAL picks it from the data type with ``YES``), 512 px tiles, and
#: overviews averaged rather than the driver's default cubic, which overshoots at
#: cliffs and breaklines. The nodata value is carried over by the copy. At most 8
#: compression threads: a 20k x 20k float32 file converts in about 20 s with 8, using
#: 0.3 GB, while all 224 cores of a big server took 4 GB and were no faster.
COG_OPTIONS: dict[str, str] = {
    "COMPRESS": "DEFLATE",
    "PREDICTOR": "YES",
    "LEVEL": "6",
    "BLOCKSIZE": "512",
    "OVERVIEWS": "AUTO",
    "OVERVIEW_RESAMPLING": "AVERAGE",
    "NUM_THREADS": str(min(8, os.cpu_count() or 1)),
    "BIGTIFF": "IF_SAFER",
}

#: Rasters this small need neither tiles nor overviews to be a valid COG.
_SMALL = 512

Kind = Literal["raster", "vector"]
Format = Literal["cog", "pmtiles", "geojson"]
Status = Literal["converting", "ready", "failed"]

#: Output file suffix of each format.
SUFFIX: dict[str, str] = {"cog": ".tif", "pmtiles": ".pmtiles", "geojson": ".geojson"}

#: File types the page reads in the browser and GDAL reads here.
VECTOR_SUFFIXES = (
    ".geojson",
    ".json",
    ".csv",
    ".tsv",
    ".txt",
    ".kml",
    ".gpx",
    ".shp",
    ".zip",
    ".gpkg",
    ".fgb",
)
#: Coordinate column names a CSV may use, as the page's own CSV reader takes them.
_CSV_X = "lon,longitude,lng,long,x"
_CSV_Y = "lat,latitude,y"


# --- cache folder and limits -------------------------------------------------------


def cache_dir() -> Path:
    """Return the folder that holds converted server files, creating it.

    ``BOWSER_CONVERT_CACHE_DIR`` when set, else ``$XDG_CACHE_HOME/bowser/convert``
    (by default ``~/.cache/bowser/convert``): converted files outlive the server,
    unlike uploads, which are swept after ``BOWSER_UPLOAD_RETENTION_H`` hours.
    """
    root = os.environ.get(CACHE_ENV)
    if root:
        path = Path(root)
    else:
        xdg = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
        path = Path(xdg) / "bowser" / "convert"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_limits() -> tuple[int, float]:
    """Return the cache's limits: ``(max bytes, max age in seconds)``.

    From ``BOWSER_CONVERT_CACHE_MAX_GB`` (default 20) and
    ``BOWSER_CONVERT_CACHE_MAX_DAYS`` (default 30); 0 turns a limit off.
    """

    def read(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, default))
        except ValueError:
            logger.warning("%s is not a number; using %s", name, default)
            return default

    gb, days = read(MAX_GB_ENV, DEFAULT_MAX_GB), read(MAX_DAYS_ENV, DEFAULT_MAX_DAYS)
    return (int(gb * 1024**3) if gb > 0 else 0), (days * 86400 if days > 0 else 0)


def prune(folder: Path, keep: str | None = None) -> list[str]:
    """Remove the least recently used outputs until ``folder`` is within its limits.

    An output not used for longer than the age limit goes; then the oldest go until
    the outputs fit the size limit. "Used" is the output's mtime, which ``prepare``
    touches every time it hands out a cached file. A conversion still running, and
    ``keep``, are never removed. Returns the removed keys.
    """
    max_bytes, max_age = cache_limits()
    entries: list[tuple[float, int, str]] = []  # (last used, bytes, key)
    for meta in folder.glob("*.json"):
        key = meta.stem
        if key == keep or _lock_file(key, folder).exists():
            continue
        files = [p for p in folder.glob(f"{key}.*") if p.is_file()]
        out = [p for p in files if p.suffix in SUFFIX.values()]
        used = max((p.stat().st_mtime for p in out or files), default=0.0)
        entries.append((used, sum(p.stat().st_size for p in files), key))
    entries.sort()
    total = sum(size for _, size, _ in entries)
    now = time.time()
    removed = []
    for used, size, key in entries:
        too_old = max_age and now - used > max_age
        too_big = max_bytes and total > max_bytes
        if not (too_old or too_big):
            continue
        for p in folder.glob(f"{key}.*"):
            p.unlink(missing_ok=True)
        total -= size
        removed.append(key)
    if removed:
        logger.info("Conversion cache: removed %d old outputs", len(removed))
    return removed


# --- what a file is ----------------------------------------------------------------


def source_files(path: str | os.PathLike) -> list[Path]:
    """Return a dataset's files: the file and, for a Shapefile, its sidecars."""
    p = Path(path)
    if p.suffix.lower() != ".shp":
        return [p]
    return [p, *sorted(q for q in p.parent.glob(f"{p.stem}.*") if q != p)]


def _gdal_name(path: str | os.PathLike) -> str:
    """Return the name GDAL opens ``path`` by (a zipped Shapefile through /vsizip/)."""
    p = str(path)
    return f"/vsizip/{p}" if p.lower().endswith(".zip") else p


def _open_options(path: str | os.PathLike) -> list[str]:
    """Return GDAL open options: a CSV's coordinate columns, as the page names them."""
    if Path(path).suffix.lower() in (".csv", ".tsv", ".txt"):
        return [f"X_POSSIBLE_NAMES={_CSV_X}", f"Y_POSSIBLE_NAMES={_CSV_Y}"]
    return []


def _ogr():
    from osgeo import gdal, ogr, osr  # noqa: PLC0415

    for module in (gdal, ogr, osr):
        module.UseExceptions()
    return gdal


def pmtiles_available() -> bool:
    """Return whether GDAL's Python bindings with the PMTiles driver are installed."""
    try:
        return _ogr().GetDriverByName("PMTiles") is not None
    except ImportError:
        return False


def _open_vector(path: str | os.PathLike):
    gdal = _ogr()
    name = _gdal_name(path)
    if Path(path).suffix.lower() == ".txt":
        name = f"CSV:{name}"
    return gdal.OpenEx(
        name, gdal.OF_VECTOR | gdal.OF_READONLY, open_options=_open_options(path)
    )


def _assumed_srs(ds) -> str | None:
    """Return ``EPSG:4326`` when a layer has no CRS (a CSV of lon/lat), else None.

    The page takes such coordinates as longitude and latitude; so does this.
    """
    for i in range(ds.GetLayerCount()):
        if ds.GetLayer(i).GetSpatialRef() is None:
            return "EPSG:4326"
    return None


def kind_of(path: str | os.PathLike) -> Kind:
    """Return whether ``path`` is a raster or a vector; raise ``ValueError`` if neither.

    A file rasterio opens is a raster; otherwise one GDAL opens as a vector.
    """
    if Path(path).suffix.lower() not in VECTOR_SUFFIXES:
        try:
            with rasterio.open(path):
                return "raster"
        except rasterio.errors.RasterioIOError:
            pass
    try:
        ds = _open_vector(path)
    except ImportError as exc:
        raise ValueError(
            "Vector files need GDAL's Python bindings (conda install gdal)."
        ) from exc
    except RuntimeError as exc:
        raise ValueError(
            f"GDAL cannot read it as raster or vector data: {exc}"
        ) from exc
    if ds is None or ds.GetLayerCount() == 0:
        raise ValueError("GDAL cannot read it as raster or vector data.")
    return "vector"


def vector_info(path: str | os.PathLike) -> dict[str, Any]:
    """Return a vector's non-empty layers, feature count and WGS84 bounds.

    The count is the driver's (fast for most formats; a CSV or GeoJSON is scanned).
    """
    from osgeo import osr  # noqa: PLC0415

    ds = _open_vector(path)  # (also turns on GDAL's exceptions)
    wgs84 = osr.SpatialReference()
    wgs84.ImportFromEPSG(4326)
    wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    layers, count, box = [], 0, [math.inf, math.inf, -math.inf, -math.inf]
    for i in range(ds.GetLayerCount()):
        lyr = ds.GetLayer(i)
        n = lyr.GetFeatureCount()
        if n == 0:
            continue
        layers.append(lyr.GetName())
        count += max(n, 0)
        try:
            minx, maxx, miny, maxy = lyr.GetExtent()
        except RuntimeError:
            continue
        srs = lyr.GetSpatialRef()
        if srs is not None and not srs.IsSame(wgs84):
            srs = srs.Clone()
            srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            t = osr.CoordinateTransformation(srs, wgs84)
            minx, miny, maxx, maxy = t.TransformBounds(minx, miny, maxx, maxy, 21)
        box = [
            min(box[0], minx),
            min(box[1], miny),
            max(box[2], maxx),
            max(box[3], maxy),
        ]
    bounds = [float(b) for b in box] if all(map(math.isfinite, box)) else None
    return {"layers": layers, "feature_count": count, "bounds": bounds}


def is_large_vector(size_bytes: int, feature_count: int) -> bool:
    """Return whether a vector is tiled (PMTiles) rather than sent to the page whole."""
    return (
        size_bytes > PMTILES_MIN_MB * 1024 * 1024
        or feature_count > PMTILES_MIN_FEATURES
    )


def is_cog(path: str | os.PathLike) -> bool:
    """Return whether ``path`` is a Cloud-Optimized GeoTIFF.

    The checks are the ones that matter for tiling, after GDAL's
    ``validate_cloud_optimized_geotiff.py``: a GeoTIFF that, when larger than
    512 px, is internally tiled and has overviews, and whose image directories
    (main and overviews) all come before the pixel data. A file written by GDAL's
    COG driver says so in its ``LAYOUT=COG`` tag and passes at once.
    """
    with rasterio.open(path) as src:
        if src.driver != "GTiff":
            return False
        if src.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG":
            return True
        small = src.width <= _SMALL and src.height <= _SMALL
        if not small and (not src.profile.get("tiled") or not src.overviews(1)):
            return False
        levels = [None, *range(len(src.overviews(1)))]
        ifds, data = [], []
        for ovr in levels:
            ifd = src.get_tag_item("IFD_OFFSET", "TIFF", bidx=1, ovr=ovr)
            block = src.get_tag_item("BLOCK_OFFSET_0_0", "TIFF", bidx=1, ovr=ovr)
            if ifd is not None:
                ifds.append(int(ifd))
            if block is not None and int(block) > 0:
                data.append(int(block))
        return not ifds or not data or max(ifds) < min(data)


# --- the conversions ---------------------------------------------------------------


def convert_to_cog(src: str | os.PathLike, dst: str | os.PathLike) -> None:
    """Write ``src`` as a COG at ``dst`` with ``COG_OPTIONS``.

    The CRS, transform and nodata value are kept, and nothing is resampled at full
    resolution.
    """
    with rasterio.Env(GDAL_CACHEMAX=512):
        rasterio.shutil.copy(str(src), str(dst), driver="COG", **COG_OPTIONS)


def pmtiles_min_zoom(bounds: list[float] | None) -> int:
    """Return the lowest zoom to tile: two levels below where the data fills a tile.

    So the layer still shows when zoomed out a little past it, without tiling the
    whole world for a small area (and at most zoom 10, where a layer of a few km
    is a dot).
    """
    if not bounds:
        return 0
    span = max(bounds[2] - bounds[0], (bounds[3] - bounds[1]) * 2, 1e-9)
    return int(min(10, max(0, math.floor(math.log2(360 / span)) - 2)))


def convert_to_pmtiles(
    src: str | os.PathLike,
    dst: str | os.PathLike,
    name: str = "",
    bounds: list[float] | None = None,
) -> None:
    """Write the vector ``src`` as a PMTiles archive of Mapbox Vector Tiles at ``dst``.

    Every layer and attribute is kept (one tile layer per source layer), reprojected
    to Web Mercator by the driver. Zooms run from ``pmtiles_min_zoom`` to
    ``PMTILES_MAX_ZOOM``; a tile over the driver's 500 kB is written at lower
    precision rather than dropped.
    """
    gdal = _ogr()
    source = _open_vector(src)
    opts = gdal.VectorTranslateOptions(
        format="PMTiles",
        srcSRS=_assumed_srs(source),
        datasetCreationOptions=[
            f"MINZOOM={pmtiles_min_zoom(bounds)}",
            f"MAXZOOM={PMTILES_MAX_ZOOM}",
            f"NAME={name or Path(src).stem}",
        ],
        skipFailures=True,
    )
    ds = gdal.VectorTranslate(str(dst), source, options=opts)
    if ds is None:
        raise RuntimeError("GDAL wrote no PMTiles archive")
    ds = None  # noqa: F841 - closing it finishes the archive


def convert_to_geojson(src: str | os.PathLike, dst: str | os.PathLike) -> None:
    """Write the vector ``src`` as one GeoJSON FeatureCollection in WGS84 at ``dst``.

    Features of every non-empty layer, with all their attributes; with more than
    one layer each feature's ``layer`` says which it came from.
    """
    gdal = _ogr()
    ds = _open_vector(src)
    names = [
        ds.GetLayer(i).GetName()
        for i in range(ds.GetLayerCount())
        if ds.GetLayer(i).GetFeatureCount() != 0
    ]
    features: list[Any] = []
    for name in names:
        tmp = f"/vsimem/bowser_{os.getpid()}_{threading.get_ident()}.geojson"
        try:
            gdal.VectorTranslate(
                tmp,
                ds,
                options=gdal.VectorTranslateOptions(
                    format="GeoJSON",
                    srcSRS=_assumed_srs(ds),
                    dstSRS="EPSG:4326",
                    layers=[name],
                    skipFailures=True,
                ),
            )
            fc = json.loads(_read_vsimem(gdal, tmp))
        finally:
            gdal.Unlink(tmp)
        for f in fc.get("features", []):
            if len(names) > 1:
                f["properties"] = {**(f.get("properties") or {}), "layer": name}
            features.append(f)
    Path(dst).write_text(
        json.dumps({"type": "FeatureCollection", "features": features})
    )


def _read_vsimem(gdal, name: str) -> str:
    f = gdal.VSIFOpenL(name, "rb")
    try:
        size = gdal.VSIStatL(name).size
        return gdal.VSIFReadL(1, size, f).decode()
    finally:
        gdal.VSIFCloseL(f)


# --- background conversion ---------------------------------------------------------

_started: dict[str, float] = {}
_threads_lock = threading.Lock()


def _start(target, args: tuple) -> None:
    """Run a conversion in a background thread (tests swap in a synchronous call)."""
    threading.Thread(target=target, args=args, daemon=True).start()


def cache_key(path: str | os.PathLike, fmt: str) -> str:
    """Return the cache key of a source and output format: its path, size and mtime."""
    parts = [str(Path(path).resolve()), fmt]
    for f in source_files(path):
        st = f.stat()
        parts += [str(st.st_size), str(st.st_mtime_ns)]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


def output_path(key: str, fmt: str, folder: Path) -> Path:
    """Return where the output for ``key`` is (or will be) in ``folder``."""
    return folder / f"{key}{SUFFIX[fmt]}"


def _lock_file(key: str, folder: Path) -> Path:
    return folder / f"{key}.lock"


def _error_file(key: str, folder: Path) -> Path:
    return folder / f"{key}.error"


def _meta_file(key: str, folder: Path) -> Path:
    return folder / f"{key}.json"


def _write_atomic(path: Path, text: str) -> None:
    """Write aside and rename, so a poll never reads a half-written file."""
    tmp = path.with_name(f"{path.name}.partial")
    tmp.write_text(text)
    tmp.replace(path)


def _lock_alive(lock: Path) -> bool:
    """Return whether the process that took ``lock`` is still running."""
    try:
        pid = int(lock.read_text().split()[0])
        os.kill(pid, 0)
    except (OSError, ValueError, IndexError):
        return False
    return True


def _run(key: str, src: str, folder: Path, meta: dict[str, Any]) -> None:
    fmt = meta["format"]
    lock = _lock_file(key, folder)
    dst = output_path(key, fmt, folder)
    # The partial output keeps the format's suffix: GDAL picks drivers by it.
    tmp = dst.with_name(f"{key}.partial{SUFFIX[fmt]}")
    t0 = time.perf_counter()
    try:
        if fmt == "cog":
            convert_to_cog(src, tmp)
        elif fmt == "pmtiles":
            convert_to_pmtiles(src, tmp, meta.get("name", ""), meta.get("bounds"))
        else:
            convert_to_geojson(src, tmp)
        tmp.replace(dst)
        logger.info("%s converted to %s in %.1f s", src, fmt, time.perf_counter() - t0)
    except Exception as exc:  # noqa: BLE001 - any GDAL failure is reported to the page
        logger.warning("%s could not be converted to %s: %s", src, fmt, exc)
        _write_atomic(_error_file(key, folder), str(exc) or type(exc).__name__)
    finally:
        tmp.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)
    if folder == cache_dir():
        prune(folder, keep=key)


def plan(path: str | os.PathLike) -> dict[str, Any]:
    """Return what ``prepare`` would make of ``path``: its kind and output format.

    A raster becomes a COG; a vector a PMTiles archive when ``is_large_vector``,
    else a GeoJSON. Vectors also carry ``vector_info``. Raises ``ValueError`` for
    a file GDAL cannot read.
    """
    kind = kind_of(path)
    if kind == "raster":
        return {"kind": "raster", "format": "cog"}
    info = vector_info(path)
    size = sum(f.stat().st_size for f in source_files(path))
    fmt = "pmtiles" if is_large_vector(size, info["feature_count"]) else "geojson"
    if fmt == "pmtiles" and not pmtiles_available():
        raise ValueError(
            f"{info['feature_count']} features is too many to draw in the browser, "
            "and this server's GDAL has no PMTiles driver to tile them."
        )
    return {"kind": "vector", "format": fmt, **info}


def prepare(
    path: str | os.PathLike, folder: Path | None = None, name: str = ""
) -> dict[str, Any]:
    """Start making ``path`` ready to draw; return its status.

    A COG is used where it is. Otherwise the output cached in ``folder`` (default
    ``cache_dir()``) is used when there is one, or a conversion starts in the
    background (once, however often this is called) and ``status`` is
    ``"converting"`` until ``status(key, folder)`` says otherwise. A conversion
    that failed before is tried again.
    """
    src = Path(path)
    folder = folder or cache_dir()
    meta = {**plan(src), "source": str(src), "name": name or src.name}
    key = cache_key(src, meta["format"])
    if meta["format"] == "cog" and is_cog(src):
        return {
            "id": key,
            **_public(meta),
            "status": "ready",
            "cog": str(src),
            "converted": False,
        }
    with _threads_lock:
        out = output_path(key, meta["format"], folder)
        if out.exists():
            os.utime(out)  # used now: the cache's eviction is least recently used
            return status(key, folder)
        lock = _lock_file(key, folder)
        if lock.exists() and _lock_alive(lock):
            return status(key, folder)
        if folder == cache_dir():
            prune(folder, keep=key)
        _error_file(key, folder).unlink(missing_ok=True)
        _write_atomic(_meta_file(key, folder), json.dumps(meta))
        lock.write_text(f"{os.getpid()} {src}")
        _started[key] = time.time()
        _start(_run, (key, str(src), folder, meta))
    return status(key, folder)


def _public(meta: dict[str, Any]) -> dict[str, Any]:
    """Return the parts of a conversion's description the page sees."""
    return {k: meta[k] for k in ("kind", "format", "name") if k in meta} | {
        k: meta[k]
        for k in ("layers", "feature_count", "bounds")
        if meta.get(k) is not None
    }


def status(key: str, folder: Path | None = None) -> dict[str, Any]:
    """Return the state of the conversion ``key`` in ``folder``.

    ``status`` is ``converting``, ``ready`` or ``failed``; a ready one names its
    output (``output``, and ``cog`` for a raster). Raises ``KeyError`` for a key
    that was never started there.
    """
    folder = folder or cache_dir()
    meta_file = _meta_file(key, folder)
    if not meta_file.exists():
        raise KeyError(key)
    meta = json.loads(meta_file.read_text())
    out: dict[str, Any] = {"id": key, **_public(meta)}
    result = output_path(key, meta["format"], folder)
    if result.exists():
        ready = {**out, "status": "ready", "output": str(result), "converted": True}
        return ready | ({"cog": str(result)} if meta["format"] == "cog" else {})
    err = _error_file(key, folder)
    if err.exists():
        return {**out, "status": "failed", "error": err.read_text()}
    lock = _lock_file(key, folder)
    try:
        alive, since = _lock_alive(lock), lock.stat().st_mtime
    except FileNotFoundError:
        # No lock: never started here, or it finished since the checks above.
        if result.exists() or err.exists():
            return status(key, folder)
        raise KeyError(key) from None
    if not alive:
        if not lock.exists():  # finished while it was read
            return status(key, folder)
        return {
            **out,
            "status": "failed",
            "error": "The conversion stopped (the server was restarted?). "
            "Add the file again to retry.",
        }
    started = _started.get(key, since)
    return {**out, "status": "converting", "elapsed_s": time.time() - started}


def raster_summary(path: str | os.PathLike) -> dict[str, Any]:
    """Return what the page needs to draw a raster: bands, nodata and WGS84 bounds.

    Each band's min, max and 2/5/95/98th percentiles (from an overview of at most
    1024 px, which a COG has), as ``POST /upload_raster`` gives them.
    """
    from rasterio.warp import transform_bounds  # noqa: PLC0415
    from rio_tiler.io import Reader  # noqa: PLC0415

    with Reader(str(path)) as r:
        stats = r.statistics(percentiles=[2, 5, 95, 98], max_size=1024)
    with rasterio.open(path) as src:
        bounds = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        nodata = src.nodata
        count = src.count
    return {
        "band_count": count,
        "bands": [
            {
                "name": name,
                "min": float(s.min),
                "max": float(s.max),
                "p2": float(s.percentile_2),
                "p98": float(s.percentile_98),
                "p5": float(s.percentile_5),
                "p95": float(s.percentile_95),
            }
            for name, s in stats.items()
        ],
        "nodata": None if nodata is None or nodata != nodata else float(nodata),
        "bounds": [float(b) for b in bounds],
    }
