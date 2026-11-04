"""Find GeoZarr cubes under a folder (Project › Open data › Search a folder)."""

from __future__ import annotations

import json
import os
from pathlib import Path

#: How deep to look, and how many cubes to list at most.
MAX_DEPTH = 4
MAX_RESULTS = 200


def _title(store: Path) -> str | None:
    """Read the cube's ``title`` attribute without opening it.

    It comes from Zarr v3 ``zarr.json`` or v2 ``.zattrs``.
    """
    for name, read in (
        ("zarr.json", lambda d: d.get("attributes", {})),
        (".zattrs", lambda d: d),
    ):
        try:
            title = read(json.loads((store / name).read_text())).get("title")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(title, str) and title.strip():
            return title.strip()
    return None


def _is_zarr(path: Path) -> bool:
    return (
        path.suffix == ".zarr"
        or (path / "zarr.json").is_file()
        or (path / ".zgroup").is_file()
    )


def find_cubes(
    root: str | Path, max_depth: int = MAX_DEPTH, limit: int = MAX_RESULTS
) -> dict:
    """Find Zarr stores under ``root``.

    Returns ``{"cubes": [{path, name, title}], "truncated": bool}``. A store is a
    ``*.zarr`` folder (or one holding ``zarr.json`` / ``.zgroup``); its insides are
    not searched. Hidden folders are skipped.
    """
    base = Path(root).expanduser().resolve()
    if not base.is_dir():
        raise NotADirectoryError(f"{base} is not a folder")
    cubes: list[dict] = []
    truncated = False
    stack: list[tuple[Path, int]] = [(base, 0)]
    while stack:
        folder, depth = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith(".") or not entry.is_dir(follow_symlinks=False):
                continue
            path = Path(entry.path)
            if _is_zarr(path):
                if len(cubes) >= limit:
                    truncated = True
                    break
                cubes.append(
                    {
                        "path": str(path),
                        "name": path.name.removesuffix(".zarr"),
                        "title": _title(path),
                    }
                )
            elif depth + 1 < max_depth:
                stack.append((path, depth + 1))
        if truncated:
            break
    cubes.sort(key=lambda c: c["path"])
    return {"cubes": cubes, "truncated": truncated}
