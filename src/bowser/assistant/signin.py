"""Signing in to an AI account instead of pasting an API key.

One registry, :data:`METHODS`, lists the ways to sign in; the tab's Sign in
drop-down offers one entry each. There are two kinds:

- ``oauth``: OAuth 2.0 authorization code with PKCE. The user's browser opens
  the provider's page and comes back to this server's ``/auth/callback``. The
  tokens are kept like API keys (:mod:`.keys`: keychain or a 0600 file), renewed
  with the refresh token and revoked on sign-out. They never reach the page or a
  log. Entry: "Continue with ChatGPT", OpenAI's "Sign in with ChatGPT" for
  open-source apps (https://developers.openai.com/siwc/token-sharing-open-source).
- ``local_agent``: the conversation goes to an AI agent program the user has
  installed and signed in to, through the Agent Client Protocol (:mod:`.acp`).
  Entry: "Sign in with Claude", the user's own Claude Code. Bowser never reads,
  copies or stores Claude Code's credentials and never calls Anthropic itself:
  only the Claude Code process talks to Anthropic, and signing in happens in
  Claude Code's own flow (``claude auth login``) on Anthropic's page.

Where Claude Code cannot open a browser the user sees (a Linux session with no
display, or Bowser started over SSH: the usual remote workstation with port
forwarding), the page opens the sign-in page instead. ``claude auth login``
prints its page's link and waits for the code that page shows. Bowser passes
the link on only when it is on Anthropic's own site, and writes the code the
user pastes to the program's input once: it is never kept, logged or sent
anywhere else. Bowser never offers a sign-in of its own; this is Claude Code's
own flow.

Sign-in works only where the page may keep keys (``BOWSER_ASSISTANT_PAGE_KEYS``)
and for requests from this computer: a sign-in is the user's own account.

This module reads no settings: the caller passes the key store.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode

from .keys import KeyStore

logger = logging.getLogger(__name__)

#: How long a started sign-in waits for the browser to come back.
PENDING_SECONDS = 600
#: Renew an access token this long before it expires.
REFRESH_MARGIN = 300
#: Clock skew allowed when checking an ID token.
CLOCK_SKEW = 300
#: Seconds before retrying a revocation (doubled each time; three tries).
REVOKE_BACKOFF = 0.5
#: Where an OAuth provider sends the browser back (OpenAI requires this path).
CALLBACK_PATH = "/auth/callback"
#: The name the user sees when OpenAI asks them to approve the app.
APP_NAME = "Bowser"

Kind = Literal["oauth", "local_agent"]


@dataclass(frozen=True)
class OAuthSpec:
    """An OAuth 2.0 provider (authorization code, PKCE, public client)."""

    issuer: str
    authorize_url: str
    token_url: str
    revoke_url: str
    jwks_url: str
    scopes: str
    #: The ``resource`` parameter (RFC 8707), sent with every grant.
    resource: str
    #: The scope that lets the token be used for chat; without it, no chat.
    chat_scope: str
    #: The API the access token is for (only these URLs get the token).
    api_url: str
    #: Where the user manages the plan's usage.
    usage_url: str = ""
    #: First sign-in registers a client: send this client id and get one back.
    register_client_id: str = ""


@dataclass(frozen=True)
class AgentSpec:
    """An agent program spoken to over ACP, maybe through an adapter."""

    #: The agent's own program (detected on PATH; it does the signing in).
    program: str
    #: The program's name as the user knows it (status text).
    name: str = ""
    #: A pinned npm package (``name@version``) that speaks ACP for the program;
    #: installed once into Bowser's cache (:func:`adapter_command`).
    adapter: str = ""
    #: The environment variable telling the adapter which program to run.
    program_env: str = ""
    #: Arguments that print the sign-in state as JSON (exit 0 when signed in).
    status_args: tuple[str, ...] = ()
    #: Arguments that start the program's own sign-in in the browser.
    login_args: tuple[str, ...] = ()
    install_url: str = ""
    #: The sites of the provider's sign-in page: a link the program prints is
    #: passed to the page only when its host is one of these (or under one).
    page_hosts: tuple[str, ...] = ()
    #: What a code from the sign-in page looks like (checked before it is sent).
    code_pattern: str = r"[A-Za-z0-9._~+/=-]{8,2048}"


@dataclass(frozen=True)
class Method:
    """One way to sign in, one entry in the tab's Sign in drop-down."""

    id: str
    label: str
    kind: Kind
    vendor: str
    #: One line under the button.
    blurb: str
    oauth: OAuthSpec | None = None
    agent: AgentSpec | None = None


