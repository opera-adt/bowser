"""What is on the ground around the cube, from outside services, for the AI tools.

Two questions: what infrastructure (roads, buildings, rail, bridges, pipelines,
dams, levees) lies at a point or in an area, from OpenStreetMap through the
Overpass API (``POST /infrastructure``); and what the ground is at a point, to
read its time series with (``GET /site_context``): land cover, geology, mapped
wetlands, soil and the terrain's slope. Ported from the OPERA DISP portal's
``infrastructure_in_zone``, ``highlight_infrastructure`` and ``site_context``,
with only numpy and pyproj (bowser-lite has no shapely or GDAL).

Every service is used as its operators ask, as the geocoder does
(:mod:`bowser.geocode`):

- a User-Agent that names Bowser and its home page, never a person's address;
- requests to one service are spaced (Overpass: one a second, and one at a time)
  for the whole server, and a busy answer (HTTP 429) is not retried at once;
- answers are cached for a day, so a repeated question is not sent again;
- results carry the source's attribution;
- an administrator can point each service elsewhere (their own Overpass, for
  heavy use) or turn it off with its variable (see :data:`SERVICES`), or turn
  every outside lookup off with ``BOWSER_CONTEXT_SERVICES=off``. Variables are
  read on each request.

A lookup that fails or is off says so ("could not be looked up"): no data is not
the same as nothing there.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import secrets
import threading
import time
import zlib
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx
import numpy as np
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field
from pyproj import Geod

from . import api_models as api
from .assistant.relay import _require_enabled, get_settings
from .geocode import user_agent

GEOD = Geod(ellps="WGS84")
#: Turns every outside lookup of this module off ("off").
ENV_ALL = "BOWSER_CONTEXT_SERVICES"
OSM_ATTRIBUTION = (
    "Data © OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright), "
    "via the Overpass API"
)
_OFF = ("off", "none", "false", "0")


class ServiceError(RuntimeError):
    """A service failed, refused or is off; the message is for the user."""

    def __init__(self, message: str, status: int = 502) -> None:
        """Keep the message and the HTTP status to answer with."""
        super().__init__(message)
        self.status = status


@dataclass
class Service:
    """An outside service: where it is, how it may be changed, how often to ask."""

    name: str
    label: str
    urls: tuple[str, ...]
    env: str
    #: Least seconds between two requests to it from this server.
    interval: float
    attribution: str
    #: Most requests in flight at once.
    concurrent: int = 4

    def endpoints(self) -> list[str]:
        """Return the URLs in use (the variable's, comma separated), or [] when off."""
        if os.environ.get(ENV_ALL, "").strip().lower() in _OFF:
            return []
        value = os.environ.get(self.env, "").strip()
        if value.lower() in _OFF:
            return []
        if value:
            return [u.strip() for u in value.split(",") if u.strip()]
        return list(self.urls)


LAND_COVER_URL = (
    "https://ic.imagery1.arcgis.com/arcgis/rest/services/"
    "Sentinel2_10m_LandCover/ImageServer/identify"
)
#: The services this module uses, by name.
SERVICES: dict[str, Service] = {
    s.name: s
    for s in (
        Service(
            "overpass",
            "OpenStreetMap Overpass API",
            (
                "https://overpass-api.de/api/interpreter",
                "https://overpass.private.coffee/api/interpreter",
            ),
            "BOWSER_OVERPASS_URL",
            1.0,
            OSM_ATTRIBUTION,
            concurrent=1,
        ),
        Service(
            "land_cover",
            "Sentinel-2 10 m land cover (Impact Observatory, Microsoft, Esri)",
            (LAND_COVER_URL,),
            "BOWSER_LANDCOVER_URL",
            0.5,
            "Land cover: Impact Observatory, Microsoft, Esri (CC BY 4.0)",
        ),
        Service(
            "geology",
            "Macrostrat geologic map units",
            ("https://macrostrat.org/api/v2/geologic_units/map",),
            "BOWSER_MACROSTRAT_URL",
            0.5,
            "Geology: Macrostrat (macrostrat.org), CC BY 4.0",
        ),
        Service(
            "wetlands",
            "USFWS National Wetlands Inventory",
            (
                "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/"
                "services/Wetlands/MapServer/0/query",
            ),
            "BOWSER_WETLANDS_URL",
            0.5,
            "Wetlands: U.S. Fish and Wildlife Service, National Wetlands Inventory",
        ),
        Service(
            "soils",
            "USDA NRCS Soil Data Access (SSURGO)",
            ("https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest",),
            "BOWSER_SOILS_URL",
            0.5,
            "Soils: USDA NRCS Soil Survey (SSURGO), via Soil Data Access",
        ),
        Service(
            "terrain",
            "AWS Terrain Tiles (Terrarium)",
            (
                "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
            ),
            "BOWSER_TERRAIN_URL",
            0.0,
            "Terrain: AWS Terrain Tiles (Mapzen; USGS 3DEP, SRTM and others)",
        ),
    )
}


class Fetcher:
    """Requests to the services: spaced, bounded, cached, identified.

    The spacing holds across event loops and threads, as the geocoder's: each
    request reserves the next free slot of its service under a lock, then waits.
    """

    def __init__(
        self,
        cache_size: int = 256,
        ttl: float = 24 * 3600.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Set the cache's size and age, and the transport (tests give a mock)."""
        self.cache_size = cache_size
        self.ttl = ttl
        self.transport = transport
        self._cache: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._next: dict[str, float] = {}
        self._busy: dict[str, int] = {}
        #: (service, monotonic time, url) of each request sent (tests read it).
        self.sent: list[tuple[str, float, str]] = []

    def clear(self) -> None:
        """Forget the cache and the spacing (tests)."""
        with self._lock:
            self._cache.clear()
            self._next.clear()
            self._busy.clear()
            self.sent.clear()

    def _cached(self, key: str) -> Any:
        with self._lock:
            hit = self._cache.get(key)
            if hit is None:
                return None
            if time.monotonic() - hit[0] > self.ttl:
                del self._cache[key]
                return None
            self._cache.move_to_end(key)
            return hit[1]

    def _store(self, key: str, value: Any) -> None:
        with self._lock:
            self._cache[key] = (time.monotonic(), value)
            self._cache.move_to_end(key)
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)

    async def _slot(self, s: Service) -> None:
        """Wait for a free place, then for this request's turn."""
        while True:
            with self._lock:
                if self._busy.get(s.name, 0) < s.concurrent:
                    self._busy[s.name] = self._busy.get(s.name, 0) + 1
                    now = time.monotonic()
                    at = max(now, self._next.get(s.name, 0.0))
                    self._next[s.name] = at + s.interval
                    break
            await asyncio.sleep(0.05)
        if at > now:
            await asyncio.sleep(at - now)

    def _done(self, s: Service) -> None:
        with self._lock:
            self._busy[s.name] = max(0, self._busy.get(s.name, 1) - 1)

    async def request(
        self,
        name: str,
        *,
        method: str = "GET",
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        json_body: Any = None,
        fill: dict[str, Any] | None = None,
        binary: bool = False,
        timeout: float = 30.0,
    ) -> tuple[Any, bool]:
        """Ask service ``name``; return ``(answer, cached)``.

        ``fill`` fills the URL's ``{placeholders}`` (tiles). The answer is the
        JSON, or the bytes with ``binary``. Mirrors are tried in turn when one
        cannot be reached or is busy (HTTP 429 or 5xx).

        Raises
        ------
        ServiceError
            The service is off, failed, refused or sent something else.

        """
        s = SERVICES[name]
        urls = s.endpoints()
        if not urls:
            raise ServiceError(f"{s.label} is turned off on this server.", 503)
        key = json.dumps(
            [urls[0], method, params, data, json_body, fill], sort_keys=True
        )
        hit = self._cached(key)
        if hit is not None:
            return hit, True
        last = ""
        for base in urls:
            url = base.format(**fill) if fill else base
            await self._slot(s)
            self.sent.append((name, time.monotonic(), url))
            try:
                async with httpx.AsyncClient(
                    transport=self.transport, timeout=timeout, trust_env=True
                ) as http:
                    r = await http.request(
                        method,
                        url,
                        params=params,
                        data=data,
                        json=json_body,
                        headers={
                            "User-Agent": user_agent(),
                            "Accept": "*/*" if binary else "application/json",
                        },
                    )
            except httpx.HTTPError as e:
                last = type(e).__name__
                continue
            finally:
                self._done(s)
            if r.status_code == 200:
                if binary:
                    value: Any = r.content
                else:
                    try:
                        value = r.json() if r.text.strip() else {}
                    except ValueError:
                        last = "an answer that is not JSON"
                        continue
                self._store(key, value)
                return value, False
            last = f"HTTP {r.status_code}"
            if r.status_code != 429 and r.status_code < 500:
                break
        if "429" in last:
            raise ServiceError(f"{s.label} is busy ({last}); try again in a minute.")
        if last.startswith("HTTP"):
            raise ServiceError(f"{s.label} answered {last}.")
        raise ServiceError(f"{s.label} could not be reached ({last}).")


#: The server's fetcher (one, so the spacing is for the whole server).
FETCHER = Fetcher()


# --- results kept for the page ------------------------------------------------------


class ResultStore:
    """Recent results (features to draw, zones to refer to), by id, for a while."""

    def __init__(self, size: int = 64, ttl: float = 4 * 3600.0) -> None:
        """Keep at most ``size`` results for ``ttl`` seconds."""
        self.size = size
        self.ttl = ttl
        self._items: OrderedDict[str, tuple[float, dict]] = OrderedDict()
        self._lock = threading.Lock()

    def put(self, kind: str, payload: dict) -> str:
        """Keep ``payload`` (with its ``kind``); return its id."""
        rid = f"{kind[:4]}-{secrets.token_urlsafe(6)}"
        with self._lock:
            self._items[rid] = (time.monotonic(), {"kind": kind, **payload})
            while len(self._items) > self.size:
                self._items.popitem(last=False)
        return rid

    def get(self, rid: str) -> dict | None:
        """Return the result ``rid``, or None when unknown or too old."""
        with self._lock:
            hit = self._items.get(rid)
            if hit is None or time.monotonic() - hit[0] > self.ttl:
                self._items.pop(rid, None)
                return None
            return hit[1]

    def latest(self, kind: str) -> tuple[str, dict] | None:
        """Return the newest result of ``kind`` and its id."""
        with self._lock:
            for rid in reversed(self._items):
                t, item = self._items[rid]
                if item["kind"] == kind and time.monotonic() - t <= self.ttl:
                    return rid, item
        return None

    def clear(self) -> None:
        """Forget everything (tests)."""
        with self._lock:
            self._items.clear()


RESULTS = ResultStore()


def zone_feature(zone: str) -> tuple[dict, str]:
    """Return the zone named ``zone`` ("Z1", or "<zones id>/Z1") and its zones id.

    A bare name is a zone of the latest ``deformation_zones`` result.
    """
    rid, _, name = zone.strip().rpartition("/")
    if rid:
        item = RESULTS.get(rid)
        if item is None or item["kind"] != "zones":
            raise ServiceError(f"No zones result {rid!r} (they are kept 4 hours).", 404)
    else:
        found = RESULTS.latest("zones")
        if found is None:
            raise ServiceError(
                "No deformation zones yet: run deformation_zones first.", 404
            )
        rid, item = found
    for f in item["features"]["features"]:
        if f["id"].lower() == name.lower():
            return f, rid
    names = ", ".join(f["id"] for f in item["features"]["features"][:20]) or "none"
    raise ServiceError(f"No zone {name!r} in {rid} (zones: {names}).", 404)


def zones_answer(
    ds: Any,
    to_xy: Any,
    *,
    threshold_mm_yr: float,
    sign: str,
    min_area_m2: float,
    bbox: str | None,
    layer: str | None,
    coherence_min: float | None,
    max_zones: int,
    ref_lon: float | None,
    ref_lat: float | None,
) -> dict[str, Any]:
    """Answer ``GET /deformation_zones`` (both servers) and keep the zones."""
    from . import zones  # noqa: PLC0415

    box = None
    if bbox:
        try:
            box = tuple(float(v) for v in bbox.split(","))
        except ValueError:
            box = ()
        if len(box) != 4:
            raise HTTPException(
                status_code=400, detail="bbox is west,south,east,north (lon/lat)."
            )
    if (ref_lon is None) != (ref_lat is None):
        raise HTTPException(status_code=400, detail="Give both ref_lon and ref_lat.")
    try:
        out = zones.deformation_zones(
            ds,
            to_xy,
            threshold_mm_yr,
            sign=sign,  # type: ignore[arg-type]
            min_area_m2=min_area_m2,
            bbox=box,  # type: ignore[arg-type]
            layer=layer,
            coherence_min=coherence_min,
            max_zones=max_zones,
            ref_lonlat=(
                (ref_lon, ref_lat)
                if ref_lon is not None and ref_lat is not None
                else None
            ),
        )
    except zones.ZonesError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    out["result_id"] = RESULTS.put(
        "zones", {"features": out["zones"], "source": out["source"]}
    )
    return out


# --- geometry on the ellipsoid (numpy and pyproj only) ------------------------------


def circle(lon: float, lat: float, radius_m: float, n: int = 64) -> dict:
    """Return a circle of ``radius_m`` around a point, as a GeoJSON Polygon."""
    az = np.linspace(0, 360, n, endpoint=False)
    lons, lats, _ = GEOD.fwd(np.full(n, lon), np.full(n, lat), az, np.full(n, radius_m))
    ring = [[float(a), float(b)] for a, b in zip(lons, lats)]
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


def bbox_polygon(bbox: list[float]) -> dict:
    """Return a GeoJSON Polygon of [west, south, east, north]."""
    w, s, e, n = bbox
    if not (w < e and s < n):
        raise ServiceError("bbox must be [west, south, east, north].", 400)
    return {
        "type": "Polygon",
        "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    }


def polygons_of(geometry: dict) -> list[list[np.ndarray]]:
    """Return the polygons of a GeoJSON (Multi)Polygon or Feature, rings as arrays."""
    if geometry.get("type") == "Feature":
        geometry = geometry.get("geometry") or {}
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    polys: Any
    if kind == "Polygon":
        polys = [coords]
    elif kind == "MultiPolygon":
        polys = coords
    else:
        raise ServiceError("Give a GeoJSON Polygon or MultiPolygon.", 400)
    out = []
    for poly in polys or []:
        rings = [np.asarray(r, dtype=float)[:, :2] for r in poly if len(r) >= 4]
        if rings:
            out.append(rings)
    if not out:
        raise ServiceError("The area is empty.", 400)
    return out


def area_bounds(polys: list[list[np.ndarray]]) -> tuple[float, float, float, float]:
    """[west, south, east, north] of an area."""
    pts = np.vstack([p[0] for p in polys])
    return (
        float(pts[:, 0].min()),
        float(pts[:, 1].min()),
        float(pts[:, 0].max()),
        float(pts[:, 1].max()),
    )


def area_m2(polys: list[list[np.ndarray]]) -> float:
    """Geodesic area of an area (holes taken out)."""
    total = 0.0
    for rings in polys:
        for j, r in enumerate(rings):
            a = abs(GEOD.polygon_area_perimeter(r[:, 0], r[:, 1])[0])
            total += a if j == 0 else -a
    return total


def _in_ring(x: np.ndarray, y: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Even-odd ray casting: which points lie in ``ring``."""
    inside = np.zeros(x.shape, bool)
    xa, ya = ring[:-1, 0], ring[:-1, 1]
    xb, yb = ring[1:, 0], ring[1:, 1]
    for x1, y1, x2, y2 in zip(xa, ya, xb, yb):
        if y1 == y2:
            continue
        crosses = (y1 > y) != (y2 > y)
        xc = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (x < xc)
    return inside


def contains(polys: list[list[np.ndarray]], x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Which of the points (lon ``x``, lat ``y``) lie in the area."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    out = np.zeros(x.shape, bool)
    for rings in polys:
        outer = rings[0]
        box = (
            (x >= outer[:, 0].min())
            & (x <= outer[:, 0].max())
            & (y >= outer[:, 1].min())
            & (y <= outer[:, 1].max())
        )
        if not box.any():
            continue
        xi, yi = x[box], y[box]
        hit = _in_ring(xi, yi, outer)
        for hole in rings[1:]:
            hit &= ~_in_ring(xi, yi, hole)
        out[np.flatnonzero(box)[hit]] = True
    return out


#: Lines are cut into pieces of at most this length (m) to clip them to an area.
PIECE_M = 15.0


def clip_line(
    polys: list[list[np.ndarray]], coords: np.ndarray
) -> tuple[float, list[np.ndarray]]:
    """Length (m) of a line inside the area, and its parts inside (lon/lat).

    The line is cut into pieces of at most :data:`PIECE_M` metres; a piece is
    inside when its middle is, so lengths are good to a piece at each crossing.
    """
    if len(coords) < 2:
        return 0.0, []
    lon1, lat1 = coords[:-1, 0], coords[:-1, 1]
    lon2, lat2 = coords[1:, 0], coords[1:, 1]
    _, _, seg = GEOD.inv(lon1, lat1, lon2, lat2)
    n = np.maximum(1, np.ceil(seg / PIECE_M).astype(int))
    which = np.repeat(np.arange(len(seg)), n)
    start = np.concatenate([[0], np.cumsum(n)[:-1]])
    k = np.arange(n.sum()) - np.repeat(start, n)
    f0 = k / n[which]
    f1 = (k + 1) / n[which]
    x0 = lon1[which] + (lon2[which] - lon1[which]) * f0
    y0 = lat1[which] + (lat2[which] - lat1[which]) * f0
    x1 = lon1[which] + (lon2[which] - lon1[which]) * f1
    y1 = lat1[which] + (lat2[which] - lat1[which]) * f1
    inside = contains(polys, (x0 + x1) / 2, (y0 + y1) / 2)
    if not inside.any():
        return 0.0, []
    length = float((seg[which] / n[which])[inside].sum())
    parts: list[np.ndarray] = []
    run: list[list[float]] = []
    for i in range(len(inside)):
        if inside[i]:
            if not run:
                run.append([x0[i], y0[i]])
            run.append([x1[i], y1[i]])
        elif run:
            parts.append(_thin(np.asarray(run)))
            run = []
    if run:
        parts.append(_thin(np.asarray(run)))
    return length, parts


def _thin(line: np.ndarray, tol: float = 2e-6) -> np.ndarray:
    """Douglas-Peucker on an open line (degrees; 2e-6 is about 0.2 m)."""
    if len(line) <= 2:
        return line
    keep = np.zeros(len(line), bool)
    keep[[0, -1]] = True
    stack = [(0, len(line) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = line[i], line[j]
        ab = b - a
        norm = math.hypot(*ab)
        pts = line[i + 1 : j]
        d = (
            np.hypot(*(pts - a).T)
            if norm == 0
            else np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / norm
        )
        k = int(np.argmax(d))
        if d[k] > tol:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return line[keep]


# --- OpenStreetMap infrastructure ---------------------------------------------------

Kind = Literal["roads", "buildings", "rail", "bridges", "pipelines", "dams", "levees"]
DEFAULT_KINDS: tuple[Kind, ...] = ("roads", "buildings")
KINDS: tuple[str, ...] = (
    "roads",
    "buildings",
    "rail",
    "bridges",
    "pipelines",
    "dams",
    "levees",
)
ROAD_CLASSES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
)
RAIL_CLASSES = "rail|light_rail|subway|tram|narrow_gauge|preserved|disused"
#: Overpass selectors of each kind (each followed by the area's bounding box).
SELECTORS: dict[str, tuple[str, ...]] = {
    "roads": (f'way["highway"~"^({ROAD_CLASSES})$"]',),
    "buildings": ('way["building"]',),
    "rail": (f'way["railway"~"^({RAIL_CLASSES})$"]',),
    "bridges": ('way["bridge"]["bridge"!="no"]',),
    "pipelines": ('way["man_made"="pipeline"]',),
    "dams": ('way["waterway"~"^(dam|weir)$"]', 'node["waterway"~"^(dam|weir)$"]'),
    "levees": ('way["man_made"="dyke"]', 'way["embankment"="levee"]'),
}
#: Largest box (km²) asked of Overpass for each kind (the portal's limits).
MAX_BOX_KM2 = {"buildings": 60.0}
MAX_BOX_KM2_DEFAULT = 2_500.0
#: Most features kept for the map per kind (the longest or largest first).
MAX_FEATURES = 3_000


def _kinds_of(tags: dict[str, str]) -> list[str]:
    """Return the kinds an OpenStreetMap element is (a bridge is also a road)."""
    out = []
    if re.fullmatch(ROAD_CLASSES, tags.get("highway", "")):
        out.append("roads")
    if "building" in tags:
        out.append("buildings")
    if re.fullmatch(RAIL_CLASSES, tags.get("railway", "")):
        out.append("rail")
    if tags.get("bridge") and tags.get("bridge") != "no":
        out.append("bridges")
    if tags.get("man_made") == "pipeline":
        out.append("pipelines")
    if tags.get("waterway") in ("dam", "weir"):
        out.append("dams")
    if tags.get("man_made") == "dyke" or tags.get("embankment") == "levee":
        out.append("levees")
    return out


def _class_of(kind: str, tags: dict[str, str]) -> str:
    """Return what to group a feature by, per kind."""
    if kind == "roads":
        return tags.get("highway", "road")
    if kind == "buildings":
        return tags.get("building", "yes")
    if kind == "rail":
        return tags.get("railway", "rail")
    if kind == "bridges":
        if "railway" in tags:
            return f"rail ({tags['railway']})"
        if "highway" in tags:
            return f"road ({tags['highway']})"
        return tags.get("bridge", "bridge")
    if kind == "pipelines":
        return tags.get("substance") or tags.get("type") or "not stated"
    if kind == "dams":
        return tags.get("waterway", "dam")
    return "levee" if tags.get("embankment") == "levee" else "dyke"


def _name_of(tags: dict[str, str]) -> str:
    return tags.get("ref") or tags.get("name") or tags.get("bridge:name") or ""


def overpass_query(kinds: list[str], bounds: tuple[float, float, float, float]) -> str:
    """Return the Overpass QL query for ``kinds`` in a box (W, S, E, N)."""
    w, s, e, n = bounds
    bb = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    parts = "".join(f"{sel}({bb});" for k in kinds for sel in SELECTORS[k])
    return f"[out:json][timeout:90];({parts});out tags geom qt;"


def summarize(
    elements: list[dict],
    polys: list[list[np.ndarray]],
    kinds: list[str],
    list_limit: int = 10,
) -> tuple[dict[str, Any], dict[str, list[dict]]]:
    """Summaries per kind of the elements in the area, and their features.

    Lines are clipped to the area (length inside), buildings count when their
    centre is inside (whole footprint), points when inside.
    """
    acc: dict[str, dict[str, Any]] = {
        k: {"n": 0, "m": 0.0, "m2": 0.0, "classes": {}, "named": {}, "feats": []}
        for k in kinds
    }
    for el in elements:
        tags = el.get("tags") or {}
        mine = [k for k in _kinds_of(tags) if k in acc]
        if not mine:
            continue
        name = _name_of(tags)
        if el.get("type") == "node":
            if "lon" not in el:
                continue
            if not contains(polys, np.array([el["lon"]]), np.array([el["lat"]]))[0]:
                continue
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
            for k in mine:
                a = acc[k]
                a["n"] += 1
                cls = _class_of(k, tags)
                a["classes"][cls] = a["classes"].get(cls, 0) + 1
                if name:
                    a["named"].setdefault((name, cls), 0.0)
                a["feats"].append((0.0, geom, k, cls, name, el.get("id"), {}))
            continue
        pts = el.get("geometry") or []
        coords = np.array(
            [[p["lon"], p["lat"]] for p in pts if p and "lon" in p], dtype=float
        )
        if len(coords) < 2:
            continue
        for k in mine:
            a = acc[k]
            cls = _class_of(k, tags)
            if k == "buildings":
                if len(coords) < 4:
                    continue
                ring = coords[:-1] if np.allclose(coords[0], coords[-1]) else coords
                cx, cy = ring[:, 0].mean(), ring[:, 1].mean()
                if not contains(polys, np.array([cx]), np.array([cy]))[0]:
                    continue
                m2 = abs(GEOD.polygon_area_perimeter(ring[:, 0], ring[:, 1])[0])
                a["n"] += 1
                a["m2"] += m2
                a["classes"][cls] = a["classes"].get(cls, 0) + 1
                if name:
                    a["named"][(name, cls)] = a["named"].get((name, cls), 0.0) + m2
                closed = [[float(x), float(y)] for x, y in ring]
                geom = {"type": "Polygon", "coordinates": [closed + [closed[0]]]}
                a["feats"].append(
                    (m2, geom, k, cls, name, el.get("id"), {"footprint_m2": round(m2)})
                )
                continue
            length, parts = clip_line(polys, coords)
            if not parts:
                continue
            a["n"] += 1
            a["m"] += length
            a["classes"][cls] = a["classes"].get(cls, 0.0) + length / 1000
            if name:
                a["named"][(name, cls)] = a["named"].get((name, cls), 0.0) + length
            lines = [
                [[round(float(x), 6), round(float(y), 6)] for x, y in p] for p in parts
            ]
            geom = (
                {"type": "LineString", "coordinates": lines[0]}
                if len(lines) == 1
                else {"type": "MultiLineString", "coordinates": lines}
            )
            a["feats"].append(
                (
                    length,
                    geom,
                    k,
                    cls,
                    name,
                    el.get("id"),
                    {"length_m": round(length, 1)},
                )
            )
    summary: dict[str, Any] = {}
    features: dict[str, list[dict]] = {}
    for k, a in acc.items():
        s: dict[str, Any] = {"count": a["n"]}
        if k == "buildings":
            s["footprint_m2"] = round(a["m2"])
            s["types"] = dict(sorted(a["classes"].items(), key=lambda kv: -kv[1])[:10])
            s["named"] = [
                {"name": n, "type": c, "footprint_m2": round(v)}
                for (n, c), v in sorted(a["named"].items(), key=lambda kv: -kv[1])
            ][:list_limit]
        else:
            if a["m"]:
                s["length_km"] = round(a["m"] / 1000, 3)
            if k != "dams" or a["m"]:
                s["km_by_class"] = {
                    c: round(v, 3)
                    for c, v in sorted(a["classes"].items(), key=lambda kv: -kv[1])
                }
            else:
                s["by_class"] = dict(a["classes"])
            s["named"] = [
                {"name": n, "class": c, **({"km": round(v / 1000, 3)} if v else {})}
                for (n, c), v in sorted(a["named"].items(), key=lambda kv: -kv[1])
            ][:list_limit]
        summary[k] = s
        ranked = sorted(a["feats"], key=lambda f: -f[0])[:MAX_FEATURES]
        features[k] = [
            {
                "type": "Feature",
                "geometry": g,
                "properties": {
                    "kind": kk,
                    "class": c,
                    "name": nm,
                    "osm_id": oid,
                    **extra,
                },
            }
            for _, g, kk, c, nm, oid, extra in ranked
        ]
    return summary, features


def describe(kind: str, s: dict[str, Any]) -> str:
    """One line on a kind's summary."""
    if not s["count"]:
        return f"no {kind} in OpenStreetMap here"
    if kind == "buildings":
        return f"{s['count']:,} buildings ({s['footprint_m2']:,} m² of footprint)"
    if "length_km" in s:
        top = ", ".join(
            f"{c} {v:.1f} km" for c, v in list(s["km_by_class"].items())[:3]
        )
        return f"{kind}: {s['length_km']:.1f} km" + (f" ({top})" if top else "")
    return f"{kind}: {s['count']}"


async def infrastructure(
    polys: list[list[np.ndarray]], kinds: list[str], list_limit: int = 10
) -> dict[str, Any]:
    """Look up ``kinds`` of infrastructure in an area; summaries and features."""
    bounds = area_bounds(polys)
    w, s, e, n = bounds
    box_km2 = abs(GEOD.polygon_area_perimeter([w, e, e, w], [s, s, n, n])[0]) / 1e6
    too_big = [k for k in kinds if box_km2 > MAX_BOX_KM2.get(k, MAX_BOX_KM2_DEFAULT)]
    if too_big:
        caps = ", ".join(
            f"{k} {MAX_BOX_KM2.get(k, MAX_BOX_KM2_DEFAULT):,.0f}" for k in too_big
        )
        raise ServiceError(
            f"The area's box is {box_km2:,.0f} km², too large for {', '.join(too_big)} "
            f"(at most {caps} km²); use one zone or a smaller area.",
            400,
        )
    data, cached = await FETCHER.request(
        "overpass",
        method="POST",
        data={"data": overpass_query(kinds, bounds)},
        timeout=120.0,
    )
    if isinstance(data, dict) and data.get("remark") and not data.get("elements"):
        raise ServiceError(f"Overpass: {str(data['remark'])[:200]}")
    elements = data.get("elements", []) if isinstance(data, dict) else []
    summary, features = summarize(elements, polys, kinds, list_limit)
    return {
        "kinds": kinds,
        "area_m2": round(area_m2(polys)),
        "summary": summary,
        "features": features,
        "cached": cached,
        "text": "; ".join(describe(k, summary[k]) for k in kinds),
        "attribution": OSM_ATTRIBUTION,
    }


# --- what the ground is at a point --------------------------------------------------

#: Land cover classes and what each means for InSAR (the portal's wording).
LAND_COVER: dict[int, tuple[str, str]] = {
    1: (
        "water",
        "Open water has no usable InSAR signal; an apparent value here is noise or "
        "comes from the shore.",
    ),
    2: (
        "trees",
        "Forest canopy lowers C-band coherence, so noise and unwrapping errors are "
        "more likely.",
    ),
    4: (
        "flooded vegetation",
        "Inundation and changing vegetation bias the phase; treat apparent motion as "
        "a possible surface effect.",
    ),
    5: (
        "crops",
        "Tilling, irrigation and crop growth change the surface each season and can "
        "look like seasonal motion.",
    ),
    7: (
        "built area",
        "Stable scatterers usually give good coherence; motion here is more likely to "
        "be real ground or structure motion.",
    ),
    8: (
        "bare ground",
        "Usually good coherence; mobile surfaces such as dunes or active channels can "
        "still change.",
    ),
    9: (
        "snow or ice",
        "Snow and ice change the signal and break coherence; expect gaps or jumps.",
    ),
    11: (
        "rangeland",
        "Often good coherence in dry seasons; soil moisture and vegetation can add "
        "seasonal signal.",
    ),
}
# Whole words: "sand" is loose sediment, "sandstone" is rock.
SEDIMENT = re.compile(
    r"\b(alluvi\w*|sands?|silts?|clays?|gravels?|unconsolidated|till|loess|peat|fill|sediments?)\b"
)
BEDROCK = re.compile(
    r"\b(grani\w*|grano\w*|diorite|gabbro|gneiss|basalt\w*|andesite\w*|rhyolite\w*|tuff|"
    r"quartzite|schist|slate|marble|limestone|dolomite|dolostone|sandstone|siltstone|"
    r"mudstone|shale|conglomerate|plutonic|metamorphic|igneous|volcanic)\b"
)
ROCK_CAUTION = {
    "unconsolidated sediment": "Compaction from groundwater or oil and gas withdrawal "
    "is plausible here; check wells and the long-term trend.",
    "bedrock": "Bedrock itself is expected to be stable, so a large trend deserves "
    "scrutiny: check slope, mining, the reference point and atmosphere before "
    "calling it ground motion.",
    "unclassified": "The map does not settle whether this is sediment or bedrock.",
}
SOIL_CAUTION = {
    "organic": "Peat can really subside as it drains and oxidises, and it responds to "
    "the water table: a long-term fall here may be genuine ground loss, and seasonal "
    "motion is expected.",
    "expansive": "Expansive clay shrinks and swells with moisture: expect seasonal "
    "motion that follows wet and dry seasons, which is not a long-term trend.",
    "wet": "Poorly drained soil: standing water and changing moisture can bias the "
    "phase and lower coherence.",
}
RECLAIMED_NAMES = re.compile(
    r"\b(fill|fills|filled|landfill|made land|dredged?|spoils?|dumps?"
    r"|udorthents|arents)\b"
)
#: The dominant soil of the SSURGO map unit at a point (USDA Soil Data Access).
SOIL_QUERY = """SELECT mu.muname, a.hydclprs AS hydric, a.drclassdcd AS drainage,
    c.compname, c.taxorder,
    (SELECT MAX(h.lep_r) FROM chorizon h
      WHERE h.cokey = c.cokey AND h.hzdept_r < 150) AS lep,
    (SELECT MAX(h.om_r) FROM chorizon h
      WHERE h.cokey = c.cokey AND h.hzdept_r < 50) AS om
  FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT({lon:.6f} {lat:.6f})') k
  JOIN mapunit mu ON mu.mukey = k.mukey JOIN muaggatt a ON a.mukey = mu.mukey
  JOIN component c ON c.cokey = (SELECT TOP 1 cc.cokey FROM component cc
    WHERE cc.mukey = mu.mukey ORDER BY cc.comppct_r DESC)"""
SCALES = ("large", "medium", "small", "tiny")
COMPASS = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split()


def factor(
    name: str, status: str, finding: str, caution: str | None = None, **extra: Any
) -> dict:
    """One factor of the site's context."""
    return {
        "factor": name,
        "status": status,
        "finding": finding,
        "caution": caution,
        **extra,
    }


def classify_rock(text: str) -> str:
    """'unconsolidated sediment', 'bedrock' or 'unclassified' from a unit's text."""
    t = text.lower()
    if SEDIMENT.search(t):
        return "unconsolidated sediment"
    if BEDROCK.search(t):
        return "bedrock"
    return "unclassified"


def classify_soil(s: dict[str, Any]) -> str | None:
    """'organic', 'expansive', 'wet' or None, from a map unit's dominant soil."""

    def number(key: str) -> float:
        try:
            return float(s.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0

    if s.get("taxorder") == "Histosols" or number("om") >= 20:
        return "organic"
    if s.get("taxorder") == "Vertisols" or number("lep") >= 6:
        return "expansive"
    return "wet" if number("hydric") >= 66 else None


def reclaimed_class(muname: str) -> str | None:
    """Say what a soil map unit's name tells of ground people built up or drained."""
    name = muname.lower()
    if re.match(r"water\b", name):
        return None
    if RECLAIMED_NAMES.search(name):
        return "fill, dredged or made land"
    plain = re.sub(
        r"\b(poorly|well|moderately|somewhat|excessively|very)\s+drained\b", "", name
    )
    if re.search(r"\b(drained|diked)\b", plain):
        if re.search(r"\b(muck|mucky|peat|peaty)\b", name):
            return "drained peat or muck"
        return "drained wetland soil"
    return None


async def _land_cover(lon: float, lat: float) -> dict:
    geometry = json.dumps({"x": lon, "y": lat, "spatialReference": {"wkid": 4326}})
    body, _ = await FETCHER.request(
        "land_cover",
        params={
            "geometry": geometry,
            "geometryType": "esriGeometryPoint",
            "returnGeometry": "false",
            "returnCatalogItems": "false",
            "f": "json",
        },
    )
    value = body.get("value")
    try:
        code = int(float(value))
    except (TypeError, ValueError):
        code = None
    cls = LAND_COVER.get(code) if code is not None else None
    if not cls:
        return factor(
            "land_cover", "no_data", f"No land cover class here (value {value!r})."
        )
    return factor(
        "land_cover",
        "flagged" if code in (1, 4, 5, 9) else "clear",
        f"Land cover: {cls[0]} (Sentinel-2 10 m, Impact Observatory, latest year).",
        cls[1],
        land_cover=cls[0],
    )


def _unit_age(d: dict) -> str:
    t, b = d.get("t_int_name"), d.get("b_int_name")
    interval = str(t or "") if t == b else f"{b or ''}–{t or ''}"
    if d.get("t_int_age") is not None and d.get("b_int_age") is not None:
        interval += f" ({d['t_int_age']}–{d['b_int_age']} Ma)"
    return interval.strip() or "age unknown"


async def _geology(lon: float, lat: float) -> dict:
    body, _ = await FETCHER.request(
        "geology", params={"lat": f"{lat:.5f}", "lng": f"{lon:.5f}"}
    )
    units = (body.get("success") or {}).get("data") or []
    units = sorted(
        units,
        key=lambda d: SCALES.index(d.get("scale")) if d.get("scale") in SCALES else 9,
    )
    u = next((d for d in units if d.get("name") or d.get("strat_name")), None)
    if not u:
        return factor(
            "geology", "no_data", "No mapped geologic unit here (Macrostrat)."
        )
    name = u.get("name") or u.get("strat_name")
    setting = classify_rock(f"{name} {u.get('lith') or ''} {u.get('descrip') or ''}")
    return factor(
        "geology",
        "clear",
        f"{name} ({_unit_age(u)}): {setting} "
        f"(Macrostrat, {u.get('scale') or '?'} scale).",
        ROCK_CAUTION[setting],
        setting=setting,
        unit=name,
        lithology=u.get("lith") or None,
    )


async def _wetlands(lon: float, lat: float) -> dict:
    body, _ = await FETCHER.request(
        "wetlands",
        params={
            "geometry": f"{lon},{lat}",
            "geometryType": "esriGeometryPoint",
            "inSR": "4326",
            "outFields": "WETLAND_TYPE,ATTRIBUTE",
            "returnGeometry": "false",
            "f": "json",
        },
    )
    if "error" in body:
        raise ServiceError(str(body["error"].get("message") or body["error"])[:200])
    features = body.get("features") or []
    if not features:
        return factor(
            "wetlands",
            "clear",
            "Not in a mapped wetland (USFWS NWI covers the US only: outside it, this "
            "says nothing).",
        )
    kind = (features[0].get("attributes") or {}).get("WETLAND_TYPE") or "wetland"
    return factor(
        "wetlands",
        "flagged",
        f"Mapped as {kind} (USFWS NWI).",
        "Inundation and surface changes can bias the phase and break coherence. Be "
        "careful: apparent motion, especially seasonal, may not be ground motion.",
        wetland_type=kind,
    )


async def _soil(lon: float, lat: float) -> dict:
    query = SOIL_QUERY.format(lon=lon, lat=lat)
    body, _ = await FETCHER.request(
        "soils",
        method="POST",
        json_body={"format": "JSON+COLUMNNAME", "query": query},
        timeout=40.0,
    )
    table = (body or {}).get("Table") or []
    s = dict(zip(table[0], table[1], strict=True)) if len(table) > 1 else None
    if not s or s.get("compname") == "Water":
        return factor(
            "soil",
            "no_data",
            "No mapped soil here (USDA SSURGO covers the US; water and some areas "
            "have none).",
        )
    kind = classify_soil(s)
    order = s.get("taxorder") or "order not given"
    props = f"{order}, {s.get('drainage') or 'drainage not given'}"
    finding = f"{s.get('muname')} ({props}; USDA SSURGO, the map unit's dominant soil)."
    reclaimed = reclaimed_class(str(s.get("muname") or ""))
    caution = SOIL_CAUTION[kind] if kind else None
    if reclaimed:
        finding += f" Mapped as {reclaimed}."
        caution = (caution + " " if caution else "") + (
            "Built-up and drained ground can compact and subside for its own reasons, "
            "separately from anything deeper."
        )
    return factor(
        "soil",
        "flagged" if kind or reclaimed else "clear",
        finding,
        caution,
        soil_type=kind or "mineral",
        map_unit=s.get("muname"),
        reclaimed=reclaimed,
    )


def decode_png(data: bytes) -> np.ndarray:
    """Decode an 8-bit, non-interlaced RGB or RGBA PNG (Terrarium tiles) to (h, w, c).

    Without Pillow, which bowser-lite does not have.
    """
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, width = 8, b"", 0
    height = depth = ctype = interlace = 0
    while pos < len(data):
        n = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + n]
        if kind == b"IHDR":
            width = int.from_bytes(chunk[0:4], "big")
            height = int.from_bytes(chunk[4:8], "big")
            depth, ctype, interlace = chunk[8], chunk[9], chunk[12]
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
        pos += 12 + n
    channels = {2: 3, 6: 4}.get(ctype)
    if depth != 8 or channels is None or interlace:
        raise ValueError("only 8-bit RGB or RGBA PNGs without interlacing")
    raw = np.frombuffer(zlib.decompress(idat), np.uint8)
    stride = width * channels
    rows = raw.reshape(height, stride + 1)
    out = np.zeros((height, stride), np.int32)
    prev = np.zeros(stride, np.int32)
    for r in range(height):
        f = rows[r, 0]
        line = rows[r, 1:].astype(np.int32)
        if f == 0:
            cur = line
        elif f == 1:  # Sub: running sums per channel
            cur = line.reshape(width, channels).cumsum(axis=0).reshape(-1) % 256
        elif f == 2:  # Up
            cur = (line + prev) % 256
        else:
            cur = np.zeros(stride, np.int32)
            for i in range(stride):
                a = cur[i - channels] if i >= channels else 0
                b = prev[i]
                if f == 3:  # Average
                    cur[i] = (line[i] + (a + b) // 2) % 256
                else:  # Paeth
                    c = prev[i - channels] if i >= channels else 0
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                    cur[i] = (line[i] + pred) % 256
        out[r] = cur
        prev = cur
    return out.reshape(height, width, channels).astype(np.uint8)


def horn_slope_aspect(z: np.ndarray, dx: float, dy: float) -> tuple[float, float]:
    """Return the slope and aspect of the centre of a 3x3 elevation window.

    Rows run north to south; Horn's method. Slope in degrees, aspect in degrees
    from north, the way the slope faces.
    """
    (a, b, c), (d, _e, f), (g, h, i) = z
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)
    dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy)
    slope = math.degrees(math.atan(math.hypot(dzdx, dzdy)))
    aspect = (
        (math.degrees(math.atan2(-dzdx, -dzdy)) + 360) % 360
        if (dzdx or dzdy)
        else float("nan")
    )
    return slope, aspect


async def _terrain(lon: float, lat: float, z: int = 13) -> dict:
    n = 2**z
    fx = (lon + 180) / 360 * n * 256
    rad = math.radians(lat)
    fy = (1 - math.log(math.tan(rad) + 1 / math.cos(rad)) / math.pi) / 2 * n * 256
    px, py = int(fx), int(fy)
    tiles: dict[tuple[int, int], np.ndarray] = {}
    win = np.zeros((3, 3))
    for j, dyy in enumerate((-1, 0, 1)):
        for i, dxx in enumerate((-1, 0, 1)):
            gx, gy = px + dxx, py + dyy
            key = (gx // 256, gy // 256)
            if key not in tiles:
                png, _ = await FETCHER.request(
                    "terrain", fill={"z": z, "x": key[0], "y": key[1]}, binary=True
                )
                tiles[key] = decode_png(png)
            r, g, b = tiles[key][gy % 256, gx % 256, :3].astype(float)
            win[j, i] = r * 256 + g + b / 256 - 32768
    cell = 156543.03392 * math.cos(rad) / n
    slope, aspect = horn_slope_aspect(win, cell, cell)
    elev = float(win[1, 1])
    extra: dict[str, Any] = {
        "elevation_m": round(elev, 1),
        "slope_deg": round(slope, 1),
        "cell_m": round(cell, 1),
    }
    if slope >= 2 and math.isfinite(aspect):
        extra["aspect_deg"] = round(aspect)
        extra["aspect"] = COMPASS[int((aspect + 11.25) // 22.5) % 16]
    else:
        extra["aspect"] = "flat"
    steep = slope >= 10
    finding = (
        f"Elevation {elev:,.0f} m, slope {slope:.1f}°"
        + (f" facing {extra['aspect']}" if extra["aspect"] != "flat" else ", flat")
        + f" (terrain tiles, ~{cell:.0f} m cells)."
    )
    caution = (
        "On a slope this steep, downslope creep or landsliding can show as motion "
        "in the measurement; the share seen depends on the slope's facing and "
        "the direction the values measure."
        if steep
        else None
    )
    return factor("terrain", "flagged" if steep else "clear", finding, caution, **extra)


#: The factors of ``GET /site_context``, in order.
SITE_FACTORS: list[tuple[str, str, Callable[[float, float], Awaitable[dict]]]] = [
    ("land_cover", "land_cover", _land_cover),
    ("geology", "geology", _geology),
    ("wetlands", "wetlands", _wetlands),
    ("soil", "soils", _soil),
    ("terrain", "terrain", _terrain),
]


async def _one(name: str, service: str, fn, lon: float, lat: float) -> dict:
    s = SERVICES[service]
    if not s.endpoints():
        return factor(
            name,
            "off",
            f"Could not be looked up: {s.label} is turned off on this server.",
        )
    try:
        out = await fn(lon, lat)
    except (
        ServiceError,
        httpx.HTTPError,
        KeyError,
        ValueError,
        TypeError,
        IndexError,
    ) as e:
        why = str(e)[:200] or type(e).__name__
        if not why.startswith(s.label):
            why = f"{s.label}: {why}"
        return factor(
            name, "unavailable", f"Could not be looked up ({why.rstrip('.')})."
        )
    out["source"] = s.attribution
    return out


async def site_context(lon: float, lat: float) -> dict[str, Any]:
    """Look up what is on the ground at a point; each factor on its own."""
    factors = await asyncio.gather(
        *(_one(name, service, fn, lon, lat) for name, service, fn in SITE_FACTORS)
    )
    flagged = [f["factor"] for f in factors if f["status"] == "flagged"]
    missing = [f["factor"] for f in factors if f["status"] in ("unavailable", "off")]
    text = f"Flagged: {', '.join(flagged) or 'nothing'}"
    if missing:
        text += f"; could not be looked up: {', '.join(missing)}"
    return {"lon": lon, "lat": lat, "factors": list(factors), "summary": text}


# --- the routes ---------------------------------------------------------------------

router = APIRouter()


class InfrastructureBody(BaseModel):
    """``POST /infrastructure``: an area (one of the ways to give it) and kinds."""

    model_config = ConfigDict(extra="forbid")

    geometry: dict[str, Any] | None = Field(
        None, description="GeoJSON Polygon or MultiPolygon (or a Feature), lon/lat."
    )
    bbox: list[float] | None = Field(
        None, min_length=4, max_length=4, description="[west, south, east, north]."
    )
    point: list[float] | None = Field(
        None, min_length=2, max_length=2, description="[lon, lat]; with radius_m."
    )
    radius_m: float = Field(500.0, gt=0, le=5000, description="Circle around point.")
    zone: str | None = Field(
        None,
        max_length=80,
        description='A deformation zone: "Z1" (of the latest zones) or '
        '"<zones id>/Z1".',
    )
    kinds: list[Kind] = Field(
        default_factory=lambda: list(DEFAULT_KINDS),
        min_length=1,
        description="What to look up.",
    )
    list_limit: int = Field(
        10, ge=0, le=100, description="Named features listed per kind."
    )


def area_from(
    body: InfrastructureBody,
) -> tuple[list[list[np.ndarray]], str, str | None]:
    """Return a request's area, how it was given, and the zones id for a zone."""
    given = [
        k for k in ("geometry", "bbox", "point", "zone") if getattr(body, k) is not None
    ]
    if len(given) != 1:
        raise ServiceError(
            "Give one of geometry, bbox, point (with radius_m) or zone.", 400
        )
    if body.zone is not None:
        feature, rid = zone_feature(body.zone)
        return polygons_of(feature["geometry"]), f"zone {feature['id']} of {rid}", rid
    if body.point is not None:
        lon, lat = body.point
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ServiceError("point is [lon, lat] in degrees.", 400)
        return (
            polygons_of(circle(lon, lat, body.radius_m)),
            f"{body.radius_m:g} m around ({lon}, {lat})",
            None,
        )
    if body.bbox is not None:
        return polygons_of(bbox_polygon(body.bbox)), f"bbox {body.bbox}", None
    return polygons_of(body.geometry or {}), "the polygon given", None


@router.post(
    "/infrastructure",
    responses={200: {"model": api.InfrastructureAnswer}},
    **api.route_doc("POST /infrastructure"),
)
async def post_infrastructure(
    body: InfrastructureBody = Body(...), settings: Any = Depends(get_settings)
):
    """OpenStreetMap infrastructure in an area: summaries, and features to draw."""
    _require_enabled(settings)
    try:
        polys, where, zones_id = area_from(body)
        kinds: list[str] = [str(k) for k in dict.fromkeys(body.kinds)]
        found = await infrastructure(polys, kinds, body.list_limit)
    except ServiceError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
    features = [f for k in kinds for f in found["features"][k]]
    rid = RESULTS.put(
        "infrastructure",
        {
            "features": {"type": "FeatureCollection", "features": features},
            "where": where,
            "kinds": kinds,
        },
    )
    return {
        "where": where,
        "kinds": kinds,
        "area_m2": found["area_m2"],
        "summary": found["summary"],
        "text": found["text"],
        "result_id": rid,
        "n_features": len(features),
        "zones_id": zones_id,
        "cached": found["cached"],
        "attribution": found["attribution"],
        "note": "OpenStreetMap: completeness varies by place; no feature here is not "
        "the same as nothing there. Lines are clipped to the area; buildings count "
        "when their centre is inside.",
    }


@router.get(
    "/site_context",
    responses={200: {"model": api.SiteContextAnswer}},
    **api.route_doc("GET /site_context"),
)
async def get_site_context(
    lon: float = Query(..., ge=-180, le=180, description="WGS84 longitude."),
    lat: float = Query(..., ge=-90, le=90, description="WGS84 latitude."),
    settings: Any = Depends(get_settings),
):
    """Say what is on the ground at a point (land cover, geology, soil, terrain...)."""
    _require_enabled(settings)
    return await site_context(lon, lat)


@router.get(
    "/context/results/{result_id}",
    responses={200: {"model": api.ContextResult}},
    **api.route_doc("GET /context/results/{result_id}"),
)
async def get_result(
    result_id: str = PathParam(
        ..., pattern=r"^[a-z]{1,4}-[A-Za-z0-9_-]{4,16}$", description="The result's id."
    ),
    settings: Any = Depends(get_settings),
):
    """Return a result kept for the page: infrastructure or zones to draw."""
    _require_enabled(settings)
    item = RESULTS.get(result_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"No result {result_id!r}.")
    return {"id": result_id, "kind": item["kind"], "features": item["features"]}


__all__ = [
    "FETCHER",
    "RESULTS",
    "SERVICES",
    "Fetcher",
    "ResultStore",
    "Service",
    "ServiceError",
    "router",
]
