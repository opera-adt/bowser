"""What a layer measures comes from the cube, never from a Sentinel-1 default."""

import math

import pytest

from bowser.measurement import KNOWN_PRODUCTS, describe_measurement


def _los(heading_deg: float, incidence_deg: float) -> dict:
    """A right-looking satellite's ground-to-satellite unit vector (ENU)."""
    h, i = math.radians(heading_deg), math.radians(incidence_deg)
    # The look direction is 90 degrees clockwise of the heading (right looking);
    # the ground-to-satellite vector points the other way, and up.
    look = h + math.pi / 2
    return {
        "heading_deg": heading_deg,
        "incidence_deg": incidence_deg,
        "los_enu_ground_to_sat": {
            "east": -math.sin(i) * math.sin(look),
            "north": -math.sin(i) * math.cos(look),
            "up": math.cos(i),
        },
    }


LOS_LAYER = {
    "units": "meters",
    "description": "Displacement along the radar line of sight. Positive values "
    "indicate apparent motion towards the platform.",
}


def test_sentinel1_like_ascending_sees_little_north_south():
    m = describe_measurement("displacement", LOS_LAYER, {}, _los(349.6, 39.0))
    assert m["kind"] == "line_of_sight"
    assert m["positive_direction"] == "towards the satellite"
    assert m["sign_source"] == "layer attribute 'description'"
    s = m["sensitivity"]
    assert s["north"] < 0.15 and s["up"] > 0.7 and s["east"] > 0.55
    assert "north-south sensitivity 0.11" in m["sensitivity_note"]
    assert m["sensitivity_note"].startswith("Sensitive mainly to vertical")


def test_mid_inclination_orbit_sees_north_south():
    # A Capella-like mid-inclination orbit: the track runs about north-east.
    m = describe_measurement("displacement", LOS_LAYER, {}, _los(45.0, 40.0))
    s = m["sensitivity"]
    assert s["north"] == pytest.approx(s["east"], abs=0.01) and s["north"] > 0.4
    assert "north-south (0.45)" in m["sensitivity_note"]
    assert "mainly" not in m["sensitivity_note"]


def test_vertical_cube_is_not_line_of_sight():
    m = describe_measurement(
        "velocity",
        {
            "units": "mm/yr",
            "long_name": "Vertical land motion",
            "positive_direction": "up",
        },
        {"title": "VLM"},
    )
    assert m["kind"] == "vertical" and m["positive_direction"] == "up"
    assert m["sensitivity"] == {"east": 0.0, "north": 0.0, "up": 1.0}
    assert "line of sight" not in m["summary"]


def test_no_metadata_is_unknown_with_no_sentinel1_defaults():
    m = describe_measurement("displacement", {"units": "m"})
    assert m["kind"] == "unknown"
    assert m["positive_direction"] is None
    assert m["sensitivity"] is None
    assert m["radar_wavelength_m"] is None and m["half_wavelength_mm"] is None
    assert m["product"] is None
    assert "not recorded" in m["summary"] and "27.7" not in m["summary"]


def test_look_geometry_without_a_stated_kind_is_hedged():
    m = describe_measurement("displacement", {"units": "m"}, {}, _los(190, 35))
    assert m["kind"] == "unknown"
    assert m["sensitivity"] is not None
    assert m["sensitivity_note"].startswith("If these values are along the line")


def test_wavelength_present_or_absent():
    m = describe_measurement("displacement", LOS_LAYER, {}, None, 0.2384)
    assert m["half_wavelength_mm"] == 119.2
    assert m["wavelength_source"] == "cube attributes"
    assert describe_measurement("displacement", LOS_LAYER)["half_wavelength_mm"] is None


def test_known_product_fills_gaps_and_attributes_override_it():
    cube = {"title": "OPERA L3 DISP-S1 subset"}
    m = describe_measurement("displacement", {"units": "m"}, cube)
    assert m["product"] == "OPERA DISP-S1"
    assert m["kind"] == "line_of_sight"
    assert m["positive_direction"] == "towards the satellite"
    assert m["half_wavelength_mm"] == 27.7
    assert m["kind_source"] == m["sign_source"] == "known product OPERA DISP-S1"
    # The file's own statements win over the table.
    m = describe_measurement(
        "displacement",
        {"units": "m", "sign_convention": "positive away from the satellite"},
        cube,
        None,
        0.05,
    )
    assert m["positive_direction"] == "away from the satellite"
    assert m["radar_wavelength_m"] == 0.05
    # A vertical layer in a DISP-S1 cube does not take the table's LOS sign.
    m = describe_measurement(
        "vertical_velocity", {"units": "m/yr", "long_name": "Vertical velocity"}, cube
    )
    assert m["kind"] == "vertical" and m["positive_direction"] is None


def test_known_products_are_only_matched_by_name():
    assert [e["name"] for e in KNOWN_PRODUCTS] == ["OPERA DISP-S1"]
    for title in ("NISAR GUNW", "Capella stack", "DISP-S10", "my_disp_s1x"):
        assert (
            describe_measurement("displacement", {"units": "m"}, {"title": title})[
                "product"
            ]
            is None
        )


def test_layers_that_measure_no_motion_have_none():
    for name, attrs in (
        ("temporal_coherence", {"units": "unitless"}),
        ("recommended_mask", {}),
        ("velocity_stderr", {"units": "m/yr"}),
    ):
        assert describe_measurement(name, attrs) is None
    assert describe_measurement("displacement", {}) is not None


def test_ambiguous_text_is_not_classified():
    m = describe_measurement(
        "displacement",
        {"units": "m", "description": "Vertical motion derived from line-of-sight"},
    )
    assert m["kind"] == "unknown"
