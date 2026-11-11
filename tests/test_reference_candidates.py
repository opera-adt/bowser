"""The stable reference-point finder (``bowser.reference_candidates``).

A synthetic cube with known answers: a planted stable patch, a lone bright pixel
in noise, a perfect-looking lake marked as water, and a second smaller patch.
tests/lite/test_lite_reference_candidates.py compares the full and lite servers
on it.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import xarray as xr

from bowser.reference_candidates import (
    STATS_CACHE,
    CandidateError,
    CandidateParams,
    MissingLayerError,
    _row_runs,
    disc_offsets,
    find_reference_candidates,
    focal_sum,
    nan_median_std,
)

NT, NY, NX = 30, 80, 80
X0, Y0, DX = 436950.0, 3758490.0, 30.0
EPSG = 32611
PATCH = (20, 20, 6)  # row, col, radius in pixels: the planted stable patch
SECOND = (20, 60, 4)  # a smaller, slightly worse patch
LONE = (60, 60)  # one perfect pixel inside noise
WATER = (slice(50, 80), slice(0, 32))  # a perfect-looking lake marked as water


def _disc(r0: int, c0: int, rad: int) -> np.ndarray:
    yy, xx = np.mgrid[:NY, :NX]
    return (yy - r0) ** 2 + (xx - c0) ** 2 <= rad**2


def make_dataset(seed: int = 0) -> xr.Dataset:
    """The synthetic cube as an in-memory dataset (UTM 11N, 30 m)."""
    rng = np.random.default_rng(seed)
    tcoh = rng.uniform(0.2, 0.65, (NT, NY, NX)).astype("float32")
    ps = rng.uniform(0.0, 0.5, (NT, NY, NX)).astype("float32")
    # Background displacement: independent random walks, 5 mm steps.
    disp = np.cumsum(rng.normal(0, 0.005, (NT, NY, NX)), axis=0)
    common = np.cumsum(rng.normal(0, 0.003, NT))[:, None]

    def plant(mask, coh, sim, noise):
        n = int(mask.sum())
        tcoh[:, mask] = coh + rng.normal(0, noise, (NT, n))
        ps[:, mask] = sim + rng.normal(0, noise, (NT, n))
        disp[:, mask] = common + rng.normal(0, 0.0005, (NT, n))

    plant(_disc(*PATCH), 0.95, 0.9, 0.01)
    plant(_disc(*SECOND), 0.9, 0.85, 0.02)
    water = np.zeros((NY, NX), bool)
    water[WATER] = True
    plant(water, 0.99, 0.98, 0.002)
    tcoh[:, LONE[0], LONE[1]] = 0.99
    ps[:, LONE[0], LONE[1]] = 0.99
    tcoh[:3, 0, 0] = np.nan  # a few missing values
    t = np.datetime64("2026-01-01") + np.arange(NT) * np.timedelta64(12, "D")
    x = X0 + DX * (np.arange(NX) + 0.5)
    y = Y0 - DX * (np.arange(NY) + 0.5)
    vel = rng.normal(0, 0.01, (NY, NX)).astype("float32")
    dims3, dims2 = ("time", "y", "x"), ("y", "x")
    return xr.Dataset(
        {
            "temporal_coherence": (dims3, tcoh),
            "phase_similarity": (dims3, ps),
            "displacement": (dims3, disp.astype("float32"), {"units": "meters"}),
            "velocity": (dims2, vel, {"units": "m/yr"}),
            "water_mask": (dims2, (~water).astype("float32")),
            "recommended_mask": (
                dims3,
                np.repeat(((tcoh.mean(0) > 0.7) & ~water)[None], NT, 0).astype(
                    "float32"
                ),
            ),
        },
        coords={"time": t.astype("datetime64[ns]"), "y": y, "x": x},
    )


def write_cube(path: Path, chunks: tuple[int, int, int] = (4, 32, 32)) -> Path:
    """Write the synthetic cube as a chunked GeoZarr store both servers open."""
    import rioxarray  # noqa: F401

    ds = make_dataset()
    for name in ds.data_vars:
        ds[name].attrs["grid_mapping"] = "spatial_ref"
    ds = ds.rio.write_crs(f"EPSG:{EPSG}")
    encoding = {
        name: {"chunks": chunks if ds[name].ndim == 3 else chunks[1:]}
        for name in ds.data_vars
    }
    ds.to_zarr(path, mode="w", consolidated=False, encoding=encoding)
    return path


@pytest.fixture
def ds() -> xr.Dataset:
    STATS_CACHE.clear()
    return make_dataset()


def _run(ds, **kw) -> dict:
    return find_reference_candidates([ds], EPSG, CandidateParams(**kw))


def _rc(c: dict) -> tuple[int, int]:
    return c["row"], c["col"]


def _within(c: dict, r0: int, c0: int, rad: float) -> bool:
    return (c["row"] - r0) ** 2 + (c["col"] - c0) ** 2 <= rad**2


def test_planted_stable_patch_ranks_first(ds):
    out = _run(ds, radius_m=90, n=5)
    best = out["candidates"][0]
    # The circle (3 px) fits inside the 6 px patch: its centre is in the core.
    assert _within(best, PATCH[0], PATCH[1], PATCH[2] - 3)
    assert out["recommended"] == best
    assert best["viable_fraction"] == pytest.approx(1.0)
    assert best["displacement_scatter_m"] < 0.001
    # Everything a set_reference_point call needs.
    assert best["radius_m"] == 90
    assert {"lon", "lat"} <= best.keys()
    assert [c["rank"] for c in out["candidates"]] == list(
        range(1, len(out["candidates"]) + 1)
    )


def test_lone_bright_pixel_ranks_below_a_coherent_neighbourhood(ds):
    out = _run(ds, radius_m=90, n=5)
    ranks = {_rc(c): c for c in out["candidates"]}
    patch_best = out["candidates"][0]
    assert _within(patch_best, PATCH[0], PATCH[1], PATCH[2])
    second = out["candidates"][1]
    assert _within(second, SECOND[0], SECOND[1], SECOND[2])
    lone = ranks[LONE]
    # The lone pixel has the best pixel score of all, yet loses on its circle,
    # to both patches.
    assert lone["pixel_score"] > patch_best["pixel_score"]
    assert lone["rank"] > second["rank"]
    assert lone["viable_fraction"] < 0.1
    assert lone["score"] < second["score"] / 10
    # With single-pixel circles it would win: the circle is what demotes it.
    single = _run(ds, radius_m=0, n=1, k_std=1.0)
    assert _rc(single["candidates"][0]) == LONE


def test_water_is_excluded(ds):
    out = _run(ds, radius_m=90, n=10)
    for c in out["candidates"]:
        assert not (50 <= c["row"] < 80 and 0 <= c["col"] < 32), c
    assert out["layers"]["water_mask"] == "water_mask"
    # Without the water mask the lake would win: the test can tell.
    STATS_CACHE.clear()
    no_water = _run(ds, radius_m=90, n=1, water_mask_layer="")
    top = no_water["candidates"][0]
    assert 50 <= top["row"] < 80 and 0 <= top["col"] < 32


def test_candidates_are_spaced(ds):
    for radius, sep in ((90, None), (60, 600.0), (30, 1200.0)):
        out = _run(ds, radius_m=radius, n=8, min_separation_m=sep, quantile=0.8)
        want = sep if sep is not None else 3 * radius
        assert out["parameters"]["min_separation_m"] == want
        xy = np.array([[c["x"], c["y"]] for c in out["candidates"]])
        assert len(xy) >= 2
        d = np.hypot(*(xy[:, None, :] - xy[None, :, :]).transpose(2, 0, 1))
        assert d[np.triu_indices(len(xy), 1)].min() >= want


def test_thresholds_are_returned(ds):
    out = _run(ds, radius_m=90, quantile=0.9)
    th = out["thresholds"]
    land = make_dataset()["water_mask"].values != 0
    med_c = np.nanmedian(ds["temporal_coherence"].values, axis=0)[land]
    med_p = np.nanmedian(ds["phase_similarity"].values, axis=0)[land]
    assert th["temporal_coherence_median_min"] == pytest.approx(
        np.quantile(med_c[np.isfinite(med_c)], 0.9), rel=1e-6
    )
    assert th["phase_similarity_median_min"] == pytest.approx(
        np.quantile(med_p, 0.9), rel=1e-6
    )
    assert th["from_quantile"] == {"temporal_coherence": True, "phase_similarity": True}
    assert th["quantile"] == 0.9 and th["k_std"] == 1.0
    given = _run(ds, radius_m=90, coherence_min=0.8, similarity_min=0.7)["thresholds"]
    assert given["temporal_coherence_median_min"] == 0.8
    assert given["phase_similarity_median_min"] == 0.7
    assert given["from_quantile"] == {
        "temporal_coherence": False,
        "phase_similarity": False,
    }
    dist = out["distribution"]
    assert dist["temporal_coherence_median"]["p95"] == pytest.approx(
        np.percentile(med_c[np.isfinite(med_c)], 95), rel=1e-6
    )
    assert dist["n_viable_pixels"] > 0


def test_the_cache_is_used_on_the_second_call(ds):
    first = _run(ds, radius_m=90)
    computed = STATS_CACHE.computed
    assert first["cached"] is False and computed >= 2
    second = _run(ds, radius_m=60, n=3)  # other parameters, same reductions
    assert second["cached"] is True
    assert STATS_CACHE.computed == computed
    # Another dataset object is another cache entry.
    third = _run(make_dataset(), radius_m=90)
    assert third["cached"] is False
    assert STATS_CACHE.computed > computed


def test_masks_option_uses_the_recommended_mask(ds):
    out = _run(ds, radius_m=90, use_masks=True)
    assert out["layers"]["masks"] == ["recommended_mask"]
    assert (
        out["distribution"]["n_valid_pixels"]
        < _run(ds)["distribution"]["n_valid_pixels"]
    )


def test_coarse_screening_refines_at_full_resolution(ds):
    coarse = ds.coarsen(x=2, y=2).mean()
    params = CandidateParams(radius_m=90, n=3, max_screen_pixels=NY * NX // 4)
    out = find_reference_candidates([ds, coarse], EPSG, params)
    assert out["screening"]["level"] == 1 and out["screening"]["refined"] is True
    best = out["candidates"][0]
    assert _within(best, PATCH[0], PATCH[1], PATCH[2] - 2)
    # Refined stats are full-resolution ones.
    med = np.nanmedian(ds["temporal_coherence"].values[:, best["row"], best["col"]])
    assert best["temporal_coherence_median"] == pytest.approx(med, rel=1e-6)


def test_dask_and_numpy_reads_agree(ds):
    pytest.importorskip("dask")
    a = _run(ds, radius_m=90)
    STATS_CACHE.clear()
    b = _run(ds.chunk({"time": 4, "y": 32, "x": 32}), radius_m=90)
    a.pop("cached"), b.pop("cached")
    assert a == b


def test_errors(ds):
    with pytest.raises(MissingLayerError, match="Variable nope not found"):
        _run(ds, coherence_layer="nope")
    with pytest.raises(CandidateError, match="projected CRS"):
        find_reference_candidates([ds], 4326, CandidateParams())
    with pytest.raises(CandidateError, match="quantile"):
        _run(ds, quantile=1.5)


def test_median_std_and_focal_sum_match_numpy():
    rng = np.random.default_rng(3)
    block = rng.random((7, 5, 6)).astype("float32")
    block[rng.random(block.shape) < 0.3] = np.nan
    block[:, 0, 0] = np.nan
    with np.errstate(all="ignore"), pytest.warns(RuntimeWarning):
        want_m = np.nanmedian(block, axis=0)
        want_s = np.nanstd(block, axis=0, dtype=np.float64)
    m, s = nan_median_std(block)
    np.testing.assert_allclose(m, want_m, rtol=1e-6)
    np.testing.assert_allclose(s, want_s, rtol=1e-5)
    a = rng.random((9, 11))
    dy, dx = np.array([-1, 0, 0, 0, 1]), np.array([0, -1, 0, 1, 0])
    got = focal_sum(a, _row_runs(dy, dx))
    pad = np.pad(a, 1)
    want = (
        pad[1:-1, 1:-1]
        + pad[:-2, 1:-1]
        + pad[2:, 1:-1]
        + pad[1:-1, :-2]
        + pad[1:-1, 2:]
    )
    np.testing.assert_allclose(got, want)


def test_circle_is_the_viewers_reference_circle(ds):
    from bowser.reference import select_circle

    dy, dx = disc_offsets(ds, 100.0)
    cx, cy = float(ds.x[40]), float(ds.y[40])
    viewer = select_circle(
        ds["displacement"], cx, cy, 100.0, margin_window=True, sqrt_distance=True
    )
    assert dy.size == int(viewer.inside.sum())
