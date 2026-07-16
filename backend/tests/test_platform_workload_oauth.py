from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport
from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.audit import ControlPlaneAuditEvent
from app.models.platform_workload_auth import (
    PLATFORM_WORKLOAD_CLIENT_ACTIVE,
    PLATFORM_WORKLOAD_CLIENT_DISABLED,
    PlatformWorkloadAssertionReplay,
    PlatformWorkloadClient,
    PlatformWorkloadSigningKey,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.schemas.platform import PLATFORM_RUNTIME_KEY_SCOPES
from app.services import platform_workload_auth
from app.services.platform_workload_auth import (
    PLATFORM_WORKLOAD_ACCESS_TOKEN_AUDIENCE,
    PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS,
    PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE,
    PLATFORM_WORKLOAD_SCOPES,
    InMemoryPlatformWorkloadKeyResolver,
    PlatformWorkloadAccessError,
    PlatformWorkloadKeyUnavailable,
    authenticate_platform_workload_access_token,
    canonical_platform_workload_token_endpoint,
    get_platform_workload_key_resolver,
)

_ADMIN_KEY = "test-platform-admin-secret"
_TEST_CLI_PACKAGE_SPEC = "clawdi@0.12.10-beta.55"
_TEST_TOOLS = {
    "codex": {
        "enabled": True,
        "provider_id": "clawdi-managed-v2",
        "primary_model": {
            "provider_id": "clawdi-managed-v2",
            "model": "gpt-5.5",
        },
    }
}


@dataclass
class WorkloadHarness:
    client: httpx.AsyncClient
    credential: PlatformWorkloadClient
    client_id: str
    client_kid: str
    client_private_key: Any
    signing_private_key: Any
    signing_key: PlatformWorkloadSigningKey
    resolver: InMemoryPlatformWorkloadKeyResolver


def _public_jwk(private_key: Any, *, kid: str) -> dict[str, Any]:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": kid, "alg": "RS256", "use": "sig", "key_ops": ["verify"]})
    return jwk


@pytest_asyncio.fixture
async def workload_harness(db_session, seed_user) -> AsyncIterator[WorkloadHarness]:
    client_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    signing_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    client_id = f"hosted-workload-{uuid.uuid4().hex}"
    client_kid = f"client-{uuid.uuid4().hex}"
    signing_kid = f"issuer-{uuid.uuid4().hex}"
    private_key_ref = f"memory://{signing_kid}"
    now = datetime.now(UTC)
    credential = PlatformWorkloadClient(
        client_id=client_id,
        assertion_kid=client_kid,
        assertion_algorithm="RS256",
        public_jwk=_public_jwk(client_private_key, kid=client_kid),
        status=PLATFORM_WORKLOAD_CLIENT_ACTIVE,
        allowed_scopes=list(PLATFORM_WORKLOAD_SCOPES),
        token_version=1,
    )
    signing_key = PlatformWorkloadSigningKey(
        kid=signing_kid,
        algorithm="RS256",
        private_key_ref=private_key_ref,
        status="active",
        not_before=now - timedelta(minutes=1),
        expires_at=now + timedelta(hours=1),
    )
    db_session.add_all([credential, signing_key])
    await db_session.commit()
    await db_session.refresh(credential)
    await db_session.refresh(signing_key)

    resolver = InMemoryPlatformWorkloadKeyResolver({private_key_ref: signing_private_key})

    async def _override_get_session():
        yield db_session

    def _override_resolver():
        return resolver

    original_admin_key = settings.admin_api_key
    original_legacy_flag = settings.platform_legacy_admin_auth_enabled
    original_public_api_url = settings.public_api_url
    original_token_endpoint = settings.platform_workload_token_endpoint
    original_issuer = settings.platform_workload_issuer
    settings.admin_api_key = _ADMIN_KEY
    settings.platform_legacy_admin_auth_enabled = True
    settings.public_api_url = "http://test"
    settings.platform_workload_token_endpoint = ""
    settings.platform_workload_issuer = "clawdi-cloud-platform-test"
    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_platform_workload_key_resolver] = _override_resolver
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield WorkloadHarness(
                client=client,
                credential=credential,
                client_id=client_id,
                client_kid=client_kid,
                client_private_key=client_private_key,
                signing_private_key=signing_private_key,
                signing_key=signing_key,
                resolver=resolver,
            )
    finally:
        app.dependency_overrides.clear()
        settings.admin_api_key = original_admin_key
        settings.platform_legacy_admin_auth_enabled = original_legacy_flag
        settings.public_api_url = original_public_api_url
        settings.platform_workload_token_endpoint = original_token_endpoint
        settings.platform_workload_issuer = original_issuer
        await db_session.execute(
            delete(PlatformWorkloadAssertionReplay).where(
                PlatformWorkloadAssertionReplay.client_id == client_id
            )
        )
        await db_session.execute(
            delete(PlatformWorkloadClient).where(PlatformWorkloadClient.client_id == client_id)
        )
        await db_session.execute(
            delete(PlatformWorkloadSigningKey).where(PlatformWorkloadSigningKey.kid == signing_kid)
        )
        await db_session.commit()


