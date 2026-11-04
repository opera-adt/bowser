"""UNR GNSS readers: the station list (MIDAS) and a station's daily positions (tenv3).

The samples are real lines from UNR's files (midas.NA.txt, P056.NA.tenv3).
"""

from pathlib import Path

import pytest

from bowser import gnss

DATA = Path(__file__).parent / "data" / "gnss"


def test_midas_rows_in_mm_per_year():
    rows = gnss.parse_midas((DATA / "midas_sample.txt").read_text())
    p056 = next(r for r in rows if r["id"] == "P056")
    assert p056 == {
        "id": "P056",
        "lon": -119.06287,
        "lat": 36.02744,
        "first": 2005.88,
        "last": 2024.65,
        "ve_mm_yr": -13.63,
        "vn_mm_yr": 12.48,
        "vu_mm_yr": -42.58,
        "sigma_vu_mm_yr": 2.37,
    }


def test_midas_drops_short_records():
    text = (DATA / "midas_sample.txt").read_text()
    short = [
        line.split()[0]
        for line in text.splitlines()
        if float(line.split()[4]) < gnss.MIN_YEARS
    ]
    assert short, "the sample should hold a station with under three years"
    assert not {r["id"] for r in gnss.parse_midas(text)} & set(short)


def test_stations_in_box_nearest_centre_first():
    rows = [
        {"id": "FAR1", "lon": -90.9, "lat": 34.9},
        {"id": "MID1", "lon": -90.5, "lat": 34.5},
        {"id": "OUT1", "lon": -80.0, "lat": 34.5},
    ]
    assert [r["id"] for r in gnss.stations_in(rows, -91, 34, -90, 35)] == [
        "MID1",
        "FAR1",
    ]
    assert len(gnss.stations_in(rows, -91, 34, -90, 35, limit=1)) == 1


def test_tenv3_in_mm_from_the_first_day():
    s = gnss.parse_tenv3((DATA / "P056_sample.tenv3").read_text())
    assert s["dates"][:2] == ["2005-11-17", "2005-11-18"]
    assert s["east_mm"][0] == s["north_mm"][0] == s["up_mm"][0] == 0.0
    assert s["east_mm"][1] == 0.96  # 0.734830 - 0.733868 m, to 0.01 mm
    assert s["up_mm"][1] == -0.55


def test_bad_station_ids_are_refused_before_any_request(monkeypatch):
    monkeypatch.setattr(
        gnss, "fetch_text", lambda *_, **__: pytest.fail("no request expected")
    )
    for bad in ("P05", "P0566", "../x", "p05!"):
        with pytest.raises(ValueError):
            gnss.station_series(bad)


def test_steps_by_station_equipment_and_earthquakes():
    steps = gnss.parse_steps((DATA / "steps_sample.txt").read_text())
    assert list(steps) == ["P056"]
    assert steps["P056"][0] == {
        "date": "2019-03-27",
        "kind": "equipment",
        "detail": "Elevation Cutoff Changed",
    }
    quake = next(s for s in steps["P056"] if s["kind"] == "earthquake")
    assert quake == {
        "date": "2010-04-04",
        "kind": "earthquake",
        "detail": "M7.2, 541 km away",
        "event": "ci14607652",
    }


def test_monuments_from_the_fixed_width_table():
    table = gnss.parse_monuments((DATA / "monuments_sample.txt").read_text())
    assert table["MACC"]["monument"] == "PERMANENT STATION UNSPECIFIED"
    assert table["MACC"]["foundation"] is None  # UNKNOWN
    deep = next(v for k, v in table.items() if k != "MACC")
    assert "DEEP DRILLED" in deep["monument"]


def test_series_carries_steps_and_monument_in_its_span(monkeypatch):
    files = {
        gnss.SERIES_URL.format(station="P056"): (
            DATA / "P056_sample.tenv3"
        ).read_text(),
        gnss.STEPS_URL: (DATA / "steps_sample.txt").read_text(),
        gnss.MONUMENTS_URL: "Site    : a : b : c : d : e\n",
    }
    monkeypatch.setattr(gnss, "fetch_text", lambda url, **_: files[url])
    monkeypatch.setattr(gnss, "_series", gnss.OrderedDict())
    monkeypatch.setattr(gnss, "_steps", {"at": 0.0, "by_station": {}})
    monkeypatch.setattr(gnss, "_monuments", {"at": 0.0, "by_station": {}})
    s = gnss.station_series("p056")
    # The sample record is three days in 2005, so no step falls inside it.
    assert s["station"] == "P056" and s["steps"] == [] and s["monument"] is None
