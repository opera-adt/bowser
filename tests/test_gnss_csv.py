"""Reading the user's own GNSS files (bowser.gnss_csv): formats, units, metadata.

Pure Python, as bowser-lite reads them too; nothing here loads bowser.config.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from bowser import gnss_csv
from bowser.gnss_csv import GnssCsvError, parse_gnss_csv

DATA = Path(__file__).parent / "data" / "gnss"

PLAIN = """\
# station: DEMO
# lon: -117.67
# lat: 33.96
date,east,north,up
2020-01-01,0.001,0.002,0.003
2020-07-01,0.002,0.003,-0.004
2021-01-01,0.003,0.004,-0.010
"""


def one(text: str, name: str = "file.csv", **kw) -> dict:
    res = parse_gnss_csv(text, name, **kw)
    assert len(res["stations"]) == 1
    return res["stations"][0]


@pytest.mark.parametrize(
    ("cell", "expected", "fmt"),
    [
        ("2021-03-04", "2021-03-04", "iso"),
        ("2021-03-04T23:59:00Z", "2021-03-04", "iso"),
        ("2021/3/4", "2021-03-04", "iso"),
        ("20210304", "2021-03-04", "yyyymmdd"),
        ("21MAR04", "2021-03-04", "yymmmdd"),
        ("2021.1712", "2021-03-04", "decimal_year"),  # (62 + 0.5) / 365
        ("2021.1698", "2021-03-04", "decimal_year"),  # its start, 62 / 365, rounded
        ("59277", "2021-03-04", "mjd"),
        ("59277.75", "2021-03-04", "mjd"),
    ],
)
def test_date_formats(cell, expected, fmt):
    d, got = gnss_csv.parse_date(cell)
    assert (d.isoformat(), got) == (expected, fmt)


@pytest.mark.parametrize("cell", ["", "x", "1850.5", "12", "2021-02-30", "nan"])
def test_not_dates(cell):
    with pytest.raises(ValueError):
        gnss_csv.parse_date(cell)


def test_each_date_format_reads_the_same_series():
    rows = {
        "iso": ("2020-01-01", "2020-07-01"),
        "decimal year": ("2020.0014", "2020.4986"),
        "mjd": ("58849", "59031"),
    }
    for label, (a, b) in rows.items():
        st = one(
            f"# lon: 1\n# lat: 2\ndate,east_mm,north_mm,up_mm\n{a},0,0,0\n{b},1,2,3\n"
        )
        assert st["dates"] == ["2020-01-01", "2020-07-01"], label


def test_metadata_lines_give_the_station_and_location():
    st = one(PLAIN, "ignored.csv")
    assert (st["id"], st["name"], st["lon"], st["lat"]) == (
        "DEMO",
        "DEMO",
        -117.67,
        33.96,
    )
    assert st["dates"] == ["2020-01-01", "2020-07-01", "2021-01-01"]
    assert st["east_mm"] == [0.0, 1.0, 2.0]  # metres (guessed) to mm from day one
    assert st["up_mm"] == [0.0, -7.0, -13.0]
    assert st["custom"] is True
    assert st["vu_mm_yr"] == pytest.approx(-13.0, abs=0.1)
    assert st["first_date"] == "2020-01-01" and st["last_date"] == "2021-01-01"


def test_station_and_location_as_columns_several_stations():
    text = (
        "site\tlongitude\tlatitude\tdecimal_year\tdE\tdN\tdU\n"
        "AAAA\t-100.5\t40\t2020.0014\t0\t0\t0\n"
        "BBBB\t200\t41\t2020.0014\t0\t0\t0\n"
        "AAAA\t-100.5\t40\t2020.4986\t1\t1\t-5\n"
        "BBBB\t200\t41\t2020.4986\t2\t2\t5\n"
        "BBBB\t200\t41\tnot-a-date\t2\t2\t5\n"
    )
    res = parse_gnss_csv(text, "net.tsv", units="mm")
    by_id = {s["id"]: s for s in res["stations"]}
    assert set(by_id) == {"AAAA", "BBBB"}
    assert (by_id["AAAA"]["lon"], by_id["AAAA"]["lat"]) == (-100.5, 40)
    assert by_id["BBBB"]["lon"] == -160  # 0-360 longitudes are turned to +-180
    assert by_id["AAAA"]["up_mm"] == [0.0, -5.0]
    assert (res["rows"], res["skipped"]) == (4, 1)
    assert by_id["BBBB"]["skipped"] == 1 and by_id["AAAA"]["skipped"] == 0


def test_units_from_the_header():
    text = (
        "# lon: 1\n# lat: 2\ndate,east (m),north (m),up (m)\n"
        "2020-01-01,0,0,0\n2020-02-01,0.01,0,0\n"
    )
    st = one(text)
    assert (st["units"], st["units_from"], st["east_mm"][1]) == ("m", "header", 10.0)
    text = text.replace("(m)", "[mm]")
    st = one(text)
    assert (st["units"], st["units_from"], st["east_mm"][1]) == ("mm", "header", 0.01)
    st = one(
        text.replace("[mm]", "")
        .replace("east ", "e_cm")
        .replace("north ", "n_cm")
        .replace("up ", "u_cm")
    )
    assert (st["units"], st["east_mm"][1]) == ("cm", 0.1)


def test_units_from_a_metadata_line_and_the_option():
    text = (
        "# lon: 1\n# lat: 2\n# units: millimetres\ndate,e,n,u\n"
        "2020-01-01,0,0,0\n2020-02-01,0.5,0,0\n"
    )
    st = one(text)
    assert (st["units"], st["units_from"], st["east_mm"][1]) == ("mm", "file", 0.5)
    st = one(text, units="m")
    assert (st["units"], st["units_from"], st["east_mm"][1]) == ("m", "option", 500.0)
    with pytest.raises(GnssCsvError, match="m, mm or cm"):
        parse_gnss_csv(text, units="ft")


def test_units_guessed_from_the_values_and_said_so():
    big = (
        "# lon: 1\n# lat: 2\ndate,east,north,up\n2020-01-01,0,0,0\n2021-01-01,4,5,-30\n"
    )
    st = one(big)
    assert (st["units"], st["units_from"]) == ("mm", "guessed")
    assert any("does not say its units" in w for w in st["warnings"])
    small = big.replace("4,5,-30", "0.004,0.005,-0.030")
    st = one(small)
    assert (st["units"], st["up_mm"][1]) == ("m", -30.0)


def test_sigmas_are_kept_in_mm():
    text = (
        "# lon: 1\n# lat: 2\ndate,e_mm,n_mm,u_mm,sig_e,sig_n,sig_u\n"
        "2020-01-01,0,0,0,1,1,3\n2020-02-01,1,1,1,1.5,1,4\n"
    )
    st = one(text)
    assert st["sigma_up_mm"] == [3.0, 4.0]
    assert st["sigma_east_mm"] == [1.0, 1.5]
    assert "sigma_up_mm" not in one(PLAIN)


def test_no_header_columns_are_date_east_north_up():
    st = one("59000 1 2 3\n59010 2 3 5\n", "n.txt", lon=10, lat=20, units="mm")
    assert st["dates"] == ["2020-05-31", "2020-06-10"]
    assert st["up_mm"] == [0.0, 2.0]
    assert (st["lon"], st["lat"], st["id"]) == (10, 20, "n")


def test_overrides_name_the_station_and_place_it():
    st = one(PLAIN, station="My site 1", lon=5, lat=6)
    assert (st["id"], st["name"], st["lon"], st["lat"]) == (
        "My_site_1",
        "My site 1",
        5,
        6,
    )


def test_vertical_only_files_warn_that_horizontals_are_zero():
    st = one("# lon: 1\n# lat: 2\ndate,up_mm\n2020-01-01,0\n2020-02-01,-4\n")
    assert st["components"] == ["up"]
    assert st["east_mm"] == [0.0, 0.0]
    assert any("vertical only" in w for w in st["warnings"])


def test_earthscope_position_csv():
    text = """\
