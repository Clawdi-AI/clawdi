from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from app.core.config import settings
from app.models.api_key import ApiKey
from app.models.audit import ControlPlaneAuditEvent
from app.models.principal_lifecycle import (
    ClerkPrincipalAuthority,
    ClerkPrincipalSuspension,
    PrincipalLifecycle,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.services.api_key import mint_api_key
from app.services.principal_lifecycle import (
    PrincipalSuspendedError,
    PrincipalTerminatedError,
    assert_clerk_principal_active,
    assert_user_authority_active,
    fence_clerk_user_deleted,
    project_clerk_user_authority,
    set_clerk_principal_suspension,
)
from app.services.user_provisioning import lazy_create_user_with_personal_project
from tests.conftest import create_env_with_project, create_test_hosted_runtime_state

pytestmark = pytest.mark.asyncio

_ISSUER = "https://platform-suspension.clerk.example.test"
_ADMIN_KEY = "platform-suspension-admin-test"
_AUTH = {"X-Admin-Key": _ADMIN_KEY}


@pytest.fixture(autouse=True)
def _suspension_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "clerk_jwt_issuer", _ISSUER)
    monkeypatch.setattr(settings, "admin_api_key", _ADMIN_KEY)


async def _set_suspension(
    client,
    *,
    subject: str,
    suspended: bool,
    reason: str,
):
    return await client.put(
        "/v1/admin/auth/suspensions",
        headers=_AUTH,
        json={
            "target_clerk_id": subject,
            "suspended": suspended,
            "reason": reason,
        },
    )


async def test_api_keys_are_denied_and_recover_without_credential_mutation(
    anon_client,
    db_session,
    seed_user,
) -> None:
    environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"suspension-runtime-{uuid.uuid4().hex}",
        machine_name="Suspension runtime",
    )
    runtime_state = await create_test_hosted_runtime_state(
        db_session,
        environment,
        runtime_name="openclaw",
    )
    normal_key = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="suspension-normal",
        commit=True,
    )
    runtime_key = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="suspension-runtime",
        environment_id=environment.id,
        runtime_deployment_id=runtime_state.deployment_id,
        managed=True,
        commit=True,
    )
    keys = (normal_key, runtime_key)
    for key in keys:
        response = await anon_client.get(
            "/v1/auth/me",
            headers={"Authorization": f"Bearer {key.raw_key}"},
        )
        assert response.status_code == 200, response.text

    suspended = await _set_suspension(
        anon_client,
        subject=seed_user.clerk_id,
        suspended=True,
        reason="security_review",
    )
    assert suspended.status_code == 200, suspended.text
    assert suspended.headers["cache-control"] == "no-store, private"
    assert suspended.json()["changed"] is True
    for key in keys:
        response = await anon_client.get(
            "/v1/auth/me",
            headers={"Authorization": f"Bearer {key.raw_key}"},
        )
        assert response.status_code == 401, response.text
        assert response.headers["content-type"] == "application/problem+json"
        assert response.headers["cache-control"] == "no-store, private"
        assert response.headers["www-authenticate"] == "Bearer"
        assert response.json() == {
            "type": "urn:clawdi:problem:account-suspended",
            "title": "Account suspended",
            "status": 401,
            "detail": "Account is suspended",
            "code": "account_suspended",
        }
        assert "security_review" not in response.text

    persisted_keys = list(
        await db_session.scalars(select(ApiKey).where(ApiKey.user_id == seed_user.id))
    )
    assert {key.id for key in persisted_keys} >= {
        normal_key.api_key.id,
        runtime_key.api_key.id,
    }
    assert all(key.revoked_at is None for key in persisted_keys)
    assert await db_session.get(User, seed_user.id) is not None
    assert await db_session.get(AgentEnvironment, environment.id) is not None

    restored = await _set_suspension(
        anon_client,
        subject=seed_user.clerk_id,
        suspended=False,
        reason="security_review_complete",
    )
    assert restored.status_code == 200, restored.text
    assert restored.headers["cache-control"] == "no-store, private"
    assert restored.json() == {
        "target_clerk_id": seed_user.clerk_id,
        "suspended": False,
        "suspended_at": None,
        "changed": True,
    }
    for key in keys:
        response = await anon_client.get(
            "/v1/auth/me",
            headers={"Authorization": f"Bearer {key.raw_key}"},
        )
        assert response.status_code == 200, response.text

    audit_events = list(
        await db_session.scalars(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.resource_type == "clerk_principal",
                ControlPlaneAuditEvent.resource_id == seed_user.clerk_id,
            )
        )
    )
    events_by_action = {event.action: event for event in audit_events}
    assert set(events_by_action) == {"principal.suspend", "principal.unsuspend"}
    assert events_by_action["principal.suspend"].details["reason"] == "security_review"
    assert events_by_action["principal.unsuspend"].details["reason"] == "security_review_complete"
    assert all(event.target_user_id == seed_user.id for event in audit_events)