def _assertion(
    harness: WorkloadHarness,
    *,
    payload_updates: dict[str, Any] | None = None,
    remove_claims: tuple[str, ...] = (),
    kid: str | None = None,
    algorithm: str = "RS256",
    signing_key: Any | None = None,
    jti: str | None = None,
) -> str:
    now = int(datetime.now(UTC).timestamp())
    payload: dict[str, Any] = {
        "iss": harness.client_id,
        "sub": harness.client_id,
        "aud": canonical_platform_workload_token_endpoint(),
        "iat": now,
        "exp": now + 120,
        "jti": jti or str(uuid.uuid4()),
    }
    payload.update(payload_updates or {})
    for claim in remove_claims:
        payload.pop(claim, None)
    key = signing_key or harness.client_private_key
    return jwt.encode(
        payload,
        key,
        algorithm=algorithm,
        headers={"kid": kid or harness.client_kid, "typ": "JWT"},
    )


async def _token_response(
    harness: WorkloadHarness,
    *,
    scope: str,
    assertion: str | None = None,
    client_id: str | None = None,
    grant_type: str = "client_credentials",
    assertion_type: str = PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE,
) -> httpx.Response:
    return await harness.client.post(
        "/v1/platform/oauth/token",
        data={
            "grant_type": grant_type,
            "client_id": client_id or harness.client_id,
            "scope": scope,
            "client_assertion_type": assertion_type,
            "client_assertion": assertion or _assertion(harness),
        },
    )


async def _access_token(harness: WorkloadHarness, scope: str) -> str:
    response = await _token_response(harness, scope=scope)
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def _workload_headers(token: str, idempotency_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Idempotency-Key": idempotency_key,
    }


def _owner(user: User) -> dict[str, str]:
    assert user.clerk_id is not None
    return {"kind": "clerk", "ref": user.clerk_id}


def _agent_body(owner: dict[str, str], agent_id: uuid.UUID) -> dict[str, Any]:
    return {
        "owner": owner,
        "agent_id": str(agent_id),
        "machine_id": f"machine-{agent_id.hex[:8]}",
        "machine_name": "workload-platform-agent",
        "agent_type": "openclaw",
        "agent_version": "1.0.0",
        "os_name": "linux",
    }


def _runtime_body(owner: dict[str, str], agent_id: uuid.UUID) -> dict[str, Any]:
    return {
        "owner": owner,
        "deployment_id": "deployment-workload",
        "instance_id": "instance-workload",
        "generation": 1,
        "cli_package_spec": _TEST_CLI_PACKAGE_SPEC,
        "locale": {"language": "en", "timezone": "UTC"},
        "system": {},
        "runtimes": {
            "openclaw": {
                "enabled": True,
                "providerMode": "configured",
                "provider_ids": ["clawdi-managed-v2"],
                "primary_model": {
                    "provider_id": "clawdi-managed-v2",
                    "model": "gpt-5.5",
                },
                "install": {"source": "official"},
                "run": {"args": ["gateway", "run"]},
                "services": {},
            }
        },
        "live_sync": {
            "enabled": True,
            "agents": [
                {
                    "agentType": "openclaw",
                    "environmentId": str(agent_id),
                }
            ],
        },
        "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
        "tools": _TEST_TOOLS,
    }


