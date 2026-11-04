"""Reading a WMS GetCapabilities server-side (browsers are usually blocked by CORS)."""

from __future__ import annotations

import ssl
import urllib.request
from xml.etree import ElementTree

from fastapi import HTTPException


def _ssl_context() -> ssl.SSLContext:
    """Return an SSL context with certifi's CA bundle when installed.

    Some hosts' system store is incomplete.
    """
    try:
        import certifi  # noqa: PLC0415

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return ssl.create_default_context()


def parse_named_layers(raw: bytes) -> list[dict]:
    """``[{name, title}]`` for every ``<Layer>`` with a ``<Name>``.

    In document order, once each.
    """
    root = ElementTree.fromstring(raw)  # noqa: S314
    layers: list[dict] = []
    seen: set[str] = set()
    for el in root.iter():
        if el.tag.split("}")[-1] != "Layer":
            continue
        name = title = None
        for child in el:
            tag = child.tag.split("}")[-1]
            if tag == "Name" and name is None:
                name = (child.text or "").strip()
            elif tag == "Title" and title is None:
                title = (child.text or "").strip()
        if name and name not in seen:
            seen.add(name)
            layers.append({"name": name, "title": title or name})
    return layers


def named_layers(url: str) -> list[dict]:
    """Fetch ``url``'s GetCapabilities and list its named layers (502 on failure)."""
    sep = "&" if "?" in url else "?"
    cap_url = f"{url}{sep}service=WMS&request=GetCapabilities"
    try:
        with urllib.request.urlopen(
            cap_url, timeout=20, context=_ssl_context()
        ) as resp:  # noqa: S310
            raw = resp.read()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Could not fetch WMS capabilities: {exc}"
        ) from exc
    try:
        return parse_named_layers(raw)
    except ElementTree.ParseError as exc:
        raise HTTPException(
            status_code=502, detail=f"Invalid WMS capabilities XML: {exc}"
        ) from exc
