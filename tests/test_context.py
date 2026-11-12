"""The AI tools' context: deformation zones, OSM infrastructure, site context.

- ``bowser.zones`` finds planted zones on a synthetic velocity layer: 4-connected
  areas split by sign, areas and rates, outlines with holes, the same with and
  without scipy; full == lite is checked on the real apps in test_api_schema.py;
- the outside services (Overpass, land cover, Macrostrat, NWI, SDA, terrain tiles)
  are reached only through a mock transport: Bowser's User-Agent (never an
  email), one request per interval per service and one Overpass at a time, a
  cache, an environment variable to move or turn off each service, mirrors
  tried on a busy answer;
- Overpass answers are parsed into per-kind summaries, lines clipped to the area;
- ``GET /site_context`` with the services up, down and off;
- the tools: MCP and the Assistant offer the same specs, with the right flags;
  through ``bowser mcp`` and the page channel, "which roads are in the area moving
  faster than 5 mm/yr" runs deformation_zones -> infrastructure_in_area ->
  highlight_infrastructure, and a fake page receives the drawings.

Nothing here imports bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import asyncio
import json
import math
import socket
import threading
import time
import zlib
from types import SimpleNamespace
from urllib.parse import parse_qs

import numpy as np
import pytest

httpx = pytest.importorskip("httpx")
pytest.importorskip("fastapi")
xr = pytest.importorskip("xarray")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import SecretStr  # noqa: E402
from pyproj import CRS, Transformer  # noqa: E402

from bowser import context, zones  # noqa: E402
from bowser.assistant import page, relay  # noqa: E402

UTM = CRS.from_epsg(32615)
TO_XY = Transformer.from_crs("EPSG:4326", UTM, always_xy=True)
TO_LL = Transformer.from_crs(UTM, "EPSG:4326", always_xy=True)
X0, Y0, DX = 760_000.0, 3_850_000.0, 30.0
NY, NX = 60, 80


# --- a synthetic cube with planted zones -------------------------------------------


def planted():
    """Velocity (m/yr) with planted zones, a quiet background and a nodata corner.

    - A: a 10 x 10 square at -20 mm/yr (subsiding);
    - B: an L of +15 mm/yr;
    - C, D: two 3 x 3 squares at -12 mm/yr touching only at a corner (two zones);
    - E: a ring at -8 mm/yr around a 4 x 4 hole of 0;
    - noise of +-2 mm/yr everywhere else, and NaN in one corner.
    """
    rng = np.random.default_rng(1)
    v = rng.uniform(-2, 2, (NY, NX))
    v[10:20, 10:20] = -20  # A
    v[30:45, 10:13] = 15  # B (vertical)
    v[42:45, 10:25] = 15  # B (foot)
    v[5:8, 40:43] = -12  # C
    v[8:11, 43:46] = -12  # D, diagonal to C
    v[30:40, 50:60] = -8  # E
    v[33:37, 53:57] = 0  # E's hole
    v[:3, -3:] = np.nan
    x = X0 + DX * (np.arange(NX) + 0.5)
    y = Y0 - DX * (np.arange(NY) + 0.5)
    t = np.datetime64("2020-01-01") + np.arange(6) * np.timedelta64(73, "D")
    years = (np.arange(6) * 73) / 365.25
    disp = (v[None] / 1000) * years[:, None, None]
    coh = np.full((NY, NX), 0.9)
    coh[30:40, 50:60] = 0.3  # E is incoherent
    return xr.Dataset(
        {
            "velocity": (("y", "x"), (v / 1000).astype("float32"), {"units": "m/yr"}),
            "displacement": (
                ("time", "y", "x"),
                disp.astype("float32"),
                {"units": "m"},
            ),
            "median_temporal_coherence": (("y", "x"), coh.astype("float32")),
        },
        coords={"x": x, "y": y, "time": t},
    )


def ll(row: float, col: float) -> tuple[float, float]:
    """lon/lat of a cell centre."""
    return TO_LL.transform(X0 + DX * (col + 0.5), Y0 - DX * (row + 0.5))


def test_planted_zones_are_found_with_their_areas_and_rates():
    out = zones.deformation_zones(planted(), TO_XY, 5.0)
    feats = {f["id"]: f["properties"] for f in out["zones"]["features"]}
    assert out["n_zones"] == 5 and out["source"] == "the velocity layer 'velocity'"
    assert out["unit"] == "mm/yr" and out["cell_m"] == 30.0
    sizes = sorted(p["n_cells"] for p in feats.values())
    assert sizes == [9, 9, 81, 84, 100]
    a = next(p for p in feats.values() if p["n_cells"] == 100)
    assert a["direction"] == "negative"
    assert a["mean_rate"] == pytest.approx(-20, abs=1e-3)
    assert a["peak_rate"] == pytest.approx(-20, abs=1e-3)
    assert a["area_m2"] == 100 * 900
    lon, lat = ll(14.5, 14.5)
    assert a["centroid"] == pytest.approx([lon, lat], abs=1e-5)
    assert feats["Z1"]["n_cells"] == 100  # the largest is Z1
    b = next(p for p in feats.values() if p["direction"] == "positive")
    assert b["n_cells"] == 81 and b["mean_rate"] == pytest.approx(15, abs=1e-3)


def test_corners_do_not_join_zones_and_holes_are_kept():
    out = zones.deformation_zones(planted(), TO_XY, 5.0)
    feats = out["zones"]["features"]
    small = [f for f in feats if f["properties"]["n_cells"] == 9]
    assert len(small) == 2  # C and D touch only at a corner: 4-connected, two zones
    ring = next(f for f in feats if f["properties"]["n_cells"] == 84)
    coords = ring["geometry"]["coordinates"]
    assert len(coords) == 2  # outer ring and the hole
    # GeoJSON: outer counter-clockwise, hole clockwise, rings closed.
    for j, r in enumerate(coords):
        r = np.asarray(r)
        assert (r[0] == r[-1]).all()
        signed = 0.5 * np.sum(r[:-1, 0] * r[1:, 1] - r[1:, 0] * r[:-1, 1])
        assert (signed > 0) == (j == 0)
    # The outline is the zone's: its area is the cells' area.
    polys = context.polygons_of(ring["geometry"])
    assert context.area_m2(polys) == pytest.approx(84 * 900, rel=0.01)
    a = next(f for f in feats if f["properties"]["n_cells"] == 100)
    assert context.area_m2(context.polygons_of(a["geometry"])) == pytest.approx(
        90_000, rel=0.01
    )
    assert len(a["geometry"]["coordinates"][0]) == 5  # a square: 4 corners + closing


def test_an_outline_touching_itself_at_a_corner_is_one_ring():
    """A gap that meets the outside only at a corner is not a hole (4-connected
    cells, 8-connected gaps): one ring, whose area is the cells'."""
    cells = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 0]], bool)
    rings = zones.trace_rings(cells)
    assert len(rings) == 1
    assert abs(zones._signed_area(rings[0])) == 7