CHATGPT_OAUTH = OAuthSpec(
    issuer="https://auth.openai.com",
    authorize_url="https://auth.openai.com/api/accounts/authorize",
    token_url="https://auth.openai.com/api/accounts/oauth/token",
    revoke_url="https://auth.openai.com/api/accounts/oauth/revoke",
    jwks_url="https://auth.openai.com/.well-known/jwks.json",
    scopes="openid profile email offline_access resource.invoke "
    "chatgpt.tokens.use.direct",
    resource="https://api.openai.com/v1",
    chat_scope="chatgpt.tokens.use.direct",
    api_url="https://api.openai.com/v1",
    usage_url="https://chatgpt.com/settings/usage?tab=overview",
    register_client_id="dynamic_agent_client",
)

CLAUDE_AGENT = AgentSpec(
    program="claude",
    name="Claude Code",
    adapter="@agentclientprotocol/claude-agent-acp@0.92.0",
    program_env="CLAUDE_CODE_EXECUTABLE",
    status_args=("auth", "status", "--json"),
    login_args=("auth", "login", "--claudeai"),
    install_url="https://code.claude.com/docs/en/setup",
    page_hosts=("claude.com", "claude.ai", "anthropic.com"),
    # Claude Code's page shows ``<code>#<state>``; it takes the two together.
    code_pattern=r"[A-Za-z0-9._~+/=-]{4,1024}#[A-Za-z0-9._~+/=-]{4,1024}",
)

METHODS: tuple[Method, ...] = (
    Method(
        id="claude",
        label="Sign in with Claude",
        kind="local_agent",
        vendor="Anthropic",
        blurb="Uses Claude Code on this computer and your Claude plan.",
        agent=CLAUDE_AGENT,
    ),
    Method(
        id="chatgpt",
        # OpenAI's guidelines name the button "Continue with ChatGPT".
        label="Continue with ChatGPT",
        kind="oauth",
        vendor="OpenAI",
        blurb="Uses your ChatGPT plan.",
        oauth=CHATGPT_OAUTH,
    ),
)


def method(method_id: str) -> Method | None:
    """Return the sign-in method with this id."""
    return next((m for m in METHODS if m.id == method_id), None)


def secret_name(m: Method) -> str:
    """Return the key store's name for a method's tokens."""
    return f"signin:{m.id}"


class SignInError(RuntimeError):
    """A sign-in that failed; the message is for the user and holds no token."""


# --- PKCE and the pending sign-ins ------------------------------------------------


def pkce_pair() -> tuple[str, str]:
    """Return ``(verifier, challenge)``: S256, base64url without padding."""
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


@dataclass
class Pending:
    """A sign-in waiting for the browser to come back."""

    method: str
    verifier: str
    nonce: str
    redirect_uri: str
    #: The client id sent: the registration entry point or an issued id.
    client_id: str
    started: float = field(default_factory=time.monotonic)


#: Started sign-ins by ``state``; each is used once.
_PENDING: dict[str, Pending] = {}


def _forget_old() -> None:
    now = time.monotonic()
    for state in [
        s for s, p in list(_PENDING.items()) if now - p.started > PENDING_SECONDS
    ]:
        _PENDING.pop(state, None)


#: Methods whose browser came back and whose tokens are being fetched.
_COMPLETING: set[str] = set()


def pending_for(method_id: str) -> bool:
    """Whether a sign-in with this method is waiting for the browser or finishing."""
    _forget_old()
    return method_id in _COMPLETING or any(
        p.method == method_id for p in list(_PENDING.values())
    )


def cancel_pending(method_id: str) -> None:
    """Forget the sign-ins of this method still waiting for the browser."""
    for s in [s for s, p in list(_PENDING.items()) if p.method == method_id]:
        _PENDING.pop(s, None)


def take_pending(state: str) -> Pending | None:
    """Return and forget the sign-in started with ``state``, if it is current."""
    _forget_old()
    if not isinstance(state, str) or not state:
        return None
    # Compare in constant time: the state is a secret of this attempt.
    for known in list(_PENDING):
        if secrets.compare_digest(known.encode(), state.encode()):
            return _PENDING.pop(known)
    return None


def host_id(store: KeyStore, m: Method) -> str:
    """Return this computer's stable id for ``m`` (made once, kept on sign-out)."""
    rec = store.account(m.id)
    value = rec.get("host_id")
    if isinstance(value, str) and value.startswith("urn:uuid:"):
        return value
    value = f"urn:uuid:{uuid.uuid4()}"
    store.set_account(m.id, host_id=value)
    return value


