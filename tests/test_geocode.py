"""The geocoder (src/bowser/geocode.py), against a mock Nominatim (no network).

Nominatim's usage policy: a User-Agent naming the application (never a person's
email), at most one request per second, results cached; the endpoint can be
replaced (or geocoding turned off) by ``BOWSER_GEOCODER_URL``.
"""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("httpx")

import httpx  # noqa: E402

from bowser import geocode  # noqa: E402

PLACE = {
    "display_name": "Arkabutla Dam, Tate County, Mississippi, United States",
    "lon": "-90.1253",
    "lat": "34.7562",
    "boundingbox": ["34.7500", "34.7600", "-90.1300", "-90.1200"],
    "type": "dam",
    "category": "waterway",
}


def nominatim(sent: list[httpx.Request], places=None):
    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json=[PLACE] if places is None else places)

    return httpx.MockTransport(handle)


@pytest.fixture(autouse=True)
def default_endpoint(monkeypatch):
    monkeypatch.delenv(geocode.ENV, raising=False)


def test_user_agent_names_bowser_and_no_one(monkeypatch):
    monkeypatch.setenv("EMAIL", "someone@example.com")
    sent: list[httpx.Request] = []
    g = geocode.Geocoder(interval=0, transport=nominatim(sent))
    results, cached = asyncio.run(g.search("  Arkabutla   Dam ", 3))
    assert not cached
    (r,) = sent
    ua = r.headers["user-agent"]
    assert ua.startswith("bowser-insar/")
    assert "(+https://github.com/opera-adt/bowser)" in ua
    assert "@" not in str(r.url) and "@" not in ua
    assert not any("@" in v for v in r.headers.values())
    assert r.url.host == "nominatim.openstreetmap.org"
    assert dict(r.url.params) == {
        "q": "Arkabutla Dam",
        "format": "jsonv2",
        "limit": "3",
    }
    # The bounding box is [west, south, east, north].
    assert results == [
        {
            "name": PLACE["display_name"],
            "lon": -90.1253,
            "lat": 34.7562,
            "bbox": [-90.13, 34.75, -90.12, 34.76],
            "kind": "dam",
            "category": "waterway",
        }
    ]


def test_at_most_one_request_per_second_and_a_cache():
    sent: list[httpx.Request] = []
    g = geocode.Geocoder(transport=nominatim(sent))

    async def three():
        return await asyncio.gather(
            g.search("Arkabutla Dam"), g.search("Sardis Dam"), g.search("Grenada")
        )

    asyncio.run(three())
    assert len(sent) == 3
    gaps = [b - a for a, b in zip(g.sent, g.sent[1:])]
    # The turns are one second apart; a request leaves a little after its turn,
    # by however long the event loop took to get to it (16 ms seen on a busy
    # macOS runner), so two send times can be closer than the turns were.
    assert all(gap >= 0.9 for gap in gaps), gaps
    assert g.sent[-1] - g.sent[0] >= 1.9, gaps
    # Asked again (in any case and spacing): from the cache, no request.
    results, cached = asyncio.run(g.search("arkabutla  DAM"))
    assert cached and results[0]["kind"] == "dam"
    assert len(sent) == 3


def test_endpoint_from_the_environment_or_off(monkeypatch):
    sent: list[httpx.Request] = []
    g = geocode.Geocoder(interval=0, transport=nominatim(sent))
    monkeypatch.setenv(geocode.ENV, "https://geo.example.org/search")
    asyncio.run(g.search("Grenada"))
    assert sent[-1].url.host == "geo.example.org"
    monkeypatch.setenv(geocode.ENV, "off")
    with pytest.raises(geocode.GeocodeError) as e:
        asyncio.run(g.search("Grenada"))
    assert e.value.status == 503
    assert len(sent) == 1


def test_bad_answers_and_places_without_a_box():
    places = [
        {"display_name": "A point", "lon": "1.5", "lat": "2.5"},
        {"display_name": "Broken", "lon": "x"},
    ]
    g = geocode.Geocoder(interval=0, transport=nominatim([], places))
    results, _ = asyncio.run(g.search("somewhere"))
    assert results == [
        {
            "name": "A point",
            "lon": 1.5,
            "lat": 2.5,
            "bbox": None,
            "kind": None,
            "category": None,
        }
    ]
    failing = geocode.Geocoder(
        interval=0, transport=httpx.MockTransport(lambda _r: httpx.Response(429))
    )
    with pytest.raises(geocode.GeocodeError, match="HTTP 429"):
        asyncio.run(failing.search("x"))
    with pytest.raises(geocode.GeocodeError):
        asyncio.run(failing.search("   "))
