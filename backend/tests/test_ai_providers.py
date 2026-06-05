import base64
import json
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.main import app
from app.models.api_key import ApiKey


def _test_jwt(account_id: str = "account-123") -> str:
    def encode(value: dict) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")

    return ".".join(
        [
            encode({"alg": "none", "typ": "JWT"}),
            encode({"https://api.openai.com/auth": {"chatgpt_account_id": account_id}}),
            "sig",
        ]
    )


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
                "value": "sk-should-not-be-here",
            },
        },
    )
    assert plaintext_extra.status_code == 422, plaintext_extra.text
    assert "sk-should-not-be-here" not in plaintext_extra.text

    managed_ref = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {
                "type": "api_key",
                "source": "managed",
                "ref": "env:OPENAI_API_KEY",
            },
        },
    )
    assert managed_ref.status_code == 422, managed_ref.text
    assert "must not include ref" in managed_ref.text

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

    unsupported_agent_profile = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "anthropic-profile",
            "type": "anthropic",
            "base_url": "https://api.anthropic.com",
            "auth": {
                "type": "agent_profile",
                "tool": "claude-code",
                "profile": "default",
            },
        },
    )
    assert unsupported_agent_profile.status_code == 422, unsupported_agent_profile.text
    assert "codex only" in unsupported_agent_profile.text.lower()

    unsupported_oauth_profile = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-oauth",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {
                "type": "oauth_profile",
                "provider": "codex",
                "profile": "default",
            },
        },
    )
    assert unsupported_oauth_profile.status_code == 422, unsupported_oauth_profile.text
    assert "oauth_profile auth is not supported" in unsupported_oauth_profile.text

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
async def test_ai_provider_allows_no_auth_local_endpoints(client: httpx.AsyncClient):
    for index, base_url in enumerate(
        [
            "http://localhost:1234/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234/v1",
            "http://0.0.0.0:1234/v1",
        ],
    ):
        created = await client.post(
            "/api/ai-providers",
            json={
                "provider_id": f"local-model-{index}",
                "type": "custom_openai_compatible",
                "base_url": base_url,
                "api_mode": "openai_chat",
                "auth": {"type": "none"},
            },
        )
        assert created.status_code == 200, created.text


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
            "runtime_env_name": "OPENAI_API_KEY",
        },
    )
    assert updated.status_code == 200, updated.text
    assert "sk-managed-secret" not in updated.text
    body = updated.json()
    assert body["auth"] == {
        "type": "api_key",
        "source": "managed",
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
    }

    unsupported_agent_profile = await client.post(
        "/api/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "claude-code",
            "profile": "default",
            "payload": '{"token":"claude-secret"}',
        },
    )
    assert unsupported_agent_profile.status_code == 422, unsupported_agent_profile.text
    assert "Codex only" in unsupported_agent_profile.text

    unsupported_oauth_profile = await client.post(
        "/api/ai-providers/openai-codex/auth/import",
        json={
            "type": "oauth_profile",
            "provider": "codex",
            "profile": "default",
            "payload": '{"token":"oauth-secret"}',
        },
    )
    assert unsupported_oauth_profile.status_code == 422, unsupported_oauth_profile.text
    assert "oauth_profile import is not supported" in unsupported_oauth_profile.text


@pytest.mark.asyncio
async def test_ai_provider_resolve_uses_only_active_auth_profile(
    client: httpx.AsyncClient,
    seed_user,
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

    first = await client.post(
        "/api/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": '{"token":"old"}',
        },
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        "/api/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "work_team",
            "payload": '{"token":"active"}',
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "work_team",
    }

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
    try:
        old_profile = await client.post(
            "/api/ai-providers/openai-codex/auth/resolve",
            json={"profile": "default"},
        )
        assert old_profile.status_code == 404, old_profile.text

        active_profile = await client.post(
            "/api/ai-providers/openai-codex/auth/resolve",
            json={"profile": "work_team"},
        )
        assert active_profile.status_code == 200, active_profile.text
        assert active_profile.json()["payload"] == '{"token":"active"}'
    finally:
        app.dependency_overrides.pop(get_auth, None)


