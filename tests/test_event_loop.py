"""Endpoints that read data do not hold up the full server's other requests.

An ``async def`` endpoint runs on the server's one event loop, so reading a cube
inside it (a time series, a profile, the layer list) makes every other request
wait: tiles, ``/config``, the next hover. Those endpoints are plain functions,
which FastAPI runs in its thread pool.

- ``/config`` is answered while each of them is busy;
- no ``async def`` endpoint of ``bowser.main`` is left without an ``await``,
  except the few that only return what is already in memory.

The server reads its settings at import, so it runs in a subprocess; nothing
here imports ``bowser.main``, ``bowser.state`` or ``bowser.config``.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import socket
import subprocess
import sys
import textwrap
import threading
import time
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "regression"))
from cube import CENTER_LONLAT, EDGE_LONLAT, REF_LONLAT, make_cube  # noqa: E402

LON, LAT = CENTER_LONLAT
REF_LON, REF_LAT = REF_LONLAT
#: Seconds the armed endpoint sleeps, and how long ``/config`` may take meanwhile.
SLOW, PROMPT = 3.0, 1.5

#: ``async def`` endpoints that may go without an ``await``: they return what is
#: already in memory. ``get_colorbar`` draws with pyplot, which is not thread
#: safe, and caches each colormap after its first request.
IN_MEMORY = {
    "get_mode",
    "get_config",
    "get_catalog",
    "get_time_bounds",
    "get_colorbar",
    "picker_redirect",
    "root",
}

# One uvicorn server whose data access sleeps once after ``flag`` is created:
# where the sleep happens (event loop or worker thread) is what the test sees.
UVICORN = textwrap.dedent(
    r"""
    import os, sys, time
    import uvicorn
    port, flag, slow = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
    import bowser.main as main

    def armed():
        try:
            os.remove(flag)  # one shot: only the request under test sleeps
        except FileNotFoundError:
            return
        time.sleep(slow)

    def slowed(f):
        def run(*a, **k):
            armed()
            return f(*a, **k)
        return run

    # What the endpoints reach their data through.
    main._StateProxy.__getattr__ = slowed(main._StateProxy.__getattr__)
    main._resolve_state = slowed(main._resolve_state)
    from rio_tiler.io import Reader
    Reader.statistics = slowed(Reader.statistics)
    uvicorn.run(main.app, host="127.0.0.1", port=port, log_level="warning")
    """
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _post(path: str, body: dict) -> tuple[str, bytes, dict]:
    return path, json.dumps(body).encode(), {"Content-Type": "application/json"}


def _tif_upload(tmp: Path) -> tuple[str, bytes, dict]:
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    tif = tmp / "overlay.tif"
    with rasterio.open(
        tif,
        "w",
        driver="GTiff",
        height=8,
        width=8,
        count=1,
        dtype="float32",
        crs="EPSG:32611",
        transform=from_origin(436950.0, 3758490.0, 30.0, 30.0),
    ) as dst:
        dst.write(np.arange(64, dtype="float32").reshape(1, 8, 8))
    edge = "bowsertestboundary"
    body = (
        f'--{edge}\r\nContent-Disposition: form-data; name="file"; '
        'filename="overlay.tif"\r\nContent-Type: image/tiff\r\n\r\n'
    ).encode()
    body += tif.read_bytes() + f"\r\n--{edge}--\r\n".encode()
    return (
        "/upload_raster",
        body,
        {"Content-Type": f"multipart/form-data; boundary={edge}"},
    )


def _requests(tmp: Path) -> dict[str, tuple[str, bytes | None, dict]]:
    """One request per endpoint that reads data: ``(path, body, headers)``."""
    where = f"lon={LON}&lat={LAT}"
    ref = f"ref_lon={REF_LON}&ref_lat={REF_LAT}"
    return {
        "datasets": ("/datasets", None, {}),
        "variables": ("/variables", None, {}),
        "point": (f"/point?dataset_name=displacement&{where}", None, {}),
        "chart_point": (
            f"/chart_point?dataset_name=displacement&{where}&{ref}",
            None,
            {},
        ),
        "trend_analysis": (f"/trend_analysis/displacement?{where}&{ref}", None, {}),
        "multi_point": _post(
            "/multi_point",
            {
                "points": [{"id": "a", "lat": LAT, "lon": LON}],
                "dataset_name": "displacement",
                "ref_lon": REF_LON,
                "ref_lat": REF_LAT,
            },
        ),
        "buffer_timeseries": _post(
            "/buffer_timeseries",
            {"lon": LON, "lat": LAT, "dataset_name": "displacement", "buffer_m": 90},
        ),
        "profile": _post(
            "/profile",
            {
                "coords": [list(REF_LONLAT), list(EDGE_LONLAT)],
                "dataset_name": "displacement",
                "n_samples": 20,
            },
        ),
        "upload_raster": _tif_upload(tmp),
    }


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """Yield ``(base URL, flag file, opener)`` of a server on the regression cube."""
    pytest.importorskip("rioxarray")
    tmp = tmp_path_factory.mktemp("loop")
    cube = make_cube(tmp / "cube.zarr")
    flag = tmp / "sleep-once"
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(cube),
        BOWSER_HISTOGRAM_WARMUP="0",
        BOWSER_REFSTATS_WARMUP="0",
        BOWSER_UPLOAD_DIR=str(tmp / "uploads"),
        NO_PROXY="*",
    )
    log = tmp / "server.log"
    with open(log, "wb") as out:
        proc = subprocess.Popen(
            [sys.executable, "-c", UVICORN, str(port), str(flag), str(SLOW)],
            env=env,
            cwd=tmp,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        for _ in range(600):
            try:
                opener.open(base + "/config", timeout=5).read()
                break
            except OSError:
                if proc.poll() is not None:
                    pytest.fail(log.read_text()[-3000:])
                time.sleep(0.1)
        yield base, flag, opener, tmp
    finally:
        proc.terminate()
        proc.wait(timeout=30)


@pytest.mark.parametrize(
    "name",
    [
        "datasets",
        "variables",
        "point",
        "chart_point",
        "trend_analysis",
        "multi_point",
        "buffer_timeseries",
        "profile",
        "upload_raster",
    ],
)
def test_config_is_answered_while_an_endpoint_reads_data(server, name):
    base, flag, opener, tmp = server
    path, body, headers = _requests(tmp)[name]
    done: dict = {}

    def busy() -> None:
        req = urllib.request.Request(base + path, data=body, headers=headers)
        t0 = time.perf_counter()
        try:
            with opener.open(req, timeout=60) as r:
                done["status"] = r.status
        except Exception as exc:  # noqa: BLE001
            done["status"] = repr(exc)
        done["took"] = time.perf_counter() - t0

    flag.write_text("")  # the next data access sleeps SLOW seconds
    th = threading.Thread(target=busy)
    th.start()
    time.sleep(0.5)  # the endpoint is asleep now
    t0 = time.perf_counter()
    opener.open(base + "/config", timeout=60).read()
    waited = time.perf_counter() - t0
    th.join()
    assert done["status"] == 200, done
    assert done["took"] >= SLOW, f"{name} never reached the slowed data access"
    assert waited < PROMPT, f"/config waited {waited:.1f} s behind {path}"


def test_async_endpoints_await_or_only_return_memory():
    spec = importlib.util.find_spec("bowser")
    assert spec is not None and spec.submodule_search_locations
    source = Path(next(iter(spec.submodule_search_locations))) / "main.py"
    blocking = []
    for node in ast.parse(source.read_text()).body:
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        routed = any(
            ast.unparse(d).startswith(("app.get", "app.post"))
            for d in node.decorator_list
        )
        awaits = any(isinstance(n, ast.Await) for n in ast.walk(node))
        if routed and not awaits and node.name not in IN_MEMORY:
            blocking.append(node.name)
    assert not blocking, (
        f"{blocking}: async def without an await runs on the event loop and holds "
        "up every other request; make it a plain def (FastAPI then uses a thread)."
    )