def begin(m: Method, store: KeyStore, redirect_uri: str, consent: bool = False) -> str:
    """Start an OAuth sign-in; return the provider's page to open.

    Parameters
    ----------
    m : Method
        An ``oauth`` method.
    store : KeyStore
        Where the account's registration and tokens are kept.
    redirect_uri : str
        This server's callback on 127.0.0.1.
    consent : bool
        Ask the provider to show its consent page again (after the user
        declined plan use).

    """
    spec = m.oauth
    assert spec is not None
    _forget_old()
    # One attempt per method at a time: a new click replaces the old one.
    cancel_pending(m.id)
    rec = store.account(m.id)
    issued = rec.get("client_id") if isinstance(rec.get("client_id"), str) else ""
    client_id = issued or spec.register_client_id
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": spec.scopes,
        "resource": spec.resource,
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if spec.register_client_id:
        params["ext_agent_host_id"] = host_id(store, m)
        if not issued:
            params["agent_name_hint"] = APP_NAME
    if issued and isinstance(rec.get("email"), str) and rec.get("signed_in"):
        params["login_hint"] = rec["email"]
    if consent:
        params["prompt"] = "consent"
    _PENDING[state] = Pending(m.id, verifier, nonce, redirect_uri, client_id)
    return f"{spec.authorize_url}?{urlencode(params)}"


# --- tokens -------------------------------------------------------------------------


def _client(transport: Any = None, timeout: float = 30.0):
    import httpx  # noqa: PLC0415

    return httpx.AsyncClient(timeout=timeout, transport=transport)


def _oauth_error(r: Any) -> str:
    try:
        body = r.json()
    except ValueError:
        return f"HTTP {r.status_code}"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("code") or err.get("message") or r.status_code)
        if err:
            return str(err)
    return f"HTTP {r.status_code}"


async def _post_form(
    url: str, data: dict[str, str], transport: Any = None
) -> dict[str, Any]:
    import httpx  # noqa: PLC0415

    try:
        async with _client(transport) as client:
            r = await client.post(
                url,
                data=data,
                headers={"Accept": "application/json"},
            )
    except httpx.TransportError as e:
        raise SignInError(
            f"Could not reach the sign-in server ({type(e).__name__})."
        ) from e
    if r.status_code >= 400:
        code = _oauth_error(r)
        # An error answer carries no tokens; its description says why.
        detail = ""
        with contextlib.suppress(ValueError, AttributeError):
            detail = str(r.json().get("error_description") or "")[:300]
        logger.warning(
            "sign-in: %s answered HTTP %s %s %s", url, r.status_code, code, detail
        )
        raise _TokenError(code)
    try:
        body = r.json()
    except ValueError as e:
        raise SignInError("The sign-in server sent an unreadable answer.") from e
    if not isinstance(body, dict) or not body.get("access_token"):
        raise SignInError("The sign-in server sent no access token.")
    return body


class _TokenError(SignInError):
    """The token endpoint refused a grant (``code`` is its error code)."""

    def __init__(self, code: str) -> None:
        super().__init__(f"The sign-in server refused: {code}.")
        self.code = code


#: Refresh errors after which the tokens are useless (sign in again).
_DEAD_GRANT = {
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
}


