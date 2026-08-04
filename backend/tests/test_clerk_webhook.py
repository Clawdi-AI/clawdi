from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid

import httpx
import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.principal_lifecycle import (
    ClerkPrincipalAuthority,
    ClerkWebhookEventReceipt,
    PrincipalLifecycle,
)
from app.models.session import AgentEnvironment
from app.models.user import PRINCIPAL_KIND_PARTNER_TENANT, User
from app.routes import clerk_webhooks
from app.services.api_key import mint_api_key
from app.services.principal_lifecycle import (
    PrincipalTerminatedError,
    assert_clerk_principal_active,
    assert_user_authority_active,
)
from app.services.user_provisioning import (
    lazy_create_partner_user_with_personal_project,
    lazy_create_user_with_personal_project,
)

pytestmark = pytest.mark.asyncio

_ISSUER = "https://direct-webhook.clerk.example.test"
_SIGNING_SECRET = "whsec_dGVzdF9jbGVya19zaWduaW5nX3NlY3JldA=="
_ADMIN_KEY = "direct-webhook-admin-test"


def _payload(
    subject: str,
    *,
    event_type: str = "user.deleted",
    timestamp_ms: int | None = None,
) -> bytes:
    return json.dumps(
        {
            "data": {"deleted": True, "id": subject, "object": "user"},
            "object": "event",
            "timestamp": timestamp_ms or int(time.time() * 1000),
            "type": event_type,
        },
        separators=(",", ":"),
    ).encode()


def _signed_headers(
    payload: bytes,
    *,
    message_id: str,
    envelope_timestamp: int | None = None,
) -> dict[str, str]:
    timestamp = str(envelope_timestamp or int(time.time()))
    secret = base64.b64decode(_SIGNING_SECRET.removeprefix("whsec_"))
    signature = base64.b64encode(
        hmac.new(
            secret,
            f"{message_id}.{timestamp}.".encode() + payload,
            hashlib.sha256,
        ).digest()
    ).decode()
    return {
        "svix-id": message_id,
        "svix-timestamp": timestamp,
        "svix-signature": f"v1,{signature}",
    }


@pytest.fixture(autouse=True)
def _direct_webhook_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "clerk_jwt_issuer", _ISSUER)
    monkeypatch.setattr(
        settings,
        "clerk_webhook_signing_secret",
        SecretStr(_SIGNING_SECRET),
    )
    monkeypatch.setattr(settings, "admin_api_key", _ADMIN_KEY)
    monkeypatch.setattr(settings, "clerk_secret_key", "sk_test_direct_webhook")
    monkeypatch.setattr(settings, "platform_legacy_admin_auth_enabled", True)


async def _delete(anon_client, subject: str, *, message_id: str) -> object:
    payload = _payload(subject)
    return await anon_client.post(
        "/v1/webhooks/clerk",
        content=payload,
        headers=_signed_headers(payload, message_id=message_id),
    )


def _mock_clerk_authority(
    monkeypatch: pytest.MonkeyPatch,
    *,
    subject: str,
    states: list[tuple[bool, int]],
    requests: list[httpx.Request] | None = None,
) -> None:
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        banned, updated_at = states.pop(0)
        return httpx.Response(
            200,
            json={"object": "user", "id": subject, "banned": banned, "updated_at": updated_at},
        )

    transport = httpx.MockTransport(handler)

    def client_factory(*_args: object, **_kwargs: object) -> httpx.AsyncClient:
        return real_client(transport=transport)

    monkeypatch.setattr(clerk_webhooks.httpx, "AsyncClient", client_factory)


async def _update(anon_client, subject: str, *, message_id: str) -> object:
    payload = _payload(subject, event_type="user.updated")
    return await anon_client.post(
        "/v1/webhooks/clerk",
        content=payload,
        headers=_signed_headers(payload, message_id=message_id),
    )


async def test_signed_authoritative_ban_and_unban_gate_user_and_api_key(
    anon_client,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = await mint_api_key(db_session, user_id=seed_user.id, label="ban-gate", commit=True)
    requests: list[httpx.Request] = []
    _mock_clerk_authority(
        monkeypatch,
        subject=seed_user.clerk_id,
        states=[(True, 2_000), (False, 3_000)],
        requests=requests,
    )

    banned = await _update(
        anon_client,
        seed_user.clerk_id,
        message_id=f"msg_{uuid.uuid4().hex}",
    )
    with pytest.raises(PrincipalTerminatedError):
        await assert_user_authority_active(db_session, seed_user.id)
    await db_session.rollback()
    rejected = await anon_client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {key.raw_key}"},
    )

    unbanned = await _update(
        anon_client,
        seed_user.clerk_id,
        message_id=f"msg_{uuid.uuid4().hex}",
    )
    restored = await anon_client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {key.raw_key}"},
    )

    assert banned.status_code == unbanned.status_code == 200
    assert rejected.status_code == 401
    assert restored.status_code == 200
    assert all(request.headers["Clerk-API-Version"] == "2026-05-12" for request in requests)