@pytest.mark.asyncio
async def test_oauth_issues_at_jwt_with_fixed_contract_and_short_ttl(
    workload_harness,
    db_session,
):
    assertion_jti = str(uuid.uuid4())
    response = await _token_response(
        workload_harness,
        scope="platform:agents:create platform:keys:mint",
        assertion=_assertion(workload_harness, jti=assertion_jti),
    )

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    body = response.json()
    assert body["token_type"] == "Bearer"
    assert body["expires_in"] == PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS
    assert body["scope"] == "platform:agents:create platform:keys:mint"

    header = jwt.get_unverified_header(body["access_token"])
    assert header == {
        "alg": "RS256",
        "kid": workload_harness.signing_key.kid,
        "typ": "at+jwt",
    }
    claims = jwt.decode(
        body["access_token"],
        workload_harness.signing_private_key.public_key(),
        algorithms=["RS256"],
        audience=PLATFORM_WORKLOAD_ACCESS_TOKEN_AUDIENCE,
        issuer=settings.platform_workload_issuer,
    )
    assert claims["sub"] == workload_harness.credential.client_id
    assert claims["client_id"] == workload_harness.credential.client_id
    assert claims["credential_id"] == str(workload_harness.credential.id)
    assert claims["token_version"] == 1
    assert claims["scope"] == body["scope"]
    assert claims["exp"] - claims["iat"] == PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS
    assert claims["nbf"] == claims["iat"]
    replay_count = await db_session.scalar(
        select(func.count())
        .select_from(PlatformWorkloadAssertionReplay)
        .where(
            PlatformWorkloadAssertionReplay.client_id == workload_harness.credential.client_id,
            PlatformWorkloadAssertionReplay.jti == assertion_jti,
        )
    )
    assert replay_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case", "expected_error"),
    [
        ("grant_type", "unsupported_grant_type"),
        ("assertion_type", "invalid_request"),
        ("client_id", "invalid_client"),
        ("kid", "invalid_client"),
        ("algorithm", "invalid_client"),
        ("signature", "invalid_client"),
        ("issuer", "invalid_client"),
        ("subject", "invalid_client"),
        ("audience", "invalid_client"),
        ("missing_issuer", "invalid_client"),
        ("missing_subject", "invalid_client"),
        ("missing_audience", "invalid_client"),
        ("missing_iat", "invalid_client"),
        ("missing_exp", "invalid_client"),
        ("future_iat", "invalid_client"),
        ("future_nbf", "invalid_client"),
        ("expired", "invalid_client"),
        ("long_lived", "invalid_client"),
        ("empty_jti", "invalid_client"),
        ("missing_jti", "invalid_client"),
    ],
)
async def test_oauth_rejects_invalid_protocol_and_assertion_branches(
    workload_harness,
    case,
    expected_error,
):
    now = int(datetime.now(UTC).timestamp())
    kwargs: dict[str, Any] = {"scope": "platform:agents:create"}
    if case == "grant_type":
        kwargs["grant_type"] = "authorization_code"
    elif case == "assertion_type":
        kwargs["assertion_type"] = "urn:example:wrong"
    elif case == "client_id":
        kwargs["client_id"] = f"wrong-{uuid.uuid4().hex}"
    elif case == "kid":
        kwargs["assertion"] = _assertion(workload_harness, kid="wrong-kid")
    elif case == "algorithm":
        kwargs["assertion"] = _assertion(
            workload_harness,
            algorithm="HS256",
            signing_key="not-a-public-key-not-a-public-key",
        )
    elif case == "signature":
        kwargs["assertion"] = _assertion(
            workload_harness,
            signing_key=rsa.generate_private_key(public_exponent=65537, key_size=2048),
        )
    elif case == "issuer":
        kwargs["assertion"] = _assertion(workload_harness, payload_updates={"iss": "wrong"})
    elif case == "subject":
        kwargs["assertion"] = _assertion(workload_harness, payload_updates={"sub": "wrong"})
    elif case == "audience":
        kwargs["assertion"] = _assertion(
            workload_harness,
            payload_updates={"aud": "https://wrong.example/token"},
        )
    elif case == "missing_issuer":
        kwargs["assertion"] = _assertion(workload_harness, remove_claims=("iss",))
    elif case == "missing_subject":
        kwargs["assertion"] = _assertion(workload_harness, remove_claims=("sub",))
    elif case == "missing_audience":
        kwargs["assertion"] = _assertion(workload_harness, remove_claims=("aud",))
    elif case == "missing_iat":
        kwargs["assertion"] = _assertion(workload_harness, remove_claims=("iat",))
    elif case == "missing_exp":
        kwargs["assertion"] = _assertion(workload_harness, remove_claims=("exp",))
    elif case == "future_iat":
        kwargs["assertion"] = _assertion(
            workload_harness,
            payload_updates={"iat": now + 120, "exp": now + 240},
        )
    elif case == "future_nbf":
        kwargs["assertion"] = _assertion(
            workload_harness,
            payload_updates={"nbf": now + 120},
        )
    elif case == "expired":
        kwargs["assertion"] = _assertion(
            workload_harness,
            payload_updates={"iat": now - 240, "exp": now - 120},
        )
    elif case == "long_lived":
        kwargs["assertion"] = _assertion(
            workload_harness,
            payload_updates={"iat": now, "exp": now + 301},
        )
    elif case == "empty_jti":
        kwargs["assertion"] = _assertion(workload_harness, payload_updates={"jti": ""})
    elif case == "missing_jti":
        kwargs["assertion"] = _assertion(workload_harness, remove_claims=("jti",))

    response = await _token_response(workload_harness, **kwargs)

    assert response.status_code in {400, 401}, response.text
    assert response.json()["error"] == expected_error
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_oauth_rejects_replay_and_scope_escalation(workload_harness):
    workload_harness.credential.allowed_scopes = ["platform:agents:create"]
    assertion = _assertion(workload_harness)
    first = await _token_response(
        workload_harness,
        scope="platform:agents:create",
        assertion=assertion,
    )
    replay = await _token_response(
        workload_harness,
        scope="platform:agents:create",
        assertion=assertion,
    )
    escalated = await _token_response(
        workload_harness,
        scope="platform:agents:create platform:agents:delete",
    )
    unapproved = await _token_response(workload_harness, scope="platform:root")

    assert first.status_code == 200, first.text
    assert replay.status_code == 401, replay.text
    assert replay.json()["error"] == "invalid_client"
    assert escalated.status_code == 400, escalated.text
    assert escalated.json()["error"] == "invalid_scope"
    assert unapproved.status_code == 400, unapproved.text
    assert unapproved.json()["error"] == "invalid_scope"