async def verify_id_token(
    spec: OAuthSpec, id_token: str, client_id: str, nonce: str, transport: Any = None
) -> dict[str, Any]:
    """Check an ID token and return its claims.

    Checks the signature (the issuer's JWKS), issuer, audience, expiry and nonce.
    """
    import httpx  # noqa: PLC0415
    import jwt  # noqa: PLC0415

    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError as e:
        raise SignInError("The ID token could not be read.") from e
    try:
        async with _client(transport) as client:
            r = await client.get(spec.jwks_url)
        keys = jwt.PyJWKSet.from_dict(r.json())
    except (httpx.TransportError, ValueError, jwt.PyJWTError) as e:
        raise SignInError("Could not read the sign-in server's keys.") from e
    key = next((k for k in keys.keys if k.key_id == header.get("kid")), None)
    if key is None:
        raise SignInError("The ID token is signed with an unknown key.")
    try:
        claims = jwt.decode(
            id_token,
            key=key.key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=spec.issuer,
            leeway=CLOCK_SKEW,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as e:
        raise SignInError(
            f"The ID token did not check out ({type(e).__name__})."
        ) from e
    if not secrets.compare_digest(str(claims.get("nonce") or ""), nonce):
        raise SignInError("The ID token is not from this sign-in (nonce).")
    if not claims.get("sub"):
        raise SignInError("The ID token names no account.")
    return claims


def _save_tokens(store: KeyStore, m: Method, body: dict[str, Any]) -> None:
    """Keep the tokens (secret) and their expiry and scopes (not secret)."""
    tokens = {
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token") or "",
        "id_token": body.get("id_token") or "",
        "expires_at": time.time() + float(body.get("expires_in") or 3600),
    }
    store.save(secret_name(m), json.dumps(tokens), hint="")
    scopes = str(body.get("scope") or "").split()
    store.set_account(m.id, scopes=scopes or None)


def _tokens(store: KeyStore, m: Method) -> dict[str, Any] | None:
    raw = store.load(secret_name(m))
    if not raw:
        return None
    try:
        tokens = json.loads(raw)
    except ValueError:
        return None
    return tokens if isinstance(tokens, dict) and tokens.get("access_token") else None


async def complete(
    m: Method,
    store: KeyStore,
    pending: Pending,
    params: dict[str, str],
    transport: Any = None,
) -> dict[str, Any]:
    """Finish a sign-in from the callback's query; return the account record.

    Raises SignInError when the user declined or anything does not check out.
    """
    _COMPLETING.add(m.id)
    try:
        return await _complete(m, store, pending, params, transport)
    finally:
        _COMPLETING.discard(m.id)


async def _complete(
    m: Method,
    store: KeyStore,
    pending: Pending,
    params: dict[str, str],
    transport: Any = None,
) -> dict[str, Any]:
    spec = m.oauth
    assert spec is not None
    if params.get("error"):
        if params["error"] == "access_denied":
            raise SignInError("Sign-in was cancelled.")
        raise SignInError(f"The sign-in page said: {params['error'][:80]}.")
    code = params.get("code") or ""
    if not code:
        raise SignInError("The sign-in page sent no code.")
    client_id = pending.client_id
    returned = params.get("client_id") or ""
    if spec.register_client_id and client_id == spec.register_client_id:
        # A first sign-in: the callback carries the issued client id.
        if not returned or returned == spec.register_client_id:
            raise SignInError("The app was not registered; sign in again.")
        client_id = returned
        # Keep the issued id before the exchange: when the exchange fails, the next
        # attempt must start with it, not register again (OpenAI: "start a fresh
        # authorization with the issued client ID retained").
        store.set_account(m.id, client_id=client_id)
    elif returned and returned != client_id:
        raise SignInError("The sign-in came back for another app registration.")
    body = await _post_form(
        spec.token_url,
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "code_verifier": pending.verifier,
            "redirect_uri": pending.redirect_uri,
            "resource": spec.resource,
        },
        transport,
    )
    claims = await verify_id_token(
        spec, str(body.get("id_token") or ""), client_id, pending.nonce, transport
    )
    rec = store.account(m.id)
    if rec.get("subject") and rec.get("client_id") == client_id:
        if rec["subject"] != claims["sub"]:
            raise SignInError("This is another account than the one signed in before.")
    _save_tokens(store, m, body)
    scopes = str(body.get("scope") or "").split()
    models: list[dict] = []
    if spec.chat_scope in scopes:
        try:
            models = await fetch_models(m, str(body["access_token"]), transport)
        except Exception:  # noqa: BLE001  (a model can be typed; the list comes later)
            models = []
    # Signed in last, with the model list, so the page never sees one without the
    # other.
    store.set_account(
        m.id,
        client_id=client_id,
        subject=str(claims["sub"]),
        email=str(claims.get("email") or "") or None,
        plan=spec.chat_scope in scopes,
        models=models or None,
        signed_in=True,
    )
    return store.account(m.id)


async def access_token(m: Method, store: KeyStore, transport: Any = None) -> str:
    """Return a current access token, renewing it first when it is about to end.

    Raises SignInError when there is none or it cannot be renewed.
    """
    spec = m.oauth
    assert spec is not None
    async with _lock(m.id):
        tokens = await asyncio.to_thread(_tokens, store, m)
        if tokens is None:
            raise SignInError(f"Sign in to {m.vendor} first.")
        if float(tokens.get("expires_at") or 0) - time.time() > REFRESH_MARGIN:
            return str(tokens["access_token"])
        rec = store.account(m.id)
        if not tokens.get("refresh_token") or not rec.get("client_id"):
            raise SignInError("The sign-in has ended; sign in again.")
        try:
            body = await _post_form(
                spec.token_url,
                {
                    "grant_type": "refresh_token",
                    "client_id": rec["client_id"],
                    "refresh_token": tokens["refresh_token"],
                    "resource": spec.resource,
                },
                transport,
            )
        except _TokenError as e:
            if e.code in _DEAD_GRANT:
                await asyncio.to_thread(_drop_tokens, store, m)
                raise SignInError("The sign-in has ended; sign in again.") from e
            raise
        body.setdefault("id_token", tokens.get("id_token") or "")
        await asyncio.to_thread(_save_tokens, store, m, body)
        return str(body["access_token"])


