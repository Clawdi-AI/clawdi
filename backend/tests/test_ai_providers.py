import asyncio
import base64
import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.ai_provider import (
    AiProvider,
    AiProviderAuthPayload,
    AiProviderOAuthAttempt,
    AiProviderOAuthRevokeTombstone,
)
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.models.platform_idempotency import PlatformMutationIdempotency
from app.models.session import AgentEnvironment
from app.routes import ai_providers as ai_provider_routes
from app.schemas.ai_provider import AiProviderAcceptRequest
from app.services import sync_events
from app.services.ai_provider_connection import ConnectionProbeResult
from app.services.ai_provider_credentials import (
    OAuthCredentialClaimConflict,
    reconcile_runtime_oauth_claims,
    release_runtime_oauth_claims,
)
from app.services.ai_provider_oauth_revoke_worker import (
    OAUTH_REVOKE_ATTEMPT_STALE_SECONDS,
    AiProviderOAuthRevokeWorker,
    claim_oauth_revoke_tombstone,
    record_oauth_revoke_result,
)
from app.services.managed_ai_provider import (
    CLAWDI_MANAGED_PROVIDER_ID,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    V1_MANAGED_AI_PROVIDER_ID,
    V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX,
    V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
    V2_MANAGED_AI_PROVIDER_API_MODE,
    V2_MANAGED_AI_PROVIDER_ID,
    archive_clawdi_managed_provider,
    is_v2_managed_provider_id,
    managed_provider_api_mode,
    runtime_managed_provider_id,
    upsert_clawdi_managed_provider,
    v2_deployment_managed_provider_id,
)
from app.services.platform_contract import platform_request_hash
from app.services.vault_crypto import decrypt, encrypt
from tests.conftest import create_env_with_project

_TEST_SYSTEM = {}


@pytest.mark.asyncio
async def test_oauth_consumer_fk_restricts_agent_delete_until_claim_pair_is_released(
    db_session,
    seed_user,
):
    environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"oauth-fk-{uuid.uuid4().hex}",
        machine_name="OAuth FK owner",
        agent_type="openclaw",
    )
    encrypted, nonce = encrypt('{"kind":"oauth-test"}')
    payload = AiProviderAuthPayload(
        owner_user_id=seed_user.id,
        provider_id=f"oauth-fk-{uuid.uuid4().hex}",
        auth_profile="default",
        kind="agent_profile",
        source="test",
        encrypted_payload=encrypted,
        nonce=nonce,
        consumer_environment_id=environment.id,
        consumer_runtime="openclaw",
    )
    db_session.add(payload)
    await db_session.commit()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                delete(AgentEnvironment).where(AgentEnvironment.id == environment.id)
            )
            await db_session.flush()

    await db_session.refresh(payload)
    assert payload.consumer_environment_id == environment.id
    assert payload.consumer_runtime == "openclaw"

    await release_runtime_oauth_claims(
        db_session,
        owner_user_id=seed_user.id,
        environment_id=environment.id,
    )
    await db_session.execute(delete(AgentEnvironment).where(AgentEnvironment.id == environment.id))
    await db_session.commit()
    await db_session.refresh(payload)
    assert payload.consumer_environment_id is None
    assert payload.consumer_runtime is None


@pytest.mark.asyncio
async def test_runtime_state_rejects_multiple_oauth_providers_before_payload_claims(
    db_session,
    seed_user,
):
    provider_ids = ["oauth-family-one", "oauth-family-two"]
    environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"oauth-family-boundary-{uuid.uuid4().hex}",
        machine_name="OAuth family boundary",
        agent_type="openclaw",
    )
    for provider_id in provider_ids:
        db_session.add(
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id=provider_id,
                type="openai",
                base_url="https://api.openai.com/v1",
                api_mode="openai_responses",
                auth_type="agent_profile",
                auth_metadata={"tool": "codex", "profile": "default"},
                managed_by="user",
            )
        )
    runtimes = {
        "openclaw": {
            "enabled": True,
            "providerMode": "configured",
            "provider_ids": provider_ids,
            "primary_model": {
                "provider_id": provider_ids[0],
                "model": "gpt-test",
            },
            "install": {"source": "official"},
        }
    }
    await db_session.flush()

    with pytest.raises(
        OAuthCredentialClaimConflict,
        match="cannot bind more than one OAuth",
    ):
        await reconcile_runtime_oauth_claims(
            db_session,
            owner_user_id=seed_user.id,
            environment_id=environment.id,
            runtimes=runtimes,
        )


async def _use_db_session_for_short_ai_provider_sessions(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = await db_session.connection()
    session_factory = async_sessionmaker(
        bind=connection,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(
        "app.routes.ai_providers.async_session_factory",
        session_factory,
    )


@pytest.mark.parametrize(
    "provider_id",
    [
        V2_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    ],
)
def test_v2_managed_ai_provider_ids_resolve_to_chat_mode(provider_id: str):
    assert is_v2_managed_provider_id(provider_id)
    assert managed_provider_api_mode(provider_id) == V2_MANAGED_AI_PROVIDER_API_MODE


def test_v1_provider_mode_resolution_does_not_accept_deployment_scoped_ids():
    provider_id = f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}42"

    assert is_v2_managed_provider_id(provider_id)
    assert managed_provider_api_mode(provider_id) is None


@pytest.mark.parametrize(
    "provider_id",
    [
        V2_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_MANAGED_AI_PROVIDER_ID,
        f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}42",
        CLAWDI_MANAGED_PROVIDER_ID,
    ],
)
def test_managed_v2_bindings_use_bare_agent_facing_id(provider_id: str):
    assert runtime_managed_provider_id(provider_id) == CLAWDI_MANAGED_PROVIDER_ID


def test_public_managed_id_is_canonical_and_scoped_ids_remain_internal():
    provider_id = v2_deployment_managed_provider_id("42")

    assert V2_MANAGED_AI_PROVIDER_ID == "clawdi"
    assert provider_id == f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}42"
    assert is_v2_managed_provider_id(CLAWDI_MANAGED_PROVIDER_ID)
    assert runtime_managed_provider_id(V1_MANAGED_AI_PROVIDER_ID) == V1_MANAGED_AI_PROVIDER_ID


@pytest.mark.parametrize("deployment_id", ["", "0", "01", "invalid", " 42"])
def test_deployment_managed_provider_rejects_noncanonical_deployment_id(
    deployment_id: str,
):
    assert v2_deployment_managed_provider_id(deployment_id) is None


@pytest.mark.parametrize(
    "provider_id",
    [
        "clawdi-v2-deployment-",
        "clawdi-v2-deployment-0",
        "clawdi-v2-deployment-01",
        "clawdi-v2-deployment-not-a-number",
        f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}{'9' * 43}",
    ],
)
def test_v2_managed_ai_provider_rejects_invalid_deployment_ids(provider_id: str):
    assert not is_v2_managed_provider_id(provider_id)
    assert managed_provider_api_mode(provider_id) is None


_VALID_AUTH_VARIANTS = [
    pytest.param(
        "secret-env",
        {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        id="secret-ref-env",
    ),
    pytest.param(
        "secret-vault",
        {"type": "secret_ref", "ref": "clawdi://providers/openai"},
        id="secret-ref-vault",
    ),
    pytest.param(
        "api-env",
        {
            "type": "api_key",
            "source": "env",
            "ref": "env:OPENAI_API_KEY",
            "profile": "work_team",
        },
        id="api-key-env",
    ),
    pytest.param(
        "api-vault",
        {
            "type": "api_key",
            "source": "vault",
            "ref": "clawdi://providers/openai",
            "profile": "personal",
        },
        id="api-key-vault",
    ),
    pytest.param(
        "api-managed",
        {"type": "api_key", "source": "managed", "profile": "work_team"},
        id="api-key-managed",
    ),
    pytest.param(
        "agent-profile",
        {"type": "agent_profile", "tool": "codex", "profile": "work_team"},
        id="agent-profile",
    ),
    pytest.param("none", {"type": "none"}, id="none"),
]

_INVALID_AUTH_VARIANTS = [
    pytest.param(
        {"type": "secret_ref", "ref": "env:OPENAI_API_KEY", "source": "env"},
        id="secret-ref-with-source",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "ref": "env:OPENAI_API_KEY"},
        id="managed-with-ref",
    ),
    pytest.param(
        {"type": "api_key", "source": "env"},
        id="env-without-ref",
    ),
    pytest.param(
        {"type": "api_key", "source": "vault", "ref": "env:OPENAI_API_KEY"},
        id="vault-with-env-ref",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "profile": "../work-team"},
        id="invalid-api-key-profile",
    ),
    pytest.param(
        {
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "ref": "env:OPENAI_API_KEY",
        },
        id="agent-profile-with-ref",
    ),
    pytest.param(
        {"type": "none", "profile": "default"},
        id="none-with-profile",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "profiel": "default"},
        id="misspelled-profile",
    ),
    pytest.param(
        {"type": "api_key", "source": "managed", "value": "sk-should-not-be-here"},
        id="plaintext-value",
    ),
    pytest.param(
        {"type": "oauth_profile", "provider": "codex", "profile": "default"},
        id="unsupported-oauth-profile",
    ),
]


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


def _codex_oauth_envelope(access_token: str, refresh_token: str) -> str:
    return json.dumps(
        {
            "kind": "local_agent_profile",
            "tool": "codex",
            "profile": "default",
            "files": [
                {
                    "logicalName": "auth.json",
                    "content": json.dumps(
                        {
                            "auth_mode": "chatgpt",
                            "tokens": {
                                "id_token": _test_jwt(),
                                "access_token": access_token,
                                "refresh_token": refresh_token,
                                "account_id": "account-123",
                            },
                        }
                    ),
                }
            ],
        }
    )


def _api_key_accept_body(value: str = "sk-atomic-secret") -> dict:
    return {
        "provider": {
            "provider_id": "openai-atomic",
            "type": "openai",
            "label": "OpenAI",
            "base_url": "https://api.openai.com/v1",
            "models": [{"id": "gpt-5.2"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed", "profile": "default"},
            "managed_by": "user",
            "runtime_env_name": "OPENAI_API_KEY",
        },
        "credential": {"type": "api_key", "value": value},
    }


@pytest.mark.asyncio
async def test_ai_provider_crud_is_account_scoped_metadata(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "models": [{"id": "gpt-5.2"}],
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
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert duplicate.status_code == 409, duplicate.text

    patched = await client.patch(
        "/v1/ai-providers/openai-main",
        json={
            "models": [{"id": "gpt-5.3"}],
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["models"] == [{"id": "gpt-5.3"}]
    assert "default_model" not in patched.json()
    assert patched.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }

    bad_patch = await client.patch("/v1/ai-providers/openai-main", json={"auth": None})
    assert bad_patch.status_code == 422, bad_patch.text
    assert "auth cannot be null" in bad_patch.text

    listing = await client.get("/v1/ai-providers")
    assert listing.status_code == 200, listing.text
    assert [item["provider_id"] for item in listing.json()["providers"]] == ["openai-main"]

    deleted = await client.delete("/v1/ai-providers/openai-main")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "status": "deleted",
        "provider_id": "openai-main",
        "remote_revoke_status": "not_required",
    }
    empty = await client.get("/v1/ai-providers")
    assert empty.status_code == 200, empty.text
    assert empty.json()["providers"] == []


@pytest.mark.asyncio
async def test_ai_provider_usability_requires_the_active_stored_credential(
    client: httpx.AsyncClient,
):
    codex_placeholder = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
        },
    )
    api_key_placeholder = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "api_key", "source": "managed", "profile": "default"},
        },
    )

    assert codex_placeholder.status_code == 200, codex_placeholder.text
    assert api_key_placeholder.status_code == 200, api_key_placeholder.text
    assert codex_placeholder.json()["usable"] is False
    assert api_key_placeholder.json()["usable"] is False

    initial_listing = await client.get("/v1/ai-providers")
    assert initial_listing.status_code == 200, initial_listing.text
    assert {
        provider["provider_id"]: provider["usable"]
        for provider in initial_listing.json()["providers"]
    } == {"openai-codex": False, "openai-main": False}

    imported = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": '{"tokens":{"access_token":"oauth-access-token"}}',
        },
    )
    key_stored = await client.post(
        "/v1/ai-providers/openai-main/auth/api-key",
        json={"value": "sk-managed-secret"},
    )

    assert imported.status_code == 200, imported.text
    assert key_stored.status_code == 200, key_stored.text
    assert imported.json()["usable"] is True
    assert key_stored.json()["usable"] is True

    completed_listing = await client.get("/v1/ai-providers")
    assert completed_listing.status_code == 200, completed_listing.text
    assert {
        provider["provider_id"]: provider["usable"]
        for provider in completed_listing.json()["providers"]
    } == {"openai-codex": True, "openai-main": True}
    assert all(
        provider.get("consumer") is None for provider in completed_listing.json()["providers"]
    )


