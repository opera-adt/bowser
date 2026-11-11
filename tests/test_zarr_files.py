"""``GET /zarr/{path}``: the cube's zarr files for the page's GPU renderer.

- a local zarr v3 store's metadata and chunks are served, with Range and HEAD;
- nothing else is: no other file of the folder, no hidden file, nothing outside
  the store (``..``, absolute paths, encoded variants, symlinks pointing out), no
  remote store, no method but GET and HEAD, no request from another web site, and
  nothing when the route is turned off.

The router is built here on a bare FastAPI app; the servers' own routing (and
full/lite parity) is in tests/test_api_schema.py. Nothing here imports
bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import os

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from bowser.zarr_files import local_store_root, make_router, resolve_inside

CHUNK = bytes(range(16))


def _client(uri, enabled=True) -> TestClient:
    app = FastAPI()
    app.include_router(make_router(lambda: uri, lambda: enabled))
    return TestClient(app)


@pytest.fixture
def store(tmp_path):
    """A tiny zarr v3 layout, a secret next to it and a second store outside it."""
    root = tmp_path / "cube.zarr"
    (root / "displacement" / "c" / "0" / "0").mkdir(parents=True)
    (root / "zarr.json").write_text('{"zarr_format": 3, "node_type": "group"}')
    (root / "displacement" / "zarr.json").write_text('{"zarr_format": 3}')
    (root / "displacement" / "c" / "0" / "0" / "0").write_bytes(CHUNK)
    (root / "velocity").mkdir()
    (root / "velocity" / "c.0.0").write_bytes(CHUNK[:4])
    # Files a zarr reader never asks for.
    (root / "notes.txt").write_text("private notes")
    (root / ".zattrs").write_text("{}")
    (root / "zarr.json.bak").write_text("{}")
    (root / "displacement" / "c" / ".hidden").write_text("x")
    (root / ".git").mkdir()
    (root / ".git" / "zarr.json").write_text("{}")
    (tmp_path / "secret.txt").write_text("secret")
    other = tmp_path / "other.zarr"
    (other / "c").mkdir(parents=True)
    (other / "zarr.json").write_text('{"other": true}')
    (other / "c" / "0").write_bytes(b"other")
    return root


def test_local_store_root(tmp_path, store):
    assert local_store_root(str(store)) == store.resolve()
    assert local_store_root(f"file://{store}") == store.resolve()
    assert local_store_root(store) == store.resolve()  # a Path, as Cube.uri may be
    for uri in ("s3://bucket/cube.zarr", "https://example.com/cube.zarr", "", None):
        assert local_store_root(uri) is None, uri
    assert local_store_root(str(tmp_path / "missing.zarr")) is None
    plain = tmp_path / "v2.zarr"
    plain.mkdir()
    (plain / ".zgroup").write_text("{}")
    assert local_store_root(str(plain)) is None  # not zarr v3: tiles instead


def test_serves_metadata_and_chunks_with_ranges(store):
    c = _client(str(store))
    r = c.get("/zarr/zarr.json")
    assert r.status_code == 200
    assert r.json()["zarr_format"] == 3
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["cache-control"] == "private, max-age=600"

    r = c.head("/zarr/displacement/c/0/0/0")
    assert r.status_code == 200
    assert r.headers["content-length"] == "16"
    assert r.content == b""

    r = c.get("/zarr/displacement/c/0/0/0", headers={"Range": "bytes=-4"})
    assert r.status_code == 206
    assert r.content == CHUNK[-4:]
    r = c.get("/zarr/displacement/c/0/0/0", headers={"Range": "bytes=4-7"})
    assert r.status_code == 206
    assert r.content == CHUNK[4:8]
    assert r.headers["content-type"] == "application/octet-stream"

    assert c.get("/zarr/velocity/c.0.0").content == CHUNK[:4]
    assert c.get("/zarr/displacement/zarr.json").status_code == 200
    assert c.get("/zarr/displacement/c/0/0/9").status_code == 404  # an empty chunk


@pytest.mark.parametrize(
    "path",
    [
        "notes.txt",
        ".zattrs",
        "zarr.json.bak",
        "displacement/c/.hidden",
        ".git/zarr.json",
        "displacement",  # a folder
        "displacement/c/0",  # a folder named like a chunk
        "displacement/c/x",
        "displacement//zarr.json",
    ],
)
def test_refuses_files_a_zarr_reader_never_reads(store, path):
    assert _client(str(store)).get(f"/zarr/{path}").status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "%2e%2e/secret.txt",
        "%2E%2E/other.zarr/zarr.json",
        "..%2fother.zarr%2fzarr.json",
        "%2e%2e%2fother.zarr%2fc%2f0",
        "%252e%252e/other.zarr/zarr.json",  # double-encoded: a literal name
        "displacement/%2e%2e/%2e%2e/other.zarr/zarr.json",
        "..%5cother.zarr%5czarr.json",  # backslashes
        "zarr.json%00",
        "zarr%00.json",
    ],
)
def test_refuses_encoded_paths_out_of_the_store(store, path):
    r = _client(str(store)).get(f"/zarr/{path}")
    assert r.status_code == 404, (path, r.status_code, r.text)


def test_refuses_dot_dot_and_absolute_paths(store):
    root = store.resolve()
    other = root.parent / "other.zarr"
    for rel in (
        "../other.zarr/zarr.json",
        "displacement/../../other.zarr/c/0",
        "../secret.txt",
        str(other / "zarr.json"),  # absolute: Path(root) / "/x" would be "/x"
        str(other / "c" / "0"),
        "/etc/zarr.json",
        "C:\\other.zarr\\zarr.json",
    ):
        with pytest.raises(HTTPException) as e:
            resolve_inside(root, rel)
        assert e.value.status_code == 404, rel
    # The same through HTTP: an absolute path after /zarr/.
    c = _client(str(store))
    assert c.get(f"/zarr/{other}/zarr.json").status_code == 404
    assert c.get(f"/zarr//{other}/zarr.json").status_code == 404


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="no symlinks")
def test_refuses_symlinks_pointing_out(store):
    root = store
    other = root.parent / "other.zarr"
    chunks = root / "displacement" / "c" / "0" / "0"
    (root / "linked").symlink_to(other, target_is_directory=True)
    (chunks / "1").symlink_to(other / "c" / "0")
    (chunks / "2").symlink_to(root.parent / "secret.txt")
    (chunks / "3").symlink_to(chunks / "0")  # a link that stays inside is fine
    c = _client(str(root))
    assert c.get("/zarr/linked/zarr.json").status_code == 404
    assert c.get("/zarr/linked/c/0").status_code == 404
    assert c.get("/zarr/displacement/c/0/0/1").status_code == 404
    assert c.get("/zarr/displacement/c/0/0/2").status_code == 404
    assert c.get("/zarr/displacement/c/0/0/3").content == CHUNK


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="no symlinks")
def test_store_reached_through_a_symlink_is_served(tmp_path, store):
    link = tmp_path / "link.zarr"
    link.symlink_to(store, target_is_directory=True)
    assert _client(str(link)).get("/zarr/zarr.json").status_code == 200


def test_read_only(store):
    c = _client(str(store))
    for method in ("POST", "PUT", "DELETE", "PATCH"):
        assert c.request(method, "/zarr/zarr.json").status_code == 405, method
    assert (store / "zarr.json").read_text().startswith('{"zarr_format": 3')


def test_only_bowsers_own_page(store):
    c = _client(str(store))
    own = "http://testserver"
    assert c.get("/zarr/zarr.json", headers={"Origin": own}).status_code == 200
    for site in ("same-origin", "none"):
        r = c.get("/zarr/zarr.json", headers={"Sec-Fetch-Site": site})
        assert r.status_code == 200, site
    for headers in (
        {"Origin": "https://elsewhere.example"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
        {"Origin": own, "Sec-Fetch-Site": "cross-site"},
    ):
        assert c.get("/zarr/zarr.json", headers=headers).status_code == 403, headers


def test_no_local_store_or_turned_off(tmp_path, store):
    assert _client(None).get("/zarr/zarr.json").status_code == 404  # COG / catalog
    remote = _client("s3://bucket/cube.zarr")
    assert remote.get("/zarr/zarr.json").status_code == 404
    gone = _client(str(tmp_path / "gone.zarr"))
    assert gone.get("/zarr/zarr.json").status_code == 404
    off = _client(str(store), enabled=False)
    assert off.get("/zarr/zarr.json").status_code == 404
    assert off.head("/zarr/displacement/c/0/0/0").status_code == 404


def test_serves_the_store_of_each_request(tmp_path, store):
    """The servers route ``?dataset=`` to a cube per request; the route follows it."""
    other = tmp_path / "other.zarr"
    current = {"uri": str(store)}
    app = FastAPI()
    app.include_router(make_router(lambda: current["uri"]))
    c = TestClient(app)
    assert c.get("/zarr/zarr.json").json()["zarr_format"] == 3
    current["uri"] = str(other)
    assert c.get("/zarr/zarr.json").json() == {"other": True}
    assert c.get("/zarr/displacement/zarr.json").status_code == 404
