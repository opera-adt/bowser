"""GeoTIFF metadata must advertise usable tiles without changing source data."""

import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import pytest
import rasterio
from morecantile import tms
from rio_tiler.io import Reader

from bowser.readers import CustomReader


def raster(path, bands=1):
    bounds = tms.get("WebMercatorQuad").xy_bounds(2048, 2047, 12)
    values = np.arange(bands * 256, dtype="float32").reshape(bands, 16, 16)
    values[:, 0, 0] = -9999
    values[:, 3, 3] = 0
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=16,
        height=16,
        count=bands,
        dtype="float32",
        crs=3857,
        nodata=-9999,
        transform=rasterio.transform.from_bounds(*bounds, 16, 16),
    ) as dst:
        dst.write(values)
        for band in range(1, bands + 1):
            dst.set_band_description(band, f"Synthetic component {band}")
            dst.set_band_unit(band, "meters")
        dst.update_tags(source="Synthetic radar")
    return values


@pytest.mark.parametrize("bands", [1, 2])
@pytest.mark.parametrize("mask_kind", ["none", "primary", "extra"])
def test_info_is_source_metadata_not_mask_statistics(tmp_path, bands, mask_kind):
    path = tmp_path / "source.tif"
    raster(path, bands)
    mask = tmp_path / "quality.tif"
    raster(mask)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    options = {"data": str(path), "mask_min_value": 0.5}
    if mask_kind == "primary":
        options["mask"] = str(mask)
    if mask_kind == "extra":
        options["extra_masks"] = [(str(mask), 0.5)]
    with Reader(path) as source, CustomReader(options) as wrapped:
        expected = source.info()
        actual = wrapped.info()
        assert actual == expected
        assert actual.dtype == "float32"
        assert len(actual.band_descriptions) == bands
        assert actual.band_descriptions[0][1] == "Synthetic component 1"
        assert actual.nodata_type == "Nodata"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_actual_cog_tilejson_and_advertised_png(tmp_path):
    source = tmp_path / "source.tif"
    values = raster(source)[0]
    quality = tmp_path / "quality.tif"
    raster(quality)
    keep = np.ones((16, 16), dtype="float32")
    keep[5:8, 6:10] = 0
    with rasterio.open(quality, "r+") as dst:
        dst.write(keep, 1)
    config = [
        {"name": name, "file_list": [str(path)], "uses_spatial_ref": False}
        for name, path in [("displacement", source), ("quality", quality)]
    ]
    (tmp_path / "rasters.json").write_text(json.dumps(config))
    hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in [source, quality]]
    script = r"""
import io, json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
from pyproj import Transformer
from morecantile import tms
from bowser.main import app

client = TestClient(app)
source = str(Path("source.tif").absolute())
base = dict(url=source, variable="displacement", time_idx=0, tile_format="png",
            rescale="0,255", colormap_name="viridis", tilesize=256)
for masked in (False, True):
    masks = [{"dataset":"quality", "threshold":0.5, "mode":"min"}]
    params = {**base, **({"layer_masks":json.dumps(masks)} if masked else {})}
    response = client.get("/cog/WebMercatorQuad/tilejson.json", params=params)
    assert response.status_code == 200, response.text[:400]
    meta = response.json()
    assert meta["data_type"] == "float32"
    assert meta["band_descriptions"] == [["b1", "Synthetic component 1"]]
    assert 0 <= meta["minzoom"] <= meta["maxzoom"]
    left,bottom,right,top = tms.get("WebMercatorQuad").xy_bounds(2048,2047,12)
    transform = Transformer.from_crs(3857,4326,always_xy=True)
    np.testing.assert_allclose(meta["bounds"],
        [*transform.transform(left,bottom), *transform.transform(right,top)],
        atol=1e-10, rtol=0)
    advertised = meta["tiles"][0]
    query = parse_qs(urlsplit(advertised).query)
    assert query["url"] == [source]
    assert query["variable"] == ["displacement"]
    assert query["tilesize"] == ["256"]
    if masked:
        assert json.loads(query["layer_masks"][0]) == masks
    tile = client.get(advertised.replace("{z}","12").replace("{x}","2048")
                      .replace("{y}","2047"))
    assert tile.status_code == 200, tile.text[:200] if tile.status_code != 200 else ""
    pixels = np.array(Image.open(io.BytesIO(tile.content)).convert("RGBA"))
    valid = np.ones((16,16),bool)
    valid[0,0] = False
    if masked:
        valid[5:8,6:10] = False
    np.testing.assert_array_equal(pixels[:,:,3] > 0, valid.repeat(16,0).repeat(16,1))
    assert pixels[3*16,3*16,3] > 0  # valid zero data remain displayed
print("TileJSON and advertised PNG passed")
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE="",
        BOWSER_DATASET_CONFIG_FILE=str(tmp_path / "rasters.json"),
        BOWSER_REF_WARMUP="0",
    )
    result = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout[-1000:] + result.stderr[-4000:]
    assert "TileJSON and advertised PNG passed" in result.stdout
    assert hashes == [
        hashlib.sha256(p.read_bytes()).hexdigest() for p in [source, quality]
    ]
    assert values[3, 3] == 0
