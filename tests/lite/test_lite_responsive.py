"""bowser-lite answers other requests while a long read is running.

The desktop app is bowser-lite: a polygon over many dates must not freeze the
page. The work runs in a worker thread, so ``/config`` is answered meanwhile.

The server reads its settings at import, so it runs in a subprocess; nothing
here imports ``bowser.lite.main`` or ``bowser.config``.
"""

from __future__ import annotations

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

import numpy as np
import pytest
import xarray as xr
from pyproj import CRS

#: Seconds the armed work sleeps, and how long ``/config`` may take meanwhile.
SLOW, PROMPT = 3.0, 1.5

# A uvicorn server whose named function sleeps once after ``flag`` is created:
# whether that holds up ``/config`` shows where the work runs.
UVICORN = textwrap.dedent(
    r"""
    import os, sys, time
    import uvicorn
    port, flag, slow = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
    import bowser.lite.main as main

    def slowed(f):
        def run(*a, **k):
            try:
                os.remove(flag + "." + f.__name__)
            except FileNotFoundError:
                return f(*a, **k)
            time.sleep(slow)
            return f(*a, **k)
        return run

    for name in sys.argv[4:]:
        setattr(main, name, slowed(getattr(main, name)))
    uvicorn.run(main.app, host="127.0.0.1", port=port, log_level="warning")
    """
)
#: The functions of ``bowser.lite.main`` that do the long work.
WORK = ["summarize_cube"]


def _cube(path: Path) -> Path:
    n = 32
    data = np.arange(3 * n * n, dtype="float32").reshape(3, n, n)
    sr = xr.DataArray(0, attrs={"crs_wkt": CRS.from_epsg(32611).to_wkt()})
    xr.Dataset(
        {"displacement": (("time", "y", "x"), data, {"units": "meters"})},
        coords={
            "time": np.array(
                ["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]"
            ),
            "x": 500000.0 + 30.0 * (np.arange(n) + 0.5),
            "y": 4000000.0 - 30.0 * (np.arange(n) + 0.5),
            "spatial_ref": sr,
        },
    ).to_zarr(path, mode="w", consolidated=False)
    return path


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("lite-responsive")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    flag = tmp / "slow"
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(_cube(tmp / "cube.zarr")),
        BOWSER_REFSTATS_WARMUP="0",
        BOWSER_REFSTATS_CACHE_DIR=str(tmp / "refstats"),
        NO_PROXY="*",
    )
    log = tmp / "server.log"
    with open(log, "wb") as out:
        proc = subprocess.Popen(
            [sys.executable, "-c", UVICORN, str(port), str(flag), str(SLOW), *WORK],
            env=env,
            cwd=tmp,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    base = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        deadline = time.time() + 120
        while True:
            try:
                opener.open(base + "/config", timeout=5).read()
                break
            except OSError:
                if proc.poll() is not None or time.time() > deadline:
                    pytest.fail(log.read_text()[-3000:])
                time.sleep(0.1)
        yield base, flag, opener
    finally:
        proc.terminate()
        proc.wait(timeout=30)


def _polygon() -> tuple[str, bytes | None, dict]:
    from pyproj import Transformer

    back = Transformer.from_crs(32611, 4326, always_xy=True)
    corners = [(500100, 3999900), (500700, 3999900), (500700, 3999300)]
    ring = [list(back.transform(x, y)) for x, y in corners]
    body = {
        "variable": "displacement",
        "geometry": {"type": "Polygon", "coordinates": [ring + ring[:1]]},
    }
    return (
        "/polygon_timeseries",
        json.dumps(body).encode(),
        {"Content-Type": "application/json"},
    )


REQUESTS = {"summarize_cube": _polygon}


@pytest.mark.parametrize("work", WORK)
def test_config_is_answered_while_lite_works(server, work):
    base, flag, opener = server
    path, body, headers = REQUESTS[work]()
    done: dict = {}

    def busy() -> None:
        req = urllib.request.Request(base + path, data=body, headers=headers)
        t0 = time.perf_counter()
        try:
            with opener.open(req, timeout=60) as r:
                done["status"] = r.status
                r.read()
        except Exception as exc:  # noqa: BLE001
            done["status"] = repr(exc)
        done["took"] = time.perf_counter() - t0

    Path(f"{flag}.{work}").write_text("")  # the next call sleeps SLOW seconds
    th = threading.Thread(target=busy)
    th.start()
    time.sleep(0.5)  # the work is asleep now
    t0 = time.perf_counter()
    opener.open(base + "/config", timeout=60).read()
    waited = time.perf_counter() - t0
    th.join()
    assert done["status"] == 200, done
    assert done["took"] >= SLOW, f"{work} was never reached"
    assert waited < PROMPT, f"/config waited {waited:.1f} s behind {path}"