@pytest.mark.asyncio
async def test_oauth_enforces_client_status_and_revoked_before(
    workload_harness,
    db_session,
):
    workload_harness.credential.status = PLATFORM_WORKLOAD_CLIENT_DISABLED
    await db_session.commit()
    disabled = await _token_response(workload_harness, scope="platform:agents:create")
    assert disabled.status_code == 401, disabled.text

    workload_harness.credential.status = PLATFORM_WORKLOAD_CLIENT_ACTIVE
    workload_harness.credential.revoked_before = datetime.now(UTC)
    await db_session.commit()
    now = int(datetime.now(UTC).timestamp())
    revoked = await _token_response(
        workload_harness,
        scope="platform:agents:create",
        assertion=_assertion(
            workload_harness,
            payload_updates={"iat": now - 1, "exp": now + 60},
        ),
    )
    assert revoked.status_code == 401, revoked.text
    assert revoked.json()["error"] == "invalid_client"


@pytest.mark.asyncio
async def test_oauth_storage_failures_are_503(
    workload_harness,
    monkeypatch,
):
    async def unavailable_client(*args, **kwargs):
        raise SQLAlchemyError("client storage unavailable")

    monkeypatch.setattr(
        platform_workload_auth,
        "load_platform_workload_client",
        unavailable_client,
    )
    client_failure = await _token_response(workload_harness, scope="platform:agents:create")
    assert client_failure.status_code == 503, client_failure.text
    assert client_failure.json()["error"] == "temporarily_unavailable"

    monkeypatch.undo()

    async def unavailable_replay(*args, **kwargs):
        raise SQLAlchemyError("replay storage unavailable")

    monkeypatch.setattr(
        platform_workload_auth,
        "store_platform_workload_assertion_replay",
        unavailable_replay,
    )
    replay_failure = await _token_response(workload_harness, scope="platform:agents:create")
    assert replay_failure.status_code == 503, replay_failure.text
    assert replay_failure.json()["error"] == "temporarily_unavailable"

    monkeypatch.undo()

    async def unavailable_signing_key(*args, **kwargs):
        raise SQLAlchemyError("issuer key storage unavailable")

    monkeypatch.setattr(
        platform_workload_auth,
        "load_platform_workload_signing_key_for_issue",
        unavailable_signing_key,
    )
    signing_key_failure = await _token_response(
        workload_harness,
        scope="platform:agents:create",
    )
    assert signing_key_failure.status_code == 503, signing_key_failure.text
    assert signing_key_failure.json()["error"] == "temporarily_unavailable"

    monkeypatch.undo()

    async def unavailable_signer(**kwargs):
        raise PlatformWorkloadKeyUnavailable("signer unavailable")

    monkeypatch.setattr(workload_harness.resolver, "sign_jwt", unavailable_signer)
    signer_failure = await _token_response(workload_harness, scope="platform:agents:create")
    assert signer_failure.status_code == 503, signer_failure.text
    assert signer_failure.json()["error"] == "temporarily_unavailable"