def _drop_tokens(store: KeyStore, m: Method) -> None:
    store.remove_key(secret_name(m))
    store.set_account(m.id, signed_in=None, plan=None, scopes=None)


_LOCKS: dict[str, asyncio.Lock] = {}


def _lock(name: str) -> asyncio.Lock:
    """One refresh at a time (the refresh token changes with each)."""
    lock = _LOCKS.get(name)
    if lock is None:
        lock = _LOCKS[name] = asyncio.Lock()
    return lock


async def sign_out(m: Method, store: KeyStore, transport: Any = None) -> bool:
    """Revoke the refresh token and forget the tokens.

    Return whether the provider confirmed the revocation (the tokens are
    forgotten either way).

    The app's registration (client id) and this computer's id stay, for the
    next sign-in.
    """
    spec = m.oauth
    assert spec is not None
    import httpx  # noqa: PLC0415

    tokens = await asyncio.to_thread(_tokens, store, m)
    client_id = store.account(m.id).get("client_id")
    revoked = tokens is None
    if tokens and client_id:
        token = tokens.get("refresh_token") or tokens.get("access_token")
        hint = "refresh_token" if tokens.get("refresh_token") else "access_token"
        for attempt in range(3):
            try:
                async with _client(transport) as client:
                    r = await client.post(
                        spec.revoke_url,
                        data={
                            "token": token,
                            "token_type_hint": hint,
                            "client_id": client_id,
                        },
                    )
                if r.status_code < 400:
                    revoked = True
                    break
                if r.status_code < 500:
                    break
            except httpx.TransportError:
                pass
            await asyncio.sleep(REVOKE_BACKOFF * 2**attempt)
    await asyncio.to_thread(_drop_tokens, store, m)
    return revoked


async def fetch_models(m: Method, token: str, transport: Any = None) -> list[dict]:
    """Return the account's models (for the picker)."""
    from .providers import CHATGPT, ResponsesProvider  # noqa: PLC0415

    spec = m.oauth
    assert spec is not None
    p = ResponsesProvider(CHATGPT, "", token, spec.api_url, transport)
    return await p.models()


# --- local agents -----------------------------------------------------------------


def find_program(name: str) -> str | None:
    """Return the full path of ``name`` on PATH, or None."""
    return shutil.which(name)


#: Variables an agent may see; everything else (API keys, tokens, Bowser's
#: settings) is left out.
_PASS_ENV = {
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "BROWSER",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "CLAUDE_CONFIG_DIR",
    # Windows
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
    "PROGRAMFILES",
    "ProgramFiles",
    "ProgramData",
}
_SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", re.IGNORECASE)


def agent_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Return the minimal environment an agent process runs with.

    Only the variables a program needs to run, find the user's home and reach
    the network; never an API key, a token or a Bowser setting.
    """
    env = {
        k: v
        for k, v in os.environ.items()
        if k in _PASS_ENV and not _SECRET_NAME.search(k)
    }
    env.update(extra or {})
    return env


@dataclass
class AgentState:
    """What the tab shows for a local agent."""

    installed: bool
    signed_in: bool = False
    account: str | None = None
    plan: str | None = None
    detail: str | None = None


#: ``claude auth status`` answers cached a short while (it starts a program).
_STATUS_CACHE: dict[str, tuple[float, AgentState]] = {}
STATUS_SECONDS = 20.0


async def agent_state(m: Method, fresh: bool = False) -> AgentState:
    """Return whether the agent's program is installed and signed in.

    Runs the program's own status command (cached briefly, unless ``fresh``);
    reads no credentials.
    """
    spec = m.agent
    assert spec is not None
    now = time.monotonic()
    cached = _STATUS_CACHE.get(m.id)
    if cached and not fresh and now - cached[0] < STATUS_SECONDS:
        return cached[1]
    program = find_program(spec.program)
    if program is None:
        state = AgentState(installed=False)
    elif spec.adapter and find_program("node") is None and find_program("npx") is None:
        state = AgentState(installed=False, detail="Node.js is needed too.")
    else:
        state = await _run_status(program, spec)
    _STATUS_CACHE[m.id] = (now, state)
    return state


def forget_state(m: Method) -> None:
    """Drop the cached status (after a sign-in finished)."""
    _STATUS_CACHE.pop(m.id, None)


async def _run_status(program: str, spec: AgentSpec) -> AgentState:
    try:
        proc = await asyncio.create_subprocess_exec(
            program,
            *spec.status_args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=agent_env(),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except (OSError, asyncio.TimeoutError):
        with contextlib.suppress(Exception):
            proc.kill()  # type: ignore[possibly-undefined]
        return AgentState(installed=True, detail="Its sign-in state could not be read.")
    try:
        info = json.loads(out.decode(errors="replace"))
    except ValueError:
        info = {}
    info = info if isinstance(info, dict) else {}
    signed_in = proc.returncode == 0 and bool(info.get("loggedIn", True))
    plan = info.get("subscriptionType")
    return AgentState(
        installed=True,
        signed_in=signed_in,
        account=str(info["email"]) if signed_in and info.get("email") else None,
        plan=str(plan).capitalize() if signed_in and plan else None,
    )


@dataclass
class Login:
    """A program's own sign-in, running (a plain process, polled)."""

    proc: Any
    started: float = field(default_factory=time.monotonic)
    error: str | None = None
    #: Whether the page opens the sign-in page (the program cannot).
    page: bool = False
    #: The provider's sign-in page the program printed (checked: its site).
    url: str | None = None
    #: Set once ``url`` is known or the program's output ended.
    seen: Any = None
    #: Whether a code was written to the program.
    code_sent: bool = False
    #: Held while writing to the program's input.
    lock: Any = None

    @property
    def running(self) -> bool:
        """Whether the program is still signing in."""
        return self.proc.poll() is None


