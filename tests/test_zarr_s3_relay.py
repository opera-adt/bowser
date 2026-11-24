"""``GET /zarr/{path}`` for a cube on S3: the server relays its files unchanged.

S3 is replaced by fsspec's in-memory filesystem (no network): ``remote_store``
returns it for the ``s3://`` URI, as the real one returns s3fs.

- metadata and chunks come through byte for byte, with HEAD, ranges and the
  suffix ranges a sharded store reads its index with;
- an absent chunk is a 404 (the reader's fill), a read failure a 502;
- the key rules and the same-site rule are those of a local store;
- the combined-mask virtual arrays work on S3 too.
"""

from __future__ import annotations

import numpy as np
import pytest
import xarray as xr
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fsspec.implementations.memory import MemoryFileSystem

from bowser import mask_dates, zarr_files
from bowser.zarr_files import _byte_range, make_router

URI = "s3://bucket/cube.zarr"


@pytest.fixture
def relay(monkeypatch):
    fs = MemoryFileSystem()
    fs.store.clear()
    fs.pseudo_dirs.clear()
    fs.pipe("/cube.zarr/zarr.json", b'{"zarr_format": 3, "node_type": "group"}')
    fs.pipe(
        "/cube.zarr/velocity/zarr.json", b'{"zarr_format": 3, "node_type": "array"}'
    )
    chunk = bytes(range(256)) * 4
    fs.pipe("/cube.zarr/velocity/c/0/0", chunk)
    fs.pipe("/cube.zarr/notes.txt", b"not a zarr file")
    monkeypatch.setattr(
        zarr_files,
        "remote_store",
        lambda uri: (fs, "/cube.zarr") if uri == URI else None,
    )
    app = FastAPI()
    app.include_router(make_router(lambda: URI))
    return TestClient(app), fs, chunk


def test_relays_metadata_and_chunks_unchanged(relay):
    client, _, chunk = relay
    meta = client.get("/zarr/zarr.json")
    assert meta.status_code == 200 and meta.json()["node_type"] == "group"
    assert meta.headers["content-type"].startswith("application/json")
    got = client.get("/zarr/velocity/c/0/0")
    assert got.status_code == 200 and got.content == chunk
    head = client.head("/zarr/velocity/c/0/0")
    assert head.status_code == 200 and head.headers["content-length"] == str(len(chunk))
    assert head.content == b""


def test_ranges_and_suffix_ranges(relay):
    client, _, chunk = relay
    part = client.get("/zarr/velocity/c/0/0", headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == chunk[10:20]
    assert part.headers["content-range"].startswith("bytes 10-19/")
    tail = client.get("/zarr/velocity/c/0/0", headers={"Range": "bytes=-16"})
    assert tail.status_code == 206 and tail.content == chunk[-16:]
    rest = client.get("/zarr/velocity/c/0/0", headers={"Range": "bytes=1000-"})
    assert rest.content == chunk[1000:]
    # A multi-part range is answered with the whole object.
    whole = client.get("/zarr/velocity/c/0/0", headers={"Range": "bytes=0-1,5-6"})
    assert whole.status_code == 200 and whole.content == chunk


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, None),
        ("bytes=0-9", (0, 10)),
        ("bytes=5-", (5, None)),
        ("bytes=-4", (96, 100)),
        ("bytes=-400", (0, 100)),
        ("bytes=0-1,4-5", None),
        ("items=0-9", None),
        ("bytes=a-b", None),
    ],
)
def test_byte_range(header, expected):
    assert _byte_range(header, lambda: 100) == expected


def test_refusals_follow_the_local_rules(relay, monkeypatch):
    client, fs, _ = relay
    assert client.get("/zarr/velocity/c/9/9").status_code == 404  # absent: fill
    for path in (
        "notes.txt",
        "velocity/.hidden",
        "../other/zarr.json",
        "velocity//c/0/0",
    ):
        assert client.get(f"/zarr/{path}").status_code == 404, path
    other = client.get(
        "/zarr/zarr.json", headers={"Origin": "https://elsewhere.example"}
    )
    assert other.status_code == 403

    def broken(*_args, **_kwargs):
        raise OSError("S3 unavailable")

    monkeypatch.setattr(fs, "cat_file", broken)
    assert client.get("/zarr/velocity/c/0/0").status_code == 502


def test_only_s3_is_relayed():
    assert zarr_files.remote_store("https://example.com/cube.zarr") is None
    assert zarr_files.remote_store("gs://bucket/cube.zarr") is None
    assert zarr_files.remote_store(None) is None


def test_combined_mask_arrays_on_s3(monkeypatch):
    """The virtual arrays read the mask's metadata and values from S3 as well."""
    fs = MemoryFileSystem()
    fs.store.clear()
    fs.pseudo_dirs.clear()
    rng = np.random.default_rng(1)
    quality = rng.uniform(0, 1, (5, 6, 7)).astype("float32")
    ds = xr.Dataset(
        {"recommended_mask": (("time", "y", "x"), quality)},
        coords={"time": np.arange(5), "y": np.arange(6)[::-1], "x": np.arange(7)},
    )
    ds.to_zarr(
        "memory://cube.zarr",
        zarr_format=3,
        consolidated=False,
        encoding={"recommended_mask": {"chunks": (2, 4, 4)}},
    )
    monkeypatch.setattr(
        zarr_files,
        "remote_store",
        lambda uri: (fs, "/cube.zarr") if uri == URI else None,
    )
    monkeypatch.setattr(
        mask_dates,
        "_open_level",
        lambda _store, _group: xr.open_zarr("memory://cube.zarr", consolidated=False),
    )
    mask_dates.BLOCKS.clear()
    app = FastAPI()
    app.include_router(make_router(lambda: URI))
    client = TestClient(app)
    meta = client.get("/zarr/recommended_mask@lowest_over_dates/zarr.json").json()
    assert meta["shape"] == [6, 7]
    assert meta["chunk_grid"]["configuration"]["chunk_shape"] == [4, 4]
    chunk = client.get("/zarr/recommended_mask@lowest_over_dates/c/0/0")
    values = np.frombuffer(chunk.content, "<f4").reshape(4, 4)
    np.testing.assert_array_equal(values, quality.min(axis=0)[:4, :4])
    mask_dates.BLOCKS.clear()