@pytest.mark.asyncio
async def test_workload_tokens_cover_exact_six_route_scope_mapping(
    workload_harness,
    seed_user,
    db_session,
):
    owner = _owner(seed_user)
    agent_id = uuid.uuid4()

    create_token = await _access_token(workload_harness, "platform:agents:create")
    created = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(create_token, "workload-create"),
        json=_agent_body(owner, agent_id),
    )
    assert created.status_code == 200, created.text

    runtime_token = await _access_token(workload_harness, "platform:runtime-state:write")
    runtime = await workload_harness.client.put(
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_workload_headers(runtime_token, "workload-runtime-put"),
        json=_runtime_body(owner, agent_id),
    )
    assert runtime.status_code == 200, runtime.text

    mint_token = await _access_token(workload_harness, "platform:keys:mint")
    minted = await workload_harness.client.post(
        "/v1/platform/auth/keys",
        headers=_workload_headers(mint_token, "workload-key-mint"),
        json={
            "owner": owner,
            "label": "workload-managed",
            "environment_id": str(agent_id),
            "scopes": list(PLATFORM_RUNTIME_KEY_SCOPES),
        },
    )
    assert minted.status_code == 200, minted.text
    key_id = minted.json()["id"]

    revoke_token = await _access_token(workload_harness, "platform:keys:revoke")
    revoked = await workload_harness.client.request(
        "DELETE",
        f"/v1/platform/auth/keys/{key_id}",
        headers=_workload_headers(revoke_token, "workload-key-revoke"),
        json={"owner": owner},
    )
    assert revoked.status_code == 200, revoked.text
    revoked_key = await db_session.get(ApiKey, uuid.UUID(key_id))
    assert revoked_key is not None and revoked_key.revoked_at is not None

    deleted_runtime = await workload_harness.client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}/runtime-state",
        headers=_workload_headers(runtime_token, "workload-runtime-delete"),
        json={"owner": owner},
    )
    assert deleted_runtime.status_code == 204, deleted_runtime.text

    delete_token = await _access_token(workload_harness, "platform:agents:delete")
    deleted_agent = await workload_harness.client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}",
        headers=_workload_headers(delete_token, "workload-agent-delete"),
        json={"owner": owner},
    )
    assert deleted_agent.status_code == 204, deleted_agent.text

    events = (
        await db_session.execute(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.source == "api.platform",
                ControlPlaneAuditEvent.details["workload_sub"].astext
                == workload_harness.credential.client_id,
            )
        )
    ).scalars()
    event_list = list(events)
    assert len(event_list) == 6
    assert all(
        event.details["credential_id"] == "[REDACTED]"
        and event.details["token_jti"] == "[REDACTED]"
        for event in event_list
    )
    assert await db_session.get(AgentEnvironment, agent_id) is None


