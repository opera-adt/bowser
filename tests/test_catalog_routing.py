"""Catalog mode: every MD endpoint honours ``?dataset=<id>``.

``bowser.main`` reads its settings at import, so the app runs in a subprocess with
``BOWSER_CATALOG_FILE`` set, the same isolation the CLI tests get.
"""

import os
import subprocess
import sys
import textwrap

import numpy as np
import pytest
import xarray as xr

rioxarray = pytest.importorskip("rioxarray")


def _cube(path, offset: float) -> None:
    """A 3-date, 8x8 displacement cube in UTM 11N whose values encode ``offset``."""
    t = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    x = 436950.0 + 30.0 * (np.arange(8) + 0.5)
    y = 3758490.0 - 30.0 * (np.arange(8) + 0.5)
    data = offset + np.arange(3, dtype="float32")[:, None, None] * np.ones(
        (3, 8, 8), "float32"
    )
    ds = xr.Dataset(
        {"displacement": (("time", "y", "x"), data, {"units": "meters"})},
        coords={"time": t, "y": y, "x": x},
    ).rio.write_crs("EPSG:32611")
    ds.to_zarr(path, mode="w", consolidated=False)


SCRIPT = textwrap.dedent(
    """
    from fastapi.testclient import TestClient
    from bowser.main import app

    c = TestClient(app)
    lon, lat = -117.687, 33.968   # inside both cubes
    q = {"dataset_name": "displacement", "lon": lon, "lat": lat}
    a = c.get("/point", params={**q, "dataset": "cube-a"})
    b = c.get("/point", params={**q, "dataset": "cube-b"})
    assert a.status_code == 200, a.text
    assert b.status_code == 200, b.text
    assert a.json() == [10.0, 11.0, 12.0], a.json()
    assert b.json() == [20.0, 21.0, 22.0], b.json()

    body = {"dataset_name": "displacement", "points": [{"lon": lon, "lat": lat}]}
    m = c.post("/multi_point", params={"dataset": "cube-b"}, json=body)
    assert m.status_code == 200, m.text

    cfg = c.get("/config", headers={"referer": "http://localhost/?dataset=cube-b"})
    assert cfg.json() == {
        "title": "Cube B",
        "opera_logo": False,
        "geotiff_export": True,
        "polygon_stats": True,
        "assistant": {
        "enabled": False,
        "providers": [],
        "configured": [],
        "sign_in": [],
        "page_channel": False,
    },
        "geotiff_upload": True,
    }, cfg.json()
    assert c.get("/config").json()["title"] != "Cube B"

    assert c.get("/point", params={**q, "dataset": "nope"}).status_code == 404
    print("OK")
"""
)


def test_catalog_endpoints_route_by_dataset(tmp_path):
    from bowser.catalog import CatalogEntry, save_catalog

    entries = []
    for key, name, offset in (("cube-a", "Cube A", 10.0), ("cube-b", "Cube B", 20.0)):
        p = tmp_path / f"{key}.zarr"
        _cube(p, offset)
        entries.append(
            CatalogEntry(
                id=key, name=name, uri=str(p), bbox=(-117.69, 33.96, -117.68, 33.97)
            )
        )
    catalog = tmp_path / "catalog.toml"
    save_catalog(entries, catalog)

    env = {**os.environ, "BOWSER_CATALOG_FILE": str(catalog)}
    r = subprocess.run(
        [sys.executable, "-c", SCRIPT],
        env=env,
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )
    assert r.returncode == 0 and "OK" in r.stdout, r.stdout[-2000:] + r.stderr[-4000:]
