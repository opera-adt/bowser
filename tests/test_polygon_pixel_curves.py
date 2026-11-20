"""Optional pixel histories use exactly the existing native selection/support."""

import numpy as np
import pytest
import test_polygon_statistics as fixtures
from pyproj import CRS

from bowser import api_models as api
from bowser.lite.polygon import summarize_cube
from bowser.polygon import PolygonRequest, summarize_rasters, summarize_xarray

source = fixtures.source
geometry = fixtures.geometry
group_from = fixtures.group_from


@pytest.mark.parametrize("storage", ["md", "cog", "lite"])
@pytest.mark.parametrize("support", ["common", "per_date"])
def test_pixel_histories_match_source_and_do_not_change_summaries(
    source, tmp_path, storage, support
):
    body = {"variable": "displacement", "geometry": geometry(True), "support": support}

    def run(request):
        if storage == "md":
            return summarize_xarray(source, request, ["a", "b", "c"])
        if storage == "cog":
            return summarize_rasters(group_from(source, tmp_path), request)
        return summarize_cube(source, CRS.from_epsg(4326), request, ["a", "b", "c"])

    original = source.copy(deep=True)
    baseline = run(PolygonRequest(**body))
    result = run(PolygonRequest(**body, curve_mode="all"))
    preview = result.pop("pixel_curves")
    assert result == baseline
    assert preview["mode"] == "all"
    assert not preview["sampled"]
    assert len(preview["curves"]) == preview["eligible_pixels"]
    for curve in preview["curves"]:
        row, col = curve["row"], curve["col"]
        assert curve["x"] == pytest.approx(float(source.x[col]))
        assert curve["y"] == pytest.approx(float(source.y[row]))
        assert not (3 <= row < 5 and 3 <= col < 5)  # hole
        expected = source.values[:, row, col]
        assert curve["values"] == [
            float(v) if np.isfinite(v) else None for v in expected
        ]
    assert any(c["values"] == [0, 0, 0] for c in preview["curves"])
    if support == "per_date":
        assert any(c["values"][1] is None for c in preview["curves"])
    else:
        assert all(None not in c["values"] for c in preview["curves"])
    assert source.identical(original)


def test_sampling_is_reproducible_and_statistics_use_all_eligible_pixels(source):
    body = {
        "variable": "field",
        "geometry": geometry(),
        "curve_mode": "sample",
        "sample_count": 3,
    }
    first = summarize_xarray(source, PolygonRequest(**body), ["a", "b", "c"])
    second = summarize_xarray(source, PolygonRequest(**body), ["a", "b", "c"])
    assert first == second
    preview = first.pop("pixel_curves")
    baseline = summarize_xarray(
        source, PolygonRequest(variable="field", geometry=geometry()), ["a", "b", "c"]
    )
    assert first == baseline
    assert preview["plotted_pixels"] == 3 < preview["eligible_pixels"]
    assert preview["sampled"] and preview["sample_seed"] == 42


def test_empty_support_does_not_fabricate_curves_or_zero(source):
    empty = source * np.nan
    for mode in ("all", "sample"):
        result = summarize_xarray(
            empty,
            PolygonRequest(variable="field", geometry=geometry(), curve_mode=mode),
            ["a", "b", "c"],
        )
        assert result["pixel_curves"]["curves"] == []
        assert result["pixel_curves"]["eligible_pixels"] == 0
        assert all(
            s["count"] == 0 and s["median"] is None for s in result["statistics"]
        )


def test_budgets_reject_instead_of_truncating_or_changing_summaries(
    source, monkeypatch
):
    from bowser import polygon

    monkeypatch.setattr(polygon, "MAX_PIXEL_CURVES", 1)
    body = {"variable": "field", "geometry": geometry()}
    with pytest.raises(ValueError, match="All-pixel curve limit"):
        summarize_xarray(
            source, PolygonRequest(**body, curve_mode="all"), ["a", "b", "c"]
        )
    baseline = summarize_xarray(source, PolygonRequest(**body), ["a", "b", "c"])
    assert "pixel_curves" not in baseline
    monkeypatch.setattr(polygon, "MAX_CURVE_VALUES", 2)
    reads = []

    def load(i):
        reads.append(i)
        return np.ones(3)

    with pytest.raises(ValueError, match="value budget"):
        polygon._summaries(load, 3, 3, "common", [10, 90], "sample", 1)
    assert reads == [0, 1, 2]  # no second pass or large curve buffer before rejection


@pytest.mark.parametrize("sample_count", [0, 501, 2.5, True])
def test_invalid_samples_are_rejected(sample_count):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        PolygonRequest(
            variable="field",
            geometry=geometry(),
            curve_mode="sample",
            sample_count=sample_count,
        )


@pytest.mark.parametrize("flip", ["x", "y"])
def test_lite_coordinates_on_reversed_axes_use_the_reported_grid(source, flip):
    source = source.isel({flip: slice(None, None, -1)})
    result = summarize_cube(
        source,
        CRS.from_epsg(4326),
        PolygonRequest(variable="field", geometry=geometry(), curve_mode="all"),
        ["a", "b", "c"],
    )
    a, b, c, d, e, f = result["grid"]["transform"]
    for curve in result["pixel_curves"]["curves"]:
        assert curve["x"] == pytest.approx(
            c + (curve["col"] + 0.5) * a + (curve["row"] + 0.5) * b
        )
        assert curve["y"] == pytest.approx(
            f + (curve["col"] + 0.5) * d + (curve["row"] + 0.5) * e
        )
        values = source.sel(x=curve["x"], y=curve["y"], method="nearest").values
        assert curve["values"] == [float(v) if np.isfinite(v) else None for v in values]


def test_static_raster_curves_have_one_saved_value(source):
    result = summarize_xarray(
        source.isel(date=0),
        PolygonRequest(
            variable="saved_velocity",
            geometry=geometry(),
            curve_mode="sample",
            sample_count=2,
        ),
        ["Stored layer"],
    )
    assert all(len(c["values"]) == 1 for c in result["pixel_curves"]["curves"])
    api.PolygonStatistics.model_validate(result)
