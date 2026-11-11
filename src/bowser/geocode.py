"""Place names and addresses to coordinates, for the map tools (``GET /geocode``).

Uses OpenStreetMap's Nominatim (https://nominatim.org) by default, following its
usage policy (https://operations.osmfoundation.org/policies/nominatim/):

- at most one request per second from this server, for all users together;
- a User-Agent that names the application and where to find it, never a
  person's address;
- results are cached, so a repeated query is not sent again;
- the results carry OpenStreetMap's attribution.

An administrator can point Bowser at another Nominatim-compatible service (their
own instance, for heavy use) with ``BOWSER_GEOCODER_URL``, or turn geocoding off
with ``BOWSER_GEOCODER_URL=off``. The variable is read on each request.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections import OrderedDict
from typing import Any

import httpx

#: Nominatim's search endpoint.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
#: The variable that replaces (or, set to "off", disables) the geocoder.
ENV = "BOWSER_GEOCODER_URL"
ATTRIBUTION = (
    "Data © OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)"
)
#: Longest query sent on.
MAX_QUERY = 200
#: Most results asked for.
MAX_LIMIT = 10


class GeocodeError(RuntimeError):
    """A failure with a message for the user; ``status`` is the HTTP status to send."""

    def __init__(self, message: str, status: int = 502) -> None:
        """Keep the message and the HTTP status."""
        super().__init__(message)
        self.status = status


def user_agent() -> str:
    """Return the User-Agent: the application, its version and its home page."""
    try:
        from importlib.metadata import version  # noqa: PLC0415

        v = version("bowser-insar").split("+")[0]
    except Exception:  # noqa: BLE001  (not installed: a source checkout)
        v = "dev"
    return f"bowser-insar/{v} (+https://github.com/opera-adt/bowser)"


def endpoint() -> str | None:
    """Return the search URL in use, or None when geocoding is off."""
    url = os.environ.get(ENV, "").strip()
    if url.lower() in ("off", "none", "false", "0"):
        return None
    return url or NOMINATIM_URL


def normalize(query: str) -> str:
    """Return ``query`` with its whitespace collapsed (the cache key)."""
    return " ".join(query.split())[:MAX_QUERY]


def parse(places: Any) -> list[dict[str, Any]]:
    """Turn Nominatim's ``jsonv2`` answer into candidates.

    Each has a ``name``, ``lon``, ``lat``, ``bbox`` as ``[west, south, east,
    north]`` (None when the place has none) and its ``kind`` (e.g. ``dam``,
    ``city``).
    """
    out = []
    for p in places if isinstance(places, list) else []:
        try:
            lon, lat = float(p["lon"]), float(p["lat"])
        except (KeyError, TypeError, ValueError):
            continue
        bbox = None
        box = p.get("boundingbox")
        if isinstance(box, list) and len(box) == 4:
            try:
                south, north, west, east = (float(v) for v in box)
                bbox = [west, south, east, north]
            except (TypeError, ValueError):
                bbox = None
        out.append(
            {
                "name": str(p.get("display_name") or p.get("name") or ""),
                "lon": lon,
                "lat": lat,
                "bbox": bbox,
                "kind": p.get("type") or p.get("addresstype"),
                "category": p.get("category") or p.get("class"),
            }
        )
    return out


class Geocoder:
    """Nominatim searches, one per ``interval`` seconds at most, cached.

    The spacing holds across event loops and threads: each request reserves
    the next free slot under a lock, then waits for it.
    """

    def __init__(
        self,
        interval: float = 1.0,
        cache_size: int = 512,
        ttl: float = 24 * 3600.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Set the spacing, the cache's size and age, and the transport."""
        self.interval = interval
        self.cache_size = cache_size
        self.ttl = ttl
        #: HTTP transport (tests give a mock; None is the network).
        self.transport = transport
        self._cache: OrderedDict[
            tuple[str, str, int], tuple[float, list]
        ] = OrderedDict()
        self._lock = threading.Lock()
        self._next = 0.0
        #: Monotonic times the requests were sent (tests read the spacing).
        self.sent: list[float] = []

    def _cached(self, key: tuple[str, str, int]) -> list | None:
        with self._lock:
            hit = self._cache.get(key)
            if hit is None:
                return None
            if time.monotonic() - hit[0] > self.ttl:
                del self._cache[key]
                return None
            self._cache.move_to_end(key)
            return hit[1]

    def _store(self, key: tuple[str, str, int], value: list) -> None:
        with self._lock:
            self._cache[key] = (time.monotonic(), value)
            self._cache.move_to_end(key)
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)

    async def _slot(self) -> None:
        """Wait for this request's turn: ``interval`` after the previous one."""
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next)
            self._next = at + self.interval
        if at > now:
            await asyncio.sleep(at - now)

    async def search(self, query: str, limit: int = 5) -> tuple[list[dict], bool]:
        """Return ``(candidates, cached)`` for ``query``, best first.

        Raises
        ------
        GeocodeError
            Geocoding is off, the query is empty, or the service failed.

        """
        url = endpoint()
        if url is None:
            raise GeocodeError("Geocoding is off on this server.", 503)
        q = normalize(query)
        if not q:
            raise GeocodeError("Give a place name or an address.", 400)
        limit = max(1, min(MAX_LIMIT, int(limit)))
        key = (url, q.casefold(), limit)
        hit = self._cached(key)
        if hit is not None:
            return hit, True
        await self._slot()
        self.sent.append(time.monotonic())
        try:
            async with httpx.AsyncClient(
                transport=self.transport, timeout=20.0, trust_env=True
            ) as http:
                r = await http.get(
                    url,
                    params={"q": q, "format": "jsonv2", "limit": limit},
                    headers={"User-Agent": user_agent(), "Accept": "application/json"},
                )
        except httpx.HTTPError as e:
            raise GeocodeError(
                f"The geocoder could not be reached ({type(e).__name__})."
            ) from e
        if r.status_code != 200:
            raise GeocodeError(f"The geocoder answered HTTP {r.status_code}.")
        try:
            places = parse(r.json())
        except ValueError as e:
            raise GeocodeError("The geocoder sent an answer that is not JSON.") from e
        self._store(key, places)
        return places, False


#: The server's geocoder (one, so the one-per-second limit is for the whole server).
GEOCODER = Geocoder()
