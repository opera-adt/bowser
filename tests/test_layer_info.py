"""General guidance must remain distinct from unmodified producer metadata."""

import copy

import numpy as np
import pytest

from bowser.layer_info import describe_layer, describe_raster_group, radar_wavelength


@pytest.mark.parametrize(
    "left,right",
    [
        ("Phase cosine similarity", "phase_similarity"),
        ("PS mask", "persistent_scatterer_mask"),
        ("SHP counts", "shp_counts"),
        ("Time series residuals (total sum)", "sum_inversion_residuals"),
        ("Connected components", "connected_component_labels"),
        ("Amplitude dispersion", "stack_amplitude_dispersion"),
        ("LOS displacement", "time_series"),
    ],
)
def test_friendly_and_source_names_share_guidance(left, right):
    assert describe_layer(left) == describe_layer(right)


def test_source_description_and_units_are_not_replaced_by_catalog_assumptions():
    attrs = {
        "description": "Positive values are away from this sensor.",
        "long_name": "Source displacement",
        "units": "centimeters",
        "flag_values": np.array([0, 1]),
        "flag_meanings": "retain exclude",
    }
    original = copy.deepcopy(attrs)
    info = describe_layer("displacement", attrs)
    assert info["description_source"] == "source"
    assert info["source_description"] == attrs["description"]
    assert info["unit"] == "centimeters"
    assert info["source_flags"] == [
        {"value": "0", "label": "retain"},
        {"value": "1", "label": "exclude"},
    ]
    assert info["unit_status"] == "provided"
    np.testing.assert_equal(attrs, original)


@pytest.mark.parametrize(
    "name", ["velocity", "water_mask", "ascending_displacement_custom", "future_layer"]
)
def test_missing_metadata_is_not_guessed(name):
    info = describe_layer(name)
    assert info["unit"] == ""
    assert info["source_description"] is None
    assert info["source_flags"] == []
    assert "toward the satellite" not in info["description"]
    assert "1 = land" not in info["description"]


def test_unknown_source_text_is_used_without_guessing_its_meaning():
    info = describe_layer(
        "unfamiliar_observation", {"description": "Temperature anomaly", "units": "K"}
    )
    assert info["description"] == "Temperature anomaly"
    assert info["description_source"] == "source"
    unknown = describe_layer("unfamiliar_observation")
    assert unknown["description_source"] == "unknown"
    assert "documentation" in unknown["description"]


@pytest.mark.parametrize("key", ["description", "comment"])
def test_producer_explanation_leads_and_guidance_is_kept_separately(key):
    text = "Positive values indicate apparent motion towards the platform."
    info = describe_layer("displacement", {key: text, "long_name": "LOS disp."})
    assert info["description"] == text
    assert info["description_source"] == "source"
    assert info["guidance"] == describe_layer("displacement")["description"]
    assert "not automatically total 3D movement" in info["guidance"]


def test_saved_summary_note_travels_with_the_guidance():
    info = describe_layer(
        "average_temporal_coherence",
        {"description": "Temporal coherence of phase inversion"},
    )
    assert info["description"] == "Temporal coherence of phase inversion"
    assert "source time support" in info["guidance"]


@pytest.mark.parametrize(
    "attrs",
    [
        {},
        {"long_name": "Linear LOS velocity", "units": "m/yr"},
        {"description": "   "},
    ],
)
def test_built_in_text_leads_without_a_producer_explanation(attrs):
    info = describe_layer("velocity", attrs)
    assert info["description_source"] == "bowser"
    assert "producer's stated period" in info["description"]
    assert "guidance" not in info


def test_unknown_layers_have_no_separate_guidance():
    info = describe_layer("unfamiliar", {"description": "Temperature anomaly"})
    assert info["description"] == "Temperature anomaly"
    assert "guidance" not in info


def test_group_keeps_the_first_rasters_producer_text_and_guidance():
    headers = [{"description": "First date."}, {"description": "Second date."}]
    info = describe_raster_group("displacement", headers)
    assert info["description"] == "First date."
    assert info["description_source"] == "source"
    assert "starting date come from the producer" in info["guidance"]


