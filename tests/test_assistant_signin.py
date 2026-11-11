"""Signing in to an AI account in the Assistant tab (src/bowser/assistant).

- the registry: "Sign in with Claude" (an agent over ACP) and "Continue with
  ChatGPT" (OAuth), nothing else;
- OAuth against a fake OpenAI sign-in server (no network): PKCE and state, the
  issued client id, the ID token's signature, issuer, audience and nonce, the
  plan scope; tokens kept like keys, renewed, revoked on sign-out; the callback
  refuses an unknown state and a request from another computer;
- the ChatGPT chat in the Responses wire format, with a data tool;
- "Sign in with Claude" with a fake ``claude`` (its own sign-in) and a fake ACP
  agent that calls Bowser's MCP server (``bowser mcp --url``) on a real local
  server: a permission request answered by the page, one declined on timeout,
  the agent's minimal environment, and Stop killing the agent and its children;
- the gates: sign-in only where the page keeps keys and from this computer.

Nothing here imports bowser.main, bowser.state or bowser.config.
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import json
import os
import socket
import sys
import textwrap
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

httpx = pytest.importorskip("httpx")
jwt = pytest.importorskip("jwt")
pytest.importorskip("cryptography")
pytest.importorskip("fastapi")

from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import SecretStr  # noqa: E402

from bowser import api_models as api  # noqa: E402
from bowser.assistant import acp, relay, signin  # noqa: E402
from bowser.assistant.keys import KeyStore  # noqa: E402

HERE = Path(__file__).resolve().parent
#: The real way to start the agent (some tests put it back after the fixture).
AGENT_ARGV = relay._agent_argv
ISSUED = "oaiapp_test123"
EMAIL = "someone@example.com"

LAYERS = {
    "displacement": {
        "label": "Displacement",
        "unit": "m",
        "x_values": ["2020-01-01", "2020-02-01"],
        "n_time_steps": 2,
        "latlon_bounds": [-118.0, 33.0, -117.0, 34.0],
        "uses_spatial_ref": True,
    },
    "temporal_coherence": {"label": "Coherence", "unit": None, "x_values": []},
}


def settings(tmp_path: Path, **over) -> SimpleNamespace:
    base = {
        "BOWSER_ASSISTANT": True,
        "BOWSER_ASSISTANT_PAGE_KEYS": True,
        "BOWSER_ASSISTANT_KEY_FILE": str(tmp_path / "assistant.json"),
        "BOWSER_AI_PROVIDER": "",
        "BOWSER_AI_KEY": SecretStr(""),
        "BOWSER_AI_MODEL": "",
        "ANTHROPIC_API_KEY": SecretStr(""),
        "OPENAI_API_KEY": SecretStr(""),
        "GEMINI_API_KEY": SecretStr(""),
        "OPENROUTER_API_KEY": SecretStr(""),
    }
    base.update(over)
    return SimpleNamespace(**base)


class FakeKeyring:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], str] = {}

    def set_password(self, service, user, key):
        self.items[service, user] = key

    def get_password(self, service, user):
        return self.items.get((service, user))

    def delete_password(self, service, user):
        self.items.pop((service, user), None)


class NoOllama:
    """No Ollama on this computer (never look for or start a real one)."""

    def binary(self):
        return None

    def ensure(self, start=True):  # noqa: ARG002
        return False

    def models(self):
        return []


def make_app(s: SimpleNamespace) -> FastAPI:
    app = FastAPI()
    app.include_router(relay.router)
    app.dependency_overrides[relay.get_settings] = lambda: s
    app.dependency_overrides[relay.get_ollama] = NoOllama

    @app.get("/datasets")
    def datasets():
        return LAYERS

    @app.get("/config")
    def config():
        return {
            "title": "",
            "opera_logo": False,
            "geotiff_export": False,
            "polygon_stats": False,
            "assistant": relay.assistant_config(s, NoOllama()),
        }

    @app.get("/mode")
    def mode():
        return {"mode": "md"}

    @app.get("/catalog")
    def catalog():
        return {"datasets": []}

    return app


@pytest.fixture
def store(tmp_path, monkeypatch) -> KeyStore:
    """One key store (keychain in memory) for every request of a test."""
    ks = KeyStore(tmp_path / "assistant.json", keyring=FakeKeyring())
    monkeypatch.setattr(relay, "key_store", lambda _s: ks)
    signin._PENDING.clear()
    signin._STATUS_CACHE.clear()
    signin._LOGINS.clear()
    signin._LOCKS.clear()
    return ks


def local(app) -> TestClient:
    return TestClient(app, client=("127.0.0.1", 50000))


def remote(app) -> TestClient:
    return TestClient(app, client=("10.1.2.3", 50000))


# --- the registry -----------------------------------------------------------------


def test_registry_lists_claude_and_chatgpt():
    assert [(m.id, m.kind) for m in signin.METHODS] == [
        ("claude", "local_agent"),
        ("chatgpt", "oauth"),
    ]
    claude = signin.method("claude")
    assert claude.label == "Sign in with Claude"
    assert claude.agent.program == "claude"
    # The pinned ACP adapter, told to run the user's own claude.
    assert claude.agent.adapter == "@agentclientprotocol/claude-agent-acp@0.92.0"
    assert claude.agent.program_env == "CLAUDE_CODE_EXECUTABLE"
    assert claude.agent.login_args == ("auth", "login", "--claudeai")
    assert claude.oauth is None
    chatgpt = signin.method("chatgpt")
    assert chatgpt.label == "Continue with ChatGPT"  # OpenAI's button text
    assert "chatgpt.tokens.use.direct" in chatgpt.oauth.scopes.split()
    assert chatgpt.oauth.api_url == "https://api.openai.com/v1"
    assert signin.method("github") is None


def test_agent_command_runs_the_installed_adapter_with_the_users_claude(
    monkeypatch, tmp_path
):
    paths = {"claude": "/opt/bin/claude", "node": "/usr/bin/node"}
    monkeypatch.setattr(signin, "find_program", paths.get)
    monkeypatch.setattr(signin, "cache_root", lambda: tmp_path)
    script = fake_install(signin.method("claude").agent, tmp_path)
    argv, extra, note = asyncio.run(relay._agent_argv(signin.method("claude")))
    # node runs the adapter from Bowser's cache: no npx, no registry check.
    assert argv == ["/usr/bin/node", str(script)]
    assert note is None
    assert extra == {"CLAUDE_CODE_EXECUTABLE": "/opt/bin/claude"}
    command, args, env = signin.mcp_command("http://127.0.0.1:5184")
    assert command == sys.executable
    assert args == ["-m", "bowser.cli", "mcp", "--url", "http://127.0.0.1:5184"]
    assert "127.0.0.1" in env["NO_PROXY"]
    # The desktop app runs the MCP server with its own executable.
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert signin.mcp_command("http://127.0.0.1:5184")[:2] == (
        sys.executable,
        ["--mcp-url", "http://127.0.0.1:5184"],
    )


def test_agent_env_is_minimal(monkeypatch):
    for name in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
        "BOWSER_AI_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ):
        monkeypatch.setenv(name, "secret-value-1234")
    monkeypatch.setenv("HOME", "/home/someone")
    env = signin.agent_env({"CLAUDE_CODE_EXECUTABLE": "/x/claude"})
    assert "secret-value-1234" not in json.dumps(env)
    assert env["HOME"] == "/home/someone"
    assert env["CLAUDE_CODE_EXECUTABLE"] == "/x/claude"
    assert set(env) <= signin._PASS_ENV | {"CLAUDE_CODE_EXECUTABLE"}


# --- a fake OpenAI sign-in server ---------------------------------------------------


class FakeOpenAI:
    """OpenAI's sign-in and API endpoints as a mock transport."""

    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        self.jwks = {"keys": [{**jwk, "kid": "k1", "alg": "RS256", "use": "sig"}]}
        self.requests: list[tuple[str, str, dict]] = []
        self.challenge = ""
        self.nonce = ""
        self.scope = (
            "openid profile email offline_access resource.invoke "
            "chatgpt.tokens.use.direct"
        )
        self.raw: list = []
        self.on_models = lambda: None
        self.n = 0
        self.refresh_error = ""
        self.revoke_status = 200
        self.chats: list[bytes] = []
        self.issuer = "https://auth.openai.com"
        self.sub = "user-1"

    def id_token(self, aud=ISSUED, nonce=None, key=None) -> str:
        now = int(time.time())
        claims = {
            "iss": self.issuer,
            "aud": aud,
            "sub": self.sub,
            "email": EMAIL,
            "iat": now,
            "exp": now + 3600,
            "nonce": self.nonce if nonce is None else nonce,
        }
        return jwt.encode(
            claims, key or self.key, algorithm="RS256", headers={"kid": "k1"}
        )

    def handler(self, request):
        url = str(request.url)
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        self.requests.append((request.method, url.split("?")[0], form))
        if url == signin.CHATGPT_OAUTH.jwks_url:
            return httpx.Response(200, json=self.jwks)
        if url == signin.CHATGPT_OAUTH.token_url:
            if form["grant_type"] == "authorization_code":
                digest = hashlib.sha256(form["code_verifier"].encode()).digest()
                if (
                    base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
                    != self.challenge
                ):
                    return httpx.Response(400, json={"error": "invalid_grant"})
                if form["code"] != "good-code":
                    return httpx.Response(400, json={"error": "invalid_grant"})
            elif self.refresh_error:
                return httpx.Response(400, json={"error": self.refresh_error})
            self.n += 1
            return httpx.Response(
                200,
                json={
                    "access_token": f"access-{self.n}",
                    "refresh_token": f"refresh-{self.n}",
                    "id_token": self.id_token(),
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "scope": self.scope,
                },
            )
        if url == signin.CHATGPT_OAUTH.revoke_url:
            return httpx.Response(self.revoke_status)
        if url == "https://api.openai.com/v1/models":
            self.on_models()
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "slug": "gpt-6.1-sol",
                            "visibility": "list",
                            "supports_reasoning": True,
                        },
                        {"slug": "hidden", "visibility": "hide"},
                    ]
                },
            )
        if url == "https://api.openai.com/v1/responses":
            return httpx.Response(
                200,
                content=self.chats.pop(0),
                headers={"content-type": "text/event-stream"},
            )
        return httpx.Response(404)


