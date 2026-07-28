"""Typed global App Settings and admin mutation contracts."""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.app_setting import AppSetting
from app.models.audit import ControlPlaneAuditEvent
from app.services.app_setting_registry import CLERK_CLI_OAUTH_SPEC
from app.services.app_settings import AppSettingUnavailable, resolve_app_setting
from app.services.clerk_cli_oauth_settings import (
    CLERK_CLI_OAUTH_SETTING_ADAPTER,
    CLERK_CLI_OAUTH_SETTING_KEY,
)

_ADMIN_KEY = "test-app-settings-admin-key"
_ADMIN_HEADERS = {"X-Admin-Key": _ADMIN_KEY}


def _configured_value(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "enabled": False,
        "schema_version": 1,
        "issuer": "https://Clerk.Example.test:443/",
        "client_id": " client_cli ",
        "application_id": " oauthapp_cli ",
        "redirect_uri": "http://127.0.0.1:18473/oauth/callback",
        "audience": " clawdi-cloud-api ",
        "authorized_parties": [
            "https://Accounts.Example.test:443/",
            "http://127.0.0.1:18473/",
            "https://accounts.example.test",
        ],
    }
    value.update(overrides)
    return value


@pytest_asyncio.fixture
async def app_settings_admin_client(
    db_session: AsyncSession,
) -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_session():
        yield db_session

    previous_admin_key = settings.admin_api_key
    previous_overrides = dict(app.dependency_overrides)
    settings.admin_api_key = _ADMIN_KEY
    app.dependency_overrides[get_session] = _override_get_session
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client
    finally:
        settings.admin_api_key = previous_admin_key
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)


def test_clerk_cli_oauth_setting_is_strict_atomic_and_canonical() -> None:
    validated = CLERK_CLI_OAUTH_SETTING_ADAPTER.validate_python(_configured_value())

    assert validated.model_dump(mode="json") == {
        "enabled": False,
        "schema_version": 1,
        "issuer": "https://clerk.example.test",
        "client_id": "client_cli",
        "application_id": "oauthapp_cli",
        "redirect_uri": "http://127.0.0.1:18473/oauth/callback",
        "audience": "clawdi-cloud-api",
        "authorized_parties": [
            "http://127.0.0.1:18473",
            "https://accounts.example.test",
        ],
    }

    for invalid in (
        _configured_value(issuer=""),
        _configured_value(client_id=""),
        _configured_value(application_id=""),
        _configured_value(redirect_uri=""),
        _configured_value(authorized_parties=["  "]),
        _configured_value(redirect_uri="https://accounts.example.test/oauth/callback"),
        _configured_value(redirect_uri="http://localhost:18473/callback"),
        _configured_value(redirect_uri="http://localhost:80/oauth/callback"),
        _configured_value(schema_version=2),
        {**_configured_value(), "client_secret": "must-not-exist"},
    ):
        with pytest.raises(ValidationError):
            CLERK_CLI_OAUTH_SETTING_ADAPTER.validate_python(invalid)

    optional_claim_binding = CLERK_CLI_OAUTH_SETTING_ADAPTER.validate_python(
        _configured_value(enabled=True, audience="", authorized_parties=[])
    )
    assert optional_claim_binding.audience == ""
    assert optional_claim_binding.authorized_parties == []


@pytest.mark.asyncio
async def test_app_setting_resolver_fails_closed_for_missing_or_malformed_value(
    db_session: AsyncSession,
) -> None:
    row = await db_session.get(AppSetting, CLERK_CLI_OAUTH_SETTING_KEY)
    if row is not None:
        await db_session.delete(row)
        await db_session.flush()
    with pytest.raises(AppSettingUnavailable, match="missing"):
        await resolve_app_setting(db_session, CLERK_CLI_OAUTH_SPEC)

    db_session.add(
        AppSetting(
            key=CLERK_CLI_OAUTH_SETTING_KEY,
            value_json={"enabled": True, "schema_version": 1},
        )
    )
    await db_session.flush()
    with pytest.raises(AppSettingUnavailable, match="invalid"):
        await resolve_app_setting(db_session, CLERK_CLI_OAUTH_SPEC)


