"""Replay the UI's requests against the full or the lite server; write what came back.

    python replay.py {full|lite} OUT_DIR [REQUESTS_JSON]

Run in a fresh interpreter with ``BOWSER_STACK_DATA_FILE`` or ``BOWSER_CATALOG_FILE``
set (both apps read settings at import), as ``tests/regression/run_scenarios.py``.

Writes ``OUT_DIR/scenarios.json`` (the regression scenarios of ``run_scenarios.py``
against the chosen app; skipped with ``SCENARIOS=0``) and, for each entry of
``REQUESTS_JSON``, its response in ``OUT_DIR/requests.json``. An entry is either a
tile, ``{name, tile: [z, x, y], params}``, saved as ``OUT_DIR/tiles/<name>.png``
(asked for as ``.png`` so the full server never answers with a JPEG), or a plain
request, ``{name, method, path, params, json}``.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "regression"))


def load_app(which: str):
    """Import the chosen app and make ``from bowser.main import app`` return it."""
    name = "bowser.lite.main" if which == "lite" else "bowser.main"
    module = importlib.import_module(name)
    sys.modules["bowser.main"] = module
    return module.app


def replay_requests(app, specs: list[dict], out: Path) -> dict:
    """Make each request and save tile PNGs.

    Return ``{name: {status, ms, body|content_type}}``.
    """
    from fastapi.testclient import TestClient

    dataset = os.environ.get("DATASET", "")
    c = TestClient(app, raise_server_exceptions=False)
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    result = {}
    for s in specs:
        params = {**s.get("params", {}), **({"dataset": dataset} if dataset else {})}
        if "tile" in s:
            z, x, y = s["tile"]
            method, path = "GET", f"/md/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png"
        else:
            method, path = s.get("method", "GET"), s["path"]
        t = time.perf_counter()
        r = c.request(method, path, params=params, json=s.get("json"))
        ms = (time.perf_counter() - t) * 1000
        entry: dict = {"status": r.status_code, "ms": round(ms, 2)}
        ctype = r.headers.get("content-type", "")
        if ctype.startswith("application/json"):
            entry["body"] = r.json()
        else:
            entry["content_type"] = ctype
        if "tile" in s and r.status_code == 200:
            (out / "tiles" / f"{s['name']}.png").write_bytes(r.content)
        result[s["name"]] = entry
    return result


def main() -> None:
    which, out = sys.argv[1], Path(sys.argv[2])
    specs = json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else []
    out.mkdir(parents=True, exist_ok=True)
    app = load_app(which)
    if os.environ.get("SCENARIOS", "1") != "0":
        import run_scenarios

        sys.argv = [sys.argv[0], str(out / "scenarios.json")]
        run_scenarios.main()
    if specs:
        result = replay_requests(app, specs, out)
        (out / "requests.json").write_text(
            json.dumps(result, indent=1, sort_keys=True) + "\n"
        )


if __name__ == "__main__":
    main()