@pytest.mark.asyncio
async def test_api_key_accept_is_atomic_usable_and_idempotent(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    user_id = seed_user.id
    env = await create_env_with_project(
        db_session,
        user_id=user_id,
        machine_id=f"provider-accept-{uuid.uuid4().hex[:8]}",
        machine_name="Provider Accept",
        agent_type="openclaw",
    )
    environment_id = env.id
    db_session.add(
        HostedRuntimeState(
            environment_id=environment_id,
            deployment_id="dep-provider-accept",
            instance_id="hri-provider-accept",
            generation=1,
            cli_package_spec="clawdi@0.13.0",
            locale={"language": "en", "timezone": "UTC"},
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes={
                "openclaw": {
                    "enabled": True,
                    "providerMode": "configured",
                    "provider_ids": ["openai-atomic"],
                    "primary_model": {
                        "provider_id": "openai-atomic",
                        "model": "gpt-5.2",
                    },
                    "install": {"source": "official"},
                }
            },
        )
    )
    await db_session.commit()

    queue = sync_events.subscribe(user_id, frozenset(), environment_id=environment_id)
    headers = {"Idempotency-Key": "provider-accept-api-key"}
    try:
        accepted = await client.post(
            "/v1/ai-providers/accept",
            headers=headers,
            json=_api_key_accept_body(),
        )
        assert accepted.status_code == 201, accepted.text
        assert "sk-atomic-secret" not in accepted.text
        assert accepted.json()["status"] == "ready"
        assert accepted.json()["provider"]["usable"] is True
        assert queue.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(environment_id),
        }

        replay = await client.post(
            "/v1/ai-providers/accept",
            headers=headers,
            json=_api_key_accept_body(),
        )
        assert replay.status_code == 201, replay.text
        assert replay.json() == accepted.json()
        assert queue.empty()

        listing = await client.get("/v1/ai-providers")
        assert listing.status_code == 200, listing.text
        assert listing.json()["providers"][0]["usable"] is True

        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(AiProvider)
                .where(
                    AiProvider.owner_user_id == user_id,
                    AiProvider.provider_id == "openai-atomic",
                )
            )
            == 1
        )
        payload = (
            await db_session.execute(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id == user_id,
                    AiProviderAuthPayload.provider_id == "openai-atomic",
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        ).scalar_one()
        assert payload.encrypted_payload != b"sk-atomic-secret"
        assert decrypt(payload.encrypted_payload, payload.nonce) == "sk-atomic-secret"

        idempotency = (
            await db_session.execute(
                select(PlatformMutationIdempotency).where(
                    PlatformMutationIdempotency.operation == "ai_provider.accept",
                    PlatformMutationIdempotency.idempotency_key == "provider-accept-api-key",
                )
            )
        ).scalar_one()
        assert idempotency.resource_type == "ai_provider"
        assert b"sk-atomic-secret" not in idempotency.encrypted_response
        request_model = AiProviderAcceptRequest.model_validate(_api_key_accept_body())
        assert idempotency.request_hash == platform_request_hash(
            {
                "provider": request_model.provider.model_dump(
                    mode="json",
                    exclude_none=False,
                ),
                "credential": {
                    "type": "api_key",
                    "value_sha256": hashlib.sha256(b"sk-atomic-secret").hexdigest(),
                },
            }
        )

        reused = await client.post(
            "/v1/ai-providers/accept",
            headers=headers,
            json=_api_key_accept_body("sk-different-secret"),
        )
        assert reused.status_code == 409, reused.text
        assert "sk-different-secret" not in reused.text
    finally:
        sync_events.unsubscribe(user_id, queue)


@pytest.mark.asyncio
async def test_ai_provider_connection_test_is_real_readiness_but_non_mutating(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    captured: dict[str, str | None] = {}

    async def fake_connection_test(**kwargs):
        captured.update(kwargs)
        return ConnectionProbeResult(ok=True)

    monkeypatch.setattr(
        "app.routes.ai_providers.test_ai_provider_connection",
        fake_connection_test,
    )
    response = await client.post(
        "/v1/ai-providers/test",
        json=_api_key_accept_body("sk-test-only"),
    )

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["readiness"] == {
        "credential_material": "available",
        "runtime_compatibility": {
            "openclaw": True,
            "hermes": True,
            "codex": True,
        },
        "deployable": True,
        "endpoint_reachability": "verified",
        "inference_verification": "verified",
    }
    assert captured == {
        "provider_type": "openai",
        "base_url": "https://api.openai.com/v1",
        "api_mode": "openai_responses",
        "model": "gpt-5.2",
        "credential": "sk-test-only",
    }
    assert "sk-test-only" not in response.text
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(AiProvider)
            .where(AiProvider.owner_user_id == seed_user.id)
        )
        == 0
    )


@pytest.mark.asyncio
async def test_ai_provider_connection_test_uses_the_selected_model_protocol(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    captured: dict[str, str | None] = {}

    async def fake_connection_test(**kwargs):
        captured.update(kwargs)
        return ConnectionProbeResult(ok=True)

    monkeypatch.setattr(
        "app.routes.ai_providers.test_ai_provider_connection",
        fake_connection_test,
    )
    body = _api_key_accept_body("sk-model-protocol")
    body["provider"]["models"] = [
        {"id": "gpt-chat", "api_mode": "openai_chat"},
    ]
    body["model"] = "gpt-chat"

    response = await client.post("/v1/ai-providers/test", json=body)

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert captured["api_mode"] == "openai_chat"
    assert response.json()["readiness"]["runtime_compatibility"] == {
        "openclaw": True,
        "hermes": True,
        "codex": False,
    }


@pytest.mark.asyncio
async def test_ai_provider_connection_test_does_not_offer_unsafe_none_auth(
    client: httpx.AsyncClient,
):
    response = await client.post(
        "/v1/ai-providers/test",
        json={
            "provider": {
                "provider_id": "local-none",
                "type": "custom_openai_compatible",
                "base_url": "http://127.0.0.1:11434/v1",
                "api_mode": "openai_chat",
                "auth": {"type": "none"},
                "models": [{"id": "local-model"}],
            },
            "credential": {"type": "none"},
        },
    )

    assert response.status_code == 422, response.text
    assert "input_value" not in response.text


@pytest.mark.asyncio
async def test_saved_ai_provider_connection_test_uses_active_managed_key_without_echo(
    client: httpx.AsyncClient,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    accepted = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": "saved-provider-connection-test"},
        json=_api_key_accept_body("sk-saved-provider-only"),
    )
    assert accepted.status_code == 201, accepted.text
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    listing_before = await client.get("/v1/ai-providers")
    captured: dict[str, str | None] = {}

    async def fake_connection_test(**kwargs):
        captured.update(kwargs)
        return ConnectionProbeResult(ok=True)

    monkeypatch.setattr(
        "app.routes.ai_providers.test_ai_provider_connection",
        fake_connection_test,
    )
    response = await client.post(
        "/v1/ai-providers/openai-atomic/test",
        json={"model": "gpt-5.2"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "ok": True,
        "readiness": {
            "credential_material": "available",
            "runtime_compatibility": {
                "openclaw": True,
                "hermes": True,
                "codex": True,
            },
            "deployable": True,
            "endpoint_reachability": "verified",
            "inference_verification": "verified",
        },
    }
    assert captured == {
        "provider_type": "openai",
        "base_url": "https://api.openai.com/v1",
        "api_mode": "openai_responses",
        "model": "gpt-5.2",
        "credential": "sk-saved-provider-only",
    }
    assert "sk-saved-provider-only" not in response.text

    listing_after = await client.get("/v1/ai-providers")
    assert listing_before.status_code == 200, listing_before.text
    assert listing_after.status_code == 200, listing_after.text
    assert listing_after.json() == listing_before.json()
    listed_provider = listing_after.json()["providers"][0]
    assert listed_provider["usable"] is True
    assert listed_provider["readiness"]["endpoint_reachability"] == "not_tested"
    assert listed_provider["readiness"]["inference_verification"] == "not_tested"


@pytest.mark.asyncio
async def test_saved_ai_provider_connection_test_rejects_non_managed_auth_safely(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    db_session.add_all(
        [
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="openai-env",
                type="openai",
                base_url="https://api.openai.com/v1",
                api_mode="openai_responses",
                models=[{"id": "gpt-5.2"}],
                auth_type="api_key",
                auth_ref="env:PRIVATE_OPENAI_API_KEY",
                auth_metadata={"source": "env"},
                managed_by="user",
                runtime_env_name="PRIVATE_OPENAI_API_KEY",
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="openai-vault",
                type="openai",
                base_url="https://api.openai.com/v1",
                api_mode="openai_responses",
                models=[{"id": "gpt-5.2"}],
                auth_type="api_key",
                auth_ref="clawdi://private/provider/key",
                auth_metadata={"source": "vault"},
                managed_by="user",
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="openai-oauth",
                type="openai",
                base_url="https://api.openai.com/v1",
                api_mode="openai_responses",
                models=[{"id": "gpt-5.2"}],
                auth_type="agent_profile",
                auth_ref=None,
                auth_metadata={
                    "tool": "codex",
                    "profile": "default",
                    "source": "oauth_pkce",
                },
                managed_by="user",
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="openai-secret-ref",
                type="openai",
                base_url="https://api.openai.com/v1",
                api_mode="openai_responses",
                models=[{"id": "gpt-5.2"}],
                auth_type="secret_ref",
                auth_ref="clawdi://private/provider/secret-ref",
                auth_metadata=None,
                managed_by="user",
            ),
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id="local-none",
                type="custom_openai_compatible",
                base_url="http://127.0.0.1:11434/v1",
                api_mode="openai_chat",
                models=[{"id": "local-model"}],
                auth_type="none",
                auth_ref=None,
                auth_metadata=None,
                managed_by="user",
            ),
        ]
    )
    await db_session.commit()
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    probe_calls = 0

    async def fail_if_probed(**kwargs):
        nonlocal probe_calls
        probe_calls += 1
        raise AssertionError(f"non-managed auth invoked the network probe: {kwargs}")

    monkeypatch.setattr(
        "app.routes.ai_providers.test_ai_provider_connection",
        fail_if_probed,
    )

    expected = {
        "openai-env": ("env_credential_not_testable", "referenced"),
        "openai-vault": ("vault_credential_not_testable", "referenced"),
        "openai-secret-ref": ("vault_credential_not_testable", "referenced"),
        "openai-oauth": ("oauth_credential_not_testable", "missing"),
        "local-none": ("none_auth_not_testable", "not_required"),
    }
    for provider_id, (code, credential_material) in expected.items():
        response = await client.post(
            f"/v1/ai-providers/{provider_id}/test",
            json={"model": "gpt-5.2"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is False
        assert body["error"]["category"] == "credential"
        assert body["error"]["code"] == code
        assert body["error"]["retryable"] is False
        assert body["readiness"]["credential_material"] == credential_material
        assert body["readiness"]["endpoint_reachability"] == "not_tested"
        assert body["readiness"]["inference_verification"] == "not_tested"
        assert "PRIVATE_OPENAI_API_KEY" not in response.text
        assert "clawdi://private" not in response.text
        assert "codex" not in body["error"]["message"].lower()
    assert probe_calls == 0


@pytest.mark.asyncio
async def test_saved_ai_provider_connection_test_redacts_unreadable_payload(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    accepted = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": "saved-provider-unreadable"},
        json=_api_key_accept_body("sk-never-return-this"),
    )
    assert accepted.status_code == 201, accepted.text
    payload = await db_session.scalar(
        select(AiProviderAuthPayload).where(
            AiProviderAuthPayload.owner_user_id == seed_user.id,
            AiProviderAuthPayload.provider_id == "openai-atomic",
        )
    )
    assert payload is not None
    payload.encrypted_payload = b"corrupt-ciphertext"
    payload.nonce = b"bad-nonce"
    await db_session.commit()
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)

    response = await client.post(
        "/v1/ai-providers/openai-atomic/test",
        json={"model": "gpt-5.2"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["error"] == {
        "category": "credential",
        "code": "saved_credential_unreadable",
        "message": "The saved API key could not be read. Save it again before testing.",
        "retryable": False,
    }
    assert response.json()["readiness"]["credential_material"] == "missing"
    assert "sk-never-return-this" not in response.text
    assert "InvalidTag" not in response.text
    assert "corrupt-ciphertext" not in response.text


@pytest.mark.asyncio
async def test_api_key_accept_rolls_back_everything_after_provider_write_failure(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = seed_user.id
    env = await create_env_with_project(
        db_session,
        user_id=user_id,
        machine_id=f"provider-accept-failure-{uuid.uuid4().hex[:8]}",
        machine_name="Provider Accept Failure",
        agent_type="openclaw",
    )
    environment_id = env.id
    db_session.add(
        HostedRuntimeState(
            environment_id=environment_id,
            deployment_id="dep-provider-accept-failure",
            instance_id="hri-provider-accept-failure",
            generation=1,
            cli_package_spec="clawdi@0.13.0",
            locale={"language": "en", "timezone": "UTC"},
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes={
                "openclaw": {
                    "enabled": True,
                    "providerMode": "configured",
                    "provider_ids": ["openai-atomic"],
                    "primary_model": {
                        "provider_id": "openai-atomic",
                        "model": "gpt-5.2",
                    },
                    "install": {"source": "official"},
                }
            },
        )
    )
    await db_session.commit()

    def _fail_idempotency_write(*args, **kwargs):
        raise RuntimeError("forced accept failure")

    monkeypatch.setattr(
        "app.routes.ai_providers.store_platform_response",
        _fail_idempotency_write,
    )
    queue = sync_events.subscribe(user_id, frozenset(), environment_id=environment_id)
    try:
        with pytest.raises(RuntimeError, match="forced accept failure"):
            await client.post(
                "/v1/ai-providers/accept",
                headers={"Idempotency-Key": "provider-accept-failure"},
                json=_api_key_accept_body(),
            )

        assert queue.empty()
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(AiProvider)
                .where(
                    AiProvider.owner_user_id == user_id,
                    AiProvider.provider_id == "openai-atomic",
                )
            )
            == 0
        )
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == user_id,
                    AiProviderAuthPayload.provider_id == "openai-atomic",
                )
            )
            == 0
        )
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(PlatformMutationIdempotency)
                .where(
                    PlatformMutationIdempotency.operation == "ai_provider.accept",
                    PlatformMutationIdempotency.idempotency_key == "provider-accept-failure",
                )
            )
            == 0
        )
    finally:
        sync_events.unsubscribe(user_id, queue)