@pytest.fixture
def openai(monkeypatch) -> FakeOpenAI:
    fake = FakeOpenAI()
    monkeypatch.setattr(relay, "SIGNIN_TRANSPORT", httpx.MockTransport(fake.handler))
    return fake


def start(client: TestClient, fake: FakeOpenAI, **body) -> dict[str, str]:
    """Click "Continue with ChatGPT"; return the authorize URL's parameters."""
    r = client.post("/assistant/signin", json={"method": "chatgpt", **body})
    assert r.status_code == 200, r.text
    url = r.json()["sign_in_url"]
    assert url.startswith("https://auth.openai.com/api/accounts/authorize?")
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    fake.challenge, fake.nonce = q["code_challenge"], q["nonce"]
    return q


def sign_in(client: TestClient, fake: FakeOpenAI) -> dict[str, str]:
    q = start(client, fake)
    r = client.get(
        "/auth/callback",
        params={"code": "good-code", "state": q["state"], "client_id": ISSUED},
    )
    assert r.status_code == 200 and "Signed in" in r.text, r.text
    return q


def method_status(client: TestClient, mid: str) -> dict:
    status = client.get("/assistant/status").json()
    return next(m for m in status["sign_in"]["methods"] if m["id"] == mid)


def test_chatgpt_sign_in_with_pkce_state_and_issued_client(tmp_path, store, openai):
    client = local(make_app(settings(tmp_path)))
    q = start(client, openai)
    assert q["client_id"] == "dynamic_agent_client"
    assert q["agent_name_hint"] == "Bowser"
    assert q["ext_agent_host_id"].startswith("urn:uuid:")
    assert q["code_challenge_method"] == "S256"
    assert q["redirect_uri"] == "http://127.0.0.1:80/auth/callback"
    assert q["resource"] == "https://api.openai.com/v1"
    assert "chatgpt.tokens.use.direct" in q["scope"].split()
    assert method_status(client, "chatgpt")["state"] == "pending"
    # The model list is read before the account counts as signed in, so the page
    # never sees a signed-in account without models.
    seen = []
    openai.on_models = lambda: seen.append(
        (store.account("chatgpt").get("signed_in"), signin.pending_for("chatgpt"))
    )

    r = client.get(
        "/auth/callback",
        params={"code": "good-code", "state": q["state"], "client_id": ISSUED},
    )
    assert r.status_code == 200 and "Signed in" in r.text
    exchange = next(
        f for m, u, f in openai.requests if f.get("grant_type") == "authorization_code"
    )
    assert exchange["client_id"] == ISSUED  # the issued id, not the entry point
    assert exchange["redirect_uri"] == q["redirect_uri"]
    assert exchange["resource"] == "https://api.openai.com/v1"

    m = method_status(client, "chatgpt")
    assert (m["state"], m["account"], m["plan"]) == ("signed_in", EMAIL, "ChatGPT plan")
    assert m["models"] == ["gpt-6.1-sol"] and m["model"] == "gpt-6.1-sol"
    assert seen == [(None, True)]  # and still "pending" while it finishes
    assert m["usage_url"].startswith("https://chatgpt.com/settings/usage")
    # Tokens in the keychain only, never in the file or a response.
    text = (tmp_path / "assistant.json").read_text()
    status = client.get("/assistant/status").text
    for secret in ("access-1", "refresh-1", "good-code", q["code_challenge"]):
        assert secret not in text and secret not in status
    assert "access-1" in store._keyring.items["bowser-assistant", "signin:chatgpt"]
    assert store.account("chatgpt")["client_id"] == ISSUED
    api.AssistantStatus.model_validate(client.get("/assistant/status").json())

    # The state is used once.
    again = client.get(
        "/auth/callback", params={"code": "good-code", "state": q["state"]}
    )
    assert again.status_code == 400

    # The next sign-in uses the issued id, with no registration hint.
    q2 = start(client, openai)
    assert q2["client_id"] == ISSUED and "agent_name_hint" not in q2
    assert q2["ext_agent_host_id"] == q["ext_agent_host_id"]
    assert q2["login_hint"] == EMAIL


