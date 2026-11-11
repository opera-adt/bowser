"""MCP server for Bowser: ``bowser mcp``.

A thin layer over Bowser's HTTP API (see docs/rest-api.md). The tools are
Bowser's data tools (:mod:`bowser.tools`), the same ones the page's Assistant
tab offers: each calls a running Bowser server, full (``bowser run``) or lite
(``bowser lite``), and turns its JSON into a compact answer a model can read.

Needs the optional ``mcp`` extra (``pip install 'bowser-insar[mcp]'``). Nothing
else in Bowser imports this module.
"""

from __future__ import annotations

import contextlib
import functools
import os
import sys
from pathlib import Path

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .tools import DEFAULT_URL, INSTRUCTIONS, BowserAPI, BowserError, build_tools

__all__ = ["DEFAULT_URL", "INSTRUCTIONS", "build_server", "lite_transport"]


def build_server(
    base_url: str = DEFAULT_URL,
    transport: httpx.AsyncBaseTransport | None = None,
) -> MCPServer:
    """Build the MCP server whose tools call the Bowser server at ``base_url``.

    Parameters
    ----------
    base_url : str
        Root URL of a running Bowser server (full or lite).
    transport : httpx.AsyncBaseTransport, optional
        HTTP transport to use instead of the network, e.g.
        ``httpx.ASGITransport(app=app)`` to call an app in this process.

    Returns
    -------
    MCPServer
        The server; call ``.run("stdio")`` or ``.run("streamable-http", ...)``.

    """
    server = MCPServer("bowser", instructions=INSTRUCTIONS, log_level="WARNING")
    for spec in build_tools(BowserAPI(base_url, transport)):
        server.add_tool(
            _tool_errors(spec.fn),
            name=spec.name,
            description=spec.description,
            annotations=ToolAnnotations(
                readOnlyHint=spec.read_only, openWorldHint=False
            ),
        )
    return server


def _tool_errors(fn):
    """Wrap ``fn`` so expected failures become tool errors the model can act on."""

    @functools.wraps(fn)
    async def wrapped(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except BowserError as e:
            raise ToolError(str(e)) from e

    return wrapped


def lite_transport(stack_file: str) -> httpx.ASGITransport:
    """Open ``stack_file`` in a bowser-lite app in this process.

    Returns a transport for :func:`build_server`, so ``bowser mcp --stack-file``
    needs no separate server. bowser-lite reads its settings from the
    environment when first imported, so this must run before anything else
    imports it. Its start-up messages go to stderr: on the stdio transport,
    stdout carries the MCP messages.
    """
    os.environ["BOWSER_STACK_DATA_FILE"] = str(Path(stack_file).expanduser())
    with contextlib.redirect_stdout(sys.stderr):
        from bowser.lite.main import app  # noqa: PLC0415

    return httpx.ASGITransport(app=app)
