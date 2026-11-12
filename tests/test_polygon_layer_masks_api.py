"""Exercise explicit masks through actual full/lite and catalog HTTP routes."""

import json
import os
import subprocess
import sys

import pytest
from test_polygon_layer_masks import inputs as inputs

from bowser.catalog import CatalogEntry, save_catalog


@pytest.fixture
def responses(inputs, tmp_path):
    ds, groups, body = inputs
    ds.to_zarr(tmp_path / "cube.zarr", consolidated=False)
    alternate = ds.copy(deep=True)
    alternate["quality"] = ds.quality * 0
    alternate.to_zarr(tmp_path / "alternate.zarr", consolidated=False)
    save_catalog(
        [
            CatalogEntry(
                id="alternate",
                name="Alternate",
                uri=str(tmp_path / "alternate.zarr"),
                bbox=(10, 45, 11, 46),
            )
        ],
        tmp_path / "catalog.toml",
    )
    manifest = {
        "body": body,
        "files": {name: group.file_list for name, group in groups.items()},
    }
    (tmp_path / "inputs.json").write_text(json.dumps(manifest))
    script = r"""
import io
import json
from pathlib import Path

import numpy as np
import rasterio
from fastapi.testclient import TestClient
from bowser import main
from bowser import api_models as api
from bowser.state import BowserState
from bowser.titiler import RasterGroup
from bowser.lite.main import app as lite_app

work = Path.cwd()
inputs = json.loads((work / 'inputs.json').read_text())
md = main._default_state
groups = {name: RasterGroup(name=name, file_list=paths)
          for name, paths in inputs['files'].items()}
cog = BowserState(mode='cog', raster_groups=groups)
results = {}
mask = [{'dataset': 'quality', 'threshold': 0.5, 'mode': 'min'}]
for storage, state, app in [('md', md, main.app), ('cog', cog, main.app),
                            ('lite', None, lite_app)]:
    if state is not None:
        main._default_state = state
    client = TestClient(app)
    for name, options in [('raw', {}), ('masked', {'layer_masks': mask}),
                          ('unknown', {'layer_masks': [{'dataset': 'absent'}]}),
                          ('unsupported_reference', {'ref_lon': 10, 'ref_lat': 45})]:
        response = client.post('/polygon_timeseries',
                               json={**inputs['body'], **options})
        results[storage + '_' + name] = {
            'status': response.status_code, 'body': response.json()}
        if response.status_code == 200:
            api.PolygonStatistics.model_validate(response.json())
    # Compare every scalar export to the masked polygon's statistics, without
    # involving display colors, references, new fits, or a simplified renderer.
    exported = []
    for i in range(3):
        response = client.get('/export/geotiff', params={
            'variable': 'displacement', 'time_idx': i, 'layer_masks': json.dumps(mask),
        })
        assert response.status_code == 200, response.text[:100]
        with rasterio.MemoryFile(response.content) as mem, mem.open() as src:
            exported.append(src.read(1, masked=True).filled(np.nan).tolist())
    results[storage + '_exports'] = exported
    if storage != 'cog':
        response = client.post('/polygon_timeseries', params={'dataset': 'alternate'},
                               json={**inputs['body'], 'layer_masks': mask})
        results[storage + '_catalog'] = {
            'status': response.status_code, 'body': response.json()}
(work / 'result.json').write_text(json.dumps(results))
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(tmp_path / "cube.zarr"),
        BOWSER_CATALOG_FILE=str(tmp_path / "catalog.toml"),
        BOWSER_REF_WARMUP="0",
    )
    process = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert process.returncode == 0, process.stdout[-1500:] + process.stderr[-5000:]
    return json.loads((tmp_path / "result.json").read_text())


@pytest.mark.parametrize("storage", ["md", "lite", "cog"])
def test_explicit_api_masks_match_actual_exported_values(responses, storage):
    import numpy as np

    assert responses[storage + "_masked"]["status"] == 200
    result = responses[storage + "_masked"]["body"]
    assert result["reference"] == "stored"
    assert result["optional_masks_applied"] is True
    frames = np.array(responses[storage + "_exports"], dtype=float)
    common = np.isfinite(frames).all(axis=0)
    assert result["common_pixels"] == common.sum()
    assert (
        result["common_pixels"] < responses[storage + "_raw"]["body"]["common_pixels"]
    )
    for i, row in enumerate(result["statistics"]):
        values = frames[i][common]
        assert row["count"] == values.size
        assert row["mean"] == pytest.approx(np.mean(values), rel=1e-12)
        assert row["median"] == pytest.approx(np.median(values), rel=1e-12)
    assert responses[storage + "_unknown"]["status"] == 422
    assert responses[storage + "_unsupported_reference"]["status"] == 422


@pytest.mark.parametrize("storage", ["md", "lite"])
def test_catalog_mask_context_stays_with_the_selected_cube(responses, storage):
    assert responses[storage + "_catalog"]["status"] == 200
    assert responses[storage + "_catalog"]["body"]["common_pixels"] == 0