@pytest.mark.asyncio
async def test_api_key_accept_atomically_replaces_provider_and_credential(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": "provider-accept-create-before-replace"},
        json=_api_key_accept_body("sk-old-secret"),
    )
    assert created.status_code == 201, created.text
    provider_id = created.json()["provider"]["id"]

    queued: list[tuple[uuid.UUID, str]] = []
    route_queued: list[tuple[uuid.UUID, str]] = []

    async def capture_runtime_change(_db, user_id, changed_provider_id):
        queued.append((user_id, changed_provider_id))

    async def capture_route_runtime_change(_db, user_id, changed_provider_id):
        route_queued.append((user_id, changed_provider_id))

    monkeypatch.setattr(
        "app.services.ai_provider_auth_transition.queue_provider_runtime_manifest_changed",
        capture_runtime_change,
    )
    monkeypatch.setattr(
        "app.routes.ai_providers.queue_provider_runtime_manifest_changed",
        capture_route_runtime_change,
    )

    replacement_body = _api_key_accept_body("sk-new-secret")
    replacement_body["provider"]["label"] = "Updated provider"
    replacement_body["replace"] = True
    headers = {"Idempotency-Key": "provider-accept-replace"}
    replaced = await client.post(
        "/v1/ai-providers/accept",
        headers=headers,
        json=replacement_body,
    )
    replay = await client.post(
        "/v1/ai-providers/accept",
        headers=headers,
        json=replacement_body,
    )

    assert replaced.status_code == replay.status_code == 201
    assert replay.json() == replaced.json()
    assert replaced.json()["provider"]["id"] == provider_id
    assert replaced.json()["provider"]["label"] == "Updated provider"
    assert queued == [(seed_user.id, "openai-atomic")]
    assert route_queued == []
    assert "sk-old-secret" not in replaced.text
    assert "sk-new-secret" not in replaced.text
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(AiProvider)
            .where(
                AiProvider.owner_user_id == seed_user.id,
                AiProvider.provider_id == "openai-atomic",
            )
        )
        == 1
    )
    payload = (
        await db_session.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == seed_user.id,
                AiProviderAuthPayload.provider_id == "openai-atomic",
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
    ).scalar_one()
    assert decrypt(payload.encrypted_payload, payload.nonce) == "sk-new-secret"


@pytest.mark.asyncio
async def test_api_key_accept_failed_replace_restores_old_provider_and_credential(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id = seed_user.id
    created = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": "provider-accept-create-before-failure"},
        json=_api_key_accept_body("sk-old-secret"),
    )
    assert created.status_code == 201, created.text
    original_label = created.json()["provider"]["label"]

    replacement_body = _api_key_accept_body("sk-never-committed")
    replacement_body["provider"]["label"] = "Must roll back"
    replacement_body["replace"] = True

    def _fail_idempotency_write(*args, **kwargs):
        raise RuntimeError("forced replace failure")

    monkeypatch.setattr(
        "app.routes.ai_providers.store_platform_response",
        _fail_idempotency_write,
    )
    with pytest.raises(RuntimeError, match="forced replace failure"):
        await client.post(
            "/v1/ai-providers/accept",
            headers={"Idempotency-Key": "provider-accept-replace-failure"},
            json=replacement_body,
        )

    provider = (
        await db_session.execute(
            select(AiProvider).where(
                AiProvider.owner_user_id == user_id,
                AiProvider.provider_id == "openai-atomic",
            )
        )
    ).scalar_one()
    payload = (
        await db_session.execute(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == user_id,
                AiProviderAuthPayload.provider_id == "openai-atomic",
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
    ).scalar_one()
    assert provider.label == original_label
    assert decrypt(payload.encrypted_payload, payload.nonce) == "sk-old-secret"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(PlatformMutationIdempotency)
            .where(
                PlatformMutationIdempotency.operation == "ai_provider.accept",
                PlatformMutationIdempotency.idempotency_key == "provider-accept-replace-failure",
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_canonical_and_legacy_managed_ids_resolve_while_deployment_id_is_hidden(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    internal_provider_id = f"{V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX}42"
    for provider_id in (
        "clawdi-v2",
        internal_provider_id,
    ):
        db_session.add(
            AiProvider(
                owner_user_id=seed_user.id,
                provider_id=provider_id,
                type="custom_openai_compatible",
                base_url="https://managed.example/v1",
                api_mode="openai_chat",
                auth_type="api_key",
                auth_metadata={"source": "managed", "profile": "default"},
                managed_by="clawdi",
                runtime_env_name="CLAWDI_MANAGED_OPENAI_API_KEY",
                models=[{"id": "gpt-5.5"}],
            )
        )
    await db_session.commit()

    listing = await client.get("/v1/ai-providers")
    canonical = await client.get("/v1/ai-providers/clawdi")
    legacy = await client.get("/v1/ai-providers/clawdi-v2")
    internal = await client.get(f"/v1/ai-providers/{internal_provider_id}")
    missing = await client.get("/v1/ai-providers/missing-provider")

    assert listing.status_code == 200, listing.text
    assert [row["provider_id"] for row in listing.json()["providers"]] == ["clawdi"]
    assert "clawdi-v2" not in listing.text
    assert canonical.status_code == 200, canonical.text
    assert canonical.json()["provider_id"] == "clawdi"
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()["provider_id"] == "clawdi"
    assert internal.status_code == missing.status_code == 404
    assert internal.json() == missing.json() == {"detail": "AI Provider not found"}


@pytest.mark.asyncio
async def test_user_ai_provider_list_excludes_deployment_managed_row_and_keeps_byo(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-byo",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    internal_provider_id = v2_deployment_managed_provider_id("42")
    assert internal_provider_id is not None
    internal_provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id=internal_provider_id,
        type="custom_openai_compatible",
        label="Clawdi managed",
        base_url="https://managed.example/v1",
        api_mode="openai_chat",
        auth_type="api_key",
        auth_metadata={"source": "managed", "profile": "default"},
        managed_by="clawdi",
        runtime_env_name=MANAGED_AI_PROVIDER_RUNTIME_ENV,
    )
    db_session.add(internal_provider)
    await db_session.commit()
    await db_session.refresh(internal_provider)

    listing = await client.get("/v1/ai-providers")

    assert listing.status_code == 200, listing.text
    assert [provider["provider_id"] for provider in listing.json()["providers"]] == ["openai-byo"]
    assert internal_provider_id not in listing.text
    assert str(internal_provider.id) not in listing.text

    fetched = await client.get("/v1/ai-providers/openai-byo")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["id"] == created.json()["id"]

    patched = await client.patch(
        "/v1/ai-providers/openai-byo",
        json={"label": "User-owned BYO"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["label"] == "User-owned BYO"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "body"),
    [
        pytest.param("GET", None, id="get"),
        pytest.param("PATCH", {"label": "mutated"}, id="patch"),
        pytest.param("DELETE", None, id="delete"),
    ],
)
async def test_user_ai_provider_item_routes_hide_deployment_managed_row(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    method: str,
    body: dict | None,
):
    internal_provider_id = v2_deployment_managed_provider_id("43")
    assert internal_provider_id is not None
    internal_provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id=internal_provider_id,
        type="custom_openai_compatible",
        label="Clawdi managed",
        base_url="https://managed.example/v1",
        api_mode="openai_chat",
        auth_type="api_key",
        auth_metadata={"source": "managed", "profile": "default"},
        managed_by="clawdi",
        runtime_env_name=MANAGED_AI_PROVIDER_RUNTIME_ENV,
    )
    db_session.add(internal_provider)
    await db_session.commit()

    response = await client.request(
        method,
        f"/v1/ai-providers/{internal_provider_id}",
        json=body,
    )
    missing = await client.request(
        method,
        "/v1/ai-providers/missing-provider",
        json=body,
    )

    assert response.status_code == missing.status_code == 404
    assert response.json() == missing.json() == {"detail": "AI Provider not found"}
    await db_session.refresh(internal_provider)
    assert internal_provider.label == "Clawdi managed"
    assert internal_provider.archived_at is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "body"),
    [
        pytest.param("/{provider_id}/validate", None, id="validate"),
        pytest.param(
            "/{provider_id}/auth/api-key",
            {"value": "sk-must-not-be-written"},
            id="api-key",
        ),
        pytest.param(
            "/{provider_id}/auth/import",
            {
                "type": "agent_profile",
                "tool": "codex",
                "profile": "default",
                "payload": '{"token":"must-not-be-written"}',
            },
            id="import",
        ),
        pytest.param(
            "/{provider_id}/auth/oauth/start",
            {
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
            id="oauth-start",
        ),
        pytest.param(
            "/{provider_id}/auth/oauth/device/start",
            {"provider": "codex"},
            id="oauth-device-start",
        ),
        pytest.param(
            "/{provider_id}/auth/oauth/device/poll",
            {"state": "must-not-be-read"},
            id="oauth-device-poll",
        ),
        pytest.param(
            "/{provider_id}/auth/oauth/complete",
            {
                "state": "must-not-be-read",
                "code": "must-not-be-exchanged",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
            id="oauth-complete",
        ),
        pytest.param(
            "/{provider_id}/auth/resolve",
            {"profile": "default"},
            id="resolve",
        ),
    ],
)
async def test_user_ai_provider_subroutes_hide_deployment_managed_row(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    path: str,
    body: dict | None,
):
    internal_provider_id = v2_deployment_managed_provider_id("45")
    assert internal_provider_id is not None
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id=internal_provider_id,
            type="custom_openai_compatible",
            label="Clawdi managed",
            base_url="https://managed.example/v1",
            api_mode="openai_chat",
            auth_type="api_key",
            auth_metadata={"source": "managed", "profile": "default"},
            managed_by="clawdi",
            runtime_env_name=MANAGED_AI_PROVIDER_RUNTIME_ENV,
        )
    )
    await db_session.commit()

    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_test",
        label="test-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    request_kwargs = {} if body is None else {"json": body}
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        internal = await client.post(
            f"/v1/ai-providers{path.format(provider_id=internal_provider_id)}",
            **request_kwargs,
        )
        missing = await client.post(
            f"/v1/ai-providers{path.format(provider_id='missing-provider')}",
            **request_kwargs,
        )
    finally:
        app.dependency_overrides.pop(get_auth, None)

    assert internal.status_code == missing.status_code == 404
    assert internal.json() == missing.json() == {"detail": "AI Provider not found"}


@pytest.mark.asyncio
async def test_user_ai_provider_upsert_cannot_replace_deployment_managed_row(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    internal_provider_id = v2_deployment_managed_provider_id("44")
    assert internal_provider_id is not None
    internal_provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id=internal_provider_id,
        type="custom_openai_compatible",
        label="Clawdi managed",
        base_url="https://managed.example/v1",
        api_mode="openai_chat",
        auth_type="api_key",
        auth_metadata={"source": "managed", "profile": "default"},
        managed_by="clawdi",
        runtime_env_name=MANAGED_AI_PROVIDER_RUNTIME_ENV,
    )
    db_session.add(internal_provider)
    await db_session.commit()

    response = await client.post(
        "/v1/ai-providers",
        params={"replace": "true"},
        json={
            "provider_id": internal_provider_id,
            "type": "openai",
            "label": "mutated",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "AI Provider not found"}
    await db_session.refresh(internal_provider)
    assert internal_provider.label == "Clawdi managed"
    assert internal_provider.base_url == "https://managed.example/v1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model",
    [
        {"id": "gpt-test", "context_window": 0},
        {"id": "gpt-test", "max_tokens": 0},
        {"id": "gpt-test", "label": ""},
        {"id": "gpt-test", "alias": ""},
        {"id": "gpt-test", "label": None},
        {"id": "gpt-test", "unknown": True},
        {"id": "gpt-test", "capabilities": {"audio": True}},
        {"id": "gpt-test", "capabilities": {"chat": "yes"}},
        {"id": "gpt-test", "capabilities": {"chat": None}},
        {"id": "gpt-test", "cost": {"input": 1, "output": 2, "currency": "USD"}},
        {"id": "gpt-test", "cost": {"input": 1, "output": 2, "cache_read": None}},
    ],
    ids=[
        "zero-context-window",
        "zero-max-tokens",
        "empty-label",
        "empty-alias",
        "null-model-field",
        "unknown-model-field",
        "unknown-capability",
        "non-bool-capability",
        "null-capability",
        "unknown-cost-field",
        "null-cost-field",
    ],
)
async def test_ai_provider_rejects_models_outside_hosted_wire_contract(
    client: httpx.AsyncClient,
    model: dict,
):
    response = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "strict-model-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            "models": [model],
        },
    )

    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_ai_provider_accepts_complete_hosted_model_contract(client: httpx.AsyncClient):
    model = {
        "id": "gpt-test",
        "label": "GPT Test",
        "alias": "gpt-test-stable",
        "api_mode": "openai_responses",
        "input_modalities": ["text", "image", "video", "audio"],
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": False,
        "context_window": 128000,
        "max_tokens": 16384,
        "cost": {"input": 1, "output": 2, "cache_read": 0.1, "cache_write": 0.2},
        "capabilities": {
            "chat": True,
            "responses": True,
            "tools": True,
            "vision": True,
            "embeddings": False,
            "image_generation": False,
        },
    }
    response = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "complete-model-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
            "models": [model],
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["models"] == [model]