@pytest.mark.asyncio
async def test_workload_owner_is_still_mandatory_and_mismatch_is_forbidden(
    workload_harness,
    seed_user,
    db_session,
):
    token = await _access_token(workload_harness, "platform:agents:create")
    missing_owner = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-missing-owner"),
        json={
            "agent_id": str(uuid.uuid4()),
            "machine_id": "missing-owner",
            "machine_name": "missing-owner",
            "agent_type": "openclaw",
        },
    )
    assert missing_owner.status_code == 422, missing_owner.text
    assert any(error["loc"][-1] == "owner" for error in missing_owner.json()["detail"])

    agent_id = uuid.uuid4()
    admin_created = await workload_harness.client.post(
        "/v1/platform/agents",
        headers={"X-Admin-Key": _ADMIN_KEY, "Idempotency-Key": "admin-owner-create"},
        json=_agent_body(_owner(seed_user), agent_id),
    )
    assert admin_created.status_code == 200, admin_created.text
    other_user = User(
        clerk_id=f"other_{uuid.uuid4().hex}",
        email="other-workload@example.test",
        name="Other Workload Owner",
    )
    db_session.add(other_user)
    await db_session.commit()

    delete_token = await _access_token(workload_harness, "platform:agents:delete")
    mismatch = await workload_harness.client.request(
        "DELETE",
        f"/v1/platform/agents/{agent_id}",
        headers=_workload_headers(delete_token, "workload-owner-mismatch"),
        json={"owner": _owner(other_user)},
    )
    assert mismatch.status_code == 403, mismatch.text
    assert await db_session.get(AgentEnvironment, agent_id) is not None

    await db_session.execute(delete(AgentEnvironment).where(AgentEnvironment.id == agent_id))
    await db_session.delete(other_user)
    await db_session.commit()


@pytest.mark.asyncio
async def test_workload_resource_auth_enforces_scope_status_version_and_revocation(
    workload_harness,
    seed_user,
    db_session,
):
    owner = _owner(seed_user)
    token = await _access_token(workload_harness, "platform:agents:create")

    wrong_scope = await workload_harness.client.request(
        "DELETE",
        f"/v1/platform/agents/{uuid.uuid4()}",
        headers=_workload_headers(token, "workload-wrong-scope"),
        json={"owner": owner},
    )
    assert wrong_scope.status_code == 403, wrong_scope.text

    workload_harness.credential.status = PLATFORM_WORKLOAD_CLIENT_DISABLED
    await db_session.commit()
    disabled = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-disabled"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert disabled.status_code == 401, disabled.text

    workload_harness.credential.status = PLATFORM_WORKLOAD_CLIENT_ACTIVE
    workload_harness.credential.token_version += 1
    await db_session.commit()
    old_version = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-old-version"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert old_version.status_code == 401, old_version.text

    workload_harness.credential.token_version -= 1
    workload_harness.credential.revoked_before = datetime.now(UTC)
    await db_session.commit()
    revoked_before = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-revoked-before"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert revoked_before.status_code == 401, revoked_before.text

    workload_harness.credential.revoked_before = None
    workload_harness.signing_key.status = "revoked"
    await db_session.commit()
    revoked_signing_key = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-revoked-signing-key"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert revoked_signing_key.status_code == 401, revoked_signing_key.text


