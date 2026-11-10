"""bowser-lite reading cubes: opening stores and pyramids, metadata, masked sampling."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import xarray as xr

from bowser.lite import cube as lcube
from bowser.lite import meta, sampling, tiles

REGRESSION = Path(__file__).resolve().parents[1] / "regression"


@pytest.fixture(scope="module")
def regression_cube(tmp_path_factory) -> Path:
    pytest.importorskip("rioxarray")
    sys.path.insert(0, str(REGRESSION))
    from cube import make_cube

    return make_cube(tmp_path_factory.mktemp("cube") / "regression.zarr")


def _plain_cube(
    path: Path,
    n: int = 16,
    with_geotransform: bool = False,
    spatial_ref_time: bool = False,
) -> Path:
    """A cube written with plain xarray (no rioxarray): CRS only in ``spatial_ref``."""
    from pyproj import CRS

    x = 500000.0 + 30.0 * (np.arange(n) + 0.5)
    y = 4000000.0 - 30.0 * (np.arange(n) + 0.5)
    t = np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]")
    attrs = {"crs_wkt": CRS.from_epsg(32611).to_wkt()}
    if with_geotransform:
        attrs["GeoTransform"] = "500000.0 30.0 0.0 4000000.0 0.0 -30.0"
    sr = xr.DataArray(
        np.zeros(2, "int64") if spatial_ref_time else 0,
        dims=("time",) if spatial_ref_time else (),
        attrs=attrs,
    )
    data = np.arange(2 * n * n, dtype="float32").reshape(2, n, n)
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                data,
                {"units": "meters", "grid_mapping": "spatial_ref"},
            ),
            "coh": (
                ("y", "x"),
                np.linspace(0, 1, n * n, dtype="float32").reshape(n, n),
            ),
        },
        coords={"time": t, "x": x, "y": y, "spatial_ref": sr},
        attrs={"title": "Plain"},
    )
    ds.to_zarr(path, mode="w", consolidated=False)
    return path


def test_open_flat_cube_reads_crs_and_normalises(tmp_path):
    c = lcube.open_cube(str(_plain_cube(tmp_path / "p.zarr", spatial_ref_time=True)))
    assert c.crs.to_epsg() == 32611 and c.mode == "md"
    assert c.dataset["spatial_ref"].dims == ()  # first time step, as the full server
    assert "grid_mapping" not in c.dataset["displacement"].attrs
    assert c.bounds() == (500000.0, 4000000.0 - 16 * 30, 500000.0 + 16 * 30, 4000000.0)
    assert len(c.levels) == 1 and c.dataset_for_tile_zoom(3) is c.dataset
    lon, lat = c.transformer_from_lonlat.transform(
        500000.0, 4000000.0, direction="INVERSE"
    )
    assert -117.1 < lon < -116.9 and 36 < lat < 36.2


def test_open_pyramid_picks_levels_by_zoom(tmp_path):
    store = tmp_path / "pyr.zarr"
    base = xr.open_zarr(_plain_cube(tmp_path / "flat.zarr", n=32), consolidated=False)
    base.to_zarr(store, group="0", mode="w", consolidated=False)
    coarse = base.coarsen(x=2, y=2).mean().assign_coords(spatial_ref=base.spatial_ref)
    coarse.to_zarr(store, group="1", mode="a", consolidated=False)
    import zarr

    root = zarr.open_group(str(store), mode="a")
    root.attrs.update(
        {
            "multiscales": {"layout": [{"asset": "0"}, {"asset": "1"}]},
            "heading_angle_deg": 12.0,
        }
    )
    c = lcube.open_cube(str(store))
    assert [lv.asset for lv in c.levels] == ["0", "1"]
    assert [lv.pixel_size_m for lv in c.levels] == [30.0, 60.0]
    assert c.dataset.attrs["heading_angle_deg"] == 12.0  # root attrs merged in
    assert c.dataset_for_tile_zoom(16) is c.levels[0].dataset  # 2.4 m tile pixels
    assert c.dataset_for_tile_zoom(11) is c.levels[1].dataset  # 76 m tile pixels


def test_load_default_needs_a_cube_or_catalog():
    # A stand-in for Settings: importing bowser.config here would build its
    # global settings from this env, and later in-process app imports reuse them.
    def settings(stack: str, catalog: str):
        return SimpleNamespace(
            BOWSER_STACK_DATA_FILE=stack, BOWSER_CATALOG_FILE=catalog
        )

    with pytest.raises(ValueError, match="COG mode"):
        lcube.load_default(settings("", ""))
    assert lcube.load_default(settings("", "cat.toml")) is None


def test_registry_lru(tmp_path):
    from bowser.catalog import CatalogEntry

    path = str(_plain_cube(tmp_path / "a.zarr"))
    entries = {
        f"c{i}": CatalogEntry(id=f"c{i}", name=f"C{i}", uri=path, bbox=(0, 0, 1, 1))
        for i in range(3)
    }
    reg = lcube.Registry(catalog=entries, maxsize=2)
    a = reg.get("c0")
    assert reg.get("c0") is a
    reg.get("c1"), reg.get("c2")
    assert list(reg._cache) == ["c1", "c2"]
    with pytest.raises(KeyError, match="unknown dataset id"):
        reg.get("zz")
    reg.register(CatalogEntry(id="new", name="N", uri=path, bbox=(0, 0, 1, 1)), a)
    assert reg.get("new") is a and "new" in reg.ids()


def test_dim_labels_and_reference_date():
    t = np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]")
    da = xr.DataArray(np.zeros((2, 1, 1)), dims=("time", "y", "x"), coords={"time": t})
    assert meta.dim_labels(da, "time") == ["2026-01-01", "2026-01-13"]
    pair = xr.DataArray(
        np.zeros((2, 1, 1)),
        dims=("pair", "y", "x"),
        coords={
            "reference_date_x": ("pair", t[[0, 0]]),
            "secondary_date_x": ("pair", t),
        },
    )
    labels = meta.dim_labels(pair, "pair")
    assert labels == ["2026-01-01_2026-01-01", "2026-01-01_2026-01-13"]
    assert meta.reference_date(labels, "pair_x") == "2026-01-01"
    assert meta.reference_date(labels, "time") is None
    named = pair.assign_coords(pair_label_x=("pair", ["a", "b"]))
    assert meta.dim_labels(named, "pair") == ["a", "b"]
    assert (
        meta.non_spatial_dim(da) == "time"
        and meta.non_spatial_dim(da.isel(time=0)) is None
    )


def test_los_metadata_and_reference_point():
    assert meta.los_metadata({}) is None
    legacy = meta.los_metadata(
        {
            "heading_angle_deg": 1,
            "incidence_angle_deg": 35,
            "los_enu_ground_to_sat": {"east": 0.5, "north": 0.1, "up": 0.8},
        }
    )
    assert legacy == {
        "heading_deg": 1.0,
        "incidence_deg": 35.0,
        "los_enu_ground_to_sat": {"east": 0.5, "north": 0.1, "up": 0.8},
    }
    swath = meta.los_metadata(
        {
            "heading_angle_deg": 1,
            "incidence_angle_deg": {"near": 30, "center": 35, "far": 40},
            "los_enu_ground_to_satellite": {
                "center": {"east": 1, "north": 0, "up": 0},
                "far": {"east": 0, "north": 1, "up": 0},
            },
        }
    )
    assert (
        swath["incidence_deg_near"] == 30.0
        and "los_enu_ground_to_sat_far" in swath
        and "los_enu_ground_to_sat_near" not in swath
    )
    ds = xr.Dataset(attrs={"reference_lonlat": [-117.0, 34.0]})
    assert meta.reference_lonlat(ds) == [-117.0, 34.0]
    assert (
        meta.reference_lonlat(
            xr.Dataset(attrs={"reference_point": [400000.0, 3700000.0]})
        )
        is None
    )
    assert meta.reference_lonlat(
        xr.Dataset(attrs={"reference_lon": 1, "reference_lat": 2})
    ) == [1.0, 2.0]


def test_latlon_bounds_match_rioxarray_reproject(regression_cube, tmp_path):
    """``/datasets`` latlon_bounds: the full server warps a 10x subsample."""
    pytest.importorskip("rioxarray")
    for path in (
        regression_cube,
        _plain_cube(tmp_path / "gt.zarr", n=64, with_geotransform=True),
    ):
        c = lcube.open_cube(str(path))
        ds = xr.open_zarr(path, consolidated=False)
        if "time" in ds.spatial_ref.dims:
            ds = ds.assign_coords(
                spatial_ref=ds.spatial_ref.isel(time=0).drop_vars("time")
            )
        ds = ds.rio.write_crs(c.crs.to_wkt())
        da = ds["displacement"][..., ::10, ::10][0]
        want = da.rio.reproject("epsg:4326", subsample=10).rio.bounds()
        assert meta.latlon_bounds(c) == pytest.approx(want, rel=1e-9)
        info = meta.dataset_info(c, True)["displacement"]
        assert info["bounds"] == pytest.approx(list(ds.rio.bounds()))
        assert info["algorithm"] == "shift" and info["unit"] == "meters"


def test_masked_point_equals_mask_then_select(regression_cube):
    c = lcube.open_cube(str(regression_cube))
    masks = [
        {"dataset": "temporal_coherence", "threshold": 0.8, "mode": "min"},
        {"dataset": "phase_similarity", "threshold": 0.85, "mode": "max"},
    ]
    ds = c.dataset
    for lon, lat in (
        (-117.67462, 33.95859),
        (-117.6800, 33.9600),
        (-117.6700, 33.9550),
    ):
        x, y = c.transformer_from_lonlat.transform(lon, lat)
        full = (
            ds["displacement"]
            .where(ds["temporal_coherence"].isel(time=0) >= 0.8)
            .where(ds["phase_similarity"].isel(time=0) <= 0.85)
        )
        want = full.sel(x=x, y=y, method="nearest").values
        np.testing.assert_array_equal(
            sampling.point_values(c, "displacement", lon, lat, masks), want
        )
        np.testing.assert_array_equal(
            sampling.point_values(c, "displacement", lon, lat, time_idx=9),
            ds["displacement"]
            .isel(time=5)
            .sel(x=x, y=y, method="nearest")
            .values.reshape(1),
        )


def test_values_at_matches_vectorised_sel(regression_cube):
    c = lcube.open_cube(str(regression_cube))
    lons = np.linspace(-117.684, -117.665, 40)
    lats = np.linspace(33.950, 33.967, 40)
    got = sampling.values_at(c, "displacement", 4, lons, lats)
    da = c.dataset["displacement"].isel(time=4)
    xs, ys = c.transformer_from_lonlat.transform(lons, lats)
    want = da.sel(
        x=xr.DataArray(xs, dims="p"), y=xr.DataArray(ys, dims="p"), method="nearest"
    ).values.astype(float)
    inside = (
        (xs >= da.x.min().item())
        & (xs <= da.x.max().item())
        & (ys >= da.y.min().item())
        & (ys <= da.y.max().item())
    )
    want[~inside] = np.nan
    np.testing.assert_array_equal(got, want)
    assert np.isnan(sampling.values_at(c, "nope", 0, lons, lats)).all()
    assert sampling.value_at(
        c, "displacement", 4, -117.67462, 33.95859
    ) == pytest.approx(float(da.sel(x=xs[20], y=ys[20], method="nearest")), abs=1)


def test_buffer_and_ref_median(regression_cube):
    c = lcube.open_cube(str(regression_cube))
    window, disc = sampling.buffer_window(
        c, "displacement", -117.67462, 33.95859, 90, []
    )
    assert disc.sum() > 20 and window.shape[1:] == disc.shape
    ref = sampling.ref_values(c, "displacement", -117.67462, 33.95859, 90)
    assert ref.shape == (6,)
    np.testing.assert_allclose(
        ref, np.nanmedian(sampling.buffer_pixels(window, disc), axis=1)
    )
    assert sampling.buffer_window(c, "displacement", -100.0, 10.0, 90, []) is None


def test_tile_source_masks_like_the_full_server(regression_cube):
    c = lcube.open_cube(str(regression_cube))
    layer_masks = '[{"dataset": "phase_similarity", "threshold": 0.8, "mode": "min"}]'
    q = tiles.TileQuery(
        variable="displacement",
        time_idx=99,
        mask_variable="recommended_mask",
        mask_min_value=0.5,
        layer_masks=layer_masks,
    )
    da, masked = tiles.tile_source(c.dataset, q)
    assert da.dims == ("y", "x") and int(da.time.dt.day) == int(
        c.dataset.time[-1].dt.day
    )
    sel = {"y": slice(0, 48), "x": slice(0, 48)}
    got = masked(da.isel(sel).load(), lambda a: a.isel(sel).load())
    ds = c.dataset
    want = da.where(ds.recommended_mask.isel(time=5) > 0.5).where(
        ds.phase_similarity.isel(time=5) >= 0.8
    )
    xr.testing.assert_identical(got.drop_vars("time"), want.drop_vars("time"))
    with pytest.raises(Exception, match="not found"):
        tiles.tile_source(c.dataset, tiles.TileQuery(variable="nope"))


def test_datasets_carry_the_cubes_radar_wavelength(tmp_path):
    """``/datasets``: the radar wavelength a variable records, for the series checks."""
    c = lcube.open_cube(str(_plain_cube(tmp_path / "w.zarr")))
    assert "radar_wavelength_m" not in meta.dataset_info(c, True)["displacement"]
    c.dataset["coh"].attrs["wavelength_m"] = "0.05546576"
    info = meta.dataset_info(c, True)
    assert info["displacement"]["radar_wavelength_m"] == 0.05546576
    assert info["coh"]["radar_wavelength_m"] == 0.05546576
