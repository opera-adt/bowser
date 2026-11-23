"""A dated mask combined over its dates (``bowser.mask_dates``).

- the lowest/highest comparison keeps exactly the pixels that pass on every date,
  for every comparison, with missing, nonfinite and fill values failing;
- blocks are read once and reused, and only the blocks a window needs are read;
- the ``/zarr/`` route serves the same values as virtual arrays for the GPU path,
  and refuses what is not a dated mask.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
import xarray as xr
from fastapi import FastAPI
from fastapi.testclient import TestClient

from bowser import mask_dates
from bowser.mask_alignment import mask_condition
from bowser.zarr_files import make_router

OPERATORS = [">=", ">", "<=", "|value| >=", "|value| <="]


@pytest.fixture(autouse=True)
def _empty_cache():
    mask_dates.BLOCKS.clear()
    yield
    mask_dates.BLOCKS.clear()


def _mask(dtype="float32", fill=None):
    rng = np.random.default_rng(3)
    values = rng.uniform(-1, 1, (6, 9, 11)).astype(dtype)
    if np.issubdtype(np.dtype(dtype), np.floating):
        values[2, 1, 1] = np.nan
        values[4, 2, 3] = np.inf
    if fill is not None:
        values[1, 3, 4] = fill
    attrs = {} if fill is None else {"missing_value": fill}
    return xr.DataArray(
        values,
        dims=("time", "y", "x"),
        coords={"time": np.arange(6), "y": np.arange(9)[::-1], "x": np.arange(11)},
        attrs=attrs,
    )


@pytest.mark.parametrize("operator", OPERATORS)
@pytest.mark.parametrize("threshold", [0.0, 0.1, 0.7])
def test_range_comparison_equals_every_date_passing(operator, threshold):
    mask = _mask(fill=-9999)
    expected = mask_condition(mask, threshold, operator).all("time").values
    lowest, highest, smallest = mask_dates.block_range(mask.values, mask.attrs)
    kept = mask_dates.keep_from_range(lowest, highest, threshold, operator, smallest)
    np.testing.assert_array_equal(np.asarray(kept), expected)
    assert not kept[1, 1] and not kept[2, 3] and not kept[3, 4]


def test_integer_masks_and_bad_thresholds():
    values = np.array([[[1, 0]], [[1, 1]]], dtype="uint8")
    lowest, highest, _ = mask_dates.block_range(values, {"_FillValue": 255})
    assert lowest.dtype == np.float64
    np.testing.assert_array_equal(
        mask_dates.keep_from_range(lowest, highest, 1, ">="), [[True, False]]
    )
    with pytest.raises(ValueError):
        mask_dates.keep_from_range(lowest, highest, np.nan, ">=")
    with pytest.raises(ValueError):
        mask_dates.keep_from_range(lowest, highest, -1, "|value| <=")


def test_blocks_are_read_once_and_only_where_needed(monkeypatch):
    mask = _mask()
    mask.encoding["preferred_chunks"] = {"time": 2, "y": 4, "x": 4}
    reads = []
    original = mask_dates.block_range

    def counted(values, attrs=None):
        reads.append(values.shape)
        return original(values, attrs)

    monkeypatch.setattr(mask_dates, "block_range", counted)
    lowest, highest, _ = mask_dates.date_range(mask, "time")
    assert lowest.dims == ("y", "x") and reads == []  # nothing read yet
    window = lowest.isel(y=slice(0, 3), x=slice(5, 7)).values
    assert reads == [(6, 4, 4)]  # one block, all dates
    expected = original(mask.values)[0]
    np.testing.assert_array_equal(window, expected[0:3, 5:7])
    highest.isel(y=slice(0, 3), x=slice(5, 7)).values
    lowest.isel(y=1, x=6).values
    assert reads == [(6, 4, 4)]  # the other end and a point reuse the block
    full = lowest.values
    assert len(reads) == 9  # 3 x 3 blocks for the whole map
    np.testing.assert_array_equal(full, expected)
    # Reverse-ordered and point selections read the same values.
    np.testing.assert_array_equal(
        lowest.isel(x=slice(None, None, -1)).values, expected[:, ::-1]
    )
    assert len(reads) == 9


def test_cache_stays_within_its_budget():
    blocks = mask_dates._Blocks(budget=2000)
    for i in range(10):
        blocks.get(("variable", 1, i), lambda: (np.zeros(50), np.zeros(50)))
    assert blocks.used <= 2000 and len(blocks.items) == 2  # 800 bytes each
    blocks.drop(1)
    assert blocks.used == 0 and not blocks.items


@pytest.fixture
def cube(tmp_path):
    mask = _mask()
    ds = xr.Dataset(
        {
            "recommended_mask": mask,
            "velocity": mask.isel(time=0, drop=True),
        }
    )
    root = tmp_path / "cube.zarr"
    ds.to_zarr(
        root,
        zarr_format=3,
        consolidated=False,
        encoding={
            "recommended_mask": {"chunks": (2, 4, 4)},
            "velocity": {"chunks": (4, 4)},
        },
    )
    app = FastAPI()
    app.include_router(make_router(lambda: root))
    return TestClient(app), mask


@pytest.mark.parametrize("which", ["lowest", "highest"])
def test_gpu_virtual_arrays_match_the_server(cube, which):
    client, mask = cube
    name = f"recommended_mask@{which}_over_dates"
    meta = client.get(f"/zarr/{name}/zarr.json")
    assert meta.status_code == 200
    doc = meta.json()
    assert doc["shape"] == [9, 11] and doc["data_type"] == "float32"
    assert doc["chunk_grid"]["configuration"]["chunk_shape"] == [4, 4]
    lowest, highest, _ = mask_dates.block_range(mask.values, mask.attrs)
    expected = lowest if which == "lowest" else highest
    for row in range(3):
        for col in range(3):
            chunk = client.get(f"/zarr/{name}/c/{row}/{col}")
            assert chunk.status_code == 200
            values = np.frombuffer(chunk.content, "<f4").reshape(4, 4)
            part = expected[row * 4 : row * 4 + 4, col * 4 : col * 4 + 4]
            np.testing.assert_array_equal(
                values[: part.shape[0], : part.shape[1]], part
            )
            # Edge chunks are padded to full size with the fill (NaN).
            assert np.isnan(values[part.shape[0] :, :]).all()
    assert client.head(f"/zarr/{name}/zarr.json").status_code == 200


@pytest.mark.parametrize(
    "path",
    [
        "velocity@lowest_over_dates/zarr.json",  # not dated
        "missing@lowest_over_dates/zarr.json",
        "recommended_mask@lowest_over_dates/c/9/0",  # outside the array
        "recommended_mask@middle_over_dates/zarr.json",
        "../recommended_mask@lowest_over_dates/zarr.json",
    ],
)
def test_virtual_arrays_refuse_what_is_not_a_dated_mask(cube, path):
    client, _ = cube
    assert client.get(f"/zarr/{path}").status_code == 404


def test_virtual_metadata_reads_as_zarr(cube):
    client, _ = cube
    doc = client.get("/zarr/recommended_mask@highest_over_dates/zarr.json").json()
    assert json.loads(json.dumps(doc))["fill_value"] == "NaN"
    assert doc["attributes"]["bowser_combined_dates"] == "time"