@pytest.mark.asyncio
async def test_provider_and_secret_mutations_invalidate_only_bound_runtime(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    env_a = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-event-a-{uuid.uuid4().hex[:8]}",
        machine_name="Provider event A",
        agent_type="openclaw",
    )
    env_b = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"provider-event-b-{uuid.uuid4().hex[:8]}",
        machine_name="Provider event B",
        agent_type="openclaw",
    )
    for env, provider_id in ((env_a, "openai-main"), (env_b, "anthropic-main")):
        db_session.add(
            HostedRuntimeState(
                environment_id=env.id,
                deployment_id=f"dep-{provider_id}",
                instance_id=f"hri-{provider_id}",
                generation=1,
                cli_package_spec="clawdi@0.12.10-beta.57",
                locale={"language": "en", "timezone": "UTC"},
                system=_TEST_SYSTEM,
                live_sync={"enabled": False, "agents": []},
                recovery={"cacheManifest": True, "allowOfflineBoot": True},
                runtimes={
                    "openclaw": {
                        "enabled": True,
                        "providerMode": "configured",
                        "provider_ids": [provider_id],
                        "primary_model": {"provider_id": provider_id, "model": "test-model"},
                        "install": {"source": "official"},
                    }
                },
            )
        )
    await db_session.commit()

    q_a = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env_a.id)
    q_b = sync_events.subscribe(seed_user.id, frozenset(), environment_id=env_b.id)
    try:
        created = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": "openai-main",
                "type": "openai",
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "api_key", "source": "managed"},
                "runtime_env_name": "OPENAI_API_KEY",
            },
        )
        assert created.status_code == 200, created.text
        assert q_a.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env_a.id),
        }
        assert q_b.empty()

        presentation_only = await client.patch(
            "/v1/ai-providers/openai-main",
            json={
                "label": "OpenAI presentation label",
                "capabilities": {"chat": True},
            },
        )
        assert presentation_only.status_code == 200, presentation_only.text
        assert q_a.empty()
        assert q_b.empty()

        rotated = await client.post(
            "/v1/ai-providers/openai-main/auth/api-key",
            json={"value": "sk-rotated", "runtime_env_name": "OPENAI_API_KEY"},
        )
        assert rotated.status_code == 200, rotated.text
        assert q_a.get_nowait() == {
            "type": "runtime_manifest_changed",
            "environment_id": str(env_a.id),
        }
        assert q_b.empty()
    finally:
        sync_events.unsubscribe(seed_user.id, q_a)
        sync_events.unsubscribe(seed_user.id, q_b)


@pytest.mark.asyncio
async def test_ai_provider_accepts_catalog_derived_known_provider_bodies(
    client: httpx.AsyncClient,
):
    known = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-derived",
            "type": "openai",
            "label": "OpenAI",
            "base_url": "https://api.openai.com/v1",
            "models": [{"id": "gpt-5.5"}, {"id": "gpt-5.4"}, {"id": "gpt-5.4-mini"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "user",
            "runtime_env_name": "OPENAI_API_KEY",
        },
    )
    assert known.status_code == 200, known.text
    assert known.json()["provider_id"] == "openai-derived"
    assert known.json()["runtime_env_name"] == "OPENAI_API_KEY"
    assert known.json()["models"] == [
        {"id": "gpt-5.5"},
        {"id": "gpt-5.4"},
        {"id": "gpt-5.4-mini"},
    ]

    codex = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "label": "Codex (ChatGPT)",
            "base_url": "https://api.openai.com/v1",
            "models": [
                {"id": "gpt-5.5"},
                {"id": "gpt-5.4"},
                {"id": "gpt-5.3-codex"},
                {"id": "gpt-5.4-mini"},
            ],
            "api_mode": "openai_responses",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
            "managed_by": "user",
        },
    )
    assert codex.status_code == 200, codex.text
    assert codex.json()["provider_id"] == "openai-codex"
    assert codex.json()["auth"] == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider_id", "auth"), _VALID_AUTH_VARIANTS)
async def test_ai_provider_auth_variants_round_trip_through_upsert_and_patch(
    client: httpx.AsyncClient,
    provider_id: str,
    auth: dict,
):
    provider = {
        "provider_id": f"auth-{provider_id}",
        "type": "custom_openai_compatible",
        "base_url": "http://127.0.0.1:1234/v1",
        "api_mode": "openai_chat",
        "auth": auth,
    }

    created = await client.post("/v1/ai-providers", json=provider)
    assert created.status_code == 200, created.text
    assert created.json()["auth"] == auth

    fetched = await client.get(f"/v1/ai-providers/auth-{provider_id}")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["auth"] == auth

    label_patch = await client.patch(
        f"/v1/ai-providers/auth-{provider_id}",
        json={"label": "Preserve auth"},
    )
    assert label_patch.status_code == 200, label_patch.text
    assert label_patch.json()["auth"] == auth

    auth_patch = await client.patch(
        f"/v1/ai-providers/auth-{provider_id}",
        json={"auth": auth},
    )
    assert auth_patch.status_code == 200, auth_patch.text
    assert auth_patch.json()["auth"] == auth


@pytest.mark.asyncio
async def test_ai_provider_patch_preserves_persisted_oauth_auth_when_auth_is_omitted(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="persisted-oauth",
        type="openai",
        label="Before",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        auth_type="oauth_profile",
        auth_metadata={
            "provider": "codex",
            "profile": "default",
            "source": "oauth_pkce",
        },
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.commit()

    patched = await client.patch(
        "/v1/ai-providers/persisted-oauth",
        json={"label": "After"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["label"] == "After"
    assert patched.json()["auth"] == {
        "type": "oauth_profile",
        "provider": "codex",
        "profile": "default",
    }
    await db_session.refresh(provider)
    assert provider.auth_metadata == {
        "provider": "codex",
        "profile": "default",
        "source": "oauth_pkce",
    }

    explicit_oauth = await client.patch(
        "/v1/ai-providers/persisted-oauth",
        json={
            "auth": {
                "type": "oauth_profile",
                "provider": "codex",
                "profile": "default",
            }
        },
    )
    assert explicit_oauth.status_code == 422, explicit_oauth.text


@pytest.mark.asyncio
async def test_metadata_auth_transitions_never_reactivate_api_key_or_oauth_material(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    body = _api_key_accept_body("sk-transition-api-key")
    body["provider"]["provider_id"] = "openai-transition-invalidation"
    accepted = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": "provider-transition-invalidation"},
        json=body,
    )
    assert accepted.status_code == 201, accepted.text

    to_oauth_metadata = await client.patch(
        "/v1/ai-providers/openai-transition-invalidation",
        json={"auth": {"type": "agent_profile", "tool": "codex", "profile": "default"}},
    )
    assert to_oauth_metadata.status_code == 200, to_oauth_metadata.text
    assert to_oauth_metadata.json()["usable"] is False
    imported = await client.post(
        "/v1/ai-providers/openai-transition-invalidation/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": _codex_oauth_envelope("transition-access", "transition-refresh"),
        },
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["usable"] is True

    to_api_metadata = await client.patch(
        "/v1/ai-providers/openai-transition-invalidation",
        json={"auth": {"type": "api_key", "source": "managed", "profile": "default"}},
    )
    assert to_api_metadata.status_code == 200, to_api_metadata.text
    assert to_api_metadata.json()["usable"] is False
    back_to_oauth_metadata = await client.patch(
        "/v1/ai-providers/openai-transition-invalidation",
        json={"auth": {"type": "agent_profile", "tool": "codex", "profile": "default"}},
    )
    assert back_to_oauth_metadata.status_code == 200, back_to_oauth_metadata.text
    assert back_to_oauth_metadata.json()["usable"] is False

    active_payloads = list(
        (
            await db_session.execute(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id == seed_user.id,
                    AiProviderAuthPayload.provider_id == "openai-transition-invalidation",
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    assert active_payloads == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "auth_metadata",
    [{}, {"source": "unknown"}],
    ids=["missing-source", "unknown-source"],
)
async def test_ai_provider_rejects_invalid_persisted_api_key_source(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    auth_metadata: dict,
):
    db_session.add(
        AiProvider(
            owner_user_id=seed_user.id,
            provider_id="invalid-persisted-source",
            type="openai",
            base_url="https://api.openai.com/v1",
            api_mode="openai_responses",
            auth_type="api_key",
            auth_metadata=auth_metadata,
            managed_by="user",
        )
    )
    await db_session.commit()

    response = await client.get("/v1/ai-providers/invalid-persisted-source")

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Stored AI provider auth metadata is invalid"


@pytest.mark.asyncio
@pytest.mark.parametrize("auth", _INVALID_AUTH_VARIANTS)
async def test_ai_provider_auth_variants_reject_cross_fields_on_upsert_and_patch(
    client: httpx.AsyncClient,
    auth: dict,
):
    provider = {
        "provider_id": "strict-auth-provider",
        "type": "custom_openai_compatible",
        "base_url": "http://127.0.0.1:1234/v1",
        "api_mode": "openai_chat",
        "auth": auth,
    }

    rejected_upsert = await client.post("/v1/ai-providers", json=provider)
    assert rejected_upsert.status_code == 422, rejected_upsert.text
    assert "sk-should-not-be-here" not in rejected_upsert.text

    provider["auth"] = {"type": "none"}
    created = await client.post("/v1/ai-providers", json=provider)
    assert created.status_code == 200, created.text

    rejected_patch = await client.patch(
        "/v1/ai-providers/strict-auth-provider",
        json={"auth": auth},
    )
    assert rejected_patch.status_code == 422, rejected_patch.text
    assert "sk-should-not-be-here" not in rejected_patch.text

    fetched = await client.get("/v1/ai-providers/strict-auth-provider")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["auth"] == {"type": "none"}


@pytest.mark.asyncio
async def test_ai_provider_rejects_invalid_auth_and_api_mode(client: httpx.AsyncClient):
    invalid_mode = await client.post(
        "/v1/ai-providers",
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

    codex_responses_mode = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "custom-openai",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "gpt-5.5"}],
            "api_mode": "codex_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "user",
            "runtime_env_name": "CUSTOM_OPENAI_API_KEY",
        },
    )
    assert codex_responses_mode.status_code == 422, codex_responses_mode.text
    assert "codex_responses" in codex_responses_mode.text

    legacy_model_prefix = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "legacy-model",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "openai-codex/gpt-5.5"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "user",
            "runtime_env_name": "CUSTOM_OPENAI_API_KEY",
        },
    )
    assert legacy_model_prefix.status_code == 422, legacy_model_prefix.text
    assert "legacy openai-codex prefix" in legacy_model_prefix.text

    for managed_provider_id in (
        V2_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
        V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    ):
        managed = await client.post(
            "/v1/ai-providers?replace=true",
            json={
                "provider_id": managed_provider_id,
                "type": "custom_openai_compatible",
                "base_url": "https://managed.example/v1",
                "models": [{"id": "gpt-5.5"}],
                "api_mode": "openai_chat",
                "auth": {"type": "api_key", "source": "managed"},
                "managed_by": "clawdi",
                "runtime_env_name": "CLAWDI_MANAGED_OPENAI_API_KEY",
            },
        )
        assert managed.status_code == 200, managed.text
        assert managed.json()["provider_id"] == CLAWDI_MANAGED_PROVIDER_ID
        assert managed.json()["api_mode"] == "openai_chat"
        assert managed.json()["models"] == [{"id": "gpt-5.5"}]

    v1_managed = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "clawdi-managed",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "openai-codex/gpt-5.5"}],
            "api_mode": "openai_responses",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "clawdi",
            "runtime_env_name": "CLAWDI_MANAGED_OPENAI_API_KEY",
        },
    )
    assert v1_managed.status_code == 200, v1_managed.text
    assert v1_managed.json()["provider_id"] == "clawdi-managed"
    assert v1_managed.json()["api_mode"] == "openai_responses"

    v1_managed_wrong_mode = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "clawdi-managed",
            "type": "custom_openai_compatible",
            "base_url": "https://managed.example/v1",
            "models": [{"id": "openai-codex/gpt-5.5"}],
            "api_mode": "openai_chat",
            "auth": {"type": "api_key", "source": "managed"},
            "managed_by": "clawdi",
            "runtime_env_name": "CLAWDI_MANAGED_OPENAI_API_KEY",
        },
    )
    assert v1_managed_wrong_mode.status_code == 422, v1_managed_wrong_mode.text
    assert "must use api_mode openai_responses" in v1_managed_wrong_mode.text

    unsupported_agent_profile = await client.post(
        "/v1/ai-providers",
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

    public_no_auth = await client.post(
        "/v1/ai-providers",
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
            "/v1/ai-providers",
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
async def test_ai_provider_rejects_malformed_ipv6_url_without_server_error(
    client: httpx.AsyncClient,
):
    response = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "invalid-ipv6",
            "type": "custom_openai_compatible",
            "base_url": "https://[2001:db8::1",
            "api_mode": "openai_chat",
            "auth": {"type": "api_key", "source": "managed"},
            "runtime_env_name": "INVALID_IPV6_KEY",
        },
    )

    assert response.status_code == 422, response.text
    assert response.json() == {"detail": {"errors": ["base_url must be an http(s) URL"]}}


