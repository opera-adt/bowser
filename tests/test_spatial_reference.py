"""Tests for deciding which variables get a moving spatial reference point."""

import numpy as np
import pytest
import xarray as xr

from bowser.utils import _is_relative_unit, _uses_spatial_reference


def _var(units: str | None = None, **attrs) -> xr.DataArray:
    """Build a minimal 2D DataArray carrying ``units`` and any extra attrs."""
    da = xr.DataArray(np.zeros((2, 2)), dims=("y", "x"))
    if units is not None:
        da.attrs["units"] = units
    da.attrs.update(attrs)
    return da


class TestIsRelativeUnit:
    @pytest.mark.parametrize(
        "units",
        ["meters", "meter", "m", "metres", "mm", "cm", "radians", "rad", "degrees"],
    )
    def test_lengths_and_angles(self, units):
        assert _is_relative_unit(units)

    @pytest.mark.parametrize("units", ["meters / year", "mm/yr", "m / s"])
    def test_rates_match_on_numerator(self, units):
        assert _is_relative_unit(units)

    @pytest.mark.parametrize("units", ["unitless", "", "1", "count", "dB", "seconds"])
    def test_non_relative(self, units):
        assert not _is_relative_unit(units)


class TestUsesSpatialReference:
    def test_explicit_attr_wins_over_units(self):
        """A producer saying False beats a relative unit."""
        var = _var("meters", bowser_uses_spatial_ref=False)
        assert not _uses_spatial_reference("displacement", var)

    def test_explicit_attr_enables_unitless_variable(self):
        var = _var(bowser_uses_spatial_ref=True)
        assert _uses_spatial_reference("some_custom_layer", var)

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("true", True), ("True", True), ("yes", True), ("false", False), ("0", False)],
    )
    def test_explicit_attr_accepts_strings(self, value, expected):
        """Zarr attrs round-trip as JSON, but producers may write strings."""
        var = _var(bowser_uses_spatial_ref=value)
        assert _uses_spatial_reference("displacement", var) is expected

    @pytest.mark.parametrize(
        ("name", "units"),
        [
            ("displacement", "meters"),  # DISP-S1
            ("time_series", "meters"),  # dolphin
            ("unwrapped", "radians"),  # dolphin
            ("velocity", "meters / year"),  # dolphin
        ],
    )
    def test_relative_units_opt_in(self, name, units):
        assert _uses_spatial_reference(name, _var(units))

    @pytest.mark.parametrize(
        "name",
        [
            "temporal_coherence",
            "phase_similarity",
            "recommended_mask",
            "connected_components",
            "interferograms",
            "ps_mask",
        ],
    )
    def test_unitless_layers_opt_out(self, name):
        assert not _uses_spatial_reference(name, _var())

    def test_water_mask_declaring_unitless_opts_out(self):
        assert not _uses_spatial_reference("water_mask", _var("unitless"))

    def test_short_wavelength_displacement_is_excluded(self):
        """Already spatially high-pass filtered: a moving reference misleads."""
        assert not _uses_spatial_reference(
            "short_wavelength_displacement", _var("meters")
        )

    def test_short_wavelength_exclusion_is_overridable(self):
        """The name-based exception is only a fallback for older products."""
        var = _var("meters", bowser_uses_spatial_ref=True)
        assert _uses_spatial_reference("short_wavelength_displacement", var)

    def test_custom_producer_name_still_works(self):
        """The old substring list would have missed this entirely."""
        assert _uses_spatial_reference("los_deformation", _var("meters"))