async def test_prelogin_subject_fence_is_idempotent_and_never_provisions_user(
    anon_client,
    db_session,
) -> None:
    subject = f"prelogin_{uuid.uuid4().hex}"
    first = await _set_suspension(
        anon_client,
        subject=subject,
        suspended=True,
        reason="prelogin_review",
    )
    repeated = await _set_suspension(
        anon_client,
        subject=subject,
        suspended=True,
        reason="prelogin_review",
    )
    assert first.status_code == repeated.status_code == 200
    assert first.json()["changed"] is True
    assert repeated.json()["changed"] is False
    assert repeated.json()["suspended_at"] == first.json()["suspended_at"]
    assert (
        await db_session.scalar(
            select(func.count(ClerkPrincipalSuspension.subject)).where(
                ClerkPrincipalSuspension.issuer == _ISSUER,
                ClerkPrincipalSuspension.subject == subject,
            )
        )
        == 1
    )
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None

    with pytest.raises(HTTPException) as error:
        await lazy_create_user_with_personal_project(
            db_session,
            clerk_id=subject,
            clerk_issuer=_ISSUER,
            email=None,
            name=None,
            race_loser_status=500,
        )
    assert error.value.status_code == 403
    await db_session.rollback()

    invalid = await _set_suspension(
        anon_client,
        subject=f"invalid_{uuid.uuid4().hex}",
        suspended=True,
        reason=" padded ",
    )
    assert invalid.status_code == 422

    cleared = await _set_suspension(
        anon_client,
        subject=subject,
        suspended=False,
        reason="prelogin_review_complete",
    )
    repeated_clear = await _set_suspension(
        anon_client,
        subject=subject,
        suspended=False,
        reason="prelogin_review_complete",
    )
    assert cleared.status_code == repeated_clear.status_code == 200
    assert cleared.json()["changed"] is True
    assert repeated_clear.json()["changed"] is False
    assert await db_session.get(ClerkPrincipalSuspension, (_ISSUER, subject)) is None
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None


async def test_clerk_unban_projection_cannot_clear_platform_suspension(
    db_session,
    seed_user,
) -> None:
    user_id = seed_user.id
    await set_clerk_principal_suspension(
        db_session,
        issuer=_ISSUER,
        subject=seed_user.clerk_id,
        suspended=True,
        reason="independent_projection",
    )
    observed_at = datetime(2026, 8, 21, tzinfo=UTC)
    await project_clerk_user_authority(
        db_session,
        issuer=_ISSUER,
        subject=seed_user.clerk_id,
        banned=True,
        authority_updated_at=observed_at,
        message_id=f"msg_{uuid.uuid4().hex}",
        payload_sha256="a" * 64,
    )
    await project_clerk_user_authority(
        db_session,
        issuer=_ISSUER,
        subject=seed_user.clerk_id,
        banned=False,
        authority_updated_at=observed_at + timedelta(seconds=1),
        message_id=f"msg_{uuid.uuid4().hex}",
        payload_sha256="b" * 64,
    )
    await db_session.commit()

    projection = await db_session.scalar(
        select(ClerkPrincipalAuthority).where(
            ClerkPrincipalAuthority.issuer == _ISSUER,
            ClerkPrincipalAuthority.subject == seed_user.clerk_id,
        )
    )
    assert projection is not None and projection.banned is False
    assert (
        await db_session.get(
            ClerkPrincipalSuspension,
            (_ISSUER, seed_user.clerk_id),
        )
        is not None
    )
    with pytest.raises(PrincipalSuspendedError):
        await assert_clerk_principal_active(
            db_session,
            issuer=_ISSUER,
            subject=seed_user.clerk_id,
        )
    await db_session.rollback()
    with pytest.raises(PrincipalSuspendedError):
        await assert_user_authority_active(db_session, user_id)


async def test_deletion_dominates_suspension_and_unban_only_removes_fence(
    anon_client,
    db_session,
) -> None:
    subject = f"deleted_{uuid.uuid4().hex}"
    assert (
        await _set_suspension(
            anon_client,
            subject=subject,
            suspended=True,
            reason="pending_deletion",
        )
    ).status_code == 200
    receipt = await fence_clerk_user_deleted(
        db_session,
        issuer=_ISSUER,
        subject=subject,
        message_id=f"msg_{uuid.uuid4().hex}",
        payload_sha256="c" * 64,
        event_occurred_at=datetime.now(UTC),
    )
    await db_session.commit()
    assert receipt.user_id is None

    cleared = await _set_suspension(
        anon_client,
        subject=subject,
        suspended=False,
        reason="deletion_is_authoritative",
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["changed"] is True
    assert await db_session.get(ClerkPrincipalSuspension, (_ISSUER, subject)) is None
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None
    assert (
        await db_session.scalar(
            select(PrincipalLifecycle.id).where(
                PrincipalLifecycle.issuer == _ISSUER,
                PrincipalLifecycle.subject == subject,
            )
        )
        is not None
    )

    with pytest.raises(PrincipalTerminatedError) as error:
        await assert_clerk_principal_active(
            db_session,
            issuer=_ISSUER,
            subject=subject,
        )
    assert type(error.value) is PrincipalTerminatedError
    await db_session.rollback()

    rejected = await _set_suspension(
        anon_client,
        subject=subject,
        suspended=True,
        reason="must_not_resurrect",
    )
    assert rejected.status_code == 409
    assert await db_session.get(ClerkPrincipalSuspension, (_ISSUER, subject)) is None
    assert await db_session.scalar(select(User.id).where(User.clerk_id == subject)) is None
