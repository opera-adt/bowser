"""Folders on the server: find cubes under one, or list one.

Project › Open data › Search a folder finds GeoZarr cubes; Overlays › Load file ›
Browse lists a folder's files to add.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

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


#: How many entries a folder listing returns at most.
MAX_ENTRIES = 1000


def list_folder(
    folder: str | Path,
    kind_of: Callable[[str], str | None],
    *,
    hidden: bool = False,
    limit: int = MAX_ENTRIES,
) -> dict:
    """List one folder for Overlays › Load file › Browse (no recursion).

    Returns ``{dir, parent, entries, truncated, skipped}``: ``dir`` with its
    symlinks resolved, its sub-folders first, then the files ``kind_of`` gives a
    kind (``"raster"``, ``"vector"``), each sorted by name, case-insensitively, at
    most ``limit`` of them. Hidden ones (``.name``) are left out unless ``hidden``.
    An entry that cannot be read (no permission, a broken link) is skipped and
    counted in ``skipped``. Raises ``NotADirectoryError`` for a path that is not a
    folder and ``PermissionError`` for one that cannot be listed.
    """
    base = Path(folder).expanduser().resolve()
    if not base.is_dir():
        raise NotADirectoryError(f"{base} is not a folder")
    dirs: list[tuple[str, os.DirEntry]] = []
    files: list[tuple[str, os.DirEntry, str]] = []
    skipped = 0
    with os.scandir(base) as it:
        for entry in it:
            if entry.name.startswith(".") and not hidden:
                continue
            try:
                is_dir = entry.is_dir()  # follows symlinks
            except OSError:
                skipped += 1
                continue
            if is_dir:
                dirs.append((entry.name.lower(), entry))
            elif (kind := kind_of(entry.name)) is not None:
                files.append((entry.name.lower(), entry, kind))
    dirs.sort(key=lambda d: d[0])
    files.sort(key=lambda f: f[0])
    truncated = len(dirs) + len(files) > limit
    entries: list[dict] = []
    listed = [(e, None) for _, e in dirs] + [(e, k) for _, e, k in files]
    for entry, kind in listed[:limit]:
        # What this user cannot read is left out: a folder it cannot open, a file
        # it cannot read, a broken link. A link's size is its target's.
        need = os.R_OK | os.X_OK if kind is None else os.R_OK
        try:
            size = None if kind is None else entry.stat().st_size
            readable = os.access(entry.path, need)
        except OSError:
            readable = False
        if not readable:
            skipped += 1
            continue
        entries.append(
            {
                "name": entry.name,
                "path": str(base / entry.name),
                "type": "dir" if kind is None else "file",
                "size": size,
                "kind": kind,
            }
        )
    parent = base.parent
    return {
        "dir": str(base),
        "parent": None if parent == base else str(parent),
        "entries": entries,
        "truncated": truncated,
        "skipped": skipped,
    }
