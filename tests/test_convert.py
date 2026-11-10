"""Added files: the COG check, the one-time conversions and their bounded cache.

``bowser.convert`` reads no settings, so it is imported in the tests; the routes
that use it are in test_data_api.py.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
gdal = pytest.importorskip("osgeo.gdal")

from test_dem import NODATA, _hills, _write  # noqa: E402


@pytest.fixture
def cache(tmp_path, monkeypatch) -> Path:
    folder = tmp_path / "cache"
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_DIR", str(folder))
    monkeypatch.delenv("BOWSER_CONVERT_CACHE_MAX_GB", raising=False)
    monkeypatch.delenv("BOWSER_CONVERT_CACHE_MAX_DAYS", raising=False)
    folder.mkdir()
    return folder


@pytest.fixture
def sync(monkeypatch) -> None:
    """Run conversions in the calling thread: no race with the background thread."""
    from bowser import convert

    monkeypatch.setattr(convert, "_start", lambda target, args: target(*args))


def _wait(convert, key: str, folder: Path, timeout: float = 120) -> dict:
    t0 = time.time()
    while (s := convert.status(key, folder))["status"] == "converting":
        assert time.time() - t0 < timeout, s
        time.sleep(0.05)
    return s


def squares(path: Path, n: int, columns: int = 100) -> Path:
    """Write ``n`` small square parcels near -90.1, 34.75 as GeoJSON, with fields."""
    rng = np.random.default_rng(0)
    features = []
    for i in range(n):
        x = -90.2 + (i % columns) * 0.002 + rng.random() * 1e-4
        y = 34.70 + (i // columns) * 0.002
        d = 0.0015
        features.append(
            {
                "type": "Feature",
                "properties": {"parcel": i, "owner": f"owner {i % 7}", "acres": i / 4},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]
                    ],
                },
            }
        )
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    return path


# --- COG check ---------------------------------------------------------------------


def test_is_cog(tmp_path):
    import rasterio.shutil

    from bowser import convert

    z = _hills(1200)
    striped = _write(tmp_path / "striped.tif", z)
    tiled = _write(
        tmp_path / "tiled.tif", z, tiled=True, blockxsize=256, blockysize=256
    )
    cog = tmp_path / "cog.tif"
    rasterio.shutil.copy(striped, cog, driver="COG")
    # A tiled GeoTIFF with overviews added afterwards: its overview directories come
    # after the pixel data, so it is not a COG either.
    late = _write(tmp_path / "late.tif", z, tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(late, "r+") as dst:
        dst.build_overviews([2, 4])

    assert convert.is_cog(cog)
    assert not convert.is_cog(striped)
    assert not convert.is_cog(tiled)  # no overviews
    assert not convert.is_cog(late)
    # A small raster needs neither tiles nor overviews.
    assert convert.is_cog(_write(tmp_path / "small.tif", _hills(100)))


# --- rasters: COG once, then the cache ----------------------------------------------


def test_raster_converts_once_and_reuses_the_cache(tmp_path, cache, monkeypatch):
    from bowser import convert

    z = _hills(1500)
    z[:40, :40] = NODATA
    src = _write(tmp_path / "lidar.tif", z)
    assert not convert.is_cog(src)

    first = convert.prepare(src)
    assert first["status"] == "converting", first
    assert first["kind"] == "raster" and first["format"] == "cog"
    done = _wait(convert, first["id"], cache)
    assert done["status"] == "ready" and done["converted"], done
    cog = Path(done["cog"])
    assert cog.parent == cache
    assert convert.is_cog(cog)
    with rasterio.open(cog) as out, rasterio.open(src) as inp:
        assert out.nodata == NODATA  # nodata kept
        assert out.crs == inp.crs and out.transform == inp.transform
        assert out.profile["compress"].lower() == "deflate"
        assert out.tags(ns="IMAGE_STRUCTURE")["PREDICTOR"] == "3"  # float predictor
        assert out.overviews(1)
        np.testing.assert_array_equal(out.read(1), z)  # lossless
        assert out.read_masks(1)[:40, :40].max() == 0

    # Later loads reuse the cached COG: no conversion is started again.
    started = []
    monkeypatch.setattr(convert, "_run", lambda *a: started.append(a))
    before = (cog.stat().st_ino, cog.read_bytes())
    again = convert.prepare(src)
    assert again == done
    assert started == []
    assert (cog.stat().st_ino, cog.read_bytes()) == before  # not rewritten

    # A rewritten source has a new key, so it is converted afresh.
    time.sleep(0.01)
    _write(src, z + 1)
    assert convert.cache_key(src, "cog") != first["id"]


def test_a_cog_is_used_where_it_is(tmp_path, cache):
    import rasterio.shutil

    from bowser import convert

    cog = tmp_path / "cog.tif"
    rasterio.shutil.copy(_write(tmp_path / "s.tif", _hills(800)), cog, driver="COG")
    out = convert.prepare(cog)
    assert out["status"] == "ready" and out["cog"] == str(cog) and not out["converted"]
    assert not list(cache.glob("*.tif"))


@pytest.mark.usefixtures("sync")
def test_a_failed_conversion_is_reported(tmp_path, cache, monkeypatch):
    from bowser import convert

    src = _write(tmp_path / "bad.tif", _hills(1000))

    def broken(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(convert, "convert_to_cog", broken)
    # The conversion runs synchronously (``sync``), so no thread races the checks.
    out = convert.prepare(src)
    assert out["status"] == "failed" and out["error"] == "disk full", out
    assert convert.status(out["id"], cache) == out
    assert not (cache / f"{out['id']}.lock").exists()
    assert not list(cache.glob("*.partial*"))
    with pytest.raises(KeyError):
        convert.status("0" * 24, cache)


def test_status_while_the_lock_goes(cache, monkeypatch):
    """A poll that sees the conversion end between its checks reads the result.

    The thread writes the ``.error`` (or output), then removes the ``.lock``; a poll
    that looked for the error just before and at the lock just after must not call
    the conversion dead.
    """
    from bowser import convert

    key = "f" * 24
    (cache / f"{key}.json").write_text('{"format": "cog", "kind": "raster"}')
    lock, err = cache / f"{key}.lock", cache / f"{key}.error"
    with pytest.raises(KeyError):  # neither running nor done
        convert.status(key, cache)
    lock.write_text(f"{os.getpid()} src")

    def finishes_now(path):
        err.write_text("boom")
        path.unlink()
        return False

    monkeypatch.setattr(convert, "_lock_alive", finishes_now)
    out = convert.status(key, cache)
    assert out["status"] == "failed" and out["error"] == "boom", out


def test_raster_summary(tmp_path):
    from bowser import convert

    out = convert.raster_summary(_write(tmp_path / "a.tif", _hills(300)))
    assert out["band_count"] == 1 and out["nodata"] == NODATA
    b = out["bands"][0]
    assert 55 < b["min"] <= b["p2"] < b["p5"] < b["p95"] < b["p98"] <= b["max"] < 145
    w, s, e, n = out["bounds"]
    assert w < -90.1385 < e and s < 34.7585 < n


# --- vectors: GeoJSON when small, PMTiles when large --------------------------------


def test_the_size_threshold():
    from bowser import convert

    mb = 1024 * 1024
    assert not convert.is_large_vector(20 * mb, 50_000)
    assert convert.is_large_vector(20 * mb + 1, 10)  # too big a file to parse
    assert convert.is_large_vector(1 * mb, 50_001)  # too many features to draw


@pytest.mark.usefixtures("cache", "sync")
def test_a_small_vector_becomes_one_geojson(tmp_path):
    from bowser import convert

    src = squares(tmp_path / "parcels.geojson", 30)
    done = convert.prepare(src, name="Parcels")
    assert done["kind"] == "vector" and done["format"] == "geojson", done
    assert done["feature_count"] == 30 and done["layers"] == ["parcels"]
    assert done["status"] == "ready" and done["name"] == "Parcels", done
    fc = json.loads(Path(done["output"]).read_text())
    assert len(fc["features"]) == 30
    assert fc["features"][3]["properties"] == {
        "parcel": 3,
        "owner": "owner 3",
        "acres": 0.75,
    }


def test_a_large_vector_becomes_pmtiles_with_its_attributes(
    tmp_path, cache, monkeypatch
):
    """A GeoJSON over the feature threshold is tiled; the tiles keep every attribute."""
    from bowser import convert

    if not convert.pmtiles_available():
        pytest.skip("GDAL has no PMTiles driver")
    # 3000 parcels stand in for >50 000: the same path, in seconds.
    monkeypatch.setattr(convert, "PMTILES_MIN_FEATURES", 2000)
    src = squares(tmp_path / "parcels.geojson", 3000)
    job = convert.prepare(src)
    assert job["format"] == "pmtiles" and job["feature_count"] == 3000, job
    w, s, e, n = job["bounds"]
    assert w == pytest.approx(-90.2, abs=1e-3) and n == pytest.approx(34.7595, abs=1e-4)
    done = _wait(convert, job["id"], cache)
    assert done["status"] == "ready", done
    archive = Path(done["output"])
    assert archive.suffix == ".pmtiles" and archive.parent == cache

    head = archive.read_bytes()[:127]
    assert head[:8] == b"PMTiles\x03"
    assert head[99] == 1  # tile type: Mapbox Vector Tiles
    min_zoom, max_zoom = head[100], head[101]
    assert min_zoom == convert.pmtiles_min_zoom(job["bounds"]) and max_zoom == 14

    ds = gdal.OpenEx(str(archive), gdal.OF_VECTOR)
    assert ds.GetDriver().ShortName == "PMTiles"
    layer = ds.GetLayerByName("parcels")
    feats = {f.GetField("parcel"): f.items() for f in layer}
    assert len(feats) == 3000  # every parcel is in the highest zoom's tiles
    assert {"parcel": 7, "owner": "owner 0", "acres": 1.75}.items() <= feats[7].items()


@pytest.mark.usefixtures("cache", "sync")
def test_a_csv_with_coordinate_columns(tmp_path):
    from bowser import convert

    src = tmp_path / "wells.csv"
    src.write_text("name,Longitude,Latitude\nA,-90.1,34.7\nB,-90.2,34.8\n")
    job = convert.prepare(src)
    assert job["format"] == "geojson" and job["feature_count"] == 2
    assert job["status"] == "ready", job
    fc = json.loads(Path(job["output"]).read_text())
    assert fc["features"][1]["geometry"]["coordinates"] == [-90.2, 34.8]
    assert fc["features"][1]["properties"]["name"] == "B"


@pytest.mark.usefixtures("cache")
def test_unreadable_files_are_refused(tmp_path):
    from bowser import convert

    junk = tmp_path / "notes.bin"
    junk.write_bytes(b"\x00\x01 not data")
    with pytest.raises(ValueError, match="cannot read"):
        convert.prepare(junk)


# --- the cache's limits -------------------------------------------------------------


def _entry(folder: Path, key: str, size: int, age_days: float) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{key}.json").write_text('{"format": "cog"}')
    out = folder / f"{key}.tif"
    out.write_bytes(b"x" * size)
    t = time.time() - age_days * 86400
    os.utime(out, (t, t))


def test_cache_limits_from_the_environment(monkeypatch):
    from bowser import convert

    monkeypatch.delenv("BOWSER_CONVERT_CACHE_MAX_GB", raising=False)
    monkeypatch.delenv("BOWSER_CONVERT_CACHE_MAX_DAYS", raising=False)
    assert convert.cache_limits() == (20 * 1024**3, 30 * 86400)
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_MAX_GB", "0.5")
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_MAX_DAYS", "0")  # 0: no age limit
    assert convert.cache_limits() == (512 * 1024**2, 0)


def test_the_cache_evicts_the_least_recently_used(cache, monkeypatch):
    from bowser import convert

    _entry(cache, "a" * 24, 400, age_days=40)  # past the 30-day limit
    _entry(cache, "b" * 24, 400, age_days=5)
    _entry(cache, "c" * 24, 400, age_days=3)
    _entry(cache, "d" * 24, 400, age_days=1)
    _entry(cache, "e" * 24, 400, age_days=60)  # still converting: kept
    (cache / f"{'e' * 24}.lock").write_text(f"{os.getpid()} src")

    # 1000 bytes allowed: after the stale entry, the oldest go until 800 bytes remain.
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_MAX_GB", str(1000 / 1024**3))
    removed = convert.prune(cache)
    assert removed == ["a" * 24, "b" * 24]
    left = {p.name for p in cache.iterdir()}
    assert f"{'c' * 24}.tif" in left and f"{'d' * 24}.tif" in left
    assert f"{'e' * 24}.tif" in left
    assert not any(n.startswith(("a" * 24, "b" * 24)) for n in left)

    # The one being handed out is never evicted, however old.
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_MAX_GB", "0")
    monkeypatch.setenv("BOWSER_CONVERT_CACHE_MAX_DAYS", str(2))
    assert convert.prune(cache, keep="c" * 24) == []
    assert (cache / f"{'c' * 24}.tif").exists()


@pytest.mark.usefixtures("sync")
def test_a_cache_hit_counts_as_use(tmp_path, cache):
    """Handing out a cached output touches it, so a file in use is not evicted."""
    from bowser import convert

    src = _write(tmp_path / "lidar.tif", _hills(1000))
    done = convert.prepare(src)
    assert done["status"] == "ready", done
    cog = Path(done["cog"])
    old = time.time() - 40 * 86400
    os.utime(cog, (old, old))
    convert.prepare(src)
    assert time.time() - cog.stat().st_mtime < 60
    assert convert.prune(cache) == []