@pytest.mark.asyncio
async def test_ai_provider_codex_profiles_are_scoped_by_provider_id(
    client: httpx.AsyncClient,
    seed_user,
):
    for provider_id, label, payload in [
        ("openai-codex-work", "Work Codex", '{"token":"work"}'),
        ("openai-codex-personal", "Personal Codex", '{"token":"personal"}'),
    ]:
        created = await client.post(
            "/api/ai-providers",
            json={
                "provider_id": provider_id,
                "type": "openai",
                "label": label,
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            },
        )
        assert created.status_code == 200, created.text
        imported = await client.post(
            f"/api/ai-providers/{provider_id}/auth/import",
            json={
                "type": "agent_profile",
                "tool": "codex",
                "profile": "default",
                "payload": payload,
            },
        )
        assert imported.status_code == 200, imported.text
        assert payload not in imported.text
        assert imported.json()["auth"] == {
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
        }

    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        work = await client.post(
            "/api/ai-providers/openai-codex-work/auth/resolve",
            json={"profile": "default"},
        )
        personal = await client.post(
            "/api/ai-providers/openai-codex-personal/auth/resolve",
            json={"profile": "default"},
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth

    assert work.status_code == 200, work.text
    assert personal.status_code == 200, personal.text
    assert work.json()["payload"] == '{"token":"work"}'
    assert personal.json()["payload"] == '{"token":"personal"}'
    assert work.json()["tool"] == "codex"
    assert personal.json()["tool"] == "codex"


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
async def test_ai_provider_oauth_start_uses_builtin_codex_config(client: httpx.AsyncClient):
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
    settings.ai_provider_oauth_config_json = ""
    try:
        started = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://localhost:1455/auth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert started.status_code == 200, started.text
    parsed = urlparse(started.json()["auth_url"])
    params = parse_qs(parsed.query)
    assert parsed.scheme == "https"
    assert parsed.netloc == "auth.openai.com"
    assert parsed.path == "/oauth/authorize"
    assert params["client_id"] == ["app_EMoamEEZ73f0CkXaXp7hrann"]
    assert params["redirect_uri"] == ["http://localhost:1455/auth/callback"]
    assert params["scope"] == [
        "openid profile email offline_access api.connectors.read api.connectors.invoke"
    ]
    assert params["id_token_add_organizations"] == ["true"]
    assert params["codex_cli_simplified_flow"] == ["true"]
    assert params["originator"] == ["codex_cli_rs"]


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_allows_dev_web_origin_http_redirect(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/api/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
        },
    )
    assert created.status_code == 200, created.text
    previous_environment = settings.environment
    previous_web_origin = settings.web_origin
    previous_cors_origins = settings.cors_origins
    settings.environment = "development"
    settings.web_origin = "http://phala-dev:33221"
    settings.cors_origins = ["http://localhost:33221"]
    try:
        started = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://phala-dev:33221/onboarding?step=provider&provider_oauth=codex",
            },
        )
        wrong_port = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://phala-dev:33222/onboarding?step=provider&provider_oauth=codex",
            },
        )
    finally:
        settings.environment = previous_environment
        settings.web_origin = previous_web_origin
        settings.cors_origins = previous_cors_origins

    assert started.status_code == 200, started.text
    assert wrong_port.status_code == 422, wrong_port.text
    params = parse_qs(urlparse(started.json()["auth_url"]).query)
    assert params["redirect_uri"] == [
        "http://phala-dev:33221/onboarding?step=provider&provider_oauth=codex"
    ]


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_requires_clean_redirect_and_params(
    client: httpx.AsyncClient,
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
            }
        }
    )
    try:
        missing_redirect = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert missing_redirect.status_code == 503, missing_redirect.text
        assert "missing redirect_uri" in missing_redirect.text

        settings.ai_provider_oauth_config_json = json.dumps(
            {
                "codex": {
                    "authorization_url": "https://oauth.example/authorize",
                    "token_url": "https://oauth.example/token",
                    "client_id": "clawdi-client",
                    "redirect_uri": "https://cloud.example/oauth/callback",
                    "extra_authorize_params": {"state": "attacker-state"},
                }
            }
        )
        reserved_override = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert reserved_override.status_code == 503, reserved_override.text
        assert "cannot override state" in reserved_override.text

        unsupported_provider = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "claude-code",
                "redirect_uri": "http://localhost:1455/auth/callback",
            },
        )
        assert unsupported_provider.status_code == 422, unsupported_provider.text
        assert "Codex only" in unsupported_provider.text
    finally:
        settings.ai_provider_oauth_config_json = previous