@pytest.mark.asyncio
async def test_ai_provider_rejects_runtime_env_collisions_in_active_user_pool(
    client: httpx.AsyncClient,
):
    first = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-one",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:SHARED_PROVIDER_KEY"},
            "runtime_env_name": "SHARED_PROVIDER_KEY",
        },
    )
    second = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-two",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "api_key", "source": "managed"},
            "runtime_env_name": "SHARED_PROVIDER_KEY",
        },
    )
    native_profile = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "codex-native",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
            "runtime_env_name": "SHARED_PROVIDER_KEY",
        },
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 409, second.text
    assert second.json() == {"detail": "runtime_env_name is already used by another AI Provider"}
    assert native_profile.status_code == 200, native_profile.text


@pytest.mark.asyncio
async def test_ai_provider_readiness_separates_material_runtime_and_verification(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "gemini-readiness",
            "type": "gemini",
            "base_url": "https://generativelanguage.googleapis.com/v1beta",
            "api_mode": "google_generate_content",
            "auth": {"type": "api_key", "source": "managed"},
            "runtime_env_name": "GEMINI_READINESS_KEY",
            "models": [{"id": "gemini-2.5-pro"}],
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["usable"] is False
    assert created.json()["readiness"] == {
        "credential_material": "missing",
        "runtime_compatibility": {
            "openclaw": True,
            "hermes": False,
            "codex": False,
        },
        "deployable": False,
        "endpoint_reachability": "not_tested",
        "inference_verification": "not_tested",
    }

    stored = await client.post(
        "/v1/ai-providers/gemini-readiness/auth/api-key",
        json={"value": "gemini-secret"},
    )
    assert stored.status_code == 200, stored.text
    assert stored.json()["usable"] is True
    assert stored.json()["readiness"]["credential_material"] == "available"
    assert stored.json()["readiness"]["deployable"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "body"),
    [
        pytest.param(
            "/v1/ai-providers/accept",
            {
                **_api_key_accept_body("   "),
                "replace": True,
            },
            id="accept",
        ),
        pytest.param(
            "/v1/ai-providers/openai-blank/auth/api-key",
            {"value": "\t\n"},
            id="auth-api-key",
        ),
        pytest.param(
            "/v1/ai-providers/openai-blank/auth/import",
            {
                "type": "agent_profile",
                "tool": "codex",
                "profile": "default",
                "payload": "  \t",
            },
            id="auth-import",
        ),
    ],
)
async def test_ai_provider_rejects_blank_credentials_at_the_boundary(
    client: httpx.AsyncClient,
    path: str,
    body: dict,
):
    if "openai-blank" in path:
        created = await client.post(
            "/v1/ai-providers",
            json={
                "provider_id": "openai-blank",
                "type": "openai",
                "base_url": "https://api.openai.com/v1",
                "auth": {"type": "api_key", "source": "managed"},
                "runtime_env_name": "OPENAI_BLANK_KEY",
            },
        )
        assert created.status_code == 200, created.text
    headers = {"Idempotency-Key": "blank-credential"} if path.endswith("/accept") else {}
    response = await client.post(path, headers=headers, json=body)

    assert response.status_code == 422, response.text
    assert "credential" in response.text.lower()
    assert "input_value" not in response.text


@pytest.mark.asyncio
async def test_ai_provider_managed_api_key_is_redacted(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    updated = await client.post(
        "/v1/ai-providers/openai-main/auth/api-key",
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
        "profile": "default",
    }
    assert body["runtime_env_name"] == "OPENAI_API_KEY"


@pytest.mark.asyncio
async def test_ai_provider_imports_agent_profile_payload_without_echo(client: httpx.AsyncClient):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    imported = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
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
        "/v1/ai-providers/openai-codex/auth/import",
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
        "/v1/ai-providers/openai-codex/auth/import",
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
async def test_ai_provider_reimport_same_oauth_envelope_does_not_revoke_active_token(
    client: httpx.AsyncClient,
    db_session,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex-reimport",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    envelope = _codex_oauth_envelope("same-access", "same-refresh")
    request = {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
        "payload": envelope,
    }

    first = await client.post(
        "/v1/ai-providers/openai-codex-reimport/auth/import",
        json=request,
    )
    second = await client.post(
        "/v1/ai-providers/openai-codex-reimport/auth/import",
        json=request,
    )

    assert first.status_code == second.status_code == 200
    assert "same-refresh" not in first.text
    assert "same-refresh" not in second.text
    assert (
        await db_session.scalar(select(func.count()).select_from(AiProviderOAuthRevokeTombstone))
        == 0
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        pytest.param(
            {
                "type": "agent_profile",
                "tool": "codex",
                "provider": "codex",
                "profile": "default",
                "payload": "agent-import-secret",
            },
            id="agent-profile-with-provider",
        ),
        pytest.param(
            {
                "type": "oauth_profile",
                "provider": "codex",
                "tool": "codex",
                "profile": "default",
                "payload": "oauth-import-secret",
            },
            id="oauth-profile-with-tool",
        ),
        pytest.param(
            {
                "type": "agent_profile",
                "profile": "default",
                "payload": "missing-tool-secret",
            },
            id="agent-profile-missing-tool",
        ),
        pytest.param(
            {
                "type": "oauth_profile",
                "profile": "default",
                "payload": "missing-provider-secret",
            },
            id="oauth-profile-missing-provider",
        ),
    ],
)
async def test_ai_provider_auth_import_variants_reject_cross_fields_without_echo(
    client: httpx.AsyncClient,
    body: dict,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "strict-import-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    response = await client.post(
        "/v1/ai-providers/strict-import-provider/auth/import",
        json=body,
    )

    assert response.status_code == 422, response.text
    assert body["payload"] not in response.text


@pytest.mark.asyncio
async def test_ai_provider_resolve_uses_only_active_auth_profile(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    consumer = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="codex-active-profile-consumer",
        machine_name="Codex active profile consumer",
        agent_type="codex",
    )
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    first = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": '{"token":"old"}',
        },
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        "/v1/ai-providers/openai-codex/auth/import",
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
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(consumer.id),
                "consumer_runtime": "codex",
            },
        )
        assert old_profile.status_code == 404, old_profile.text

        active_profile = await client.post(
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={
                "profile": "work_team",
                "environment_id": str(consumer.id),
                "consumer_runtime": "codex",
            },
        )
        assert active_profile.status_code == 200, active_profile.text
        assert active_profile.json()["payload"] == '{"token":"active"}'
    finally:
        app.dependency_overrides.pop(get_auth, None)


@pytest.mark.asyncio
async def test_ai_provider_codex_profiles_are_scoped_by_provider_id(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    consumer = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="codex-provider-profile-consumer",
        machine_name="Codex provider profile consumer",
        agent_type="codex",
    )
    for provider_id, label, payload in [
        ("openai-codex-work", "Work Codex", '{"token":"work"}'),
        ("openai-codex-personal", "Personal Codex", '{"token":"personal"}'),
    ]:
        created = await client.post(
            "/v1/ai-providers",
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
            f"/v1/ai-providers/{provider_id}/auth/import",
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
            "/v1/ai-providers/openai-codex-work/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(consumer.id),
                "consumer_runtime": "codex",
            },
        )
        personal = await client.post(
            "/v1/ai-providers/openai-codex-personal/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(consumer.id),
                "consumer_runtime": "codex",
            },
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
        "/v1/ai-providers",
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
                "redirect_uri": "https://cloud.example/oauth/callback",
                "scope": "openid profile",
            }
        }
    )
    try:
        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        mismatched_redirect = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://attacker.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert started.status_code == 200, started.text
    assert mismatched_redirect.status_code == 422, mismatched_redirect.text
    assert "server-registered" in mismatched_redirect.text
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
        "/v1/ai-providers",
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
            "/v1/ai-providers/openai-codex/auth/oauth/start",
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
async def test_ai_provider_oauth_start_rejects_web_redirect_for_official_codex_client(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/v1/ai-providers",
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
    settings.web_origin = "http://dev.clawdi.test:33221"
    settings.cors_origins = ["http://localhost:33221"]
    try:
        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://dev.clawdi.test:33221/onboarding?step=provider&provider_oauth=codex",
            },
        )
        wrong_port = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "http://dev.clawdi.test:33222/onboarding?step=provider&provider_oauth=codex",
            },
        )
    finally:
        settings.environment = previous_environment
        settings.web_origin = previous_web_origin
        settings.cors_origins = previous_cors_origins

    assert started.status_code == 422, started.text
    assert wrong_port.status_code == 422, wrong_port.text
    assert "loopback" in started.text


@pytest.mark.asyncio
async def test_ai_provider_oauth_start_requires_clean_redirect_and_params(
    client: httpx.AsyncClient,
):
    created = await client.post(
        "/v1/ai-providers",
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
            "/v1/ai-providers/openai-codex/auth/oauth/start",
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
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert reserved_override.status_code == 503, reserved_override.text
        assert "cannot override state" in reserved_override.text

        unsupported_provider = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
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
async def test_oauth_reconnect_start_keeps_current_credential_active(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    provider_id = "openai-codex-reconnect-start"
    owner_user_id = seed_user.id
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    imported = await client.post(
        f"/v1/ai-providers/{provider_id}/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": _codex_oauth_envelope("old-access", "old-refresh"),
        },
    )
    assert imported.status_code == 200, imported.text
    before = await db_session.scalar(
        select(AiProviderAuthPayload).where(
            AiProviderAuthPayload.owner_user_id == owner_user_id,
            AiProviderAuthPayload.provider_id == provider_id,
            AiProviderAuthPayload.auth_profile == "default",
        )
    )
    assert before is not None
    old_revision = before.credential_revision
    old_ciphertext = before.encrypted_payload

    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    started = await client.post(
        f"/v1/ai-providers/{provider_id}/auth/oauth/start",
        json={"provider": "codex"},
    )

    assert started.status_code == 200, started.text
    await db_session.refresh(before)
    after = before
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == owner_user_id,
            AiProvider.provider_id == provider_id,
        )
    )
    assert after is not None
    assert provider is not None
    assert after.archived_at is None
    assert after.credential_revision == old_revision
    assert after.encrypted_payload == old_ciphertext
    assert decrypt(after.encrypted_payload, after.nonce) == _codex_oauth_envelope(
        "old-access", "old-refresh"
    )
    assert provider.auth_type == "agent_profile"
    assert provider.auth_metadata == {"tool": "codex", "profile": "default"}
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(AiProviderOAuthRevokeTombstone)
            .where(AiProviderOAuthRevokeTombstone.owner_user_id == owner_user_id)
        )
        == 0
    )

    class FakeOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            if data["grant_type"] == "authorization_code":
                return httpx.Response(
                    200,
                    json={
                        "id_token": _test_jwt(),
                        "access_token": "new-access",
                        "refresh_token": "new-refresh",
                    },
                )
            return httpx.Response(200, json={"access_token": "sk-new"})

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    try:
        completed = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "reconnect-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert completed.status_code == 200, completed.text
    await db_session.refresh(before)
    active = before
    assert active is not None
    assert active.credential_revision != old_revision
    assert "new-refresh" in decrypt(active.encrypted_payload, active.nonce)
    tombstones = list(
        (
            await db_session.execute(
                select(AiProviderOAuthRevokeTombstone).where(
                    AiProviderOAuthRevokeTombstone.owner_user_id == owner_user_id,
                    AiProviderOAuthRevokeTombstone.provider_id == provider_id,
                )
            )
        ).scalars()
    )
    by_digest = {row.token_sha256: row for row in tombstones}
    old_digest = hashlib.sha256(b"old-refresh").hexdigest()
    new_digest = hashlib.sha256(b"new-refresh").hexdigest()
    assert by_digest[old_digest].status == "pending"
    assert by_digest[old_digest].encrypted_token is not None
    assert b"old-refresh" not in by_digest[old_digest].encrypted_token
    assert by_digest[new_digest].status == "cancelled"
    assert by_digest[new_digest].encrypted_token is None


