import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.main import app
from app.models.api_key import ApiKey


@pytest.mark.asyncio
async def test_ai_provider_crud_is_account_scoped_metadata(client: httpx.AsyncClient):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-5.2",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            "runtime_env_name": "OPENAI_API_KEY",
            "capabilities": {"chat": True, "tools": True},
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["scope"] == "account_global"
    assert body["auth"] == {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"}

    duplicate = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert duplicate.status_code == 409, duplicate.text

    patched = await client.patch(
        "/api/ai-providers/openai-main",
        json={
            "default_model": "gpt-5.3",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["default_model"] == "gpt-5.3"
    assert patched.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }

    bad_patch = await client.patch("/api/ai-providers/openai-main", json={"auth": None})
    assert bad_patch.status_code == 422, bad_patch.text
    assert "auth cannot be null" in bad_patch.text

    listing = await client.get("/api/ai-providers")
    assert listing.status_code == 200, listing.text
    assert [item["provider_id"] for item in listing.json()["providers"]] == ["openai-main"]

    deleted = await client.delete("/api/ai-providers/openai-main")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"status": "deleted", "provider_id": "openai-main"}
    empty = await client.get("/api/ai-providers")
    assert empty.status_code == 200, empty.text
    assert empty.json()["providers"] == []


@pytest.mark.asyncio
async def test_ai_provider_rejects_invalid_auth_and_api_mode(client: httpx.AsyncClient):
    invalid_mode = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "anthropic-main",
            "type": "anthropic",
            "base_url": "https://api.anthropic.com",
            "api_mode": "openai_chat",
            "auth": {"type": "secret_ref", "ref": "env:ANTHROPIC_API_KEY"},
        },
    )
    assert invalid_mode.status_code == 422, invalid_mode.text
    assert "incompatible" in invalid_mode.text

    plaintext_extra = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {
                "type": "api_key",
                "source": "managed",
                "payload_ref": "encrypted:redacted",
                "value": "sk-should-not-be-here",
            },
        },
    )
    assert plaintext_extra.status_code == 422, plaintext_extra.text
    assert "sk-should-not-be-here" not in plaintext_extra.text

    wrong_payload_ref = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {
                "type": "api_key",
                "source": "managed",
                "payload_ref": "ai-provider-auth://other/default",
            },
        },
    )
    assert wrong_payload_ref.status_code == 422, wrong_payload_ref.text
    assert "invalid payload_ref" in wrong_payload_ref.text

    bad_env_ref = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:"},
        },
    )
    assert bad_env_ref.status_code == 422, bad_env_ref.text
    assert "secret_ref auth" in bad_env_ref.text

    bad_agent_profile = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "agent_profile", "tool": "Codex", "profile": "../default"},
        },
    )
    assert bad_agent_profile.status_code == 422, bad_agent_profile.text
    assert "agent_profile auth has invalid" in bad_agent_profile.text

    public_no_auth = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "public-local",
            "type": "custom_openai_compatible",
            "base_url": "https://example.com/v1",
            "api_mode": "openai_chat",
            "auth": {"type": "none"},
        },
    )
    assert public_no_auth.status_code == 422, public_no_auth.text
    assert "none auth" in public_no_auth.text


@pytest.mark.asyncio
async def test_ai_provider_managed_api_key_is_redacted(client: httpx.AsyncClient):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    updated = await client.post(
        "/api/ai-providers/openai-main/auth/api-key",
        json={
            "value": "sk-managed-secret",
            "profile": "default",
            "runtime_env_name": "OPENAI_API_KEY",
        },
    )
    assert updated.status_code == 200, updated.text
    assert "sk-managed-secret" not in updated.text
    body = updated.json()
    assert body["auth"] == {
        "type": "api_key",
        "source": "managed",
        "payload_ref": "ai-provider-auth://openai-main/default",
    }
    assert body["runtime_env_name"] == "OPENAI_API_KEY"


@pytest.mark.asyncio
async def test_ai_provider_imports_agent_profile_payload_without_echo(client: httpx.AsyncClient):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    imported = await client.post(
        "/api/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "work_team",
            "payload": '{"token":"codex-secret"}',
        },
    )
    assert imported.status_code == 200, imported.text
    assert "codex-secret" not in imported.text
    assert imported.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "work_team",
        "payload_ref": "ai-provider-auth://openai-codex/work_team",
    }


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_returns_backend_generated_link(client: httpx.AsyncClient):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "scope": "openid profile",
            }
        }
    )
    try:
        started = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "profile": "default",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert started.status_code == 200, started.text
    body = started.json()
    assert body["provider_id"] == "openai-codex"
    assert body["oauth_provider"] == "codex"
    assert body["profile"] == "default"
    parsed = urlparse(body["auth_url"])
    params = parse_qs(parsed.query)
    assert parsed.scheme == "https"
    assert parsed.netloc == "oauth.example"
    assert params["client_id"] == ["clawdi-client"]
    assert params["response_type"] == ["code"]
    assert params["redirect_uri"] == ["https://cloud.example/oauth/callback"]
    assert params["code_challenge_method"] == ["S256"]
    assert params["scope"] == ["openid profile"]
    assert params["state"] == [body["state"]]


@pytest.mark.asyncio
async def test_ai_provider_oauth_complete_exchanges_and_redacts_token(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "client_secret": "oauth-client-secret",
            }
        }
    )
    token_requests: list[dict] = []

    class FakeOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            token_requests.append({"url": url, "data": data})
            return httpx.Response(
                200,
                json={"access_token": "oauth-access-token", "refresh_token": "oauth-refresh-token"},
            )

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    try:
        started = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "profile": "default",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert started.status_code == 200, started.text
        completed = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert completed.status_code == 200, completed.text
    assert "oauth-access-token" not in completed.text
    assert completed.json()["auth"] == {
        "type": "oauth_profile",
        "provider": "codex",
        "profile": "default",
        "payload_ref": "ai-provider-auth://openai-codex/default",
    }
    assert token_requests[0]["url"] == "https://oauth.example/token"
    assert token_requests[0]["data"]["grant_type"] == "authorization_code"
    assert token_requests[0]["data"]["client_id"] == "clawdi-client"
    assert token_requests[0]["data"]["client_secret"] == "oauth-client-secret"
    assert token_requests[0]["data"]["code"] == "oauth-code"
    assert token_requests[0]["data"]["code_verifier"]


@pytest.mark.asyncio
async def test_ai_provider_resolve_managed_auth_requires_cli(
    client: httpx.AsyncClient,
    seed_user,
):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    managed = await client.post(
        "/api/ai-providers/openai-main/auth/api-key",
        json={"value": "sk-managed-secret", "profile": "default"},
    )
    assert managed.status_code == 200, managed.text

    web_resolve = await client.post(
        "/api/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert web_resolve.status_code == 403, web_resolve.text

    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    app.dependency_overrides[get_auth] = _override_get_auth
    resolved = await client.post(
        "/api/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json() == {
        "provider_id": "openai-main",
        "auth_type": "api_key",
        "payload_ref": "ai-provider-auth://openai-main/default",
        "value": "sk-managed-secret",
        "payload": None,
        "tool": None,
        "provider": None,
        "profile": "default",
    }

    deleted = await client.delete("/api/ai-providers/openai-main")
    assert deleted.status_code == 200, deleted.text

    recreated = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {
                "type": "api_key",
                "source": "managed",
                "payload_ref": "ai-provider-auth://openai-main/default",
            },
        },
    )
    assert recreated.status_code == 200, recreated.text

    stale_resolve = await client.post(
        "/api/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert stale_resolve.status_code == 404, stale_resolve.text