@pytest.mark.asyncio
async def test_admin_app_setting_upsert_is_guarded_canonical_atomic_and_audited(
    app_settings_admin_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    unauthorized = await app_settings_admin_client.get("/v1/admin/settings")
    assert unauthorized.status_code == 401

    response = await app_settings_admin_client.put(
        f"/v1/admin/settings/{CLERK_CLI_OAUTH_SETTING_KEY}",
        headers=_ADMIN_HEADERS,
        json={"value": _configured_value(enabled=True)},
    )
    assert response.status_code == 200, response.text
    expected = {
        "enabled": True,
        "schema_version": 1,
        "issuer": "https://clerk.example.test",
        "client_id": "client_cli",
        "application_id": "oauthapp_cli",
        "redirect_uri": "http://127.0.0.1:18473/oauth/callback",
        "audience": "clawdi-cloud-api",
        "authorized_parties": [
            "http://127.0.0.1:18473",
            "https://accounts.example.test",
        ],
    }
    assert response.json()["value"] == expected

    listed = await app_settings_admin_client.get(
        "/v1/admin/settings",
        headers=_ADMIN_HEADERS,
    )
    fetched = await app_settings_admin_client.get(
        f"/v1/admin/settings/{CLERK_CLI_OAUTH_SETTING_KEY}",
        headers=_ADMIN_HEADERS,
    )
    assert listed.status_code == 200
    assert [item["key"] for item in listed.json()["items"]] == [CLERK_CLI_OAUTH_SETTING_KEY]
    assert fetched.status_code == 200
    assert fetched.json()["value"] == expected

    event = (
        await db_session.execute(
            select(ControlPlaneAuditEvent).where(
                ControlPlaneAuditEvent.action == "app_setting.upsert",
                ControlPlaneAuditEvent.resource_id == CLERK_CLI_OAUTH_SETTING_KEY,
            )
        )
    ).scalar_one()
    assert event.actor_type == "admin"
    assert event.resource_type == "app_setting"
    assert event.source == "api.admin"
    assert event.details == {
        "created": False,
        "previous_enabled": False,
        "enabled": True,
        "schema_version": 1,
    }
    assert "oauthapp_cli" not in str(event.details)


@pytest.mark.asyncio
async def test_admin_app_setting_rejects_unknown_and_invalid_values_without_partial_write(
    app_settings_admin_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    row = await db_session.get(AppSetting, CLERK_CLI_OAUTH_SETTING_KEY)
    assert row is not None
    original = row.value_json
    audit_count = (
        await db_session.execute(
            select(func.count())
            .select_from(ControlPlaneAuditEvent)
            .where(
                ControlPlaneAuditEvent.action == "app_setting.upsert",
                ControlPlaneAuditEvent.resource_id == CLERK_CLI_OAUTH_SETTING_KEY,
            )
        )
    ).scalar_one()

    invalid = await app_settings_admin_client.put(
        f"/v1/admin/settings/{CLERK_CLI_OAUTH_SETTING_KEY}",
        headers=_ADMIN_HEADERS,
        json={"value": _configured_value(client_id="")},
    )
    unknown = await app_settings_admin_client.put(
        "/v1/admin/settings/unknown",
        headers=_ADMIN_HEADERS,
        json={"value": {}},
    )

    assert invalid.status_code == 400
    assert invalid.json() == {"detail": "Invalid app setting value"}
    assert unknown.status_code == 404
    await db_session.refresh(row)
    assert row.value_json == original
    assert (
        await db_session.execute(
            select(func.count())
            .select_from(ControlPlaneAuditEvent)
            .where(
                ControlPlaneAuditEvent.action == "app_setting.upsert",
                ControlPlaneAuditEvent.resource_id == CLERK_CLI_OAUTH_SETTING_KEY,
            )
        )
    ).scalar_one() == audit_count

    delete = await app_settings_admin_client.delete(
        f"/v1/admin/settings/{CLERK_CLI_OAUTH_SETTING_KEY}",
        headers=_ADMIN_HEADERS,
    )
    assert delete.status_code == 405
