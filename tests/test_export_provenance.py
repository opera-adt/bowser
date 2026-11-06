"""Check export facts, unknowns, short names, and reference coordinates."""

import copy
import json

import pytest
from pyproj import Transformer

from bowser.export_provenance import export_provenance


def test_explicit_metadata_dates_and_no_mutation():
    attrs = {
        "units": "meters",
        "reference_date": "20260101",
        "frame_id": 0,
        "sign_convention": "negative away from satellite",
    }
    root = {"sensor": "Example radar", "frame_id": 42, "api_token": "do-not-copy"}
    original = copy.deepcopy((attrs, root))
    tags, name = export_provenance(
        "Displacement",
        attrs,
        root_attrs=root,
        selected_index=2,
        selected_label="2026-01-25T12:30:00",
        available_labels=["2026-01-01", "2026-01-25"],
    )
    info = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])
    assert name == "Displacement_20260101-20260125.tif"
    assert info["source"]["frame"] == "0"
    assert info["source"]["sensor"] == "Example radar"
    assert info["time"]["selected_label"] == "2026-01-25T12:30:00"
    assert info["time"]["available_record_start"] == "2026-01-01"
    assert info["time"]["velocity_fit_start"] is None
    assert "do-not-copy" not in json.dumps(info)
    assert (attrs, root) == original


def test_velocity_record_bounds_are_not_claimed_as_fit_period():
    tags, name = export_provenance(
        "Velocity", {}, available_labels=["2026-01-01", "2026-02-01"]
    )
    info = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])
    assert name == "Velocity.tif"
    assert info["time"]["available_record_end"] == "2026-02-01"
    assert info["time"]["velocity_fit_start"] is None
    assert info["source"]["units"] is None
    assert info["reference"]["mode"] == "stored"


def test_verified_fit_period_and_mask_are_named():
    tags, name = export_provenance(
        "Velocity",
        {"velocity_fit_start": "20260101", "velocity_fit_end": "20260201"},
        masks=[{"layer": "quality", "operator": ">=", "threshold": 0.8}],
    )
    assert name == "Velocity_20260101-20260201_masked.tif"
    assert tags["BOWSER_EXPORT_MASKED"] == "true"


@pytest.mark.parametrize(
    "label,token",
    [
        ("2026-01-01_2026-01-13", "20260101-20260113"),
        ("2026-01-13", "20260113"),
        ("2026-99-99", "t3"),
        ("3", "t3"),
    ],
)
def test_pair_labels_are_retained_without_inventing_a_temporal_datum(label, token):
    tags, name = export_provenance(
        "Displacement", {}, selected_label=label, selected_index=3
    )
    assert name == f"Displacement_{token}.tif"
    assert (
        json.loads(tags["BOWSER_EXPORT_PROVENANCE"])["time"]["reference_date"] is None
    )


@pytest.mark.parametrize(
    "lon,lat,epsg",
    [
        (-118, 34, 32611),
        (151, -34, 32756),
        (6, 60, 32632),
        (10, 78, 32633),
        (180, 0, 32660),
        (-180, 0, 32601),
        (0, 85, None),
    ],
)
def test_applied_reference_coordinates_and_offset(lon, lat, epsg):
    attrs = {
        "BOWSER_REFERENCE_OPERATION": "exported_value = stored_value - reference_value",
        "BOWSER_REFERENCE_LONGITUDE": lon,
        "BOWSER_REFERENCE_LATITUDE": lat,
        "BOWSER_REFERENCE_VALUE": 0,
        "BOWSER_REFERENCE_METHOD": "nearest_pixel",
    }
    tags, _ = export_provenance("displacement", attrs)
    ref = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])["reference"]
    assert ref["mode"] == "interactive"
    assert float(ref["value"]) == 0
    assert ref["coordinate_crs"] == "EPSG:4326"
    if epsg:
        assert ref["utm"]["crs"] == f"EPSG:{epsg}"
        x, y = Transformer.from_crs(4326, epsg, always_xy=True).transform(lon, lat)
        assert ref["utm"]["easting_meters"] == pytest.approx(x)
        assert ref["utm"]["northing_meters"] == pytest.approx(y)
    else:
        assert ref["utm"] is None


def test_source_identifier_allowlist_and_safe_filename():
    tags, name = export_provenance(
        "../../odd / name",
        {
            "product_id": "https://example.invalid/data?token=secret",
            "track": "relative-42",
            "history": "private local history",
            "units": "m/year",
        },
    )
    assert name == "odd-name.tif"
    assert "secret" not in tags["BOWSER_EXPORT_PROVENANCE"]
    assert "private local" not in tags["BOWSER_EXPORT_PROVENANCE"]
    assert tags["BOWSER_SOURCE_UNITS"] == "m/year"


def test_intrinsic_nodata_and_zero_remain_distinct():
    tags, _ = export_provenance(
        "data", {}, source_nodata=-9999, export_nodata=float("nan")
    )
    info = json.loads(tags["BOWSER_EXPORT_PROVENANCE"])
    assert info["nodata"]["source"] == -9999
    assert info["nodata"]["export"] == "nan"
    assert info["masks"]["applied"] == []
