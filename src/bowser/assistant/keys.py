"""API keys for the Assistant, kept on this computer and never in the page.

The page sends a key once (``PUT /assistant/key``); the server keeps it in the
system keychain when the ``keyring`` package has a working backend, otherwise in
a JSON file only this user can read (mode 0600, in a 0700 folder). The same file
always holds what is not secret: which store each key is in and its last four
characters (a hint for the page). Keys are never logged, returned to the page or
put in an error message.

This module reads no settings: the caller passes the file's path.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
from pathlib import Path
from typing import Any

#: The keychain's service name; each key is stored under its provider's id.
SERVICE = "bowser-assistant"


def default_path() -> Path:
    """Return the file in the user's config folder (``…/bowser/assistant.json``)."""
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "bowser" / "assistant.json"


def system_keyring() -> Any | None:
    """Return the ``keyring`` module when it has a usable backend, else None."""
    try:
        import keyring  # noqa: PLC0415
        from keyring.backends.fail import Keyring as FailKeyring  # noqa: PLC0415
    except ImportError:
        return None
    try:
        backend = keyring.get_keyring()
    except Exception:  # noqa: BLE001  (a broken backend is no backend)
        return None
    return None if isinstance(backend, FailKeyring) else keyring


class KeyStore:
    """Saved API keys, one record per provider.

    Parameters
    ----------
    path : Path
        The JSON file (created on the first save).
    keyring : module or None, optional
        The keychain to use; by default :func:`system_keyring`. Pass None to keep
        keys in the file only.

    """

    _DEFAULT = object()

    def __init__(self, path: Path, keyring: Any = _DEFAULT) -> None:
        """Use the file at ``path`` and the given keychain."""
        self.path = Path(path)
        self._keyring = system_keyring() if keyring is KeyStore._DEFAULT else keyring

    # --- the file -------------------------------------------------------------------

    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            self.path.parent.chmod(0o700)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.unlink(missing_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=1)
        tmp.replace(self.path)

    def _records(self) -> dict[str, dict[str, Any]]:
        records = self._read().get("providers")
        return records if isinstance(records, dict) else {}

    def _save_records(self, records: dict[str, dict[str, Any]]) -> None:
        data = self._read()
        data["providers"] = records
        self._write(data)

    # --- keys -------------------------------------------------------------------------

    def load(self, provider: str) -> str | None:
        """Return the key saved for ``provider``, or None."""
        rec = self._records().get(provider) or {}
        if rec.get("store") == "keyring":
            if self._keyring is None:
                return None
            try:
                return self._keyring.get_password(SERVICE, provider) or None
            except Exception:  # noqa: BLE001  (locked or gone: no key)
                return None
        key = rec.get("key")
        return key if isinstance(key, str) and key else None

    def save(self, provider: str, key: str, hint: str | None = None) -> str:
        """Keep ``key`` for ``provider``; return where: ``keyring`` or ``file``.

        ``hint`` replaces the default hint (the key's last four characters), e.g.
        for a sign-in's tokens, whose tail means nothing.
        """
        self.remove_key(provider)
        records = self._records()
        if hint is None:
            hint = f"…{key[-4:]}" if len(key) >= 12 else "…"
        rec: dict[str, Any] = {"hint": hint}
        stored = False
        if self._keyring is not None:
            try:
                self._keyring.set_password(SERVICE, provider, key)
                stored = True
            except Exception:  # noqa: BLE001  (no D-Bus, locked keychain: use the file)
                stored = False
        if stored:
            rec["store"] = "keyring"
        else:
            rec.update(store="file", key=key)
        records[provider] = rec
        self._save_records(records)
        return rec["store"]

    def remove_key(self, provider: str) -> None:
        """Forget ``provider``'s key."""
        records = self._records()
        rec = records.get(provider)
        if not rec:
            return
        if rec.get("store") == "keyring" and self._keyring is not None:
            with contextlib.suppress(Exception):
                self._keyring.delete_password(SERVICE, provider)
        records.pop(provider)
        self._save_records(records)

    def describe(self, provider: str) -> dict[str, Any]:
        """Return what the page may see: ``{"saved", "store", "hint"}``, no key."""
        rec = self._records().get(provider) or {}
        saved = rec.get("store") in ("keyring", "file")
        return {
            "saved": saved,
            "store": rec.get("store") if saved else None,
            "hint": rec.get("hint") if saved else None,
        }

    # --- sign-in accounts: what is not secret ----------------------------------------

    def account(self, name: str) -> dict[str, Any]:
        """Return the non-secret record of sign-in ``name`` (e.g. its email)."""
        accounts = self._read().get("accounts")
        rec = accounts.get(name) if isinstance(accounts, dict) else None
        return dict(rec) if isinstance(rec, dict) else {}

    def set_account(self, name: str, **fields: Any) -> None:
        """Update sign-in ``name``'s record; a None value removes that field.

        Never put a token here: this file is not the keychain.
        """
        data = self._read()
        accounts = data.get("accounts")
        accounts = accounts if isinstance(accounts, dict) else {}
        rec = dict(accounts.get(name) or {})
        for k, v in fields.items():
            if v is None:
                rec.pop(k, None)
            else:
                rec[k] = v
        if rec:
            accounts[name] = rec
        else:
            accounts.pop(name, None)
        data["accounts"] = accounts
        self._write(data)