def test_callback_refuses_bad_state_other_computers_and_bad_tokens(
    store, tmp_path, openai
):
    app = make_app(settings(tmp_path))
    client = local(app)
    q = start(client, openai)
    # An unknown state: nothing is exchanged.
    r = client.get(
        "/auth/callback",
        params={"code": "good-code", "state": "forged", "client_id": ISSUED},
    )
    assert r.status_code == 400
    # From another computer: refused before the state is even looked at.
    r = remote(app).get(
        "/auth/callback",
        params={"code": "good-code", "state": q["state"], "client_id": ISSUED},
    )
    assert r.status_code == 403
    assert not [f for _, _, f in openai.requests if f.get("grant_type")]
    # The user declined.
    r = client.get(
        "/auth/callback", params={"error": "access_denied", "state": q["state"]}
    )
    assert r.status_code == 400 and "cancelled" in r.text
    # A first sign-in without the issued client id is incomplete.
    q = start(client, openai)
    r = client.get("/auth/callback", params={"code": "good-code", "state": q["state"]})
    assert r.status_code == 400 and "registered" in r.text
    # A wrong PKCE verifier (the server checks it): the code is refused.
    q = start(client, openai)
    openai.challenge = "something-else"
    r = client.get(
        "/auth/callback",
        params={"code": "good-code", "state": q["state"], "client_id": ISSUED},
    )
    assert r.status_code == 400
    # An ID token for another nonce, or signed with another key.
    q = start(client, openai)
    openai.nonce = "other-nonce"
    r = client.get(
        "/auth/callback",
        params={"code": "good-code", "state": q["state"], "client_id": ISSUED},
    )
    assert r.status_code == 400 and "nonce" in r.text
    q = start(client, openai)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    openai.id_token = lambda *_a, **_k: FakeOpenAI.id_token(openai, key=other)
    r = client.get(
        "/auth/callback",
        params={"code": "good-code", "state": q["state"], "client_id": ISSUED},
    )
    assert r.status_code == 400 and "did not check out" in r.text
    assert store.load("signin:chatgpt") is None
    assert method_status(client, "chatgpt")["state"] == "signed_out"