@pytest.mark.asyncio
async def test_workload_access_token_expires_at_exactly_five_minutes(
    workload_harness,
    db_session,
):
    token = await _access_token(workload_harness, "platform:agents:create")
    claims = jwt.decode(token, options={"verify_signature": False, "verify_aud": False})

    with pytest.raises(PlatformWorkloadAccessError) as exc_info:
        await authenticate_platform_workload_access_token(
            db_session,
            workload_harness.resolver,
            token,
            required_scope="platform:agents:create",
            now=datetime.fromtimestamp(claims["exp"], tz=UTC),
        )

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_workload_resource_storage_failure_is_503_without_admin_fallback(
    workload_harness,
    seed_user,
    monkeypatch,
):
    token = await _access_token(workload_harness, "platform:agents:create")
    owner = _owner(seed_user)

    async def unavailable_client(*args, **kwargs):
        raise SQLAlchemyError("status storage unavailable")

    monkeypatch.setattr(
        platform_workload_auth,
        "load_platform_workload_client",
        unavailable_client,
    )
    response = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-status-unavailable"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert response.status_code == 503, response.text

    monkeypatch.undo()

    async def unavailable_signing_key(*args, **kwargs):
        raise SQLAlchemyError("issuer key status storage unavailable")

    monkeypatch.setattr(
        platform_workload_auth,
        "load_platform_workload_signing_key",
        unavailable_signing_key,
    )
    signing_key_failure = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-signing-key-unavailable"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert signing_key_failure.status_code == 503, signing_key_failure.text

    monkeypatch.undo()

    async def unavailable_verifier(**kwargs):
        raise PlatformWorkloadKeyUnavailable("verification key unavailable")

    monkeypatch.setattr(
        workload_harness.resolver,
        "resolve_verification_key",
        unavailable_verifier,
    )
    verifier_failure = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=_workload_headers(token, "workload-verifier-unavailable"),
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert verifier_failure.status_code == 503, verifier_failure.text


@pytest.mark.asyncio
async def test_platform_credential_selection_legacy_flag_ambiguity_and_no_fallback(
    workload_harness,
    seed_user,
):
    owner = _owner(seed_user)
    admin_success = await workload_harness.client.post(
        "/v1/platform/agents",
        headers={"X-Admin-Key": _ADMIN_KEY, "Idempotency-Key": "legacy-admin-enabled"},
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert admin_success.status_code == 200, admin_success.text

    settings.platform_legacy_admin_auth_enabled = False
    disabled = await workload_harness.client.post(
        "/v1/platform/agents",
        headers={"X-Admin-Key": _ADMIN_KEY, "Idempotency-Key": "legacy-admin-disabled"},
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert disabled.status_code == 401, disabled.text
    settings.platform_legacy_admin_auth_enabled = True

    token = await _access_token(workload_harness, "platform:agents:create")
    ambiguous = await workload_harness.client.post(
        "/v1/platform/agents",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Admin-Key": _ADMIN_KEY,
            "Idempotency-Key": "ambiguous-credentials",
        },
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert ambiguous.status_code == 400, ambiguous.text

    invalid_bearer = await workload_harness.client.post(
        "/v1/platform/agents",
        headers={
            "Authorization": f"Bearer {_ADMIN_KEY}",
            "Idempotency-Key": "bearer-no-root-fallback",
        },
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert invalid_bearer.status_code == 401, invalid_bearer.text

    workload_in_admin_header = await workload_harness.client.post(
        "/v1/platform/agents",
        headers={
            "X-Admin-Key": token,
            "Idempotency-Key": "admin-no-workload-fallback",
        },
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert workload_in_admin_header.status_code == 401, workload_in_admin_header.text

    repeated = await workload_harness.client.post(
        "/v1/platform/agents",
        headers=[
            ("Authorization", f"Bearer {token}"),
            ("Authorization", f"Bearer {token}"),
            ("Idempotency-Key", "repeated-credentials"),
        ],
        json=_agent_body(owner, uuid.uuid4()),
    )
    assert repeated.status_code == 400, repeated.text


@pytest.mark.asyncio
async def test_oauth_rejects_admin_or_authorization_header_auth(workload_harness):
    form = {
        "grant_type": "client_credentials",
        "client_id": workload_harness.credential.client_id,
        "scope": "platform:agents:create",
        "client_assertion_type": PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE,
        "client_assertion": _assertion(workload_harness),
    }
    with_admin = await workload_harness.client.post(
        "/v1/platform/oauth/token",
        headers={"X-Admin-Key": _ADMIN_KEY},
        data=form,
    )
    with_bearer = await workload_harness.client.post(
        "/v1/platform/oauth/token",
        headers={"Authorization": "Bearer unrelated"},
        data=form,
    )
    assert with_admin.status_code == 400, with_admin.text
    assert with_bearer.status_code == 400, with_bearer.text
    assert with_admin.json()["error"] == "invalid_request"
    assert with_bearer.json()["error"] == "invalid_request"