@pytest.mark.asyncio
@pytest.mark.parametrize("tombstone_state", ["pending", "processing", "revoked"])
async def test_same_token_delete_reconnect_cannot_adopt_revoke_tombstone(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
    tombstone_state: str,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    provider_id = f"openai-codex-same-token-{tombstone_state}"
    owner_user_id = seed_user.id
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    imported = await client.post(
        f"/v1/ai-providers/{provider_id}/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": _codex_oauth_envelope("same-access", "same-refresh"),
        },
    )
    assert imported.status_code == 200, imported.text
    deleted = await client.delete(f"/v1/ai-providers/{provider_id}")
    assert deleted.status_code == 200, deleted.text
    tombstone = await db_session.scalar(
        select(AiProviderOAuthRevokeTombstone).where(
            AiProviderOAuthRevokeTombstone.owner_user_id == owner_user_id,
            AiProviderOAuthRevokeTombstone.provider_id == provider_id,
        )
    )
    assert tombstone is not None
    tombstone_id = tombstone.id
    claim = None
    if tombstone_state != "pending":
        claim = await claim_oauth_revoke_tombstone(
            db_session,
            now=datetime.now(UTC) + timedelta(seconds=1),
        )
        assert claim is not None
        await db_session.commit()
    if tombstone_state == "revoked":
        assert claim is not None
        assert await record_oauth_revoke_result(
            db_session,
            claim=claim,
            revoked=True,
        )
        await db_session.commit()

    recreated = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert recreated.status_code == 200, recreated.text
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )

    class SameTokenOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            if data["grant_type"] == "authorization_code":
                return httpx.Response(
                    200,
                    json={
                        "id_token": _test_jwt(),
                        "access_token": "same-access",
                        "refresh_token": "same-refresh",
                    },
                )
            return httpx.Response(200, json={"access_token": "sk-same-token"})

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", SameTokenOAuthClient)
    try:
        started = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert started.status_code == 200, started.text
        completed = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "same-token-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert completed.status_code == 409, completed.text
    assert "compensation already started" in completed.text
    db_session.expire_all()
    tombstone = await db_session.get(AiProviderOAuthRevokeTombstone, tombstone_id)
    assert tombstone is not None
    assert tombstone.status == tombstone_state
    assert tombstone.oauth_attempt_id is None
    assert (tombstone.encrypted_token is None) == (tombstone_state == "revoked")
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(AiProviderAuthPayload)
            .where(
                AiProviderAuthPayload.owner_user_id == owner_user_id,
                AiProviderAuthPayload.provider_id == provider_id,
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
        == 0
    )
    attempt = await db_session.scalar(
        select(AiProviderOAuthAttempt).where(
            AiProviderOAuthAttempt.state_sha256
            == hashlib.sha256(started.json()["state"].encode()).hexdigest()
        )
    )
    assert attempt is not None
    assert attempt.status == "failed"