@pytest.mark.usefixtures("store")
def test_sign_in_without_the_plan_scope_cannot_chat(tmp_path, openai):
    client = local(make_app(settings(tmp_path)))
    openai.scope = "openid profile email offline_access"
    sign_in(client, openai)
    m = method_status(client, "chatgpt")
    assert m["state"] == "no_plan" and "plan" in m["detail"]
    r = client.post(
        "/assistant/chat",
        json={"provider": "chatgpt", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert r.status_code == 403
    # Continuing again with consent asks for the consent page.
    assert start(client, openai, consent=True)["prompt"] == "consent"


def test_tokens_are_renewed_and_revoked(tmp_path, store, openai):
    client = local(make_app(settings(tmp_path)))
    sign_in(client, openai)
    m = signin.method("chatgpt")
    transport = relay.SIGNIN_TRANSPORT
    assert asyncio.run(signin.access_token(m, store, transport)) == "access-1"
    # About to expire: renewed with the refresh token, which changes too.
    tokens = json.loads(store.load("signin:chatgpt"))
    store.save(
        "signin:chatgpt",
        json.dumps({**tokens, "expires_at": time.time() + 10}),
        hint="",
    )
    assert asyncio.run(signin.access_token(m, store, transport)) == "access-2"
    grant = [
        f for _, _, f in openai.requests if f.get("grant_type") == "refresh_token"
    ][-1]
    assert grant == {
        "grant_type": "refresh_token",
        "client_id": ISSUED,
        "refresh_token": "refresh-1",
        "resource": "https://api.openai.com/v1",
    }
    assert json.loads(store.load("signin:chatgpt"))["refresh_token"] == "refresh-2"

    # Sign out: the refresh token is revoked and the tokens forgotten; the app's
    # registration and this computer's id stay for the next sign-in.
    host = store.account("chatgpt")["host_id"]
    r = client.delete("/assistant/signin", params={"method": "chatgpt"})
    assert r.status_code == 200 and r.json()["note"] is None
    revoke = [f for _, u, f in openai.requests if u == signin.CHATGPT_OAUTH.revoke_url][
        -1
    ]
    assert revoke == {
        "token": "refresh-2",
        "token_type_hint": "refresh_token",
        "client_id": ISSUED,
    }
    assert store.load("signin:chatgpt") is None
    assert ("bowser-assistant", "signin:chatgpt") not in store._keyring.items
    assert store.account("chatgpt")["client_id"] == ISSUED
    assert store.account("chatgpt")["host_id"] == host
    assert method_status(client, "chatgpt")["state"] == "signed_out"


def test_dead_refresh_token_and_unconfirmed_revocation(
    tmp_path, store, openai, monkeypatch
):
    client = local(make_app(settings(tmp_path)))
    sign_in(client, openai)
    m = signin.method("chatgpt")
    tokens = json.loads(store.load("signin:chatgpt"))
    store.save("signin:chatgpt", json.dumps({**tokens, "expires_at": 0}), hint="")
    openai.refresh_error = "refresh_token_reused"
    with pytest.raises(signin.SignInError, match="sign in again"):
        asyncio.run(signin.access_token(m, store, relay.SIGNIN_TRANSPORT))
    assert store.load("signin:chatgpt") is None

    openai.refresh_error = ""
    sign_in(client, openai)
    openai.revoke_status = 503
    monkeypatch.setattr(signin, "REVOKE_BACKOFF", 0)
    r = client.delete("/assistant/signin", params={"method": "chatgpt"})
    assert "did not confirm" in r.json()["note"]
    assert store.load("signin:chatgpt") is None
    tries = [u for _, u, _ in openai.requests if u == signin.CHATGPT_OAUTH.revoke_url]
    assert len(tries) == 3


def _sse(*events: dict) -> bytes:
    return b"".join(f"data: {json.dumps(e)}\n\n".encode() for e in events)


@pytest.mark.usefixtures("store")
def test_chatgpt_chat_uses_the_responses_api_with_bowsers_tools(tmp_path, openai):
    client = local(make_app(settings(tmp_path)))
    sign_in(client, openai)
    call = {
        "type": "function_call",
        "id": "fc_1",
        "call_id": "call_1",
        "name": "bowser.list_layers",
        "arguments": "{}",
    }
    reasoning = {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque"}
    openai.chats = [
        _sse(
            {"type": "response.output_item.done", "item": reasoning},
            {"type": "response.output_item.done", "item": call},
            {"type": "response.completed", "response": {"output": [reasoning, call]}},
        ),
        _sse(
            {"type": "response.output_text.delta", "delta": "Two "},
            {"type": "response.output_text.delta", "delta": "layers."},
            {
                "type": "response.completed",
                "response": {
                    "output": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "Two layers."}],
                        }
                    ]
                },
            },
        ),
    ]
    r = client.post(
        "/assistant/chat",
        json={
            "provider": "chatgpt",
            "messages": [{"role": "user", "content": "layers?"}],
        },
    )
    assert r.status_code == 200, r.text
    ev = [json.loads(b[6:]) for b in r.text.split("\n\n") if b.startswith("data: ")]
    result = next(e for e in ev if e["type"] == "tool_result")
    assert result["name"] == "list_layers" and result["ok"]
    assert set(result["result"]["layers"]) == set(LAYERS)
    assert ev[-1] == {"type": "done", "stop": "end"}
    assert "".join(e["text"] for e in ev if e["type"] == "text") == "Two layers."

    sent = [
        (req.headers, json.loads(req.content))
        for req in _requests(openai, "https://api.openai.com/v1/responses")
    ]
    headers, first = sent[0]
    assert headers["authorization"] == "Bearer access-1"
    assert first["store"] is False and first["stream"] is True
    assert first["model"] == "gpt-6.1-sol"
    assert first["include"] == ["reasoning.encrypted_content"]
    assert first["tools"][0]["type"] == "namespace"
    assert first["tools"][0]["name"] == "bowser"
    assert "list_layers" in {t["name"] for t in first["tools"][0]["tools"]}
    assert first["input"][0]["content"][0] == {"type": "input_text", "text": "layers?"}
    # The earlier reply goes back as it came, without server ids, then the result.
    second = sent[1][1]["input"]
    assert second[1] == {"type": "reasoning", "encrypted_content": "opaque"}
    assert second[2] == {k: v for k, v in call.items() if k != "id"}
    assert second[3]["type"] == "function_call_output"
    assert second[3]["call_id"] == "call_1"


def _requests(fake: FakeOpenAI, url: str) -> list:
    return [r for r in fake.raw if str(r.url) == url]


@pytest.fixture(autouse=True)
def _keep_raw_requests(monkeypatch):
    """Keep the raw requests the fake server saw (headers and bodies)."""
    original = FakeOpenAI.handler

    def handler(self, request):
        self.raw.append(request)
        return original(self, request)

    monkeypatch.setattr(FakeOpenAI, "handler", handler)


@pytest.mark.usefixtures("store")
def test_plan_usage_limit_is_a_rate_limit(tmp_path, openai):
    client = local(make_app(settings(tmp_path)))
    sign_in(client, openai)
    openai.chats = [
        _sse(
            {
                "type": "response.failed",
                "response": {
                    "error": {
                        "code": "subscription_sharing_usage_limit_exceeded",
                        "message": "Usage limit reached.",
                    }
                },
            }
        )
    ]
    r = client.post(
        "/assistant/chat",
        json={"provider": "chatgpt", "messages": [{"role": "user", "content": "hi"}]},
    )
    ev = [json.loads(b[6:]) for b in r.text.split("\n\n") if b.startswith("data: ")]
    assert ev[-1]["type"] == "error" and ev[-1]["kind"] == "rate_limit"
    assert ev[-1]["code"] == "subscription_sharing_usage_limit_exceeded"