def test_a_repeated_variable_label_is_not_treated_as_an_explanation():
    info = describe_layer("unfamiliar_layer", {"long_name": "Unfamiliar layer"})
    assert info["source_description"] == "Unfamiliar layer"
    assert info["description_source"] == "unknown"
    assert "documentation" in info["description"]


@pytest.mark.parametrize("values", [[0, 1], "[0, 1]", "0 1"])
def test_source_categories_keep_valid_zero(values):
    info = describe_layer(
        "water_mask", {"flag_values": values, "flag_meanings": "land water"}
    )
    assert info["source_flags"] == [
        {"value": "0", "label": "land"},
        {"value": "1", "label": "water"},
    ]


@pytest.mark.parametrize(
    "attrs",
    [
        {"flag_masks": [1, 2], "flag_meanings": "a b"},
        {"flag_values": [0], "flag_meanings": "a b"},
        {"flag_values": 0, "flag_meanings": "a"},
    ],
)
def test_missing_or_ambiguous_categories_are_not_fabricated(attrs):
    assert describe_layer("quality", attrs)["source_flags"] == []


@pytest.mark.parametrize(
    "name",
    [
        "average_temporal_coherence",
        "median_phase_similarity",
        "Temporal coherence (minimum)",
    ],
)
def test_saved_quality_summaries_do_not_claim_to_be_current_date_quality(name):
    info = describe_layer(name)
    assert info["description_source"] == "bowser"
    assert "source time support" in info["description"]


def test_quality_clues_do_not_certify_stationary_ground_or_accuracy():
    assert "still move" in describe_layer("ps_mask")["description"]
    assert "independent measurements" in describe_layer("shp_counts")["description"]
    assert "not directly" in describe_layer("estimated_phase_quality")["description"]
    assert (
        "unresolved relative offsets"
        in describe_layer("connected_components")["description"]
    )
    assert (
        "not independent proof"
        in describe_layer("timeseries_inversion_residuals")["description"]
    )


def test_group_does_not_silently_apply_first_raster_units_to_every_date():
    result = describe_raster_group("displacement", [{"units": "m"}, {"units": "cm"}])
    assert result["unit"] == ""
    assert result["unit_status"] == "mixed"
    assert any("no common unit" in text for text in result["metadata_notes"])
    assert (
        describe_raster_group("velocity", [{"units": "m/year"}] * 2)["unit"] == "m/year"
    )
    assert (
        describe_raster_group("displacement", [{}, {"units": "m"}])["unit_status"]
        == "mixed"
    )


def test_group_does_not_use_an_inverted_flag_dictionary_for_all_dates():
    headers = [
        {"flag_values": [0, 1], "flag_meanings": "land water"},
        {"flag_values": [0, 1], "flag_meanings": "water land"},
    ]
    original = copy.deepcopy(headers)
    result = describe_raster_group("water_mask", headers)
    assert result["source_flags"] == []
    assert any("Category meanings differ" in text for text in result["metadata_notes"])
    assert headers == original


def test_radar_wavelength_comes_from_the_cube_or_its_variables():
    assert radar_wavelength({}, {"wavelength_m": "0.05546576"}) == 0.05546576
    assert (
        radar_wavelength({"radar_wavelength": 0.2384}, {"wavelength_m": 0.05}) == 0.2384
    )
    # A filter's cutoff "wavelength" (metres on the ground) and nonsense are not it.
    assert radar_wavelength({"wavelength_cutoff": 50.0}, {"wavelength": 50.0}) is None
    assert radar_wavelength({"wavelength": "C-band"}) is None
    assert radar_wavelength() is None


def test_radar_wavelength_from_a_centre_frequency_in_hertz():
    # NISAR products record centerFrequency (Hz) per band (JPL D-102272).
    lband = radar_wavelength({"centerFrequency": 1257.5e6})
    assert lband == pytest.approx(0.23840, abs=1e-5)
    assert radar_wavelength({"center_frequency": "3.2e9"}) == pytest.approx(0.09369, abs=1e-5)
    # A wavelength, when recorded, wins; an implausible frequency is ignored.
    assert radar_wavelength({"centerFrequency": 1257.5e6, "wavelength": 0.0555}) == 0.0555
    assert radar_wavelength({"centerFrequency": 50.0}) is None