_LOGINS: dict[str, Login] = {}

#: Seconds ``POST /assistant/signin`` waits for the program to print its page.
PAGE_WAIT_SECONDS = 45.0


def browser_here() -> bool:
    """Whether an agent's program can open a browser the user sees.

    Not when Bowser was started over SSH (the browser is on the user's own
    computer, reaching Bowser through port forwarding), and not on Linux
    without a display. Then the page opens the sign-in page itself.
    """
    if os.environ.get("SSH_CONNECTION") or os.environ.get("SSH_TTY"):
        return False
    if not sys.platform.startswith("linux"):
        return True
    return any(os.environ.get(v) for v in ("DISPLAY", "WAYLAND_DISPLAY"))


#: A link in a program's output; it ends at a space, a quote or a control
#: character (such as a terminal escape).
_URL = re.compile(r"https://[^\s\"'<>\x00-\x1f]+")


def sign_in_page(text: str, hosts: tuple[str, ...]) -> str | None:
    """Return the first ``https://`` link in ``text`` on one of ``hosts``, or None.

    A host matches itself and its subdomains. Links with a user name, a port
    or on any other site are skipped.
    """
    from urllib.parse import urlsplit  # noqa: PLC0415

    for found in _URL.finditer(text):
        url = found.group(0).rstrip(".,;)")
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError:
            continue
        host = (parts.hostname or "").lower()
        if (
            parts.scheme == "https"
            and not parts.username
            and not parts.password
            and port is None
            and "@" not in parts.netloc
            and any(host == h or host.endswith("." + h) for h in hosts)
        ):
            return url
    return None


def _login_env(page: bool) -> dict[str, str]:
    """Return the sign-in program's environment (no browser where the page opens it)."""
    env = agent_env()
    if page:
        for name in ("DISPLAY", "WAYLAND_DISPLAY", "BROWSER"):
            env.pop(name, None)
    return env