# --- gates --------------------------------------------------------------------------


@pytest.mark.usefixtures("store")
def test_sign_in_only_from_this_computer_where_the_page_keeps_keys(tmp_path, openai):
    s = settings(tmp_path)
    app = make_app(s)
    far = remote(app)
    status = far.get("/assistant/status").json()["sign_in"]
    assert status == {
        "allowed": False,
        "reason": "Signing in works only on the computer that runs Bowser.",
        "methods": [],
    }
    assert far.post("/assistant/signin", json={"method": "chatgpt"}).status_code == 403
    assert (
        far.delete("/assistant/signin", params={"method": "chatgpt"}).status_code == 403
    )
    chat = {
        "provider": "claude",
        "conversation": "c1",
        "messages": [{"role": "user", "content": "hi"}],
    }
    assert far.post("/assistant/chat", json=chat).status_code == 403
    perm = {"conversation": "c1", "id": "p1", "choice": "allow"}
    assert far.post("/assistant/permission", json=perm).status_code == 403
    assert far.post("/assistant/stop", json={}).status_code == 403
    # Signed in, the account answers this computer only.
    sign_in(local(app), openai)
    chat["provider"] = "chatgpt"
    assert far.post("/assistant/chat", json=chat).status_code == 403

    # A hosted server (no page keys): no sign-in at all, and /config says so.
    hosted = make_app(settings(tmp_path, BOWSER_ASSISTANT_PAGE_KEYS=False))
    st = local(hosted).get("/assistant/status").json()["sign_in"]
    assert st["allowed"] is False and "own computer" in st["reason"]
    assert (
        local(hosted).post("/assistant/signin", json={"method": "chatgpt"}).status_code
        == 403
    )
    assert local(hosted).get("/config").json()["assistant"]["sign_in"] == []
    assert local(app).get("/config").json()["assistant"]["sign_in"] == [
        "claude",
        "chatgpt",
    ]
    api.ConfigInfo.model_validate(local(app).get("/config").json())


# --- Sign in with Claude: a fake claude and a fake ACP agent -----------------------

FAKE_CLAUDE = textwrap.dedent(
    """\
    #!{python}
    # A stand-in claude: `auth status` and `auth login` only (no network).
    import json, os, sys, time
    from pathlib import Path
    state = Path({state!r})
    Path({envfile!r}).write_text(json.dumps(dict(os.environ)))
    if sys.argv[1:3] == ["auth", "status"]:
        if state.exists():
            print(json.dumps({{"loggedIn": True, "authMethod": "claude.ai",
                              "email": "me@example.com", "subscriptionType": "max"}}))
            sys.exit(0)
        print(json.dumps({{"loggedIn": False, "authMethod": "none"}}))
        sys.exit(1)
    if sys.argv[1:3] == ["auth", "login"]:
        time.sleep(0.5)  # the user signs in on Anthropic's page
        state.write_text("signed in")
        sys.exit(0)
    sys.exit(2)
    """
)


