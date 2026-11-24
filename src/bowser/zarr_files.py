"""Read-only HTTP access to the open GeoZarr cube's files, for the GPU renderer.

The page's experimental GPU renderer (``?render=gpu`` or ``?render=auto``) reads
the cube's chunks itself instead of asking for rendered PNG tiles.
``GET /zarr/{path}`` serves the files of the cube the request is routed to: the
server's own cube (``BOWSER_STACK_DATA_FILE``), or the catalog entry named by
``?dataset=`` (both servers route that in middleware, as for every data route).
HTTP Range and HEAD are supported, so a sharded store can be read one inner
chunk at a time.

What is served, and what is refused:

- a zarr v3 store on this computer's disk (a folder with a ``zarr.json``), or one
  on S3 (``s3://``), whose files the server reads and relays unchanged, with the
  same access as for its tiles (anonymous unless ``BOWSER_S3_ANON=0``). Another
  remote store (``https://``, ``gs://``), a COG stack or no cube is a 404, and
  the page draws server tiles instead;
- only zarr's own files: ``zarr.json`` metadata and chunk files (``c/0/1/2`` or
  ``c.0.1.2``); any other file in the folder, and any hidden file or folder, is a
  404;
- and two virtual arrays per dated ``(date, y, x)`` mask, computed from it:
  ``<mask>@lowest_over_dates`` and ``<mask>@highest_over_dates``, its lowest and
  highest value over the dates (``mask_dates``), which the GPU path draws on a
  layer without dates;
- nothing outside the store: the path, with symlinks followed, must stay inside
  the store's folder, so ``..``, absolute paths, encoded variants and symlinks
  that point out are a 404 (on S3, the same key rules keep a request under the
  store's prefix);
- GET and HEAD only (405 otherwise);
- a browser request from another web site (an ``Origin`` or ``Sec-Fetch-Site``
  that is not this server) is a 403: the data API allows any origin, but bulk
  reads of the raw cube are for Bowser's own page;
- ``BOWSER_ZARR_FILES=false`` turns the route off (404), for a server that should
  send rendered tiles only.

Nothing here imports the settings or the app state; the servers pass them in.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as PathParam
from starlette.responses import FileResponse, Response

from . import api_models as api
from .mask_dates import virtual_file

#: A zarr v3 metadata document, or a chunk key of the default encoding ("/" or ".").
_ZARR_KEY = re.compile(r"^(?:[^/]+/)*(?:zarr\.json|c(?:/\d+)+|c(?:\.\d+)+)$")
_NOT_FOUND = "Not found"


def local_store_root(uri: Any) -> Path | None:
    """Return the folder of a local zarr v3 store, or None.

    Parameters
    ----------
    uri
        The cube's path or URL (``BowserState.uri`` / ``Cube.uri``); None when the
        server has no cube (COG mode, or a catalog without ``?dataset=``).

    Returns
    -------
    Path | None
        The resolved store folder (symlinks followed), or None for a remote store,
        a missing path or a folder that is not a zarr v3 store.

    """
    if not uri:
        return None
    text = str(uri)
    if text.startswith("file://"):
        text = text[len("file://") :]
    elif "://" in text:
        return None
    try:
        root = Path(text).expanduser().resolve()
        return root if (root / "zarr.json").is_file() else None
    except (OSError, RuntimeError, ValueError):
        return None


def _check_key(rel: str) -> None:
    """Raise a 404 unless ``rel`` is a zarr key with no empty, hidden or odd part."""
    parts = rel.split("/")
    if not _ZARR_KEY.match(rel) or any(
        not p or p.startswith(".") or "\\" in p or "\0" in p for p in parts
    ):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)


def resolve_inside(root: Path, rel: str) -> Path:
    """Return the file ``rel`` of the store at ``root``, or raise a 404.

    ``rel`` must be a zarr key (``zarr.json`` or a chunk), with no empty, hidden
    (``.``-prefixed) or backslashed part, and must resolve (symlinks followed) to a
    regular file inside ``root``.
    """
    _check_key(rel)
    try:
        target = (root / rel).resolve()
        inside = target.is_relative_to(root) and target.is_file()
    except (OSError, RuntimeError, ValueError):
        inside = False
    if not inside:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return target


@lru_cache(maxsize=16)
def remote_store(uri: Any) -> tuple[Any, str] | None:
    """Return ``(filesystem, prefix)`` for an S3 store, or None.

    The filesystem uses the servers' S3 access (anonymous unless
    ``BOWSER_S3_ANON=0``). Other schemes are not relayed.
    """
    text = str(uri or "")
    if not text.startswith("s3://"):
        return None
    import fsspec  # noqa: PLC0415

    from .lite.cube import storage_options_for  # noqa: PLC0415

    fs, prefix = fsspec.core.url_to_fs(text, **(storage_options_for(text) or {}))
    return fs, prefix.rstrip("/")


def _byte_range(header: str | None, size: Any) -> tuple[int, int | None] | None:
    """Parse one ``bytes=`` range into ``(start, end)`` (end exclusive, None = to EOF).

    ``size`` is a callable giving the object's size, called only for a suffix
    range (``bytes=-N``, how a sharded store reads its index). None: no or an
    unsupported (multi-part) range, so the whole object is sent.
    """
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    first, _, last = header[len("bytes=") :].strip().partition("-")
    try:
        if not first:
            total = size()
            return max(0, total - int(last)), total
        start = int(first)
        return start, int(last) + 1 if last else None
    except ValueError:
        return None


def _remote_file(request: Request, fs: Any, prefix: str, rel: str) -> Response:
    """Relay the S3 object ``rel`` under ``prefix``, or the range of it asked for."""
    _check_key(rel)
    key = f"{prefix}/{rel}"
    media = (
        "application/json" if rel.endswith("zarr.json") else "application/octet-stream"
    )
    headers = {"Cache-Control": "private, max-age=600", "Accept-Ranges": "bytes"}
    try:
        wanted = _byte_range(request.headers.get("range"), lambda: fs.size(key))
        if request.method == "HEAD":
            headers["Content-Length"] = str(fs.size(key))
            return Response(status_code=200, media_type=media, headers=headers)
        if wanted is None:
            return Response(fs.cat_file(key), media_type=media, headers=headers)
        start, end = wanted
        data = fs.cat_file(key, start=start, end=end)
    except FileNotFoundError as exc:
        # An absent chunk is all fill: the reader treats a 404 as that.
        raise HTTPException(status_code=404, detail=_NOT_FOUND) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Could not read the store") from exc
    headers["Content-Range"] = f"bytes {start}-{start + len(data) - 1}/*"
    return Response(data, status_code=206, media_type=media, headers=headers)


def _require_same_site(request: Request) -> None:
    """Refuse a browser request from another web site (CORS is open for data)."""
    own = f"{request.url.scheme}://{request.headers.get('host', '')}"
    origin = request.headers.get("origin")
    site = request.headers.get("sec-fetch-site")
    if (origin and origin != own) or (site and site not in ("same-origin", "none")):
        raise HTTPException(status_code=403, detail="Only Bowser's own page.")


def make_router(
    store_uri: Callable[[], Any], enabled: Callable[[], bool] = lambda: True
) -> APIRouter:
    """Build the ``/zarr/{path}`` router.

    Parameters
    ----------
    store_uri
        Returns the path or URL of the cube this request is routed to (or None).
    enabled
        Returns whether the route is on (``settings.BOWSER_ZARR_FILES``).

    Returns
    -------
    APIRouter
        The router, for ``app.include_router``.

    """
    router = APIRouter()

    @router.api_route(
        "/zarr/{path:path}",
        methods=["GET", "HEAD"],
        response_class=Response,
        responses=api.ZARR_FILE_RESPONSES,
        **api.route_doc("GET /zarr/{path}"),
    )
    def zarr_file(
        request: Request,
        path: Annotated[str, PathParam(**api.PARAMS["zarr_path"])],
    ) -> Response:
        """Return one file of the cube's zarr store (metadata or a chunk)."""
        if not enabled():
            raise HTTPException(status_code=404, detail="Not served on this server")
        _require_same_site(request)
        uri = store_uri()
        root = local_store_root(uri)
        remote = None if root is not None else remote_store(uri)
        if root is None and remote is None:
            raise HTTPException(status_code=404, detail="No local or S3 zarr v3 cube")

        def read(rel: str) -> bytes:
            if root is not None:
                return resolve_inside(root, rel).read_bytes()
            _check_key(rel)
            try:
                return remote[0].cat_file(f"{remote[1]}/{rel}")
            except FileNotFoundError as exc:
                raise LookupError(rel) from exc

        # A dated mask combined over its dates, for the GPU path (mask_dates).
        try:
            virtual = virtual_file(str(root if root is not None else uri), path, read)
        except (LookupError, KeyError, ValueError) as exc:
            raise HTTPException(status_code=404, detail=_NOT_FOUND) from exc
        if virtual is not None:
            content, media = virtual
            return Response(
                content=b"" if request.method == "HEAD" else content,
                media_type=media,
                headers={
                    "Cache-Control": "private, max-age=600",
                    "Content-Length": str(len(content)),
                },
            )
        if remote is not None:
            return _remote_file(request, *remote, path)
        target = resolve_inside(root, path)
        media = "application/json" if target.name == "zarr.json" else None
        return FileResponse(
            target,
            media_type=media or "application/octet-stream",
            headers={"Cache-Control": "private, max-age=600"},
        )

    return router
