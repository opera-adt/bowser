"""Entry point of the packaged Bowser app (PyInstaller freezes this file).

Bowser                      the app: start screen in its own window
Bowser --browser            the same in the default browser
Bowser --smoke-test CUBE    start headless, open CUBE, fetch one tile and one point,
                            the statistics of an area and a GeoTIFF export, exit 0
                            on success
Bowser --mcp-url URL        Bowser's MCP server on stdio for the Bowser at URL (what
                            a signed-in Claude Code starts; see bowser.assistant)
"""

from __future__ import annotations

import json
import sys
import urllib.request


def smoke_test(cube: str) -> int:
    """Check the frozen app before CI uploads it: open a cube, fetch a tile."""
    import os  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from bowser import desktop  # noqa: PLC0415

    os.environ.update(
        desktop.desktop_env(Path(tempfile.mkdtemp(prefix="bowser-smoke-")))
    )
    server = desktop.LocalServer()
    server.start()

    def call(path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            server.url + path, data=data, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310
            return r.status, r.read()

    try:
        _, opened = call("/catalog/open", {"uri": cube})
        dataset = json.loads(opened)["id"]
        _, info = call(f"/datasets?dataset={dataset}")
        variable, meta = next(iter(json.loads(info).items()))
        w, s, e, n = meta["latlon_bounds"]
        lon, lat = (w + e) / 2, (s + n) / 2
        _, series = call(
            f"/point?dataset={dataset}&dataset_name={variable}&lon={lon}&lat={lat}"
        )
        status, tile = call(
            f"/md/tiles/WebMercatorQuad/0/0/0.png?dataset={dataset}"
            f"&variable={variable}&time_idx=0&rescale=-1,1&colormap_name=rdbu"
        )
        ok = (
            status == 200
            and tile[:8] == b"\x89PNG\r\n\x1a\n"
            and len(json.loads(series)) > 0
        )
        print(
            f"smoke test {'passed' if ok else 'FAILED'}: {variable}, "
            f"{len(json.loads(series))} values, tile {len(tile)} bytes"
        )
        analysis = analysis_check(call, dataset, variable, meta["latlon_bounds"])
        return 0 if ok and analysis and assistant_check(call) else 1
    finally:
        server.stop()


def analysis_check(call, dataset: str, variable: str, bounds: list[float]) -> bool:
    """Check area statistics and GeoTIFF export, which the app does without GDAL."""
    import urllib.error  # noqa: PLC0415

    w, s, e, n = bounds
    lon, lat = (w + e) / 2, (s + n) / 2
    pixels = 0
    # A box around the centre: larger until it holds a pixel centre.
    for share in (0.002, 0.01, 0.05, 0.25):
        dx, dy = (e - w) * share, (n - s) * share
        ring = [
            [lon - dx, lat - dy],
            [lon + dx, lat - dy],
            [lon + dx, lat + dy],
            [lon - dx, lat + dy],
            [lon - dx, lat - dy],
        ]
        body = {
            "variable": variable,
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }
        try:
            _, stats = call(f"/polygon_timeseries?dataset={dataset}", body)
        except urllib.error.HTTPError as err:
            if err.code == 422:  # no pixel centre inside yet
                continue
            raise
        found = json.loads(stats)
        pixels = found["polygon_pixels"] if found["statistics"] else 0
        break
    status, tif = call(
        f"/export/geotiff?dataset={dataset}&variable={variable}&time_idx=0"
    )
    # A little-endian TIFF (42) or BigTIFF (43).
    exported = status == 200 and tif[:4] in (b"II*\x00", b"II+\x00")
    ok = pixels > 0 and exported
    print(
        f"analysis check {'passed' if ok else 'FAILED'}: area of {pixels} pixels, "
        f"GeoTIFF {len(tif)} bytes"
    )
    return ok


#: What the Assistant tab loads only when it is used: missing from the frozen app,
#: they would fail on the user's first question, not at start.
ASSISTANT_MODULES = (
    "anthropic",
    "httpx",
    "keyring",
    "jwt",
    "mcp.server.mcpserver",
    "bowser.mcp_server",
    "bowser.assistant.providers",
    "bowser.assistant.signin",
)


def assistant_check(call) -> bool:
    """Check the Assistant is on in the app and all it loads later is packed."""
    import importlib  # noqa: PLC0415

    _, status = call("/assistant/status")
    enabled = bool(json.loads(status).get("enabled"))
    missing = []
    for name in ASSISTANT_MODULES:
        try:
            importlib.import_module(name)
        except Exception as e:  # noqa: BLE001  (any failure means it is not usable)
            missing.append(f"{name} ({type(e).__name__}: {e})")
    ok = enabled and not missing
    print(
        f"assistant check {'passed' if ok else 'FAILED'}: enabled={enabled}"
        + (f", cannot import {'; '.join(missing)}" if missing else "")
    )
    return ok


def main() -> int:
    """Run the app, or the smoke test with ``--smoke-test CUBE``."""
    if "--smoke-test" in sys.argv:
        return smoke_test(sys.argv[sys.argv.index("--smoke-test") + 1])
    if "--mcp-url" in sys.argv:
        from bowser.mcp_server import build_server  # noqa: PLC0415

        build_server(sys.argv[sys.argv.index("--mcp-url") + 1]).run("stdio")
        return 0
    from bowser.desktop import run  # noqa: PLC0415

    run(browser="--browser" in sys.argv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