@pytest.mark.asyncio
async def test_ai_provider_oauth_complete_exchanges_and_redacts_token(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    seed_user,
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
            if data["grant_type"] == "urn:ietf:params:oauth:grant-type:token-exchange":
                return httpx.Response(200, json={"access_token": "sk-codex-api-key"})
            return httpx.Response(
                200,
                json={
                    "id_token": _test_jwt(),
                    "access_token": "oauth-access-token",
                    "refresh_token": "oauth-refresh-token",
                },
            )

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    try:
        invalid_state = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": "not-valid",
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert invalid_state.status_code == 400, invalid_state.text
        assert token_requests == []

        started = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert started.status_code == 200, started.text
        mismatch = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/other-callback",
            },
        )
        assert mismatch.status_code == 400, mismatch.text
        assert token_requests == []
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
    assert "oauth-refresh-token" not in completed.text
    assert "sk-codex-api-key" not in completed.text
    assert completed.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }
    assert token_requests[0]["url"] == "https://oauth.example/token"
    assert token_requests[0]["data"]["grant_type"] == "authorization_code"
    assert token_requests[0]["data"]["client_id"] == "clawdi-client"
    assert token_requests[0]["data"]["client_secret"] == "oauth-client-secret"
    assert token_requests[0]["data"]["code"] == "oauth-code"
    assert token_requests[0]["data"]["code_verifier"]
    assert token_requests[1]["url"] == "https://oauth.example/token"
    assert token_requests[1]["data"] == {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "client_id": "clawdi-client",
        "requested_token": "openai-api-key",
        "subject_token": _test_jwt(),
        "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
    }
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        resolved = await client.post(
            "/api/ai-providers/openai-codex/auth/resolve",
            json={"profile": "default"},
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth
    assert resolved.status_code == 200, resolved.text
    payload = json.loads(resolved.json()["payload"])
    assert payload["kind"] == "local_agent_profile"
    assert payload["tool"] == "codex"
    auth_json = json.loads(payload["files"][0]["content"])
    assert auth_json["auth_mode"] == "chatgpt"
    assert auth_json["OPENAI_API_KEY"] == "sk-codex-api-key"
    assert auth_json["tokens"]["access_token"] == "oauth-access-token"
    assert auth_json["tokens"]["refresh_token"] == "oauth-refresh-token"
    assert auth_json["tokens"]["account_id"] == "account-123"


@pytest.mark.asyncio
async def test_ai_provider_oauth_complete_omits_missing_codex_api_key(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    seed_user,
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
            }
        }
    )

    class FakeOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            return httpx.Response(
                200,
                json={
                    "id_token": _test_jwt(),
                    "access_token": "oauth-access-token",
                    "refresh_token": "oauth-refresh-token",
                },
            )

    async def fake_obtain_codex_api_key(client, config, id_token):
        return None

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    monkeypatch.setattr(
        "app.routes.ai_providers._obtain_codex_api_key",
        fake_obtain_codex_api_key,
    )
    try:
        started = await client.post(
            "/api/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
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
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        resolved = await client.post(
            "/api/ai-providers/openai-codex/auth/resolve",
            json={"profile": "default"},
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth
    assert resolved.status_code == 200, resolved.text
    payload = json.loads(resolved.json()["payload"])
    auth_json = json.loads(payload["files"][0]["content"])
    assert auth_json["auth_mode"] == "chatgpt"
    assert "OPENAI_API_KEY" not in auth_json
    assert auth_json["tokens"]["access_token"] == "oauth-access-token"
    assert auth_json["tokens"]["refresh_token"] == "oauth-refresh-token"


@pytest.mark.asyncio
async def test_ai_provider_account_mutations_reject_environment_api_keys(
    client: httpx.AsyncClient,
    seed_user,
):
    env_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_env",
        label="agent-env",
        environment_id=uuid.uuid4(),
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=env_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        created = await client.post(
            "/api/ai-providers",
            json={
                "provider_id": "openai-main",
                "type": "openai",
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            },
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth

    assert created.status_code == 403, created.text
    assert "Agent API keys" in created.text


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
        json={"value": "sk-managed-secret"},
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
            },
        },
    )
    assert recreated.status_code == 200, recreated.text

    stale_resolve = await client.post(
        "/api/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert stale_resolve.status_code == 404, stale_resolve.text