@pytest.mark.parametrize("max_cells", [zones.MAX_CELLS, 1200, 300])
def test_layers_are_read_in_bands_with_the_same_result(monkeypatch, max_cells):
    """A DISP-S1 stack is tens of GB: only a band of rows is in memory at a time."""
    monkeypatch.setattr(zones, "MAX_CELLS", max_cells)  # blocks of 1, 2 and 4 cells
    ds = planted()
    # A coherence per date too, so the median over dates is read in bands as well.
    coh = ds["median_temporal_coherence"].expand_dims(time=ds.time).copy()
    coh[1, 30:40, 50:60] = np.nan
    per_date = ds.drop_vars("median_temporal_coherence").assign(temporal_coherence=coh)
    cases = [
        (ds, {}),
        (ds, {"coherence_min": 0.5}),
        (ds.drop_vars("velocity"), {}),
        (per_date, {"coherence_min": 0.5}),
        (ds, {"bbox": (*ll(50, 5), *ll(3, 70))}),
    ]
    whole = [zones.deformation_zones(d, TO_XY, 5.0, **kw) for d, kw in cases]
    assert whole[0]["n_zones"] > 0

    rows_read = []
    block_mean = zones._block_mean

    band = 8 * NX * 6 * 3  # 3 rows of the 6 dates, or 18 of a 2-D layer

    def spy(a, k):
        rows_read.append((a.shape[-2], max(k, band // (8 * a.shape[-1]))))
        return block_mean(a, k)

    monkeypatch.setattr(zones, "_block_mean", spy)
    monkeypatch.setattr(zones, "BAND_BYTES", band)
    banded = [zones.deformation_zones(d, TO_XY, 5.0, **kw) for d, kw in cases]
    assert banded == whole
    # Never more rows at once than fit the band (at least one block), in many bands.
    assert all(rows <= most for rows, most in rows_read), rows_read
    assert len(rows_read) > 5 * len(cases)


def test_options_sign_area_bbox_quality_reference_and_fitted_rate():
    ds = planted()
    neg = zones.deformation_zones(ds, TO_XY, 5.0, sign="negative")
    assert {f["properties"]["direction"] for f in neg["zones"]["features"]} == {
        "negative"
    }
    big = zones.deformation_zones(ds, TO_XY, 5.0, min_area_m2=20_000)
    assert big["n_zones"] == 3 and big["n_found"] == 5
    top = zones.deformation_zones(ds, TO_XY, 5.0, max_zones=2)
    assert top["n_zones"] == 2 and top["truncated"]
    # A box around A only.
    w, s = ll(22, 8)
    e, n = ll(8, 22)
    boxed = zones.deformation_zones(ds, TO_XY, 5.0, bbox=(w, s, e, n))
    assert [f["properties"]["n_cells"] for f in boxed["zones"]["features"]] == [100]
    # E is incoherent: coherence_min leaves it out.
    coh = zones.deformation_zones(ds, TO_XY, 5.0, coherence_min=0.5)
    assert 84 not in [f["properties"]["n_cells"] for f in coh["zones"]["features"]]
    assert coh["quality_mask"] == {"layer": "median_temporal_coherence", "min": 0.5}
    # Relative to a point in A: A becomes 0, the background +20.
    ref = zones.deformation_zones(ds, TO_XY, 25.0, ref_lonlat=ll(15, 15))
    assert ref["reference"]["rate_subtracted"] == pytest.approx(-20, abs=1e-3)
    assert ref["n_zones"] == 1  # B at +35
    # Without a velocity layer, a rate is fitted to the displacement.
    fitted = zones.deformation_zones(ds.drop_vars("velocity"), TO_XY, 5.0)
    assert fitted["source"].startswith("a straight line fitted to 'displacement'")
    assert sorted(f["properties"]["n_cells"] for f in fitted["zones"]["features"]) == [
        9,
        9,
        81,
        84,
        100,
    ]
    with pytest.raises(zones.ZonesError, match="does not overlap"):
        zones.deformation_zones(ds, TO_XY, 5.0, bbox=(0, 0, 1, 1))


def test_without_scipy_the_zones_are_the_same(monkeypatch):
    pytest.importorskip("scipy")
    ds = planted()
    with_scipy = zones.deformation_zones(ds, TO_XY, 5.0)
    monkeypatch.setattr(zones, "label", zones.label_numpy)
    assert zones.deformation_zones(ds, TO_XY, 5.0) == with_scipy
    from scipy import ndimage

    rng = np.random.default_rng(3)
    m = rng.random((120, 90)) > 0.55
    a, na = zones.label_numpy(m)
    b, nb = ndimage.label(m)
    assert na == nb and (a == b).all()


# --- the outside services ------------------------------------------------------------


class Services:
    """A mock of every outside service, recording the requests."""

    def __init__(self) -> None:
        self.requests: list = []
        self.down: set[str] = set()
        self.busy: set[str] = set()
        self.elements: list[dict] = []

    def handler(self, request):
        self.requests.append(request)
        host = request.url.host
        for d in self.down:
            if d in host:
                raise httpx.ConnectError("down", request=request)
        for b in self.busy:
            if b in host:
                return httpx.Response(429, text="rate_limited")
        if "overpass" in host:
            return httpx.Response(200, json={"elements": self.elements})
        if "imagery1.arcgis.com" in host:
            return httpx.Response(200, json={"value": "5"})
        if "macrostrat" in host:
            return httpx.Response(
                200,
                json={
                    "success": {
                        "data": [
                            {
                                "name": "Alluvium",
                                "lith": "silt, clay",
                                "scale": "large",
                                "t_int_name": "Holocene",
                                "b_int_name": "Holocene",
                            },
                        ]
                    }
                },
            )
        if "fwspublicservices" in host:
            return httpx.Response(
                200,
                json={
                    "features": [
                        {"attributes": {"WETLAND_TYPE": "Freshwater Emergent Wetland"}}
                    ]
                },
            )
        if "sdmdataaccess" in host:
            table = [
                ["muname", "hydric", "drainage", "compname", "taxorder", "lep", "om"],
                [
                    "Sharkey clay, 0 to 1 percent slopes",
                    "95",
                    "Poorly drained",
                    "Sharkey",
                    "Vertisols",
                    "7.5",
                    "2",
                ],
            ]
            return httpx.Response(200, json={"Table": table})
        if "elevation-tiles-prod" in str(request.url):
            x = int(request.url.path.split("/")[-2])
            return httpx.Response(200, content=terrarium_tile(x))
        return httpx.Response(404)


def png_rgb(rgb: np.ndarray, filters: list[int] | None = None) -> bytes:
    """Encode an RGB uint8 image as a PNG with the given filter per row."""
    h, w, _ = rgb.shape
    raw = b""
    prev = np.zeros(w * 3, np.int32)
    for r in range(h):
        line = rgb[r].reshape(-1).astype(np.int32)
        f = (filters or [0])[r % len(filters or [0])]
        if f == 0:
            out = line
        elif f == 1:
            left = np.concatenate([np.zeros(3, np.int32), line[:-3]])
            out = (line - left) % 256
        elif f == 2:
            out = (line - prev) % 256
        elif f == 3:
            left = np.concatenate([np.zeros(3, np.int32), line[:-3]])
            out = (line - (left + prev) // 2) % 256
        else:
            left = np.concatenate([np.zeros(3, np.int32), line[:-3]])
            ul = np.concatenate([np.zeros(3, np.int32), prev[:-3]])
            p = left + prev - ul
            pa, pb, pc = abs(p - left), abs(p - prev), abs(p - ul)
            pred = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, prev, ul))
            out = (line - pred) % 256
        raw += bytes([f]) + out.astype(np.uint8).tobytes()
        prev = line

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            len(data).to_bytes(4, "big")
            + kind
            + data
            + zlib.crc32(kind + data).to_bytes(4, "big")
        )

    ihdr = w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def terrarium_tile(x: int) -> bytes:
    """Tile column ``x`` of a plane rising 1 m per pixel to the east (Terrarium)."""
    col = np.arange(256)[None, :].repeat(256, 0)
    elev = 100.0 + (x % 100) * 256 + col  # metres, continuous across tiles
    v = elev + 32768
    rgb = np.stack([v // 256, v % 256, np.zeros_like(v)], axis=-1).astype(np.uint8)
    return png_rgb(rgb, [0, 1, 2, 3, 4])


@pytest.fixture
def services(monkeypatch):
    """The mock services behind the server's fetcher, with fresh state and policy."""
    mock = Services()
    monkeypatch.setattr(context.FETCHER, "transport", httpx.MockTransport(mock.handler))
    context.FETCHER.clear()
    context.RESULTS.clear()
    for name in list(context.SERVICES):
        monkeypatch.delenv(context.SERVICES[name].env, raising=False)
    monkeypatch.delenv(context.ENV_ALL, raising=False)
    yield mock
    context.FETCHER.clear()
    context.RESULTS.clear()


def test_png_decoder_reads_every_filter():
    rng = np.random.default_rng(0)
    img = rng.integers(0, 256, (7, 9, 3), dtype=np.uint8)
    assert (context.decode_png(png_rgb(img, [0, 1, 2, 3, 4])) == img).all()
    pil = pytest.importorskip("PIL.Image")
    import io

    buf = io.BytesIO()
    pil.fromarray(img).save(buf, format="PNG")
    assert (context.decode_png(buf.getvalue()) == img).all()


def test_requests_name_bowser_are_spaced_cached_and_can_be_moved(services, monkeypatch):
    monkeypatch.setattr(context.SERVICES["overpass"], "interval", 0.25)

    async def run():
        f = context.FETCHER
        await asyncio.gather(
            f.request("overpass", method="POST", data={"data": "a"}),
            f.request("overpass", method="POST", data={"data": "b"}),
            f.request("overpass", method="POST", data={"data": "c"}),
        )
        again, cached = await f.request("overpass", method="POST", data={"data": "a"})
        return cached

    assert asyncio.run(run()) is True
    sent = [t for name, t, _ in context.FETCHER.sent if name == "overpass"]
    assert len(sent) == 3  # the repeat came from the cache
    gaps = np.diff(sorted(sent))
    assert (gaps >= 0.24).all(), gaps
    for r in services.requests:
        ua = r.headers["user-agent"]
        assert ua.startswith("bowser-insar/") and "github.com/opera-adt/bowser" in ua
        assert "@" not in ua
        assert r.url.host == "overpass-api.de"
    # Another endpoint, from the variable (read on each request).
    monkeypatch.setenv(
        "BOWSER_OVERPASS_URL", "https://overpass.example.org/api/interpreter"
    )
    asyncio.run(context.FETCHER.request("overpass", method="POST", data={"data": "a"}))
    assert services.requests[-1].url.host == "overpass.example.org"
    # Off: no request at all.
    n = len(services.requests)
    monkeypatch.setenv("BOWSER_OVERPASS_URL", "off")
    with pytest.raises(context.ServiceError, match="turned off") as e:
        asyncio.run(
            context.FETCHER.request("overpass", method="POST", data={"data": "x"})
        )
    assert e.value.status == 503
    monkeypatch.delenv("BOWSER_OVERPASS_URL")
    monkeypatch.setenv("BOWSER_CONTEXT_SERVICES", "off")
    with pytest.raises(context.ServiceError, match="turned off"):
        asyncio.run(context.FETCHER.request("geology", params={"lat": 1}))
    assert len(services.requests) == n


@pytest.mark.usefixtures("services")
def test_one_overpass_at_a_time(monkeypatch):
    monkeypatch.setattr(context.SERVICES["overpass"], "interval", 0.0)
    inflight = {"now": 0, "max": 0}

    async def slow(_request):
        inflight["now"] += 1
        inflight["max"] = max(inflight["max"], inflight["now"])
        await asyncio.sleep(0.1)
        inflight["now"] -= 1
        return httpx.Response(200, json={"elements": []})

    class Slow(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            return await slow(request)

    monkeypatch.setattr(context.FETCHER, "transport", Slow())

    async def run():
        await asyncio.gather(
            *(
                context.FETCHER.request(
                    "overpass", method="POST", data={"data": str(i)}
                )
                for i in range(4)
            )
        )

    asyncio.run(run())
    assert inflight["max"] == 1


def test_a_busy_service_tries_the_mirror_then_says_so(services, monkeypatch):
    monkeypatch.setattr(context.SERVICES["overpass"], "interval", 0.0)
    services.busy = {"overpass-api.de"}
    data, _ = asyncio.run(
        context.FETCHER.request("overpass", method="POST", data={"data": "q"})
    )
    assert [r.url.host for r in services.requests] == [
        "overpass-api.de",
        "overpass.private.coffee",
    ]
    services.busy = {"overpass"}
    with pytest.raises(context.ServiceError, match="is busy"):
        asyncio.run(
            context.FETCHER.request("overpass", method="POST", data={"data": "other"})
        )


# --- OpenStreetMap infrastructure -------------------------------------------------


def way(oid, tags, pts):
    return {
        "type": "way",
        "id": oid,
        "tags": tags,
        "geometry": [{"lon": a, "lat": b} for a, b in pts],
    }


def square(lon, lat, half):
    return [
        (lon - half, lat - half),
        (lon + half, lat - half),
        (lon + half, lat + half),
        (lon - half, lat + half),
        (lon - half, lat - half),
    ]


AREA_BBOX = [-90.10, 34.70, -90.00, 34.80]


def osm_elements():
    """Features around AREA_BBOX: crossing, inside and outside it."""
    return [
        # A primary road crossing the area west to east at 34.75: 0.1° inside.
        way(
            1,
            {"highway": "primary", "ref": "MS 301"},
            [(-90.15, 34.75), (-89.95, 34.75)],
        ),
        # A residential street wholly inside.
        way(
            2,
            {"highway": "residential", "name": "Dam Rd"},
            [(-90.05, 34.72), (-90.05, 34.74)],
        ),
        # A road wholly outside.
        way(3, {"highway": "primary"}, [(-90.3, 34.9), (-90.2, 34.9)]),
        # A footway (not a road class counted).
        way(4, {"highway": "footway"}, [(-90.05, 34.71), (-90.04, 34.71)]),
        # Buildings: centre inside, centre outside.
        way(
            5, {"building": "house", "name": "Gatehouse"}, square(-90.05, 34.76, 0.0002)
        ),
        way(6, {"building": "yes"}, square(-90.2, 34.76, 0.0002)),
        # A rail bridge across the edge (half inside).
        way(
            7,
            {"railway": "rail", "bridge": "yes", "name": "Coldwater Bridge"},
            [(-90.11, 34.78), (-90.09, 34.78)],
        ),
        # A dam as a node, a levee and a pipeline inside.
        {
            "type": "node",
            "id": 8,
            "lat": 34.77,
            "lon": -90.06,
            "tags": {"waterway": "dam", "name": "Arkabutla Dam"},
        },
        way(9, {"man_made": "dyke"}, [(-90.08, 34.73), (-90.07, 34.73)]),
        way(
            10,
            {"man_made": "pipeline", "substance": "gas"},
            [(-90.09, 34.71), (-90.09, 34.79)],
        ),
    ]


def test_overpass_answers_become_summaries_per_kind():
    polys = context.polygons_of(context.bbox_polygon(AREA_BBOX))
    kinds = list(context.KINDS)
    summary, feats = context.summarize(osm_elements(), polys, kinds)
    km_lon = context.GEOD.inv(-90.1, 34.75, -90.0, 34.75)[2] / 1000
    roads = summary["roads"]
    assert roads["count"] == 2
    assert roads["km_by_class"]["primary"] == pytest.approx(km_lon, abs=0.03)
    dam_rd = context.GEOD.inv(-90.05, 34.72, -90.05, 34.74)[2] / 1000
    assert roads["km_by_class"]["residential"] == pytest.approx(dam_rd, abs=0.01)
    assert roads["named"][0]["name"] == "MS 301"
    assert summary["buildings"]["count"] == 1
    assert summary["buildings"]["types"] == {"house": 1}
    assert summary["buildings"]["named"][0]["name"] == "Gatehouse"
    half = context.GEOD.inv(-90.10, 34.78, -90.09, 34.78)[2] / 1000
    assert summary["rail"]["length_km"] == pytest.approx(half, abs=0.02)
    assert summary["bridges"]["km_by_class"] == {
        "rail (rail)": pytest.approx(half, abs=0.02)
    }
    assert summary["dams"] == {
        "count": 1,
        "by_class": {"dam": 1},
        "named": [{"name": "Arkabutla Dam", "class": "dam"}],
    }
    assert summary["levees"]["count"] == 1 and summary["pipelines"][
        "km_by_class"
    ].keys() == {"gas"}
    # Features to draw: lines clipped to the area.
    primary = next(f for f in feats["roads"] if f["properties"]["osm_id"] == 1)
    xs = [p[0] for p in primary["geometry"]["coordinates"]]
    assert min(xs) >= -90.1 - 0.001 and max(xs) <= -90.0 + 0.001
    q = context.overpass_query(["roads", "dams"], tuple(AREA_BBOX))
    assert q.startswith("[out:json][timeout:90];(")
    assert "(34.70000,-90.10000,34.80000,-90.00000)" in q and 'node["waterway"' in q


def settings(**over) -> SimpleNamespace:
    base = {
        "BOWSER_ASSISTANT": True,
        "BOWSER_ASSISTANT_PAGE_KEYS": True,
        "BOWSER_ASSISTANT_KEY_FILE": "",
        "BOWSER_AI_PROVIDER": "",
        "BOWSER_AI_KEY": SecretStr(""),
        "BOWSER_AI_MODEL": "",
        "ANTHROPIC_API_KEY": SecretStr(""),
        "OPENAI_API_KEY": SecretStr(""),
        "GEMINI_API_KEY": SecretStr(""),
        "OPENROUTER_API_KEY": SecretStr(""),
    }
    base.update(over)
    return SimpleNamespace(**base)


LAYERS = {
    "velocity": {
        "label": "velocity",
        "unit": "m/yr",
        "x_values": [],
        "n_time_steps": 1,
        "latlon_bounds": None,
        "uses_spatial_ref": True,
        "los_metadata": {
            "heading_deg": 350.0,
            "incidence_deg": 37.0,
            "los_enu_ground_to_sat": {"east": -0.59, "north": -0.1, "up": 0.8},
        },
    },
    "median_temporal_coherence": {
        "label": "c",
        "unit": "",
        "x_values": [],
        "n_time_steps": 1,
    },
    "median_phase_similarity": {
        "label": "s",
        "unit": "",
        "x_values": [],
        "n_time_steps": 1,
    },
}


def make_app(s: SimpleNamespace, ds=None) -> FastAPI:
    """The relay's, the channel's and the context routes, and a small data API."""
    from fastapi import Query  # noqa: PLC0415

    app = FastAPI()
    app.include_router(relay.router)
    app.include_router(page.router)
    app.include_router(context.router)
    app.dependency_overrides[relay.get_settings] = lambda: s
    ds = planted() if ds is None else ds
    bounds = list(TO_LL.transform_bounds(X0, Y0 - DX * NY, X0 + DX * NX, Y0))
    for info in LAYERS.values():
        info["latlon_bounds"] = bounds

    @app.get("/datasets")
    def datasets():
        return LAYERS

    @app.get("/point")
    def point(dataset_name: str, lon: float, lat: float):  # noqa: ARG001
        return [0.82] if "coherence" in dataset_name else [0.41]

    @app.get("/deformation_zones")
    def deformation_zones(
        threshold_mm_yr: float = 5.0,
        sign: str = "both",
        min_area_m2: float = 0.0,
        bbox: str | None = None,
        layer: str | None = None,
        coherence_min: float | None = Query(None),
        max_zones: int = 50,
    ):
        return context.zones_answer(
            ds,
            TO_XY,
            threshold_mm_yr=threshold_mm_yr,
            sign=sign,
            min_area_m2=min_area_m2,
            bbox=bbox,
            layer=layer,
            coherence_min=coherence_min,
            max_zones=max_zones,
            ref_lon=None,
            ref_lat=None,
        )

    return app


def local(app) -> TestClient:
    return TestClient(app, client=("127.0.0.1", 50000))


def test_infrastructure_route_takes_any_area_and_keeps_the_features(services):
    services.elements = osm_elements()
    c = local(make_app(settings()))
    r = c.post("/infrastructure", json={"bbox": AREA_BBOX, "kinds": ["roads", "dams"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (
        body["summary"]["roads"]["count"] == 2 and body["summary"]["dams"]["count"] == 1
    )
    assert "OpenStreetMap" in body["attribution"] and not body["cached"]
    kept = c.get(f"/context/results/{body['result_id']}").json()
    assert kept["kind"] == "infrastructure" and len(kept["features"]["features"]) == 3
    # The same question again comes from the cache.
    again = c.post(
        "/infrastructure", json={"bbox": AREA_BBOX, "kinds": ["roads", "dams"]}
    )
    assert again.json()["cached"] and len(services.requests) == 1
    sent = parse_qs(services.requests[0].content.decode())["data"][0]
    assert 'way["highway"' in sent and 'node["waterway"~"^(dam|weir)$"]' in sent
    # A circle around a point.
    near = c.post(
        "/infrastructure",
        json={"point": [-90.05, 34.76], "radius_m": 100, "kinds": ["buildings"]},
    )
    assert near.json()["summary"]["buildings"]["count"] == 1
    # One area, not two; buildings only in small areas; zones need zones first.
    assert (
        c.post("/infrastructure", json={"bbox": AREA_BBOX, "point": [0, 0]}).status_code
        == 400
    )
    big = c.post(
        "/infrastructure", json={"bbox": [-91, 34, -90, 35], "kinds": ["buildings"]}
    )
    assert big.status_code == 400 and "too large for buildings" in big.json()["detail"]
    assert c.post("/infrastructure", json={"zone": "Z1"}).status_code == 404
    # Off with the Assistant (as the geocoder).
    off = local(make_app(settings(BOWSER_ASSISTANT=False)))
    assert off.post("/infrastructure", json={"bbox": AREA_BBOX}).status_code == 403
    assert off.get("/site_context", params={"lon": 0, "lat": 0}).status_code == 403


def test_site_context_with_services_up_down_and_off(services, monkeypatch):
    c = local(make_app(settings()))
    up = c.get("/site_context", params={"lon": -90.05, "lat": 34.76}).json()
    f = {x["factor"]: x for x in up["factors"]}
    assert (
        f["land_cover"]["land_cover"] == "crops"
        and f["land_cover"]["status"] == "flagged"
    )
    assert f["geology"]["setting"] == "unconsolidated sediment"
    assert "Compaction" in f["geology"]["caution"]
    assert f["wetlands"]["status"] == "flagged"
    assert (
        f["soil"]["soil_type"] == "expansive"
        and "shrinks and swells" in f["soil"]["caution"]
    )
    t = f["terrain"]
    cell = t["cell_m"]
    assert t["elevation_m"] > 100
    assert t["slope_deg"] == pytest.approx(math.degrees(math.atan(1 / cell)), abs=0.2)
    assert t["aspect"] == "flat" or t["aspect_deg"] == pytest.approx(270, abs=1)
    assert all(x["source"] for x in up["factors"])
    # Down: each one says it could not be looked up; the others still answer.
    context.FETCHER.clear()
    services.down = {"macrostrat", "fwspublicservices"}
    down = c.get("/site_context", params={"lon": -90.05, "lat": 34.76}).json()
    f = {x["factor"]: x for x in down["factors"]}
    assert f["geology"]["status"] == "unavailable"
    assert f["geology"]["finding"].startswith("Could not be looked up")
    assert f["wetlands"]["status"] == "unavailable"
    assert f["land_cover"]["status"] == "flagged"
    assert "could not be looked up: geology, wetlands" in down["summary"]
    # Off: nothing is sent.
    n = len(services.requests)
    monkeypatch.setenv("BOWSER_CONTEXT_SERVICES", "off")
    off = c.get("/site_context", params={"lon": -90.05, "lat": 34.76}).json()
    assert {x["status"] for x in off["factors"]} == {"off"}
    assert len(services.requests) == n


# --- the tools ---------------------------------------------------------------------


NEW_TOOLS = {
    # name: (read_only, page, open_world)
    "list_context_layers": (True, True, False),
    "add_context_layer": (False, True, False),
    "remove_context_layer": (False, True, False),
    "infrastructure_at": (True, False, True),
    "infrastructure_in_area": (True, False, True),
    "highlight_infrastructure": (False, True, True),
    "clear_highlights": (False, True, False),
    "get_areas": (True, True, False),
    "deformation_zones": (True, False, False),
    "site_context": (True, False, True),
}


def test_tool_specs_flags_and_page_commands():
    from bowser.tools import PAGE_COMMANDS, BowserAPI, build_tools  # noqa: PLC0415

    specs = {s.name: s for s in build_tools(BowserAPI())}
    for name, (ro, pg, ow) in NEW_TOOLS.items():
        s = specs[name]
        assert (s.read_only, s.page, s.open_world) == (ro, pg, ow), name
        assert s.mcp
        assert s.quiet == ro, name
        if pg:
            assert name in PAGE_COMMANDS
    assert "draw_highlight" in PAGE_COMMANDS and "draw_highlight" not in specs
    from bowser.tools import INSTRUCTIONS  # noqa: PLC0415

    assert "deformation_zones" in INSTRUCTIONS and "site_context" in INSTRUCTIONS
    assert "go_to X -> deformation_zones" in INSTRUCTIONS


def test_mcp_and_assistant_offer_the_same_context_tools():
    pytest.importorskip("mcp")
    from mcp import Client  # noqa: PLC0415

    from bowser.mcp_server import build_server  # noqa: PLC0415
    from bowser.tools import BowserAPI, build_tools  # noqa: PLC0415

    async def listing():
        async with Client(build_server("http://127.0.0.1:1")) as client:
            return (await client.list_tools()).tools

    mcp_tools = {t.name: t for t in asyncio.run(listing())}
    specs = {s.name: s for s in build_tools(BowserAPI())}
    for name, (ro, _pg, ow) in NEW_TOOLS.items():
        t = mcp_tools[name]
        assert t.description == specs[name].description
        assert t.input_schema == specs[name].input_schema
        assert (
            t.annotations.read_only_hint is ro and t.annotations.open_world_hint is ow
        )


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def served(services, monkeypatch):
    import uvicorn  # noqa: PLC0415

    page.reset()
    monkeypatch.setattr(page, "PING_SECONDS", 0.2)
    app = make_app(settings())
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try:
            httpx.get(f"{url}/datasets", timeout=1)
            break
        except httpx.TransportError:
            time.sleep(0.05)
    yield SimpleNamespace(url=url, services=services)
    server.should_exit = True
    thread.join(10)
    page.reset()


def roads_through_zone_a() -> list[dict]:
    """A road through zone A (west to east, through its middle) and one far away."""
    (w, mid), (e, _) = ll(14.5, 5), ll(14.5, 25)
    far = ll(55, 75)
    return [
        way(11, {"highway": "secondary", "name": "Levee Rd"}, [(w, mid), (e, mid)]),
        way(12, {"highway": "secondary"}, [far, (far[0] + 0.001, far[1])]),
    ]


def test_which_roads_are_in_the_area_moving_faster_than_5_mm_yr(served):
    """Through bowser mcp: zones, the roads in the largest, drawn on the page."""
    pytest.importorskip("mcp")
    from fake_page import FakePage  # noqa: PLC0415
    from mcp import Client  # noqa: PLC0415

    from bowser.mcp_server import build_server  # noqa: PLC0415

    served.services.elements = roads_through_zone_a()
    p = FakePage(
        served.url, lambda _name, args: {"ok": True, "name": args.get("name")}
    ).open()

    async def flow():
        transport = httpx.AsyncHTTPTransport()
        try:
            return await steps(transport)
        finally:
            await transport.aclose()

    async def steps(transport):
        async with Client(build_server(served.url, transport)) as client:
            z = await client.call_tool("deformation_zones", {"threshold_mm_yr": 5})
            zones_out = json.loads(z.content[0].text)
            r = await client.call_tool(
                "infrastructure_in_area", {"zone": "Z1", "kinds": ["roads"]}
            )
            roads = json.loads(r.content[0].text)
            h = await client.call_tool(
                "highlight_infrastructure", {"zone": "Z1", "kinds": ["roads"]}
            )
            return zones_out, roads, h

    zones_out, roads, h = asyncio.run(flow())
    p.close()
    assert zones_out["n_zones"] == 5 and zones_out["zones"][0]["zone"] == "Z1"
    assert zones_out["map"]["on_map"] is True
    road = roads["summary"]["roads"]
    assert road["count"] == 1 and road["named"][0]["name"] == "Levee Rd"
    assert road["length_km"] == pytest.approx(0.3, abs=0.02)  # A is 10 cells of 30 m
    assert "never call a road" in roads["note"]
    assert not h.is_error
    names = [c[0] for c in p.commands]
    assert names == ["draw_highlight", "draw_highlight", "highlight_infrastructure"]
    assert p.commands[0][1]["result_id"] == zones_out["zones_id"]
    assert p.commands[1][1]["result_id"] == roads["result_id"]
    assert p.commands[2][1] == {"kinds": ["roads"], "zone": "Z1"}
    # The page fetches what it draws from the server.
    kept = httpx.get(f"{served.url}/context/results/{roads['result_id']}").json()
    assert [f["properties"]["name"] for f in kept["features"]["features"]] == [
        "Levee Rd"
    ]


def test_site_context_tool_adds_quality_slope_in_los_and_nearby_infrastructure(served):
    pytest.importorskip("mcp")
    from mcp import Client  # noqa: PLC0415

    from bowser.mcp_server import build_server  # noqa: PLC0415

    served.services.elements = roads_through_zone_a()
    lon, lat = ll(14.5, 14.5)

    async def ask():
        transport = httpx.AsyncHTTPTransport()
        try:
            async with Client(build_server(served.url, transport)) as client:
                r = await client.call_tool("site_context", {"lon": lon, "lat": lat})
                return json.loads(r.content[0].text)
        finally:
            await transport.aclose()

    out = asyncio.run(ask())
    f = {x["factor"]: x for x in out["factors"]}
    assert f["quality"]["temporal_coherence"]["value"] == 0.82
    assert f["quality"]["phase_similarity"]["layer"] == "median_phase_similarity"
    # Slope facing west (aspect 270): downslope is west, the LOS looks east-up.
    assert f["terrain"]["downslope_seen_in_los"] == pytest.approx(
        math.cos(math.radians(f["terrain"]["slope_deg"])) * 0.59
        - math.sin(math.radians(f["terrain"]["slope_deg"])) * 0.8,
        abs=0.02,
    )
    assert f["infrastructure"]["summary"]["roads"]["count"] == 1
    assert out["summary"].startswith("Flagged:")
    # With the services down, the tool still answers and says what is missing.
    context.FETCHER.clear()
    served.services.down = {
        "overpass",
        "arcgis",
        "macrostrat",
        "fws",
        "sdmdataaccess",
        "amazonaws",
    }
    out = asyncio.run(ask())
    f = {x["factor"]: x for x in out["factors"]}
    assert f["infrastructure"]["status"] == "unavailable"
    assert f["geology"]["finding"].startswith("Could not be looked up")
    assert f["quality"]["status"] == "flagged"  # phase similarity 0.41: low


def test_downslope_share_needs_a_line_of_sight_measurement():
    """A vertical cube is not projected on a look vector it does not measure along."""
    from bowser.tools import _downslope_in_los  # noqa: PLC0415

    terrain = {"slope_deg": 20.0, "aspect_deg": 270.0}
    los = {"east": -0.59, "north": -0.1, "up": 0.8}
    assert _downslope_in_los(terrain, los, "line_of_sight")["downslope_seen_in_los"]
    vertical = _downslope_in_los(terrain, los, "vertical")
    assert vertical["downslope_seen_in_los"] is None
    assert "vertical motion" in vertical["downslope_note"]
