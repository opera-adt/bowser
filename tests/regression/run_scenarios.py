"""Replay the requests the bowser UI makes against one cube; print normalised JSON.

Writes to the path given as the only argument. Run in a fresh interpreter
(``bowser.main`` reads its settings at import), with
either ``BOWSER_STACK_DATA_FILE`` (single dataset) or ``BOWSER_CATALOG_FILE`` set.
``DATASET`` (env) is the catalog id to send as ``?dataset=``; empty in single mode.

Request shapes mirror src/hooks/useApi.ts, src/components/MapContainer.tsx
(RasterTileLayer) and src/components/ProfileTool.tsx, so a change in what the
backend returns for what the UI asks is caught here, whatever the map library.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cube import CENTER_LONLAT, EDGE_LONLAT, REF_LONLAT  # noqa: E402

DATASET = os.environ.get("DATASET", "")


def norm(v):
    """Round floats to 6 significant figures, NaN/inf -> None, recursively."""
    if isinstance(v, float):
        if not math.isfinite(v):
            return None
        return float(f"{v:.6g}")
    if isinstance(v, dict):
        return {k: norm(x) for k, x in sorted(v.items())}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


def q(**kw) -> dict:
    """Query params, plus ?dataset= when routing to a catalog entry."""
    return {**kw, **({"dataset": DATASET} if DATASET else {})}


def tile_xyz(lon: float, lat: float, z: int) -> tuple[int, int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return z, x, y


def png_fingerprint(content: bytes) -> dict:
    """Decoded-pixel fingerprint (robust to PNG encoder differences)."""
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(io.BytesIO(content)).convert("RGBA"))
    return {
        "shape": list(a.shape),
        "sha256": hashlib.sha256(a.tobytes()).hexdigest()[:16],
        "mean_rgba": [round(float(m), 2) for m in a.reshape(-1, 4).mean(0)],
        "opaque_fraction": round(float((a[..., 3] > 0).mean()), 4),
    }


def main() -> None:
    from fastapi.testclient import TestClient

    from bowser.main import app

    c = TestClient(app)
    out: dict = {}

    def get(name, path, **params):
        r = c.get(path, params=q(**params))
        out[name] = {
            "status": r.status_code,
            "body": norm(r.json())
            if r.headers.get("content-type", "").startswith("application/json")
            else None,
        }
        return r

    def post(name, path, body):
        r = c.post(path, params=q(), json=body)
        out[name] = {
            "status": r.status_code,
            "body": norm(r.json()) if r.status_code == 200 else r.text[:300],
        }
        return r

    lon, lat = CENTER_LONLAT
    rlon, rlat = REF_LONLAT

    get("mode", "/mode")
    get("variables", "/variables")
    ds = get("datasets", "/datasets").json()
    out["datasets"]["body"] = norm(
        {
            k: {
                kk: vv
                for kk, vv in v.items()
                if kk not in ("file_list", "mask_file_list")
            }
            for k, v in ds.items()
        }
    )
    get("time_bounds", "/datasets/displacement/time_bounds")
    get("dataset_range", "/dataset_range/displacement")
    get("dataset_range_velocity", "/dataset_range/velocity")
    get("histogram", "/histogram/displacement", time_index=3, nbins=20)
    get("point", "/point", dataset_name="displacement", lon=lon, lat=lat)
    get(
        "point_time_idx",
        "/point",
        dataset_name="displacement",
        lon=lon,
        lat=lat,
        time_idx=2,
    )
    get("point_2d", "/point", dataset_name="velocity", lon=lon, lat=lat)
    get("point_outside", "/point", dataset_name="displacement", lon=-117.0, lat=34.5)
    get(
        "chart_point",
        "/chart_point",
        dataset_name="displacement",
        lon=lon,
        lat=lat,
        ref_lon=rlon,
        ref_lat=rlat,
    )
    get(
        "trend",
        "/trend_analysis/displacement",
        lon=lon,
        lat=lat,
        ref_lon=rlon,
        ref_lat=rlat,
    )
    pts = [
        {"id": "p1", "lat": lat, "lon": lon, "color": "#f00", "name": "dam"},
        {
            "id": "p2",
            "lat": EDGE_LONLAT[1],
            "lon": EDGE_LONLAT[0],
            "color": "#00f",
            "name": "edge",
        },
    ]
    mp = {
        "points": pts,
        "dataset_name": "displacement",
        "ref_lon": rlon,
        "ref_lat": rlat,
        "calculate_trends": True,
        "layer_masks": [],
        "ref_buffer_m": 0,
    }
    post("multi_point", "/multi_point", mp)
    post(
        "multi_point_masked",
        "/multi_point",
        {
            **mp,
            "layer_masks": [
                {"dataset": "temporal_coherence", "threshold": 0.7, "mode": "min"}
            ],
        },
    )
    post(
        "buffer",
        "/buffer_timeseries",
        {
            "lon": lon,
            "lat": lat,
            "dataset_name": "displacement",
            "buffer_m": 90,
            "n_samples": 5,
            "ref_lon": rlon,
            "ref_lat": rlat,
            "layer_masks": [],
            "ref_buffer_m": 0,
        },
    )
    line = [[rlon, rlat], [EDGE_LONLAT[0], EDGE_LONLAT[1]]]
    post(
        "profile",
        "/profile",
        {
            "coords": line,
            "dataset_name": "displacement",
            "time_index": 5,
            "n_samples": 50,
            "radius": 0,
            "n_random": 0,
            "sampling_interval": 0,
        },
    )
    post(
        "profile_buffer",
        "/profile",
        {
            "coords": line,
            "dataset_name": "displacement",
            "time_index": 5,
            "n_samples": 50,
            "radius": 60,
            "n_random": 0,
            "sampling_interval": 0,
        },
    )
    r = c.get("/colorbar/RdBu_r")
    out["colorbar"] = {
        "status": r.status_code,
        "content_type": r.headers.get("content-type"),
    }

    # Map tiles, exactly as RasterTileLayer requests them.
    tj = get(
        "tilejson",
        "/md/WebMercatorQuad/tilejson.json",
        variable="displacement",
        time_idx=3,
        rescale="-0.01,0.01",
        colormap_name="rdbu_r",
        algorithm="shift",
        algorithm_params=json.dumps({"shift": 0.001}),
    ).json()
    if isinstance(tj, dict) and tj.get("tiles"):
        out["tilejson"]["body"] = norm({k: v for k, v in tj.items() if k != "tiles"})
        template = tj["tiles"][0].split("://", 1)[-1].split("/", 1)[1]
        for z in (14, 16):
            zz, x, y = tile_xyz(lon, lat, z)
            r = c.get("/" + template.format(z=zz, x=x, y=y))
            out[f"tile_z{z}"] = {
                "status": r.status_code,
                **(
                    png_fingerprint(r.content)
                    if r.status_code == 200
                    else {"text": r.text[:200]}
                ),
            }
    Path(sys.argv[1]).write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
