"""Per-pixel stack statistics: disk cache, shared warm-up, parallel reads, strides.

Uses the planted-patch cube of tests/test_reference_candidates.py, written as a
chunked Zarr store so the disk cache has files to fingerprint.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import xarray as xr
from test_reference_candidates import EPSG, NT, PATCH, SECOND, _within, write_cube

import bowser.refstats as rs
from bowser.reference_candidates import (
    CandidateParams,
    find_reference_candidates,
    status,
    warm_up,
)
from bowser.refstats import STATS_CACHE, Source, stack_median_std

pytest.importorskip("rioxarray")


@pytest.fixture(autouse=True)
def _cache_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BOWSER_REFSTATS_CACHE_DIR", str(tmp_path / "refstats"))
    monkeypatch.delenv("BOWSER_REFSTATS_CACHE", raising=False)
    STATS_CACHE.clear()
    yield
    STATS_CACHE.clear()


@pytest.fixture
def store(tmp_path) -> Path:
    return write_cube(tmp_path / "planted.zarr")


def _open(path: Path) -> xr.Dataset:
    return xr.open_zarr(path, consolidated=False, chunks=None)


def _run(ds, path, **kw):
    return find_reference_candidates(
        [ds], EPSG, CandidateParams(radius_m=90, **kw), sources=[Source(str(path))]
    )


def test_disk_cache_is_reused_after_a_restart(store):
    first = _run(_open(store), store)
    assert first["cached"] is False
    computed = STATS_CACHE.computed
    files = sorted((Path(os.environ["BOWSER_REFSTATS_CACHE_DIR"])).glob("*.npz"))
    assert len(files) == 3  # coherence, similarity, water mask
    # A restart: the memory cache is gone and the store is opened afresh.
    STATS_CACHE.clear()
    loaded = STATS_CACHE.loaded
    again = _run(_open(store), store)
    assert again["cached"] is True
    assert STATS_CACHE.computed == computed
    assert STATS_CACHE.loaded == loaded + 3
    first.pop("cached"), again.pop("cached")
    assert again == first


def test_disk_cache_survives_a_new_process(store):
    import subprocess
    import sys

    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "import xarray as xr\n"
        "from bowser.reference_candidates import CandidateParams, "
        "find_reference_candidates\n"
        "from bowser.refstats import STATS_CACHE, Source\n"
        "ds = xr.open_zarr(%r, consolidated=False, chunks=None)\n"
        "out = find_reference_candidates([ds], %d, CandidateParams(radius_m=90), "
        "sources=[Source(%r)])\n"
        "print(out['cached'], STATS_CACHE.computed, STATS_CACHE.loaded)\n"
    ) % (str(Path(__file__).parent), str(store), EPSG, str(store))
    env = {**os.environ}
    runs = [
        subprocess.run(
            [sys.executable, "-c", code],
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        for _ in range(2)
    ]
    assert all(r.returncode == 0 for r in runs), runs[-1].stderr[-2000:]
    assert runs[0].stdout.split() == ["False", "3", "0"]
    assert runs[1].stdout.split() == ["True", "0", "3"]


def test_the_key_changes_when_the_data_changes(store):
    ds = _open(store)
    src = Source(str(store))
    (m0, _), _ = STATS_CACHE.get(ds, "temporal_coherence", source=src)
    k0 = rs.disk_key(src, "temporal_coherence", 1)
    import zarr

    arr = zarr.open_array(store=str(store), path="temporal_coherence", mode="r+")
    time.sleep(0.01)  # a distinct modification time even on coarse clocks
    arr[:, 0:8, 0:8] = 0.0
    k1 = rs.disk_key(src, "temporal_coherence", 1)
    assert k1 != k0
    assert rs.disk_key(src, "phase_similarity", 1) == rs.disk_key(
        src, "phase_similarity", 1
    )
    STATS_CACHE.clear()
    computed = STATS_CACHE.computed
    (m1, _), reused = STATS_CACHE.get(_open(store), "temporal_coherence", source=src)
    assert reused is False and STATS_CACHE.computed == computed + 1
    assert np.all(m1[:8, :8] == 0) and not np.all(m0[:8, :8] == 0)
    # Another stride or level is another key.
    assert rs.disk_key(src, "temporal_coherence", 2) != k1
    assert rs.disk_key(Source(str(store), "1"), "temporal_coherence", 1) is None


def test_warm_up_shares_its_result_with_the_endpoint(store, monkeypatch):
    calls: list[str] = []
    gate = threading.Event()
    real = rs.stack_median_std

    def slow(da, *a, **kw):
        calls.append(str(da.name))
        gate.wait(10)
        return real(da, *a, **kw)

    monkeypatch.setattr(rs, "stack_median_std", slow)
    monkeypatch.setenv("BOWSER_REFSTATS_WARMUP", "1")
    ds = _open(store)
    src = [Source(str(store))]
    assert warm_up([ds], sources=src) is True
    assert warm_up([ds], sources=src) is False  # once per dataset
    for _ in range(100):
        if calls:
            break
        time.sleep(0.02)
    st = status([ds])
    assert st["state"] == "running" and st["layers"]["temporal_coherence"]["state"] == (
        "running"
    )
    result: dict = {}
    t = threading.Thread(target=lambda: result.update(out=_run(ds, store)))
    t.start()
    time.sleep(0.2)
    gate.set()
    t.join(30)
    assert result["out"]["cached"] is True  # the search computed nothing itself
    assert sorted(calls) == ["phase_similarity", "temporal_coherence", "water_mask"]
    assert status([ds])["state"] == "ready"


def test_warm_up_is_off_when_disabled(store, monkeypatch):
    monkeypatch.setenv("BOWSER_REFSTATS_WARMUP", "0")
    assert warm_up([_open(store)], sources=[Source(str(store))]) is False
    monkeypatch.delenv("BOWSER_REFSTATS_WARMUP")
    assert warm_up([_open(store)], default=False) is False


@pytest.mark.parametrize("name", ["temporal_coherence", "water_mask"])
def test_parallel_reads_equal_serial_ones(store, name, monkeypatch):
    monkeypatch.setattr(rs, "BLOCK_BYTES", 30 * 16 * 16 * 4)  # many blocks
    ds = _open(store)
    src = Source(str(store))
    assert rs.direct_array(ds[name], src) is not None
    serial = stack_median_std(ds[name], workers=1)  # through xarray
    for workers in (1, 4, 8):
        direct = stack_median_std(ds[name], workers=workers, source=src)
        for a, b in zip(serial, direct):
            np.testing.assert_array_equal(a, b)
    dask = xr.open_zarr(store, consolidated=False)  # as the full server opens it
    for a, b in zip(serial, stack_median_std(dask[name], workers=4)):
        np.testing.assert_array_equal(a, b)
    # A window too.
    win = stack_median_std(ds[name], slice(5, 50), slice(7, 61), workers=4, source=src)
    np.testing.assert_array_equal(win[0], serial[0][5:50, 7:61])


def test_stride_reads_whole_chunks():
    da = xr.DataArray(np.zeros((30, 2, 2)), dims=("time", "y", "x"))
    da.encoding["preferred_chunks"] = {"time": 4, "y": 2, "x": 2}
    assert rs.selected_dates(da, 1) == [(i, min(i + 4, 30)) for i in range(0, 30, 4)]
    assert rs.selected_dates(da, 2) == [(0, 4), (8, 12), (16, 20), (24, 28)]


def test_stride_screening_with_exact_recheck_finds_the_planted_patch(store):
    ds = _open(store)
    out = _run(ds, store, screen_stride=2)
    sc = out["screening"]
    assert sc["date_stride"] == 2 and sc["dates_screened"] < NT
    assert sc["refined"] is True
    best = out["candidates"][0]
    assert _within(best, PATCH[0], PATCH[1], PATCH[2] - 3)
    # The candidates' statistics use every date, not the screened subset.
    tc = ds["temporal_coherence"].values[:, best["row"], best["col"]]
    assert best["temporal_coherence_median"] == pytest.approx(
        float(np.nanmedian(tc)), rel=1e-6
    )
    # The same places as screening every date: the planted patch, then the second.
    full = _run(ds, store, screen_stride=1)
    for res in (out, full):
        assert _within(res["candidates"][1], SECOND[0], SECOND[1], SECOND[2])


def test_prune_applies_age_and_size_limits(monkeypatch):
    root = Path(os.environ["BOWSER_REFSTATS_CACHE_DIR"])
    root.mkdir(parents=True)
    now = time.time()
    for i, age_days in enumerate([40, 3, 2, 1]):
        p = root / f"f{i}.npz"
        p.write_bytes(b"x" * 600_000)
        os.utime(p, (now - age_days * 86400,) * 2)
    stale_tmp = root / ".f.1.2.tmp"
    stale_tmp.write_bytes(b"x")
    os.utime(stale_tmp, (now - 7200,) * 2)
    monkeypatch.setenv("BOWSER_REFSTATS_CACHE_MAX_MB", "1.2")
    rs.prune(now)
    assert sorted(p.name for p in root.iterdir()) == ["f2.npz", "f3.npz"]
