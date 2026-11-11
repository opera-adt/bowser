"""Read-only HTTP access to the open GeoZarr cube's files, for the GPU renderer.

The page's experimental GPU renderer (``?render=gpu`` or ``?render=auto``) reads
the cube's chunks itself instead of asking for rendered PNG tiles.
``GET /zarr/{path}`` serves the files of the cube the request is routed to: the
server's own cube (``BOWSER_STACK_DATA_FILE``), or the catalog entry named by
``?dataset=`` (both servers route that in middleware, as for every data route).
HTTP Range and HEAD are supported (Starlette's ``FileResponse``), so a sharded
store can be read one inner chunk at a time.

What is served, and what is refused:

- only a zarr v3 store on this computer's disk (a folder with a ``zarr.json``);
  a remote store (``s3://``, ``https://``), a COG stack or no cube is a 404, and
  the page draws server tiles instead;
- only zarr's own files: ``zarr.json`` metadata and chunk files (``c/0/1/2`` or
  ``c.0.1.2``); any other file in the folder, and any hidden file or folder, is a
  404;
- nothing outside the store: the path, with symlinks followed, must stay inside
  the store's folder, so ``..``, absolute paths, encoded variants and symlinks
  that point out are a 404;
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
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as PathParam
from starlette.responses import FileResponse, Response

from . import api_models as api

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


def resolve_inside(root: Path, rel: str) -> Path:
    """Return the file ``rel`` of the store at ``root``, or raise a 404.

    ``rel`` must be a zarr key (``zarr.json`` or a chunk), with no empty, hidden
    (``.``-prefixed) or backslashed part, and must resolve (symlinks followed) to a
    regular file inside ``root``.
    """
    parts = rel.split("/")
    if not _ZARR_KEY.match(rel) or any(
        not p or p.startswith(".") or "\\" in p or "\0" in p for p in parts
    ):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    try:
        target = (root / rel).resolve()
        inside = target.is_relative_to(root) and target.is_file()
    except (OSError, RuntimeError, ValueError):
        inside = False
    if not inside:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return target


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
        root = local_store_root(store_uri())
        if root is None:
            raise HTTPException(status_code=404, detail="No local zarr v3 cube")
        target = resolve_inside(root, path)
        media = "application/json" if target.name == "zarr.json" else None
        return FileResponse(
            target,
            media_type=media or "application/octet-stream",
            headers={"Cache-Control": "private, max-age=600"},
        )

    return router