PBO Station Position Time Series. Reference Frame : NAM14
Format Version: 1.1.0
4-character ID: P123
Station name  : Some Valley
Begin Date, End Date : 2005-01-01, 2006-01-01
{position}
{header}
2005-01-01,0.0,0.0,0.0,1,1,3,repro,
2005-07-02,5.0,-2.5,1.0,1,1,3,repro,
2006-01-01,10.0,-5.0,2.0,1,1,3,repro,
""".format(
        position="Reference position :  41.38 North Latitude, -112.27 East "
        "Longitude, 1300.0 meters elevation,",
        header="Date, North (mm), East (mm), Vertical (mm), North Std. Deviation "
        "(mm), East Std. Deviation (mm), Vertical Std. Deviation (mm), Quality,",
    )
    st = one(text, "P123.cwu.nam14.csv")
    assert (st["id"], st["name"]) == ("P123", "Some Valley")
    assert (st["lon"], st["lat"]) == (-112.27, 41.38)
    assert st["frame"] == "NAM14"
    assert st["north_mm"] == [0.0, 5.0, 10.0]
    assert st["east_mm"] == [0.0, -2.5, -5.0]
    assert st["sigma_up_mm"] == [3.0, 3.0, 3.0]
    assert st["units_from"] == "header"
    assert st["vn_mm_yr"] == pytest.approx(10.0, abs=0.05)


def test_ngl_tenv3_reads_as_the_unr_reader_does():
    from bowser import gnss

    text = (DATA / "P056_sample.tenv3").read_text()
    st = one(text, "P056.NA.tenv3")
    unr = gnss.parse_tenv3(text)
    assert st["dates"] == unr["dates"]
    assert st["east_mm"] == unr["east_mm"] and st["up_mm"] == unr["up_mm"]
    assert (st["id"], st["lon"], st["lat"]) == ("P056", -119.062869, 36.027437)
    assert st["date_format"] == "yymmmdd" and st["units"] == "m"
    assert len(st["sigma_up_mm"]) == len(st["dates"])


def test_bad_rows_are_skipped_and_counted():
    text = (
        PLAIN
        + "2021-02-01,x,0,0\nnot a row\n2021-03-01,,,\n2021-04-01,0.004,0.005,nan\n"
    )
    res = parse_gnss_csv(text, "f.csv")
    assert (res["rows"], res["skipped"]) == (3, 4)
    assert res["stations"][0]["skipped"] == 4


def test_rows_are_sorted_by_date():
    text = (
        "# lon: 1\n# lat: 2\ndate,e_mm,n_mm,u_mm\n2020-03-01,2,2,2\n2020-01-01,0,0,0\n"
    )
    st = one(text)
    assert st["dates"] == ["2020-01-01", "2020-03-01"]
    assert st["up_mm"] == [0.0, 2.0]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "empty"),
        ("\n  \n", "empty"),
        ("just,some,words\nand,more,words\n", "No columns found"),
        (
            "# lon: 1\n# lat: 2\ndate,east,north\n2020-01-01,0,0\n2020-01-02,0,0\n",
            "No up",
        ),
        (
            "# lon: 1\n# lat: 2\ndate,e,n,u\n2020-01-01,0,0,0\n",
            "Fewer than two usable rows",
        ),
        ("# lon: 1\n# lat: 2\ndate,e,n,u\nx,0,0,0\ny,0,0,0\n", r"0; 2 skipped"),
        ("date,e,n,u\n2020-01-01,0,0,0\n2020-02-01,0,0,0\n", "No location"),
        (
            "# lon: 1\n# lat: 95\ndate,e,n,u\n2020-01-01,0,0,0\n2020-02-01,0,0,0\n",
            "not a place",
        ),
    ],
)
def test_nothing_usable_is_a_clear_error(text, message):
    with pytest.raises(GnssCsvError, match=message):
        parse_gnss_csv(text, "f.csv")


def test_example_file_in_the_docs_reads():
    res = parse_gnss_csv(
        (DATA / "custom_station.csv").read_text(), "custom_station.csv"
    )
    st = res["stations"][0]
    assert st["id"] == "DEMO" and st["units_from"] == "header"
    assert res["skipped"] == 1
    assert st["rows"] >= 20


def test_big_files_are_refused(tmp_path, monkeypatch):
    f = tmp_path / "big.csv"
    f.write_text(PLAIN)
    assert gnss_csv.read_file(f) == PLAIN
    monkeypatch.setattr(gnss_csv, "MAX_BYTES", 10)
    with pytest.raises(GnssCsvError, match="MB"):
        gnss_csv.read_file(f)