@pytest.mark.asyncio
async def test_oauth_reverse_completion_and_expired_committed_receipt_replay(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    provider_id = "openai-codex-reverse"
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
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
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    requests: list[dict] = []

    class FakeOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            requests.append({"url": url, "data": data})
            if data["grant_type"] == "authorization_code":
                return httpx.Response(
                    200,
                    json={
                        "id_token": _test_jwt(),
                        "access_token": "reverse-access",
                        "refresh_token": "reverse-refresh",
                    },
                )
            return httpx.Response(200, json={"access_token": "sk-reverse"})

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    try:
        first = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        second = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert first.status_code == second.status_code == 200
        stale = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": first.json()["state"],
                "code": "first-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert stale.status_code == 409, stale.text
        assert requests == []
        completed = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": second.json()["state"],
                "code": "second-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert completed.status_code == 200, completed.text
        stale_after_commit = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": first.json()["state"],
                "code": "first-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert stale_after_commit.status_code == 409, stale_after_commit.text
        assert len(requests) == 2

        attempt = await db_session.scalar(
            select(AiProviderOAuthAttempt).where(
                AiProviderOAuthAttempt.state_sha256
                == hashlib.sha256(second.json()["state"].encode()).hexdigest()
            )
        )
        assert attempt is not None
        assert attempt.status == "committed"
        assert "reverse-access" not in json.dumps(attempt.receipt)
        assert "reverse-refresh" not in json.dumps(attempt.receipt)
        attempt.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db_session.commit()

        replay = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": second.json()["state"],
                "code": "second-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert replay.status_code == 200, replay.text
    assert replay.json() == completed.json()
    assert len(requests) == 2
    tombstone = await db_session.scalar(
        select(AiProviderOAuthRevokeTombstone).where(
            AiProviderOAuthRevokeTombstone.owner_user_id == seed_user.id,
            AiProviderOAuthRevokeTombstone.provider_id == provider_id,
        )
    )
    assert tombstone is not None
    assert tombstone.status == "cancelled"
    assert tombstone.encrypted_token is None
    assert tombstone.token_nonce is None


@pytest.mark.asyncio
async def test_stale_exchanging_oauth_attempt_is_fenced_without_reexchange(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    provider_id = "openai-codex-stale-exchange"
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
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
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    connection = await db_session.connection()
    short_sessions = async_sessionmaker(
        bind=connection,
        expire_on_commit=True,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(ai_provider_routes, "async_session_factory", short_sessions)
    network_calls = 0

    class NoNetworkClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            nonlocal network_calls
            network_calls += 1
            raise AssertionError("stale exchange must not be replayed")

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", NoNetworkClient)
    try:
        started = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert started.status_code == 200, started.text
        decode_calls = 0
        original_decode = ai_provider_routes._decode_oauth_state

        def counting_decode(state: str):
            nonlocal decode_calls
            decode_calls += 1
            return original_decode(state)

        monkeypatch.setattr(ai_provider_routes, "_decode_oauth_state", counting_decode)
        attempt_id, replay = await ai_provider_routes._begin_oauth_attempt_exchange(
            owner_user_id=seed_user.id,
            provider_id=provider_id,
            state=started.json()["state"],
            flow_kind="authorization_code",
            payload_updates={
                "authorization_code": "one-time-code",
                "requested_redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert replay is None
        assert decode_calls == 1
        attempt = await db_session.get(AiProviderOAuthAttempt, attempt_id)
        assert attempt is not None
        attempt.exchange_started_at = datetime.now(UTC) - timedelta(
            seconds=ai_provider_routes.OAUTH_EXCHANGE_STALE_SECONDS + 1
        )
        await db_session.commit()

        retried = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "one-time-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert retried.status_code == 409, retried.text
    assert "start sign-in again" in retried.text
    assert network_calls == 0
    db_session.expire_all()
    attempt = await db_session.get(AiProviderOAuthAttempt, attempt_id)
    assert attempt is not None
    assert attempt.status == "failed"


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_stale_exchange_revoke_claim_fences_original_commit(
    client: httpx.AsyncClient,
    engine,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    provider_id = "openai-codex-stale-worker-race"
    owner_user_id = seed_user.id
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous_config = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    payload_build_started = asyncio.Event()
    release_payload_build = asyncio.Event()
    revoke_started = asyncio.Event()
    release_revoke = asyncio.Event()

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
                    "access_token": "stale-race-access",
                    "refresh_token": "stale-race-refresh",
                },
            )

    async def blocking_payload_build(*args, **kwargs):
        payload_build_started.set()
        await release_payload_build.wait()
        return (
            _codex_oauth_envelope("stale-race-access", "stale-race-refresh"),
            "agent_profile",
            {"tool": "codex", "profile": "default", "source": "oauth_pkce"},
        )

    session_factory = async_sessionmaker(engine, expire_on_commit=True)

    async def _independent_session():
        async with session_factory() as session:
            yield session

    async def blocking_revoke(claim):
        assert claim.token == "stale-race-refresh"
        revoke_started.set()
        await release_revoke.wait()

    previous_get_session = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = _independent_session
    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    monkeypatch.setattr(
        "app.routes.ai_providers._oauth_payload_from_token_response",
        blocking_payload_build,
    )
    completion_task = None
    worker_task = None
    try:
        started = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert started.status_code == 200, started.text
        async with session_factory() as lookup:
            started_attempt = await lookup.scalar(
                select(AiProviderOAuthAttempt).where(
                    AiProviderOAuthAttempt.state_sha256
                    == hashlib.sha256(started.json()["state"].encode()).hexdigest()
                )
            )
            assert started_attempt is not None
            flow_id = started_attempt.flow_id
        completion_task = asyncio.create_task(
            client.post(
                f"/v1/ai-providers/{provider_id}/auth/oauth/complete",
                json={
                    "state": started.json()["state"],
                    "code": "stale-worker-race-code",
                    "redirect_uri": "https://cloud.example/oauth/callback",
                },
            )
        )
        await asyncio.wait_for(payload_build_started.wait(), timeout=2)

        async with session_factory() as aging:
            attempt = await aging.scalar(
                select(AiProviderOAuthAttempt)
                .where(AiProviderOAuthAttempt.flow_id == flow_id)
                .with_for_update()
            )
            assert attempt is not None
            attempt.exchange_started_at = datetime.now(UTC) - timedelta(
                seconds=OAUTH_REVOKE_ATTEMPT_STALE_SECONDS + 1
            )
            await aging.commit()

        worker = AiProviderOAuthRevokeWorker(session_factory, revoke=blocking_revoke)
        worker_task = asyncio.create_task(worker.run_once())
        await asyncio.wait_for(revoke_started.wait(), timeout=2)
        release_payload_build.set()
        completed = await asyncio.wait_for(completion_task, timeout=2)
        assert completed.status_code == 409, completed.text

        async with session_factory() as verification:
            attempt = await verification.scalar(
                select(AiProviderOAuthAttempt).where(AiProviderOAuthAttempt.flow_id == flow_id)
            )
            tombstones = list(
                (
                    await verification.execute(
                        select(AiProviderOAuthRevokeTombstone).where(
                            AiProviderOAuthRevokeTombstone.owner_user_id == owner_user_id,
                            AiProviderOAuthRevokeTombstone.provider_id == provider_id,
                        )
                    )
                ).scalars()
            )
            active_payload_count = await verification.scalar(
                select(func.count())
                .select_from(AiProviderAuthPayload)
                .where(
                    AiProviderAuthPayload.owner_user_id == owner_user_id,
                    AiProviderAuthPayload.provider_id == provider_id,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        assert attempt is not None
        assert attempt.status == "failed"
        assert active_payload_count == 0
        assert len(tombstones) == 1
        assert tombstones[0].status == "processing"
        assert tombstones[0].oauth_attempt_id == attempt.id
        assert tombstones[0].encrypted_token is not None

        release_revoke.set()
        assert await asyncio.wait_for(worker_task, timeout=2) == tombstones[0].id
        async with session_factory() as verification:
            tombstone = await verification.get(
                AiProviderOAuthRevokeTombstone,
                tombstones[0].id,
            )
            assert tombstone is not None
            assert tombstone.status == "revoked"
            assert tombstone.encrypted_token is None
            assert tombstone.token_nonce is None
    finally:
        release_payload_build.set()
        release_revoke.set()
        if completion_task is not None and not completion_task.done():
            completion_task.cancel()
        if worker_task is not None and not worker_task.done():
            worker_task.cancel()
        app.dependency_overrides[get_session] = previous_get_session
        settings.ai_provider_oauth_config_json = previous_config


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_oauth_commit_and_new_start_follow_provider_attempt_lock_order(
    client: httpx.AsyncClient,
    engine,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    provider_id = "openai-codex-commit-start-order"
    auth = AuthContext(user=seed_user)
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    imported = await client.post(
        f"/v1/ai-providers/{provider_id}/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": _codex_oauth_envelope("old-order-access", "old-order-refresh"),
        },
    )
    assert imported.status_code == 200, imported.text
    previous_config = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=True)

    async def _independent_session():
        async with session_factory() as session:
            yield session

    previous_get_session = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = _independent_session
    transition_started = asyncio.Event()
    release_transition = asyncio.Event()
    original_transition = ai_provider_routes.transition_ai_provider_auth

    async def blocking_transition(*args, **kwargs):
        transition_started.set()
        await release_transition.wait()
        return await original_transition(*args, **kwargs)

    monkeypatch.setattr(ai_provider_routes, "transition_ai_provider_auth", blocking_transition)
    commit_task = None
    start_task = None
    try:
        started_a = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert started_a.status_code == 200, started_a.text
        attempt_a_id, replay = await ai_provider_routes._begin_oauth_attempt_exchange(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            state=started_a.json()["state"],
            flow_kind="authorization_code",
            payload_updates={
                "authorization_code": "commit-start-order-code",
                "requested_redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert replay is None
        commit_task = asyncio.create_task(
            ai_provider_routes._commit_oauth_attempt(
                attempt_id=attempt_a_id,
                auth=auth,
                provider_auth_type="agent_profile",
                payload_text=_codex_oauth_envelope(
                    "new-order-access",
                    "new-order-refresh",
                ),
                metadata={"tool": "codex", "profile": "default", "source": "oauth_pkce"},
                compensation=None,
            )
        )
        await asyncio.wait_for(transition_started.wait(), timeout=2)
        start_task = asyncio.create_task(
            client.post(
                f"/v1/ai-providers/{provider_id}/auth/oauth/start",
                json={"provider": "codex"},
            )
        )
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(start_task), timeout=0.05)
        release_transition.set()
        committed, started_b = await asyncio.wait_for(
            asyncio.gather(commit_task, start_task),
            timeout=2,
        )
        assert committed.usable is True
        assert started_b.status_code == 200, started_b.text

        async with session_factory() as verification:
            attempts = list(
                (
                    await verification.execute(
                        select(AiProviderOAuthAttempt)
                        .where(AiProviderOAuthAttempt.provider_id == provider_id)
                        .order_by(AiProviderOAuthAttempt.created_at)
                    )
                ).scalars()
            )
            payload = await verification.scalar(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id == auth.user_id,
                    AiProviderAuthPayload.provider_id == provider_id,
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        assert [attempt.status for attempt in attempts] == ["committed", "pending"]
        assert payload is not None
        assert attempts[1].base_credential_revision == payload.credential_revision
    finally:
        release_transition.set()
        if commit_task is not None and not commit_task.done():
            commit_task.cancel()
        if start_task is not None and not start_task.done():
            start_task.cancel()
        app.dependency_overrides[get_session] = previous_get_session
        settings.ai_provider_oauth_config_json = previous_config


@pytest.mark.asyncio
async def test_post_exchange_commit_failure_leaves_durable_compensation(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    provider_id = "openai-codex-post-exchange-failure"
    auth = AuthContext(user=seed_user)
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous_config = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
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
            if data["grant_type"] == "authorization_code":
                return httpx.Response(
                    200,
                    json={
                        "id_token": _test_jwt(),
                        "access_token": "post-exchange-access",
                        "refresh_token": "post-exchange-refresh",
                    },
                )
            return httpx.Response(200, json={"access_token": "sk-post-exchange"})

    async def fail_transition(*args, **kwargs):
        raise RuntimeError("forced credential commit failure")

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeOAuthClient)
    monkeypatch.setattr(ai_provider_routes, "transition_ai_provider_auth", fail_transition)
    try:
        started = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert started.status_code == 200, started.text
        attempt_id, replay = await ai_provider_routes._begin_oauth_attempt_exchange(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            state=started.json()["state"],
            flow_kind="authorization_code",
            payload_updates={
                "authorization_code": "post-exchange-code",
                "requested_redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert replay is None
        with pytest.raises(RuntimeError, match="forced credential commit failure"):
            await ai_provider_routes._exchange_and_commit_oauth_attempt(attempt_id, auth)
    finally:
        settings.ai_provider_oauth_config_json = previous_config

    attempt = await db_session.get(AiProviderOAuthAttempt, attempt_id)
    assert attempt is not None
    assert attempt.status == "failed"
    tombstone = await db_session.scalar(
        select(AiProviderOAuthRevokeTombstone).where(
            AiProviderOAuthRevokeTombstone.oauth_attempt_id == attempt_id
        )
    )
    assert tombstone is not None
    assert tombstone.status == "pending"
    assert tombstone.encrypted_token is not None
    assert tombstone.token_nonce is not None
    assert b"post-exchange-refresh" not in tombstone.encrypted_token
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(AiProviderAuthPayload)
            .where(
                AiProviderAuthPayload.owner_user_id == auth.user_id,
                AiProviderAuthPayload.provider_id == provider_id,
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_post_exchange_provider_shape_change_fails_commit_and_keeps_compensation(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    provider_id = "openai-codex-shape-race"
    auth = AuthContext(user=seed_user)
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_mode": "openai_responses",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous_config = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    try:
        started = await client.post(
            f"/v1/ai-providers/{provider_id}/auth/oauth/start",
            json={"provider": "codex"},
        )
        assert started.status_code == 200, started.text
        attempt_id, replay = await ai_provider_routes._begin_oauth_attempt_exchange(
            owner_user_id=auth.user_id,
            provider_id=provider_id,
            state=started.json()["state"],
            flow_kind="authorization_code",
            payload_updates={
                "authorization_code": "shape-race-code",
                "requested_redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert replay is None
        async with ai_provider_routes.async_session_factory() as compensation_db:
            compensation = await ai_provider_routes.enqueue_oauth_revoke_tombstone(
                compensation_db,
                owner_user_id=auth.user_id,
                provider_id=provider_id,
                oauth_provider="codex",
                revocable=("shape-race-refresh", "refresh_token"),
                oauth_attempt_id=attempt_id,
            )
            await compensation_db.commit()
        assert compensation is not None

        changed = await client.patch(
            f"/v1/ai-providers/{provider_id}",
            json={
                "type": "custom_openai_compatible",
                "base_url": "https://proxy.example/v1",
                "api_mode": "openai_chat",
            },
        )
        assert changed.status_code == 200, changed.text

        with pytest.raises(HTTPException) as error:
            await ai_provider_routes._commit_oauth_attempt(
                attempt_id=attempt_id,
                auth=auth,
                provider_auth_type="agent_profile",
                payload_text=_codex_oauth_envelope(
                    "shape-race-access",
                    "shape-race-refresh",
                ),
                metadata={"tool": "codex", "profile": "default", "source": "oauth_pkce"},
                compensation=compensation,
            )
        assert error.value.status_code == 409
    finally:
        settings.ai_provider_oauth_config_json = previous_config

    attempt = await db_session.get(AiProviderOAuthAttempt, attempt_id)
    tombstone = await db_session.get(AiProviderOAuthRevokeTombstone, compensation.id)
    assert attempt is not None
    assert attempt.status == "failed"
    assert tombstone is not None
    assert tombstone.status == "pending"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(AiProviderAuthPayload)
            .where(
                AiProviderAuthPayload.owner_user_id == auth.user_id,
                AiProviderAuthPayload.provider_id == provider_id,
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_oauth_device_accept_polls_then_persists_tokens(
    client: httpx.AsyncClient,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
):
    connection = await db_session.connection()
    device_session_factory = async_sessionmaker(
        bind=connection,
        expire_on_commit=True,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(
        "app.routes.ai_providers.async_session_factory",
        device_session_factory,
    )
    previous = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://auth.openai.com/oauth/authorize",
                "token_url": "https://auth.openai.com/oauth/token",
                "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            }
        }
    )
    requests: list[dict] = []
    device_poll_count = 0

    class FakeDeviceClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, *, headers=None, json=None, data=None):
            nonlocal device_poll_count
            requests.append({"url": url, "headers": headers, "json": json, "data": data})
            if url.endswith("/deviceauth/usercode"):
                return httpx.Response(
                    200,
                    json={
                        "device_auth_id": "device-auth-id",
                        "user_code": "ABCD-EFGH",
                        "interval": 1,
                    },
                )
            if url.endswith("/deviceauth/token"):
                device_poll_count += 1
                if device_poll_count == 1:
                    return httpx.Response(403, json={"error": "authorization_pending"})
                return httpx.Response(
                    200,
                    json={
                        "authorization_code": "device-authorization-code",
                        "code_verifier": "device-code-verifier",
                    },
                )
            if data and data.get("grant_type") == "authorization_code":
                return httpx.Response(
                    200,
                    json={
                        "id_token": _test_jwt(),
                        "access_token": "oauth-access-token",
                        "refresh_token": "oauth-refresh-token",
                    },
                )
            if data and data.get("grant_type") == "urn:ietf:params:oauth:grant-type:token-exchange":
                return httpx.Response(200, json={"access_token": "sk-codex-api-key"})
            if url.endswith("/oauth/revoke") and json:
                return httpx.Response(200)
            raise AssertionError(f"unexpected request: {url}")

    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", FakeDeviceClient)
    try:
        accepted = await client.post(
            "/v1/ai-providers/accept",
            headers={"Idempotency-Key": "device-accept"},
            json={
                "provider": {
                    "provider_id": "openai-codex",
                    "type": "openai",
                    "label": "Codex (ChatGPT)",
                    "base_url": "https://api.openai.com/v1",
                    "api_mode": "openai_responses",
                    "auth": {"type": "agent_profile", "tool": "codex", "profile": "default"},
                    "managed_by": "user",
                    "models": [{"id": "gpt-5.5"}],
                },
                "credential": {
                    "type": "oauth",
                    "provider": "codex",
                    "flow": "device_code",
                },
                "replace": False,
            },
        )
        assert accepted.status_code == 201, accepted.text
        authorization = accepted.json()["authorization"]
        assert authorization == {
            "flow": "device_code",
            "provider_id": "openai-codex",
            "oauth_provider": "codex",
            "profile": "default",
            "verification_url": "https://auth.openai.com/codex/device",
            "user_code": "ABCD-EFGH",
            "state": authorization["state"],
            "expires_at": authorization["expires_at"],
            "poll_interval_seconds": 1,
        }

        pending = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/device/poll",
            json={"state": authorization["state"]},
        )
        assert pending.status_code == 200, pending.text
        assert pending.json() == {"status": "pending", "retry_after_seconds": 1}

        completed = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/device/poll",
            json={"state": authorization["state"]},
        )
        deleted = await client.delete("/v1/ai-providers/openai-codex")
    finally:
        settings.ai_provider_oauth_config_json = previous

    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "ready"
    assert completed.json()["provider"]["usable"] is True
    assert deleted.status_code == 200, deleted.text
    assert "oauth-access-token" not in completed.text
    exchange = next(item for item in requests if item["data"] and item["data"].get("code"))
    assert exchange["data"] == {
        "grant_type": "authorization_code",
        "code": "device-authorization-code",
        "redirect_uri": "https://auth.openai.com/deviceauth/callback",
        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "code_verifier": "device-code-verifier",
    }
    assert not any(item["url"].endswith("/oauth/revoke") for item in requests)
    assert deleted.json()["remote_revoke_status"] == "pending"
    tombstone = await db_session.scalar(
        select(AiProviderOAuthRevokeTombstone).where(
            AiProviderOAuthRevokeTombstone.provider_id == "openai-codex"
        )
    )
    assert tombstone is not None
    assert tombstone.status == "pending"
    assert tombstone.encrypted_token is not None
    assert b"oauth-refresh-token" not in tombstone.encrypted_token


@pytest.mark.asyncio
async def test_ai_provider_oauth_complete_exchanges_and_redacts_token(
    client: httpx.AsyncClient,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    seed_user,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    consumer = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="codex-oauth-consumer",
        machine_name="Codex OAuth consumer",
        agent_type="codex",
    )
    created = await client.post(
        "/v1/ai-providers",
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
                "redirect_uri": "https://cloud.example/oauth/callback",
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
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": "not-valid",
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert invalid_state.status_code == 400, invalid_state.text
        assert token_requests == []

        started = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert started.status_code == 200, started.text
        mismatch = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code",
                "redirect_uri": "https://cloud.example/other-callback",
            },
        )
        assert mismatch.status_code == 400, mismatch.text
        assert token_requests == []
        completed = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
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
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(consumer.id),
                "consumer_runtime": "codex",
            },
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
    db_session,
    monkeypatch: pytest.MonkeyPatch,
    seed_user,
):
    await _use_db_session_for_short_ai_provider_sessions(db_session, monkeypatch)
    consumer = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id="codex-oauth-no-api-key-consumer",
        machine_name="Codex OAuth no API key consumer",
        agent_type="codex",
    )
    created = await client.post(
        "/v1/ai-providers",
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
                "redirect_uri": "https://cloud.example/oauth/callback",
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
            "/v1/ai-providers/openai-codex/auth/oauth/start",
            json={
                "provider": "codex",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
        assert started.status_code == 200, started.text
        completed = await client.post(
            "/v1/ai-providers/openai-codex/auth/oauth/complete",
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
            "/v1/ai-providers/openai-codex/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(consumer.id),
                "consumer_runtime": "codex",
            },
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
            "/v1/ai-providers",
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
        "/v1/ai-providers",
        json={
            "provider_id": "openai-main",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    managed = await client.post(
        "/v1/ai-providers/openai-main/auth/api-key",
        json={"value": "sk-managed-secret"},
    )
    assert managed.status_code == 200, managed.text

    web_resolve = await client.post(
        "/v1/ai-providers/openai-main/auth/resolve",
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
        "/v1/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert resolved.status_code == 200, resolved.text
    resolved_body = resolved.json()
    assert isinstance(resolved_body.pop("credential_revision"), str)
    assert resolved_body == {
        "provider_id": "openai-main",
        "auth_type": "api_key",
        "value": "sk-managed-secret",
        "payload": None,
        "tool": None,
        "provider": None,
        "profile": "default",
    }

    deleted = await client.delete("/v1/ai-providers/openai-main")
    assert deleted.status_code == 200, deleted.text

    recreated = await client.post(
        "/v1/ai-providers",
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
        "/v1/ai-providers/openai-main/auth/resolve",
        json={"profile": "default"},
    )
    assert stale_resolve.status_code == 404, stale_resolve.text


@pytest.mark.asyncio
async def test_environment_bound_legacy_key_resolves_only_actual_provider_binding(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    bound = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "bound-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert bound.status_code == 200, bound.text
    assert (
        await client.post(
            "/v1/ai-providers/bound-provider/auth/api-key",
            json={"value": "sk-bound"},
        )
    ).status_code == 200
    unbound = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "other-provider",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert unbound.status_code == 200, unbound.text
    assert (
        await client.post(
            "/v1/ai-providers/other-provider/auth/api-key",
            json={"value": "sk-other"},
        )
    ).status_code == 200
    hosted = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"bound-{uuid.uuid4().hex}",
        machine_name="Bound runtime",
        agent_type="openclaw",
    )
    other = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"other-{uuid.uuid4().hex}",
        machine_name="Other runtime",
        agent_type="openclaw",
    )
    self_managed = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"self-{uuid.uuid4().hex}",
        machine_name="Self-managed runtime",
        agent_type="openclaw",
    )
    db_session.add(
        HostedRuntimeState(
            environment_id=hosted.id,
            deployment_id="dep-bound",
            instance_id="hri-bound",
            generation=1,
            cli_package_spec="clawdi@0.13.0",
            locale={"language": "en", "timezone": "UTC"},
            system=_TEST_SYSTEM,
            live_sync={"enabled": False, "agents": []},
            recovery={"cacheManifest": True, "allowOfflineBoot": True},
            runtimes={
                "openclaw": {
                    "enabled": True,
                    "providerMode": "configured",
                    "provider_ids": ["bound-provider"],
                    "primary_model": {
                        "provider_id": "bound-provider",
                        "model": "gpt-test",
                    },
                    "install": {"source": "official"},
                }
            },
        )
    )
    await db_session.commit()

    async def resolve_with_environment_key(environment_id: uuid.UUID, provider_id: str):
        key = ApiKey(
            user_id=seed_user.id,
            key_hash="unused",
            key_prefix="clawdi_env",
            label="legacy-agent",
            environment_id=environment_id,
            scopes=None,
        )

        async def _override_get_auth() -> AuthContext:
            return AuthContext(user=seed_user, api_key=key)

        app.dependency_overrides[get_auth] = _override_get_auth
        return await client.post(
            f"/v1/ai-providers/{provider_id}/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(environment_id),
                "consumer_runtime": "openclaw",
            },
        )

    original_get_auth = app.dependency_overrides[get_auth]
    try:
        allowed = await resolve_with_environment_key(hosted.id, "bound-provider")
        wrong_provider = await resolve_with_environment_key(hosted.id, "other-provider")
        self_managed_result = await resolve_with_environment_key(self_managed.id, "bound-provider")
        wrong_environment_key = ApiKey(
            user_id=seed_user.id,
            key_hash="unused-other",
            key_prefix="clawdi_other",
            label="other-agent",
            environment_id=other.id,
            scopes=None,
        )

        async def _override_other_auth() -> AuthContext:
            return AuthContext(user=seed_user, api_key=wrong_environment_key)

        app.dependency_overrides[get_auth] = _override_other_auth
        horizontal = await client.post(
            "/v1/ai-providers/bound-provider/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(hosted.id),
                "consumer_runtime": "openclaw",
            },
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth

    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["value"] == "sk-bound"
    assert wrong_provider.status_code == 403, wrong_provider.text
    assert self_managed_result.status_code == 403, self_managed_result.text
    assert horizontal.status_code == 403, horizontal.text


@pytest.mark.asyncio
async def test_oauth_payload_has_one_runtime_owner_and_reconnect_rotates_revision(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex-owner",
            "type": "openai",
            "base_url": "https://chatgpt.com/backend-api/codex",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    imported = await client.post(
        "/v1/ai-providers/openai-codex-owner/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": '{"kind":"local_agent_profile","generation":1}',
        },
    )
    assert imported.status_code == 200, imported.text
    codex = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"codex-{uuid.uuid4().hex}",
        machine_name="Codex owner",
        agent_type="codex",
    )
    other_codex = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"codex-other-{uuid.uuid4().hex}",
        machine_name="Other Codex",
        agent_type="codex",
    )
    await db_session.commit()
    api_key = ApiKey(
        user_id=seed_user.id,
        key_hash="unused",
        key_prefix="clawdi_personal",
        label="personal-cli",
        scopes=None,
    )

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=api_key)

    original_get_auth = app.dependency_overrides[get_auth]
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        first = await client.post(
            "/v1/ai-providers/openai-codex-owner/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(codex.id),
                "consumer_runtime": "codex",
            },
        )
        claimed_listing = await client.get("/v1/ai-providers")
        conflict = await client.post(
            "/v1/ai-providers/openai-codex-owner/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(other_codex.id),
                "consumer_runtime": "codex",
            },
        )
        reconnected = await client.post(
            "/v1/ai-providers/openai-codex-owner/auth/import",
            json={
                "type": "agent_profile",
                "tool": "codex",
                "profile": "default",
                "payload": '{"kind":"local_agent_profile","generation":2}',
            },
        )
        second = await client.post(
            "/v1/ai-providers/openai-codex-owner/auth/resolve",
            json={
                "profile": "default",
                "environment_id": str(codex.id),
                "consumer_runtime": "codex",
            },
        )
    finally:
        app.dependency_overrides[get_auth] = original_get_auth

    assert first.status_code == 200, first.text
    assert claimed_listing.status_code == 200, claimed_listing.text
    claimed_provider = next(
        provider
        for provider in claimed_listing.json()["providers"]
        if provider["provider_id"] == "openai-codex-owner"
    )
    assert claimed_provider["consumer"] == {
        "environment_id": str(codex.id),
        "runtime": "codex",
    }
    assert conflict.status_code == 409, conflict.text
    assert reconnected.status_code == 200, reconnected.text
    assert second.status_code == 200, second.text
    assert first.json()["credential_revision"] != second.json()["credential_revision"]
    assert json.loads(second.json()["payload"])["generation"] == 2


@pytest.mark.asyncio
async def test_oauth_import_rejects_multiple_hosted_runtime_bindings(
    client: httpx.AsyncClient,
    db_session,
    seed_user,
):
    provider_id = "openai-codex-shared-family"
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": provider_id,
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text

    for runtime in ("hermes", "openclaw"):
        environment = await create_env_with_project(
            db_session,
            user_id=seed_user.id,
            machine_id=f"oauth-shared-{runtime}-{uuid.uuid4().hex}",
            machine_name=f"OAuth shared {runtime}",
            agent_type=runtime,
        )
        db_session.add(
            HostedRuntimeState(
                environment_id=environment.id,
                deployment_id=f"dep-oauth-shared-{runtime}",
                instance_id=f"hri-oauth-shared-{runtime}",
                generation=1,
                cli_package_spec="clawdi@0.13.0",
                locale={"language": "en", "timezone": "UTC"},
                system=_TEST_SYSTEM,
                live_sync={"enabled": False, "agents": []},
                recovery={"cacheManifest": True, "allowOfflineBoot": True},
                runtimes={
                    runtime: {
                        "enabled": True,
                        "providerMode": "configured",
                        "provider_ids": [provider_id],
                        "primary_model": {
                            "provider_id": provider_id,
                            "model": "gpt-test",
                        },
                        "install": {"source": "official"},
                    }
                },
            )
        )
    await db_session.commit()

    imported = await client.post(
        f"/v1/ai-providers/{provider_id}/auth/import",
        json={
            "type": "agent_profile",
            "tool": "codex",
            "profile": "default",
            "payload": '{"kind":"local_agent_profile","files":[]}',
        },
    )

    assert imported.status_code == 409, imported.text
    assert imported.json()["detail"] == (
        "OAuth credential cannot be bound to multiple Agent runtimes"
    )


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_oauth_complete_cannot_revive_a_concurrently_deleted_provider(
    client: httpx.AsyncClient,
    engine,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await client.post(
        "/v1/ai-providers",
        json={
            "provider_id": "openai-codex-delete-race",
            "type": "openai",
            "base_url": "https://api.openai.com/v1",
            "auth": {"type": "secret_ref", "ref": "env:OPENAI_API_KEY"},
        },
    )
    assert created.status_code == 200, created.text
    previous_config = settings.ai_provider_oauth_config_json
    settings.ai_provider_oauth_config_json = json.dumps(
        {
            "codex": {
                "authorization_url": "https://oauth.example/authorize",
                "token_url": "https://oauth.example/token",
                "client_id": "clawdi-client",
                "redirect_uri": "https://cloud.example/oauth/callback",
            }
        }
    )
    started = await client.post(
        "/v1/ai-providers/openai-codex-delete-race/auth/oauth/start",
        json={"provider": "codex"},
    )
    assert started.status_code == 200, started.text

    exchange_started = asyncio.Event()
    release_exchange = asyncio.Event()

    class BlockingOAuthClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, data):
            if data["grant_type"] == "authorization_code":
                exchange_started.set()
                await release_exchange.wait()
                return httpx.Response(
                    200,
                    json={
                        "id_token": _test_jwt(),
                        "access_token": "oauth-access-race",
                        "refresh_token": "oauth-refresh-race",
                    },
                )
            return httpx.Response(200, json={"access_token": "sk-codex-api-key-race"})

    session_factory = async_sessionmaker(engine, expire_on_commit=True)

    async def _independent_session():
        async with session_factory() as session:
            yield session

    previous_get_session = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = _independent_session
    monkeypatch.setattr("app.routes.ai_providers.httpx.AsyncClient", BlockingOAuthClient)
    completion_task = asyncio.create_task(
        client.post(
            "/v1/ai-providers/openai-codex-delete-race/auth/oauth/complete",
            json={
                "state": started.json()["state"],
                "code": "oauth-code-race",
                "redirect_uri": "https://cloud.example/oauth/callback",
            },
        )
    )
    try:
        await asyncio.wait_for(exchange_started.wait(), timeout=2)
        deleted = await client.delete("/v1/ai-providers/openai-codex-delete-race")
        assert deleted.status_code == 200, deleted.text
        release_exchange.set()
        completed = await asyncio.wait_for(completion_task, timeout=2)
    finally:
        release_exchange.set()
        if not completion_task.done():
            completion_task.cancel()
        app.dependency_overrides[get_session] = previous_get_session
        settings.ai_provider_oauth_config_json = previous_config

    assert completed.status_code == 409, completed.text
    async with session_factory() as verification:
        provider = await verification.scalar(
            select(AiProvider).where(
                AiProvider.owner_user_id == seed_user.id,
                AiProvider.provider_id == "openai-codex-delete-race",
            )
        )
        active_payload_count = await verification.scalar(
            select(func.count())
            .select_from(AiProviderAuthPayload)
            .where(
                AiProviderAuthPayload.owner_user_id == seed_user.id,
                AiProviderAuthPayload.provider_id == "openai-codex-delete-race",
                AiProviderAuthPayload.archived_at.is_(None),
            )
        )
        compensation = await verification.scalar(
            select(AiProviderOAuthRevokeTombstone).where(
                AiProviderOAuthRevokeTombstone.owner_user_id == seed_user.id,
                AiProviderOAuthRevokeTombstone.provider_id == "openai-codex-delete-race",
            )
        )
    assert provider is not None
    assert provider.archived_at is not None
    assert active_payload_count == 0
    assert compensation is not None
    assert compensation.status == "pending"
    assert compensation.encrypted_token is not None
    assert b"oauth-refresh-race" not in compensation.encrypted_token


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_managed_provider_rotate_and_archive_are_serialized_and_consistent(
    db_session,
    engine,
    seed_user,
):
    provider_id = v2_deployment_managed_provider_id("424242")
    assert provider_id is not None
    await upsert_clawdi_managed_provider(
        db_session,
        user=seed_user,
        provider_id=provider_id,
        base_url="https://managed.example.test/v1",
        api_key="sk-initial",
        default_model="gpt-test",
    )
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    rotate_holds_locks = asyncio.Event()
    allow_rotate_commit = asyncio.Event()

    async def rotate():
        async with session_factory() as session:
            await upsert_clawdi_managed_provider(
                session,
                user=seed_user,
                provider_id=provider_id,
                base_url="https://managed.example.test/v1",
                api_key="sk-rotated",
                default_model="gpt-test",
            )
            rotate_holds_locks.set()
            await allow_rotate_commit.wait()
            await session.commit()

    async def archive():
        async with session_factory() as session:
            archived = await archive_clawdi_managed_provider(
                session,
                owner_user_id=seed_user.id,
                provider_id=provider_id,
            )
            assert archived is not None
            await session.commit()

    rotate_task = asyncio.create_task(rotate())
    await asyncio.wait_for(rotate_holds_locks.wait(), timeout=2)
    archive_task = asyncio.create_task(archive())
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(archive_task), timeout=0.05)
    allow_rotate_commit.set()
    await asyncio.wait_for(asyncio.gather(rotate_task, archive_task), timeout=2)

    async with session_factory() as verification:
        provider = await verification.scalar(
            select(AiProvider).where(
                AiProvider.owner_user_id == seed_user.id,
                AiProvider.provider_id == provider_id,
            )
        )
        payload = await verification.scalar(
            select(AiProviderAuthPayload).where(
                AiProviderAuthPayload.owner_user_id == seed_user.id,
                AiProviderAuthPayload.provider_id == provider_id,
                AiProviderAuthPayload.auth_profile == "default",
            )
        )
    assert provider is not None
    assert payload is not None
    assert provider.archived_at is not None
    assert payload.archived_at is not None