async def test_ban_before_first_login_and_stale_update_are_safe(
    anon_client,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    subject = f"prelogin_{uuid.uuid4().hex}"
    _mock_clerk_authority(
        monkeypatch,
        subject=subject,
        states=[(True, 5_000), (False, 4_000), (True, 5_000), (True, 5_000)],
    )
    assert (
        await _update(anon_client, subject, message_id=f"msg_{uuid.uuid4().hex}")
    ).status_code == 200
    assert (
        await _update(anon_client, subject, message_id=f"msg_{uuid.uuid4().hex}")
    ).status_code == 200
    # An exact Svix replay re-fetches current authority and remains idempotent.
    replay_id = f"msg_{uuid.uuid4().hex}"
    replay_payload = _payload(subject, event_type="user.updated")
    replay_headers = _signed_headers(replay_payload, message_id=replay_id)
    for _ in range(2):
        replay = await anon_client.post(
            "/v1/webhooks/clerk",
            content=replay_payload,
            headers=replay_headers,
        )
        assert replay.status_code == 200

    with pytest.raises(HTTPException) as error:
        await lazy_create_user_with_personal_project(
            db_session,
            clerk_id=subject,
            clerk_issuer=_ISSUER,
            email=None,
            name=None,
            race_loser_status=500,
        )
    await db_session.rollback()
    projection = await db_session.scalar(
        select(ClerkPrincipalAuthority).where(ClerkPrincipalAuthority.subject == subject)
    )
    assert error.value.status_code == 403
    assert projection is not None and projection.banned is True


async def test_delete_wins_over_authoritative_unban(
    anon_client,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    subject = f"delete_wins_{uuid.uuid4().hex}"
    assert (
        await _delete(anon_client, subject, message_id=f"msg_{uuid.uuid4().hex}")
    ).status_code == 200

    def fail_if_clerk_is_called(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("tombstoned update must not call Clerk")

    monkeypatch.setattr(clerk_webhooks.httpx, "AsyncClient", fail_if_clerk_is_called)
    assert (
        await _update(anon_client, subject, message_id=f"msg_{uuid.uuid4().hex}")
    ).status_code == 200
    with pytest.raises(PrincipalTerminatedError):
        await assert_clerk_principal_active(db_session, issuer=_ISSUER, subject=subject)


async def test_signature_timestamp_and_body_validation_precede_persistence(
    anon_client,
    db_session,
) -> None:
    payload = _payload(f"invalid_{uuid.uuid4().hex}")
    invalid_signature = _signed_headers(payload, message_id="msg_invalid_signature")
    invalid_signature["svix-signature"] = "v1,invalid"
    bad = await anon_client.post(
        "/v1/webhooks/clerk",
        content=payload,
        headers=invalid_signature,
    )
    stale_headers = _signed_headers(
        payload,
        message_id="msg_stale",
        envelope_timestamp=int(time.time()) - settings.clerk_webhook_tolerance_seconds - 1,
    )
    stale = await anon_client.post(
        "/v1/webhooks/clerk",
        content=payload,
        headers=stale_headers,
    )
    malformed = b'{"object":"event","type":"user.deleted","data":{}}'
    invalid_body = await anon_client.post(
        "/v1/webhooks/clerk",
        content=malformed,
        headers=_signed_headers(malformed, message_id="msg_invalid_body"),
    )

    assert bad.status_code == stale.status_code == invalid_body.status_code == 400
    assert await db_session.scalar(select(func.count()).select_from(PrincipalLifecycle)) == 0
    assert await db_session.scalar(select(func.count()).select_from(ClerkWebhookEventReceipt)) == 0


async def test_verified_message_is_durable_idempotent_evidence(anon_client, db_session) -> None:
    subject = f"idempotent_{uuid.uuid4().hex}"
    message_id = f"msg_{uuid.uuid4().hex}"
    payload = _payload(subject)
    headers = _signed_headers(payload, message_id=message_id)
    first = await anon_client.post("/v1/webhooks/clerk", content=payload, headers=headers)
    duplicate = await anon_client.post("/v1/webhooks/clerk", content=payload, headers=headers)

    conflicting_payload = _payload(f"different_{uuid.uuid4().hex}")
    conflict = await anon_client.post(
        "/v1/webhooks/clerk",
        content=conflicting_payload,
        headers=_signed_headers(conflicting_payload, message_id=message_id),
    )

    assert first.status_code == duplicate.status_code == 200
    assert conflict.status_code == 400
    lifecycle = await db_session.scalar(
        select(PrincipalLifecycle).where(PrincipalLifecycle.subject == subject)
    )
    assert lifecycle is not None and lifecycle.cleanup_completed_at is not None
    receipts = tuple(
        await db_session.scalars(
            select(ClerkWebhookEventReceipt).where(
                ClerkWebhookEventReceipt.lifecycle_id == lifecycle.id
            )
        )
    )
    assert len(receipts) == 1
    assert receipts[0].payload_sha256 == hashlib.sha256(payload).hexdigest()


async def test_delete_before_create_fences_lazy_create_and_owner_mutations(
    anon_client,
    db_session,
) -> None:
    subject = f"missing_{uuid.uuid4().hex}"
    response = await _delete(
        anon_client,
        subject,
        message_id=f"msg_{uuid.uuid4().hex}",
    )
    assert response.status_code == 200

    with pytest.raises(HTTPException) as lazy_error:
        await lazy_create_user_with_personal_project(
            db_session,
            clerk_id=subject,
            clerk_issuer=_ISSUER,
            email=None,
            name=None,
            race_loser_status=500,
        )
    await db_session.rollback()
    admin = await anon_client.post(
        "/v1/admin/auth/keys",
        headers={"X-Admin-Key": _ADMIN_KEY},
        json={"target_clerk_id": subject, "label": "stale-admin"},
    )
    platform = await anon_client.post(
        "/v1/platform/agents",
        headers={
            "X-Admin-Key": _ADMIN_KEY,
            "Idempotency-Key": f"agent-{uuid.uuid4().hex}",
        },
        json={
            "owner": {"kind": "clerk", "ref": subject},
            "agent_id": str(uuid.uuid4()),
            "machine_id": "stale",
            "machine_name": "stale",
            "agent_type": "openclaw",
            "os_name": "linux",
        },
    )

    assert lazy_error.value.status_code == 403
    assert admin.status_code == platform.status_code == 403
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None


async def test_cleanup_failure_keeps_fence_and_same_message_retries(
    anon_client,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="direct-webhook-retry",
        commit=True,
    )
    payload = _payload(seed_user.clerk_id)
    message_id = f"msg_{uuid.uuid4().hex}"
    headers = _signed_headers(payload, message_id=message_id)

    async def _fail_cleanup(*args, **kwargs):
        raise RuntimeError("injected cleanup failure")

    with monkeypatch.context() as scoped:
        scoped.setattr(clerk_webhooks, "complete_principal_cleanup", _fail_cleanup)
        failed = await anon_client.post(
            "/v1/webhooks/clerk",
            content=payload,
            headers=headers,
        )
    assert failed.status_code == 503
    lifecycle = await db_session.scalar(
        select(PrincipalLifecycle).where(PrincipalLifecycle.subject == seed_user.clerk_id)
    )
    assert lifecycle is not None
    assert lifecycle.cleanup_completed_at is None
    assert await db_session.get(ClerkWebhookEventReceipt, message_id) is not None

    stale_key = await anon_client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {minted.raw_key}"},
    )
    repaired = await anon_client.post(
        "/v1/webhooks/clerk",
        content=payload,
        headers=headers,
    )
    await db_session.refresh(lifecycle)
    await db_session.refresh(minted.api_key)
    assert stale_key.status_code == 401
    assert repaired.status_code == 200
    assert lifecycle.cleanup_completed_at is not None
    assert minted.api_key.revoked_at is not None


async def test_unrelated_clerk_tombstone_does_not_fence_partner_tenant(
    anon_client,
    db_session,
) -> None:
    assert (
        await _delete(
            anon_client,
            f"unrelated_{uuid.uuid4().hex}",
            message_id=f"msg_{uuid.uuid4().hex}",
        )
    ).status_code == 200
    partner_ref = f"partner:{uuid.uuid4().hex}"
    partner = await lazy_create_partner_user_with_personal_project(
        db_session,
        partner_tenant_ref=partner_ref,
        race_loser_status=500,
    )
    await db_session.commit()
    agent_id = uuid.uuid4()
    created = await anon_client.post(
        "/v1/platform/agents",
        headers={
            "X-Admin-Key": _ADMIN_KEY,
            "Idempotency-Key": f"partner-{uuid.uuid4().hex}",
        },
        json={
            "owner": {"kind": PRINCIPAL_KIND_PARTNER_TENANT, "ref": partner_ref},
            "agent_id": str(agent_id),
            "machine_id": "partner",
            "machine_name": "partner",
            "agent_type": "openclaw",
            "os_name": "linux",
        },
    )
    assert created.status_code == 200, created.text
    assert partner.principal_kind == PRINCIPAL_KIND_PARTNER_TENANT
    assert await db_session.get(AgentEnvironment, agent_id) is not None


@pytest.mark.committed_db
async def test_signed_delete_waits_for_active_shared_authority_mutation(
    engine,
    db_session,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    subject = seed_user.clerk_id
    assert subject is not None
    seed_user.clerk_issuer = _ISSUER
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    mutation_ready = asyncio.Event()
    release_mutation = asyncio.Event()
    fence_started = asyncio.Event()
    fence_pid: int | None = None
    minted_key_id: uuid.UUID | None = None
    original_fence = clerk_webhooks.fence_clerk_user_deleted

    async def _observed_fence(db, **kwargs):
        nonlocal fence_pid
        fence_pid = await db.scalar(select(func.pg_backend_pid()))
        fence_started.set()
        return await original_fence(db, **kwargs)

    async def _fresh_session():
        async with session_factory() as session:
            yield session

    async def _active_mutation() -> None:
        nonlocal minted_key_id
        async with session_factory() as session:
            await assert_clerk_principal_active(
                session,
                issuer=_ISSUER,
                subject=subject,
            )
            minted = await mint_api_key(
                session,
                user_id=seed_user.id,
                label="shared-before-signed-delete",
                commit=False,
            )
            minted_key_id = minted.api_key.id
            mutation_ready.set()
            await asyncio.wait_for(release_mutation.wait(), timeout=5)
            await session.commit()

    payload = _payload(subject)
    previous_session_override = app.dependency_overrides.get(get_session)
    monkeypatch.setattr(clerk_webhooks, "fence_clerk_user_deleted", _observed_fence)
    app.dependency_overrides[get_session] = _fresh_session
    mutation_task = asyncio.create_task(_active_mutation())
    delete_task: asyncio.Task | None = None
    lifecycle: PrincipalLifecycle | None = None
    try:
        await asyncio.wait_for(mutation_ready.wait(), timeout=5)
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            delete_task = asyncio.create_task(
                client.post(
                    "/v1/webhooks/clerk",
                    content=payload,
                    headers=_signed_headers(
                        payload,
                        message_id=f"msg_lock_{uuid.uuid4().hex}",
                    ),
                )
            )
            await asyncio.wait_for(fence_started.wait(), timeout=5)
            assert fence_pid is not None
            async with session_factory() as observer:
                for _ in range(100):
                    waiting = await observer.scalar(
                        text(
                            "SELECT EXISTS (SELECT 1 FROM pg_locks "
                            "WHERE pid = :pid AND locktype = 'advisory' "
                            "AND NOT granted)"
                        ),
                        {"pid": fence_pid},
                    )
                    if waiting:
                        break
                    await asyncio.sleep(0.01)
                assert waiting is True

            release_mutation.set()
            await asyncio.wait_for(mutation_task, timeout=5)
            response = await asyncio.wait_for(delete_task, timeout=10)
            assert response.status_code == 200

        async with session_factory() as session:
            assert minted_key_id is not None
            api_key = await session.get(ApiKey, minted_key_id)
            assert api_key is not None and api_key.revoked_at is not None
            with pytest.raises(PrincipalTerminatedError):
                await assert_user_authority_active(session, seed_user.id)
            await session.rollback()
            lifecycle = await session.scalar(
                select(PrincipalLifecycle).where(
                    PrincipalLifecycle.issuer == _ISSUER,
                    PrincipalLifecycle.subject == subject,
                )
            )
            assert lifecycle is not None
            await session.delete(lifecycle)
            await session.commit()
    finally:
        if previous_session_override is None:
            app.dependency_overrides.pop(get_session, None)
        else:
            app.dependency_overrides[get_session] = previous_session_override
        release_mutation.set()
        for task in (mutation_task, delete_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (mutation_task, delete_task) if task is not None),
            return_exceptions=True,
        )