def start_login(m: Method) -> None:
    """Start the agent program's own sign-in.

    Where it can open a browser, it opens the provider's page itself. Else
    (:func:`browser_here`) it prints its page's link, which the tab opens, and
    waits for the code that page shows (:func:`send_code`). Bowser reads only
    that link and whether the program signed in.
    """
    import subprocess  # noqa: PLC0415
    import threading  # noqa: PLC0415

    spec = m.agent
    assert spec is not None
    current = _LOGINS.get(m.id)
    if current and current.running:
        return
    program = find_program(spec.program)
    if program is None:
        raise SignInError(f"{spec.program} is not installed.")
    page = not browser_here()
    proc = subprocess.Popen(  # noqa: S603  (the user's own program, fixed args)
        [program, *spec.login_args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=_login_env(page),
        start_new_session=sys.platform != "win32",
    )
    login = Login(proc, page=page, seen=threading.Event(), lock=threading.Lock())
    _LOGINS[m.id] = login
    threading.Thread(
        target=_follow_login,
        args=(login, spec),
        name=f"signin-{m.id}",
        daemon=True,
    ).start()


def _follow_login(login: Login, spec: AgentSpec) -> None:
    """Read a sign-in program's output for its page's link and its failure.

    Only those are looked for; the output is not kept or logged (it may echo
    the code).
    """
    name = spec.name or spec.program
    out = login.proc.stdout
    rest = b""
    try:
        while True:
            chunk = out.read1(4096) if hasattr(out, "read1") else out.read(4096)
            if not chunk:
                break
            *lines, rest = (rest + chunk).split(b"\n")
            rest = rest[-4096:]
            for raw in lines:
                line = raw.decode(errors="replace")
                url = sign_in_page(line, spec.page_hosts)
                if url:
                    login.url = url
                    login.seen.set()
                elif "Login failed" in line:
                    login.error = (
                        f"{name} could not sign in"
                        f"{' with that code' if login.code_sent else ''}. Sign in "
                        "again."
                    )
                    _kill_group(login.proc)
    except (OSError, ValueError):
        pass
    finally:
        login.seen.set()


def wait_for_page(m: Method, timeout: float | None = None) -> str | None:
    """Wait for the running sign-in's page (where the tab opens it); return it.

    None when the program opens the browser itself, ended (it was signed in
    already, or failed) or printed no page in time.
    """
    login = _LOGINS.get(m.id)
    if login is None or not login.page:
        return None
    login.seen.wait(PAGE_WAIT_SECONDS if timeout is None else timeout)
    return login.url if login.running and not login.error else None


def send_code(m: Method, code: str) -> None:
    """Write the code from the sign-in page to the waiting program, once.

    The code goes only to the program's input: it is not kept or logged.
    Raises SignInError when no sign-in waits for a code or it is not one.
    """
    spec = m.agent
    login = _LOGINS.get(m.id)
    if (
        spec is None
        or login is None
        or not login.page
        or not login.url
        or not login.running
        or login.error
    ):
        raise SignInError("No sign-in is waiting for a code; sign in again.")
    code = code.strip() if isinstance(code, str) else ""
    name = spec.name or spec.program
    if len(code) > 2048 or not re.fullmatch(spec.code_pattern, code):
        raise SignInError(
            f"That is not a whole code from {name}'s sign-in page; copy it again."
        )
    try:
        with login.lock:
            login.proc.stdin.write(code.encode("ascii") + b"\n")
            login.proc.stdin.flush()
    except (OSError, ValueError) as e:
        raise SignInError(f"{name} is no longer waiting; sign in again.") from e
    login.code_sent = True


def _kill_group(proc: Any) -> None:
    """End a sign-in program and what it started."""
    import signal  # noqa: PLC0415

    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        if sys.platform == "win32":
            proc.kill()
        else:
            os.killpg(proc.pid, signal.SIGKILL)


def login_state(m: Method) -> Login | None:
    """Return the running (or just ended) sign-in of ``m``; stop a stale one."""
    login = _LOGINS.get(m.id)
    if login is None:
        return None
    if login.running and time.monotonic() - login.started > PENDING_SECONDS:
        _kill_group(login.proc)
        login.error = "Signing in took too long."
    return login


def end_login(m: Method) -> None:
    """Stop and forget ``m``'s sign-in program."""
    login = _LOGINS.pop(m.id, None)
    if login is None:
        return
    if login.running:
        _kill_group(login.proc)
    with contextlib.suppress(Exception):
        login.proc.wait(5)
    for pipe in (login.proc.stdin, login.proc.stdout):
        with contextlib.suppress(OSError):
            if pipe is not None:
                pipe.close()


# --- the agent's ACP adapter, installed once ----------------------------------------


def cache_root() -> Path:
    """Return Bowser's cache folder (``~/.cache/bowser`` or the platform's)."""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "bowser"


def _split_package(spec: str) -> tuple[str, str]:
    """Split ``@scope/name@1.2.3`` into its name and version."""
    name, _, version = spec.rpartition("@")
    return name, version


def adapter_dir(spec: AgentSpec, root: Path | None = None) -> Path:
    """Return the folder the pinned adapter is installed in (one per version)."""
    name, version = _split_package(spec.adapter)
    return (root or cache_root()) / "acp" / f"{name.rsplit('/', 1)[-1]}@{version}"


def installed_adapter(spec: AgentSpec, root: Path | None = None) -> Path | None:
    """Return the adapter's entry script when the pinned version is installed."""
    name, version = _split_package(spec.adapter)
    package = adapter_dir(spec, root) / "node_modules" / name
    try:
        meta = json.loads((package / "package.json").read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get("version") != version:
        return None
    bin_ = meta.get("bin")
    if isinstance(bin_, dict):
        short = name.rsplit("/", 1)[-1]
        bin_ = bin_.get(short) or next(iter(bin_.values()), None)
    if not isinstance(bin_, str):
        return None
    script = (package / bin_).resolve()
    return script if script.is_file() else None


#: Seconds an install may take (npm downloads the adapter and its SDK).
INSTALL_SECONDS = 600.0


async def install_adapter(spec: AgentSpec, root: Path | None = None) -> Path:
    """Install the pinned adapter into Bowser's cache, once; return its script.

    ``npm install --prefix`` into a fresh folder next to the final one, then a
    rename, so a half-done install is never used. A lock file keeps two
    installs (in this process or another Bowser) from running at once. Raises
    SignInError when it fails.
    """
    found = installed_adapter(spec, root)
    if found:
        return found
    npm = find_program("npm")
    if npm is None:
        raise SignInError("npm is not installed.")
    final = adapter_dir(spec, root)
    final.parent.mkdir(parents=True, exist_ok=True)
    async with _file_lock(final.with_name(final.name + ".lock")):
        found = installed_adapter(spec, root)
        if found:
            return found
        work = final.with_name(f"{final.name}.part-{os.getpid()}")
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        proc = await asyncio.create_subprocess_exec(
            npm,
            "install",
            "--prefix",
            str(work),
            "--no-audit",
            "--no-fund",
            "--no-save",
            "--loglevel=error",
            # The SDK's bundled agent binary (~250 MB) is never run: the adapter
            # is told to run the user's own program (program_env).
            *(["--omit=optional"] if spec.program_env else []),
            spec.adapter,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=agent_env(),
            cwd=str(work),
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), INSTALL_SECONDS)
        except asyncio.TimeoutError as e:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            shutil.rmtree(work, ignore_errors=True)
            raise SignInError("Installing the adapter took too long.") from e
        if proc.returncode != 0:
            shutil.rmtree(work, ignore_errors=True)
            why = err.decode(errors="replace").strip().splitlines()[-1:] or [""]
            raise SignInError(f"npm could not install the adapter: {why[0][:200]}")
        shutil.rmtree(final, ignore_errors=True)
        work.rename(final)
    found = installed_adapter(spec, root)
    if not found:
        raise SignInError("The adapter was installed but its program is missing.")
    return found


@contextlib.asynccontextmanager
async def _file_lock(path: Path, wait: float = INSTALL_SECONDS):
    """Hold ``path`` as a lock between processes (created, then removed).

    A lock older than ``wait`` is taken to be left over from a crash.
    """
    deadline = time.monotonic() + wait
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            break
        except FileExistsError:
            with contextlib.suppress(OSError):
                if time.time() - path.stat().st_mtime > wait:
                    path.unlink()
                    continue
            if time.monotonic() > deadline:
                raise SignInError("Another install of the adapter did not finish.")
            await asyncio.sleep(0.5)
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            path.unlink()


async def adapter_command(
    spec: AgentSpec, on_install: Any = None, root: Path | None = None
) -> tuple[list[str], str | None]:
    """Return ``(argv, note)`` that start the agent's ACP adapter.

    ``node <script>`` from Bowser's cache, installing it first when needed
    (``on_install()`` is called then, for the status). When that fails,
    ``npx --prefer-offline`` with a note saying so. Raises SignInError when
    neither works.
    """
    node = find_program("node")
    script = installed_adapter(spec, root)
    if script is None and node is not None:
        if on_install is not None:
            on_install()
        try:
            script = await install_adapter(spec, root)
        except SignInError as e:
            note = f"{e} Using npx instead, which is slower to start."
            npx = find_program("npx")
            if npx is None:
                raise
            return [npx, "--yes", "--prefer-offline", spec.adapter], note
    if node is None or script is None:
        npx = find_program("npx")
        if npx is None:
            raise SignInError("Node.js is needed to talk to it.")
        return [npx, "--yes", "--prefer-offline", spec.adapter], (
            "Node.js was not found; using npx, which is slower to start."
        )
    return [node, str(script)], None


def mcp_command(base_url: str) -> tuple[str, list[str], dict[str, str]]:
    """Return ``(command, args, env)`` running ``bowser mcp --url base_url``.

    With this Python (or the desktop app's executable), for an agent to start.
    """
    import bowser  # noqa: PLC0415

    env: dict[str, str] = {"NO_PROXY": "127.0.0.1,localhost,::1"}
    if getattr(sys, "frozen", False):
        # The desktop app: its own executable runs the MCP server.
        return sys.executable, ["--mcp-url", base_url], env
    root = str(Path(bowser.__file__).resolve().parents[1])
    import sysconfig  # noqa: PLC0415

    installed = {
        str(Path(sysconfig.get_paths()[k]).resolve()) for k in ("purelib", "platlib")
    }
    if root not in installed:
        env["PYTHONPATH"] = root
    return sys.executable, ["-m", "bowser.cli", "mcp", "--url", base_url], env


def workdir(store: KeyStore) -> Path:
    """Return an empty private folder for an agent to run in."""
    folder = store.path.parent / "agent"
    folder.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        folder.chmod(0o700)
    return folder