@pytest.fixture
def claude(tmp_path, monkeypatch, store):  # noqa: ARG001  (one key store per test)
    """A fake claude on PATH (signed out) and the fake ACP agent as its adapter."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    exe = bin_dir / "claude"
    exe.write_text(
        FAKE_CLAUDE.format(
            python=sys.executable,
            state=str(tmp_path / "claude-signed-in"),
            envfile=str(tmp_path / "claude-env.json"),
        )
    )
    exe.chmod(0o755)
    found = {"claude": str(exe), "npx": "/usr/bin/npx"}
    monkeypatch.setattr(signin, "find_program", found.get)
    out = tmp_path / "agent"

    async def fake_argv(_m, on_install=None):  # noqa: ARG001
        return [sys.executable, str(HERE / "fake_acp_agent.py"), str(out)], {}, None

    monkeypatch.setattr(relay, "_agent_argv", fake_argv)
    monkeypatch.setattr(signin, "cache_root", lambda: tmp_path / "cache")
    for name in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
        "BOWSER_AI_KEY",
    ):
        monkeypatch.setenv(name, "secret-value-1234")
    yield SimpleNamespace(exe=exe, out=out, state=tmp_path / "claude-signed-in")
    acp.kill_all_now()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def served(tmp_path, claude):
    """The relay and a small data API on a real local server (for bowser mcp)."""
    import uvicorn

    app = make_app(settings(tmp_path))
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            httpx.get(f"{url}/assistant/status", timeout=1)
            break
        except httpx.TransportError:
            time.sleep(0.05)
    yield SimpleNamespace(url=url, claude=claude)
    server.should_exit = True
    thread.join(10)


def _claude_status(c) -> dict:
    return next(
        m
        for m in c.get("/assistant/status").json()["sign_in"]["methods"]
        if m["id"] == "claude"
    )


def _stream(c, body: dict, on_event=None) -> list[dict]:
    out = []
    with c.stream("POST", "/assistant/chat", json=body) as r:
        assert r.status_code == 200, r.read()
        for line in r.iter_lines():
            if line.startswith("data: "):
                e = json.loads(line[6:])
                out.append(e)
                if on_event:
                    on_event(e)
    return out


def test_claude_sign_in_runs_claudes_own_login(tmp_path, claude, monkeypatch):
    client = local(make_app(settings(tmp_path)))
    signin._STATUS_CACHE.clear()
    m = method_status(client, "claude")
    assert (m["state"], m["install_url"]) == (
        "signed_out",
        "https://code.claude.com/docs/en/setup",
    )
    r = client.post("/assistant/signin", json={"method": "claude"})
    assert r.status_code == 200 and r.json()["sign_in_url"] is None
    assert method_status(client, "claude")["state"] == "pending"
    for _ in range(100):
        m = method_status(client, "claude")
        if m["state"] != "pending":
            break
        time.sleep(0.1)
    assert (m["state"], m["account"], m["plan"]) == (
        "signed_in",
        "me@example.com",
        "Max",
    )
    # claude ran with the minimal environment (no keys of this process).
    seen = (tmp_path / "claude-env.json").read_text()
    assert "secret-value-1234" not in seen
    # Signing out stops using it here; claude itself stays signed in.
    client.delete("/assistant/signin", params={"method": "claude"})
    assert method_status(client, "claude")["state"] == "signed_out"
    assert claude.state.exists()
    # Not installed: the tab says where to get it.
    monkeypatch.setattr(signin, "find_program", lambda _n: None)
    signin._STATUS_CACHE.clear()
    assert method_status(client, "claude")["state"] == "not_installed"


def test_claude_chat_through_acp_with_mcp_tools_and_a_permission(served):
    claude = served.claude
    claude.state.write_text("signed in")
    with httpx.Client(base_url=served.url, timeout=120) as c:
        assert c.post("/assistant/signin", json={"method": "claude"}).status_code == 200
        assert _claude_status(c)["state"] == "signed_in"
        answered = []

        def answer(e):
            if e["type"] == "permission":
                answered.append(e)
                r = c.post(
                    "/assistant/permission",
                    json={"conversation": "chat-1", "id": e["id"], "choice": "allow"},
                )
                assert r.json() == {"ok": True}

        ev = _stream(
            c,
            {
                "provider": "claude",
                "conversation": "chat-1",
                "messages": [
                    {"role": "user", "content": "[page: {}]\n\nWhich layers?"}
                ],
            },
            answer,
        )
    kinds = [e["type"] for e in ev]
    assert kinds[0] == "status"
    assert answered and answered[0]["name"] == "list_layers"
    assert [o["kind"] for o in answered[0]["options"]] == [
        "allow_once",
        "allow_always",
        "reject_once",
    ]
    call = next(e for e in ev if e["type"] == "tool_call")
    assert (call["name"], call["runs"], call["status"]) == (
        "list_layers",
        "agent",
        "Listing the layers",
    )
    result = next(e for e in ev if e["type"] == "tool_result")
    assert result["ok"] is True
    # The agent read the layers through Bowser's MCP server, from this server.
    text = "".join(e["text"] for e in ev if e["type"] == "text")
    assert text == "The layers are: displacement, temporal_coherence."
    assert ev[-2] == {
        "type": "message",
        "message": {"role": "assistant", "content": text},
    }
    assert ev[-1]["type"] == "done" and ev[-1]["stop"] == "end"

    new = json.loads((claude.out / "new.json").read_text())
    server = new["mcpServers"][0]
    assert server["name"] == "bowser"
    assert server["args"][-2:] == ["--url", served.url]
    assert new["_meta"]["claudeCode"]["options"]["tools"] == []
    assert "Bowser" in new["_meta"]["systemPrompt"]["append"]
    init = json.loads((claude.out / "init.json").read_text())
    assert init["clientCapabilities"] == {
        "fs": {"readTextFile": False, "writeTextFile": False},
        "terminal": False,
    }
    # The agent asked in bypass mode: Bowser switched it to asking first.
    assert json.loads((claude.out / "modes.json").read_text())["modeId"] == "default"
    env = json.loads((claude.out / "env.json").read_text())
    assert "secret-value-1234" not in json.dumps(env)
    assert not {k for k in env if k.startswith("BOWSER_")}


def test_unanswered_permission_is_declined(served, monkeypatch):
    served.claude.state.write_text("signed in")
    monkeypatch.setattr(acp, "PERMISSION_SECONDS", 1.0)
    with httpx.Client(base_url=served.url, timeout=120) as c:
        c.post("/assistant/signin", json={"method": "claude"})
        ev = _stream(
            c,
            {
                "provider": "claude",
                "conversation": "chat-2",
                "messages": [{"role": "user", "content": "Which layers?"}],
            },
        )
        closed = next(e for e in ev if e["type"] == "permission_closed")
        assert closed["outcome"] == "timeout"
        result = next(e for e in ev if e["type"] == "tool_result")
        assert result["ok"] is False
        assert "Not allowed" in "".join(e["text"] for e in ev if e["type"] == "text")
        # An answer after the fact finds nothing open.
        r = c.post(
            "/assistant/permission",
            json={"conversation": "chat-2", "id": closed["id"], "choice": "allow"},
        )
        assert r.status_code == 404


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers; read its state where we can.
    status = Path(f"/proc/{pid}/status")
    return not (status.exists() and "\nState:\tZ" in status.read_text())


@pytest.mark.skipif(sys.platform == "win32", reason="process groups")
def test_stop_kills_the_agent_and_what_it_started(served):
    served.claude.state.write_text("signed in")
    pids_file = served.claude.out / "pids.txt"
    with httpx.Client(base_url=served.url, timeout=120) as c:
        c.post("/assistant/signin", json={"method": "claude"})
        events: list[dict] = []

        def ask():
            events.extend(
                _stream(
                    c,
                    {
                        "provider": "claude",
                        "conversation": "chat-3",
                        "messages": [{"role": "user", "content": "hang"}],
                    },
                )
            )

        t = threading.Thread(target=ask, daemon=True)
        t.start()
        for _ in range(300):
            if pids_file.exists():
                break
            time.sleep(0.05)
        agent, child = map(int, pids_file.read_text().split())
        assert _alive(agent) and _alive(child)
        assert c.post("/assistant/stop", json={"conversation": "chat-3"}).json() == {
            "stopped": 1
        }
        t.join(30)
    for _ in range(100):
        if not _alive(agent) and not _alive(child):
            break
        time.sleep(0.05)
    assert not _alive(agent) and not _alive(child)
    assert events[-1]["type"] == "error"
    assert acp.SESSIONS == {}


@pytest.mark.usefixtures("store")
def test_server_shutdown_stops_the_agents(tmp_path):
    closed = []

    class Fake:
        async def close(self):
            closed.append(True)

    with TestClient(make_app(settings(tmp_path))):
        acp.SESSIONS["x"] = Fake()
    assert closed == [True] and acp.SESSIONS == {}


def test_tool_names_of_different_agents():
    known = {"list_layers", "point_timeseries"}
    assert (
        acp.tool_name(
            {"_meta": {"claudeCode": {"toolName": "mcp__bowser__point_timeseries"}}},
            known,
        )
        == "point_timeseries"
    )
    assert acp.tool_name({"title": "bowser.list_layers"}, known) == "list_layers"
    assert acp.tool_name({"title": "Read file"}, known) == "Read file"


# --- the adapter, installed once; the agent started before the first question ---

FAKE_NPM = textwrap.dedent(
    """\
    #!{python}
    # A stand-in npm: `install --prefix DIR ... name@version` writes the package
    # (no network). Its mode file says: ok, fail or slow.
    import json, sys, time
    from pathlib import Path
    here = Path(__file__)
    mode = (here.parent / "npm-mode").read_text().strip()
    with (here.parent / "npm-calls.txt").open("a") as f:
        f.write(" ".join(sys.argv[1:]) + "\\n")
    if mode == "slow":
        time.sleep(1.0)
    if mode == "fail":
        print("npm ERR! network unreachable", file=sys.stderr)
        sys.exit(1)
    prefix = Path(sys.argv[sys.argv.index("--prefix") + 1])
    name, _, version = sys.argv[-1].rpartition("@")
    pkg = prefix / "node_modules" / name
    (pkg / "dist").mkdir(parents=True)
    (pkg / "dist" / "index.js").write_text("// the adapter")
    short = name.rsplit("/", 1)[-1]
    (pkg / "package.json").write_text(json.dumps(
        {{"name": name, "version": version, "bin": {{short: "dist/index.js"}}}}))
    """
)

FAKE_NODE = textwrap.dedent(
    """\
    #!{python}
    # A stand-in node: runs the fake ACP agent whatever script it is given.
    import os, sys
    os.execv({python!r}, [{python!r}, {agent!r}, {out!r}])
    """
)


def fake_install(spec, root: Path, version: str | None = None) -> Path:
    """Put an installed adapter in the cache (as npm would); return its script."""
    name, pinned = signin._split_package(spec.adapter)
    pkg = signin.adapter_dir(spec, root) / "node_modules" / name
    (pkg / "dist").mkdir(parents=True, exist_ok=True)
    (pkg / "dist" / "index.js").write_text("// the adapter")
    meta = {"version": version or pinned, "bin": {"claude-agent-acp": "dist/index.js"}}
    (pkg / "package.json").write_text(json.dumps(meta))
    return (pkg / "dist" / "index.js").resolve()


@pytest.fixture
def npm(tmp_path, monkeypatch):
    """A fake npm, node and npx on PATH and an empty cache."""
    bin_dir = tmp_path / "npm-bin"
    bin_dir.mkdir()
    exe = bin_dir / "npm"
    exe.write_text(FAKE_NPM.format(python=sys.executable))
    exe.chmod(0o755)
    node = bin_dir / "node"
    node.write_text(
        FAKE_NODE.format(
            python=sys.executable,
            agent=str(HERE / "fake_acp_agent.py"),
            out=str(tmp_path / "agent"),
        )
    )
    node.chmod(0o755)
    (bin_dir / "npm-mode").write_text("ok")
    paths = {
        "npm": str(exe),
        "node": str(node),
        "npx": "/usr/bin/npx",
        "claude": signin.find_program("claude") or "/opt/bin/claude",
    }
    monkeypatch.setattr(signin, "find_program", paths.get)
    root = tmp_path / "cache"
    monkeypatch.setattr(signin, "cache_root", lambda: root)

    def calls() -> list[str]:
        f = bin_dir / "npm-calls.txt"
        return f.read_text().splitlines() if f.exists() else []

    return SimpleNamespace(
        root=root,
        node=str(node),
        calls=calls,
        mode=lambda m: (bin_dir / "npm-mode").write_text(m),
        spec=signin.method("claude").agent,
    )


def test_adapter_is_installed_once_then_run_with_node(npm):
    installs = []
    argv, note = asyncio.run(
        signin.adapter_command(npm.spec, lambda: installs.append(1))
    )
    script = signin.installed_adapter(npm.spec)
    assert argv == [npm.node, str(script)] and note is None
    assert script.parent.parent.parent.parent.name == "node_modules"
    assert signin.adapter_dir(npm.spec).name == "claude-agent-acp@0.92.0"
    call = npm.calls()[0].split()
    assert call[:2] == ["install", "--prefix"]
    assert "--no-audit" in call and "--no-fund" in call
    # Not the SDK's own copy of the agent: the user's runs.
    assert "--omit=optional" in call
    assert call[-1] == "@agentclientprotocol/claude-agent-acp@0.92.0"
    assert installs == [1]
    # The next start reuses it: no npm, no install status.
    again, _ = asyncio.run(signin.adapter_command(npm.spec, lambda: installs.append(1)))
    assert again == argv
    assert len(npm.calls()) == 1 and installs == [1]
    # No half-done folders or lock left behind.
    assert sorted(p.name for p in (npm.root / "acp").iterdir()) == [
        "claude-agent-acp@0.92.0"
    ]


def test_adapter_is_reinstalled_when_the_pin_changes(npm):
    asyncio.run(signin.adapter_command(npm.spec))
    newer = dataclasses.replace(
        npm.spec, adapter="@agentclientprotocol/claude-agent-acp@0.93.0"
    )
    argv, _ = asyncio.run(signin.adapter_command(newer))
    assert "claude-agent-acp@0.93.0" in argv[1]
    assert len(npm.calls()) == 2
    # A folder with the pinned name but another version inside is not trusted.
    fake_install(npm.spec, npm.root, version="0.91.0")
    assert signin.installed_adapter(npm.spec) is None
    asyncio.run(signin.adapter_command(npm.spec))
    assert len(npm.calls()) == 3
    assert signin.installed_adapter(npm.spec) is not None


def test_two_starts_install_once(npm):
    npm.mode("slow")

    async def both():
        return await asyncio.gather(
            signin.adapter_command(npm.spec), signin.adapter_command(npm.spec)
        )

    first, second = asyncio.run(both())
    assert first == second
    assert len(npm.calls()) == 1


def test_another_process_installing_holds_the_lock(npm):
    lock = signin.adapter_dir(npm.spec).with_name("claude-agent-acp@0.92.0.lock")
    lock.parent.mkdir(parents=True)
    lock.write_text("")  # another Bowser is installing

    async def run():
        task = asyncio.ensure_future(signin.adapter_command(npm.spec))
        await asyncio.sleep(0.8)
        waited = not task.done() and npm.calls() == []
        lock.unlink()  # it finished
        return waited, await task

    waited, (argv, _) = asyncio.run(run())
    assert waited
    assert argv[0] == npm.node and len(npm.calls()) == 1


def test_failed_install_falls_back_to_npx_and_says_so(npm):
    npm.mode("fail")
    argv, note = asyncio.run(signin.adapter_command(npm.spec))
    assert argv == [
        "/usr/bin/npx",
        "--yes",
        "--prefer-offline",
        "@agentclientprotocol/claude-agent-acp@0.92.0",
    ]
    assert "npm could not install the adapter" in note and "npx" in note
    assert not (npm.root / "acp").exists() or not any(
        p.name.startswith("claude-agent-acp@0.92.0")
        for p in (npm.root / "acp").iterdir()
        if not p.name.endswith(".lock")
    )


def _phases(c, conversation: str, until=("ready", "error"), timeout=120) -> list:
    seen: list = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = c.get("/assistant/agent", params={"conversation": conversation}).json()
        if not seen or seen[-1]["phase"] != state["phase"]:
            seen.append(state)
        if state["phase"] in until:
            break
        time.sleep(0.05)
    return seen


def test_first_start_installs_the_adapter_and_reports_each_phase(
    served, npm, monkeypatch
):
    served.claude.state.write_text("signed in")
    monkeypatch.setattr(relay, "_agent_argv", AGENT_ARGV)
    npm.mode("slow")
    with httpx.Client(base_url=served.url, timeout=120) as c:
        c.post("/assistant/signin", json={"method": "claude"})
        first = c.post("/assistant/agent", json={"conversation": "w1"}).json()
        seen = _phases(c, "w1")
    phases = [first["phase"]] + [s["phase"] for s in seen]
    # One phase after the other, from the first answer on.
    assert [p for i, p in enumerate(phases) if i == 0 or p != phases[i - 1]] == [
        "installing",
        "starting",
        "ready",
    ], seen
    texts = {s["phase"]: s["text"] for s in seen}
    assert texts["installing"] == "Installing Anthropic's adapter (first time only)…"
    assert texts["starting"] == "Starting Claude Code…"
    assert texts["ready"] == "Ready"
    assert seen[-1]["elapsed"] > 0 and seen[-1]["note"] is None
    assert len(npm.calls()) == 1


def test_warm_session_is_reused_by_the_first_question(served):
    served.claude.state.write_text("signed in")
    starts = served.claude.out / "starts.txt"
    with httpx.Client(base_url=served.url, timeout=120) as c:
        c.post("/assistant/signin", json={"method": "claude"})
        c.post("/assistant/agent", json={"conversation": "w2"})
        assert _phases(c, "w2")[-1]["phase"] == "ready"
        # Asking again for the same chat does not start another agent.
        assert (
            c.post("/assistant/agent", json={"conversation": "w2"}).json()["phase"]
            == "ready"
        )
        assert len(starts.read_text().split()) == 1

        def allow(e):
            if e["type"] == "permission":
                c.post(
                    "/assistant/permission",
                    json={"conversation": "w2", "id": e["id"], "choice": "allow"},
                )

        ev = _stream(
            c,
            {
                "provider": "claude",
                "conversation": "w2",
                "messages": [{"role": "user", "content": "Which layers?"}],
            },
            allow,
        )
    # Already started: no waiting, the same process answers.
    assert not [e for e in ev if e["type"] == "status"]
    assert ev[-1]["type"] == "done"
    assert len(starts.read_text().split()) == 1


def _pid_of(served) -> int:
    return int((served.claude.out / "starts.txt").read_text().split()[-1])


def test_warm_session_closes_when_idle(served, monkeypatch):
    served.claude.state.write_text("signed in")
    monkeypatch.setattr(acp, "IDLE_SECONDS", 0.5)
    with httpx.Client(base_url=served.url, timeout=120) as c:
        c.post("/assistant/signin", json={"method": "claude"})
        c.post("/assistant/agent", json={"conversation": "w3"})
        assert _phases(c, "w3")[-1]["phase"] == "ready"
        pid = _pid_of(served)
        assert _phases(c, "w3", until=("none",), timeout=10)[-1]["phase"] == "none"
    for _ in range(100):
        if not _alive(pid):
            break
        time.sleep(0.05)
    assert not _alive(pid)


@pytest.mark.parametrize("how", ["sign_out", "stop"])
def test_warm_session_closes_on_sign_out_and_stop(served, how):
    served.claude.state.write_text("signed in")
    with httpx.Client(base_url=served.url, timeout=120) as c:
        c.post("/assistant/signin", json={"method": "claude"})
        c.post("/assistant/agent", json={"conversation": "w4"})
        assert _phases(c, "w4")[-1]["phase"] == "ready"
        pid = _pid_of(served)
        if how == "sign_out":
            c.delete("/assistant/signin", params={"method": "claude"})
        else:
            assert c.post("/assistant/stop", json={"conversation": "w4"}).json() == {
                "stopped": 1
            }
        state = c.get("/assistant/agent", params={"conversation": "w4"}).json()
        assert state["phase"] == "none"
    for _ in range(100):
        if not _alive(pid):
            break
        time.sleep(0.05)
    assert not _alive(pid)
