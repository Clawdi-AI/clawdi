from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_RUNTIME_MARKER_DISCORD_GATEWAY_TERMINAL_CLOSE,
    CHANNEL_VISIBILITY_PUBLIC,
    MESSAGE_DIRECTION_INBOUND,
    PAIR_CODE_STATUS_PENDING,
    ChannelAccount,
    ChannelAccountRuntimeMarker,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelMessage,
    ChannelPairCode,
)
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import public as public_router
from app.routes.channel_routers import shared as shared_router
from app.routes.channel_routers.discord import (
    cleanup_discord_guild_commands_after_authority_revoked,
)
from app.routes.channel_routers.shared import discord_gateway_dispatch
from app.services import channel_config as channel_config_service
from app.services import channels as channel_service
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channels import (
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    discord_control_command_from_payload,
    discord_control_reply_for_command,
    encrypt_optional_token,
    extract_discord_routing_key,
    hash_token,
    record_discord_dispatch,
)
from app.services.discord_command_reconciliation_worker import (
    DiscordCommandReconciliationWorker,
    reconcile_discord_guild_commands,
)
from app.services.discord_gateway_worker import (
    discord_gateway_account_revision,
    record_discord_gateway_dispatch,
)
from app.services.discord_rate_limiter import DiscordRateLimiter
from app.services.url_security import UnsafeOutboundUrlError
from tests.channel_helpers import (
    _REAL_DISCORD_BOT_GUILD_MEMBERSHIP_CHECK,
    DISCORD_TEST_APPLICATION_ID,
    DISCORD_TEST_PUBLIC_KEY,
    _archive_discord_binding_with_identity_lock,
    _clear_fake_provider_calls,
    _client_for_user,
    _create_admin_channel,
    _create_paired_discord_channel,
    _create_public_discord_account,
    _create_user_with_channel_agent,
    _discord_provider_result,
    _discord_ready_config,
    _DiscordPreparationProviderClient,
    _FailingProviderClient,
    _FakeProviderClient,
    _FakeProviderResponse,
    _install_discord_gateway_test_session_factory,
    _make_discord_projection_due,
    _make_discord_retry_due,
    _record_discord_interaction,
    _reset_discord_gateway_sessions,
    _reset_fake_provider_client,
    _seed_created_channel_link,
    _StatefulDiscordCommandClient,
)
from tests.db_lock_helpers import wait_for_lock_wait

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]


@pytest.fixture(autouse=True)
def _verified_discord_guild_membership(monkeypatch: pytest.MonkeyPatch) -> None:
    original_configure = public_router.configure_discord_application
    original_sync = public_router.sync_channel_commands
    original_verify_token = admin_router.verify_discord_application_token_identity

    async def verified_membership(
        _account: ChannelAccount,
        *,
        guild_id: str,
    ) -> channel_service.DiscordGuildMembershipCheck:
        assert guild_id
        return channel_service.DiscordGuildMembershipCheck()

    async def configure_test_discord_application(account: ChannelAccount) -> dict[str, Any]:
        config = dict(account.config) if isinstance(account.config, dict) else {}
        if config.get("_test_discord_server_state") is not True:
            return await original_configure(account)
        config["discord_install_config_version"] = channel_service.DISCORD_INSTALL_CONFIG_VERSION
        config["discord_user_install_supported"] = True
        account.config = config
        return {
            "id": config.get("application_id"),
            "integration_types_config": {"0": {}, "1": {}},
        }

    async def sync_test_discord_commands(
        *,
        account: ChannelAccount,
        commands: list[dict[str, Any]] | None = None,
        guild_id: str | None = None,
        use_configured_discord_guild: bool | None = None,
    ) -> list[dict[str, Any]]:
        config = account.config if isinstance(account.config, dict) else {}
        if (
            config.get("_test_discord_server_state") is True
            and channel_service.discord_reserved_commands_are_current(account)
            and commands is None
            and use_configured_discord_guild is False
        ):
            return []
        return await original_sync(
            account=account,
            commands=commands,
            guild_id=guild_id,
            use_configured_discord_guild=use_configured_discord_guild,
        )

    async def verify_test_discord_token_identity(
        *,
        application_id: str,
        provider_token: str,
        config: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if isinstance(config, dict) and config.get("_test_discord_server_state") is True:
            return {"id": application_id}
        return await original_verify_token(
            application_id=application_id,
            provider_token=provider_token,
            config=config,
        )

    monkeypatch.setattr(
        channel_service,
        "discord_bot_guild_membership_check",
        verified_membership,
    )
    monkeypatch.setattr(
        public_router,
        "configure_discord_application",
        configure_test_discord_application,
    )
    monkeypatch.setattr(public_router, "sync_channel_commands", sync_test_discord_commands)
    monkeypatch.setattr(
        admin_router,
        "verify_discord_application_token_identity",
        verify_test_discord_token_identity,
    )
    monkeypatch.setattr(discord_router, "verify_discord_signature", lambda **_kwargs: True)


@pytest_asyncio.fixture(autouse=True)
async def _reset_channel_provider_http_client():
    await channel_service.close_channel_provider_http_client()
    _reset_fake_provider_client()
    _clear_fake_provider_calls()
    try:
        yield
    finally:
        await channel_service.close_channel_provider_http_client()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {
            "provider": "discord",
            "name": "discord-create-missing-token",
            "config": _discord_ready_config(),
        },
        {
            "provider": "discord",
            "name": "discord-create-missing-application",
            "provider_token": "discord-provider-token",
            "config": {"public_key": DISCORD_TEST_PUBLIC_KEY},
        },
        {
            "provider": "discord",
            "name": "discord-create-missing-public-key",
            "provider_token": "discord-provider-token",
            "config": {"application_id": DISCORD_TEST_APPLICATION_ID},
        },
        {
            "provider": "discord",
            "name": "discord-create-invalid-public-key",
            "provider_token": "discord-provider-token",
            "config": {
                "application_id": DISCORD_TEST_APPLICATION_ID,
                "public_key": "not-a-public-key",
            },
        },
    ],
)
async def test_create_discord_channel_requires_http_interactions_credentials(
    client: httpx.AsyncClient,
    payload: dict[str, Any],
):
    response = await client.post("/v1/channels", json=payload)

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_historical_discord_without_public_key_is_readable_but_cannot_pair(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-historical-incomplete",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.config = {"application_id": DISCORD_TEST_APPLICATION_ID}
    await db_session.commit()

    readable = await client.get(f"/v1/channels/{created['id']}")
    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert readable.status_code == 200
    assert pair.status_code == 409
    assert "public_key" in pair.json()["detail"]

    listed = await client.get("/v1/channels")
    assert listed.status_code == 200
    assert listed.json()[0]["has_provider_token"] is True
    assert "webhook_secret" not in listed.text
    assert "telegram-secret" not in listed.text
    assert "agent_token" not in listed.text


@pytest.mark.asyncio
async def test_discord_connection_issue_uses_current_account_revision(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name=f"discord-runtime-marker-{uuid4().hex}",
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    revision = discord_gateway_account_revision(account)
    db_session.add(
        ChannelAccountRuntimeMarker(
            account_id=account.id,
            kind=CHANNEL_RUNTIME_MARKER_DISCORD_GATEWAY_TERMINAL_CLOSE,
            scope=revision,
            outcome="authentication_failed",
        )
    )
    await db_session.commit()

    listed = await client.get("/v1/channels")
    assert listed.status_code == 200, listed.text
    listed_account = next(item for item in listed.json() if item["id"] == created["id"])
    assert listed_account["connection_issue"] == "authentication_failed"
    fetched = await client.get(f"/v1/channels/{created['id']}")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["connection_issue"] == "authentication_failed"

    account.config = {
        **(account.config if isinstance(account.config, dict) else {}),
        "gateway_intents": 513,
    }
    await db_session.commit()
    listed_after_revision_change = await client.get("/v1/channels")
    assert listed_after_revision_change.status_code == 200
    changed_account = next(
        item for item in listed_after_revision_change.json() if item["id"] == created["id"]
    )
    assert changed_account["connection_issue"] is None


@pytest.mark.asyncio
async def test_discord_public_routes_reject_non_object_account_config_without_500(
    db_session: AsyncSession,
) -> None:
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="non-object-discord-config",
        agent_type="openclaw",
    )
    provider_token, provider_token_nonce = encrypt_optional_token("discord-token")
    account = channel_service.build_channel_account(
        owner_user_id=user.id,
        provider=CHANNEL_PROVIDER_DISCORD,
        name=f"non-object-discord-config-{uuid4().hex}",
        visibility="private",
        webhook_secret_hash=hash_token(uuid4().hex),
        encrypted_provider_token=provider_token,
        provider_token_nonce=provider_token_nonce,
    )
    db_session.add(account)
    await db_session.commit()
    await db_session.execute(
        update(ChannelAccount).where(ChannelAccount.id == account.id).values(config=[])
    )
    await db_session.commit()

    async with _client_for_user(db_session, user) as user_client:
        fetched = await user_client.get(f"/v1/channels/{account.id}")
        command_response = await user_client.post(
            f"/v1/channels/{account.id}/commands/sync",
            json={
                "commands": [
                    {
                        "name": "inspect_config_boundary",
                        "description": "Exercise account config validation",
                    }
                ],
                "guild_id": "test-guild",
            },
        )
        response = await user_client.post(
            f"/v1/channels/{account.id}/pair-codes",
            json={"agent_id": str(agent.id), "ttl_seconds": 900},
        )

    assert fetched.status_code == 200, fetched.text
    assert command_response.status_code == 400
    assert command_response.json() == {
        "detail": "discord application_id is required in channel config"
    }
    assert response.status_code == 400
    assert response.json() == {"detail": "Discord application_id is required."}


@pytest.mark.asyncio
async def test_discord_account_config_url_error_does_not_leak_validator_detail(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    marker = "internal-host.invalid Authorization: Bot validator-secret"

    async def reject_sensitive_url(_url: str, *, label: str) -> None:
        assert label == "discord api_base_url"
        raise UnsafeOutboundUrlError(marker)

    monkeypatch.setattr(
        channel_config_service,
        "validate_channel_http_url",
        reject_sensitive_url,
    )

    response = await client.post(
        "/v1/channels",
        json={
            "provider": "discord",
            "name": "discord-sensitive-config-error",
            "provider_token": "discord-token",
            "config": {
                **_discord_ready_config(),
                "api_base_url": "https://discord-provider.example/api/v10",
            },
        },
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "discord api_base_url must be a public https URL"}
    assert marker not in response.text


@pytest.mark.asyncio
async def test_discord_proxy_url_error_does_not_leak_validator_detail(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-sensitive-proxy-url-error",
        channel_id="discord-sensitive-channel",
        guild_id="discord-sensitive-guild",
    )
    marker = "127.0.0.1 signed_url=https://internal.invalid/?signature=secret"

    async def reject_sensitive_url(_url: str, *, label: str) -> None:
        assert label == "discord api base url"
        raise UnsafeOutboundUrlError(marker)

    monkeypatch.setattr(shared_router, "validate_channel_http_url", reject_sensitive_url)

    response = await client.get(
        "/v1/channels/discord/v10/guilds/discord-sensitive-guild",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "discord api base url must be a public https URL"}
    assert marker not in response.text


@pytest.mark.asyncio
async def test_discord_rest_gateway_bot_uses_agent_token(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-agent",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    response = await client.get(
        "/v1/channels/discord/v10/gateway/bot",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == 200
    gateway_url = urlparse(response.json()["url"])
    assert gateway_url.path.startswith("/v1/channels/discord/gateway/")
    assert gateway_url.path.rpartition("/")[2]
    assert response.json()["shards"] == 1


@pytest.mark.asyncio
async def test_discord_rest_accepts_preserve_path_mitm_alias(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-agent-preserve-path",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    response = await client.get(
        "/v1/channels/discord/api/v10/gateway/bot",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == 200
    gateway_url = urlparse(response.json()["url"])
    assert gateway_url.path.startswith("/v1/channels/discord/gateway/")
    assert gateway_url.path.rpartition("/")[2]


@pytest.mark.asyncio
async def test_discord_rest_application_commands_are_tenant_shadowed(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-shadow",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    headers = {"Authorization": f"Bot {created['agent_token']}"}
    rich_command = {
        "id": "virtual-command-id",
        "application_id": "untrusted-application-id",
        "guild_id": "response-only-guild",
        "version": "response-only-version",
        "name": "deploy",
        "name_localizations": {"de": "bereitstellen"},
        "name_localized": "localized response only",
        "description": "Deploy a service",
        "description_localizations": {"de": "Dienst bereitstellen"},
        "description_localized": "localized description response only",
        "default_member_permissions": "32",
        "nsfw": True,
        "integration_types": [0, 1],
        "contexts": [0, 1, 2],
        "dm_permission": False,
        "handler": 1,
        "future_command_field": {"preserved": True},
    }

    updated = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers=headers,
        json=[rich_command],
    )
    listed = await client.get(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers=headers,
    )
    reserved = await client.post(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers=headers,
        json={"name": "clawdi_pair", "description": "bad"},
    )
    invalid_object = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers=headers,
        json=["not-an-object"],
    )

    assert updated.status_code == 200
    shadowed = updated.json()[0]
    assert shadowed == {
        **rich_command,
        "application_id": DISCORD_TEST_APPLICATION_ID,
        "type": 1,
    }
    assert listed.json() == [shadowed]
    assert reserved.status_code == 400
    assert invalid_object.status_code == 400
    assert invalid_object.json() == {"detail": "application command object required"}


@pytest.mark.asyncio
async def test_discord_application_command_identity_validation_is_type_aware(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-identity-validation",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    missing_description = await client.post(
        command_url,
        headers=headers,
        json={"name": "missing_description", "type": 1},
    )
    empty_description = await client.post(
        command_url,
        headers=headers,
        json={"name": "empty_description", "type": 1, "description": "   "},
    )
    boolean_type = await client.post(
        command_url,
        headers=headers,
        json={"name": "boolean_type", "type": True, "description": "Invalid type"},
    )
    user_context = await client.post(
        command_url,
        headers=headers,
        json={"name": "inspect_user", "type": 2},
    )
    message_context = await client.post(
        command_url,
        headers=headers,
        json={"name": "inspect_message", "type": 3},
    )
    listed = await client.get(command_url, headers=headers)

    assert missing_description.status_code == 400
    assert missing_description.json() == {"detail": "command description is required"}
    assert empty_description.status_code == 400
    assert empty_description.json() == {"detail": "command description is required"}
    assert boolean_type.status_code == 400
    assert boolean_type.json() == {"detail": "command type is invalid"}
    assert user_context.status_code == 200
    assert user_context.json()["type"] == 2
    assert "description" not in user_context.json()
    assert message_context.status_code == 200
    assert message_context.json()["type"] == 3
    assert "description" not in message_context.json()
    assert [command["name"] for command in listed.json()] == [
        "inspect_user",
        "inspect_message",
    ]


@pytest.mark.asyncio
async def test_discord_application_command_lifecycle_is_tenant_shadowed(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"id": "provider-command"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-lifecycle",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    created_command = await client.post(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers=headers,
        json={"name": "deploy", "description": "Deploy"},
    )
    command_id = created_command.json()["id"]
    edited = await client.patch(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands/{command_id}",
        headers=headers,
        json={"description": "Deploy service"},
    )
    listed = await client.get(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers=headers,
    )
    deleted = await client.delete(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands/{command_id}",
        headers=headers,
    )
    missing = await client.patch(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands/missing",
        headers=headers,
        json={"description": "missing"},
    )
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=account.user_id,
            external_chat_id="channel-1",
            external_chat_type="guild_text",
            external_chat_name="guild-1",
        )
    )
    await db_session.commit()
    guild_created = await client.post(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-1/commands",
        headers=headers,
        json={"name": "guilddeploy", "description": "Guild deploy"},
    )
    guild_id = guild_created.json()["id"]
    guild_edited = await client.patch(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-1/commands/{guild_id}",
        headers=headers,
        json={"description": "Guild deploy service"},
    )

    assert created_command.status_code == 200
    assert edited.status_code == 200
    assert edited.json()["description"] == "Deploy service"
    assert listed.json()[0]["id"] == command_id
    assert deleted.status_code == 204
    assert missing.status_code == 404
    assert missing.json() == {"code": 10063, "message": "Unknown application command"}
    assert guild_created.status_code == 200
    assert guild_edited.json()["description"] == "Guild deploy service"


@pytest.mark.asyncio
async def test_discord_application_commands_validate_application_and_guild_scope(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-scope",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    wrong_app = await client.put(
        "/v1/channels/discord/v10/applications/wrong-app/commands",
        headers=headers,
        json=[{"name": "deploy", "description": "Deploy"}],
    )
    unbound_guild = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-404/commands",
        headers=headers,
        json=[{"name": "deploy", "description": "Deploy"}],
    )
    dm_create = await client.post(
        "/v1/channels/discord/v10/users/@me/channels",
        headers=headers,
        json={"recipient_id": "user-1"},
    )
    unknown = await client.post(
        "/v1/channels/discord/v10/unknown/path",
        headers=headers,
        json={},
    )

    assert wrong_app.status_code == 403
    assert wrong_app.json() == {"code": 50001, "message": "Missing Access"}
    assert unbound_guild.status_code == 403
    assert unbound_guild.json() == {"code": 50001, "message": "Missing Access"}
    assert dm_create.status_code == 403
    assert dm_create.json() == {"code": 50001, "message": "Missing Access"}
    assert unknown.status_code == 403
    assert unknown.json() == {"code": 50001, "message": "Missing Access"}


@pytest.mark.asyncio
async def test_discord_command_materialization_and_guild_management_are_application_scoped(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    other_application_id = "223456789012345678"
    _reset_fake_provider_client({"id": "provider-command"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-fanout",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    other = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-contender",
                "provider_token": "discord-provider-token-2",
                "config": _discord_ready_config(other_application_id),
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    other_account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(other["id"]))
        )
    ).scalar_one()
    for chat_id, guild_id, owner, link_id in (
        ("chan-owned", "guild-owned", account, created["agent_link_id"]),
        ("chan-contested-a", "guild-contested", account, created["agent_link_id"]),
        ("chan-contested-b", "guild-contested", other_account, other["agent_link_id"]),
    ):
        db_session.add(
            ChannelBinding(
                account_id=owner.id,
                bot_agent_link_id=UUID(link_id),
                user_id=owner.user_id,
                external_chat_id=chat_id,
                external_chat_type="guild_text",
                external_chat_name=guild_id,
            )
        )
    await db_session.commit()
    rich_command = {
        "id": "virtual-response-id",
        "application_id": "stale-application-id",
        "guild_id": "stale-guild-id",
        "version": "stale-version",
        "name": "deploy",
        "name_localizations": {"de": "bereitstellen"},
        "name_localized": "response-only-name",
        "description": "Deploy",
        "description_localizations": {"de": "Bereitstellen"},
        "description_localized": "response-only-description",
        "default_member_permissions": "32",
        "nsfw": True,
        "integration_types": [0, 1],
        "contexts": [0, 1, 2],
        "dm_permission": False,
        "handler": 1,
        "type": 1,
        "future_command_field": {"preserved": True},
    }

    first_global = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[rich_command],
    )

    assert first_global.status_code == 200
    assert first_global.json()[0] == {
        **rich_command,
        "application_id": DISCORD_TEST_APPLICATION_ID,
    }
    assert {urlparse(call["url"]).path for call in _FakeProviderClient.calls} == {
        f"/api/v10/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-owned/commands",
        f"/api/v10/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-contested/commands",
    }
    expected_provider_command = {
        "name": "deploy",
        "name_localizations": {"de": "bereitstellen"},
        "description": "Deploy",
        "description_localizations": {"de": "Bereitstellen"},
        "default_member_permissions": "32",
        "nsfw": True,
        "handler": 1,
        "type": 1,
        "future_command_field": {"preserved": True},
    }
    for call in _FakeProviderClient.calls:
        assert call["method"] == "PUT"
        assert call["headers"]["Authorization"] == "Bot discord-provider-token"
        assert json.loads(call["content"]) == [expected_provider_command]

    _reset_fake_provider_client({"id": "other-provider-command"})
    second_global = await client.put(
        f"/v1/channels/discord/v10/applications/{other_application_id}/commands",
        headers={"Authorization": f"Bot {other['agent_token']}"},
        json=[{"name": "other_deploy", "description": "Other deploy"}],
    )
    assert second_global.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith(
        f"/applications/{other_application_id}/guilds/guild-contested/commands"
    )
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == (
        "Bot discord-provider-token-2"
    )

    _reset_fake_provider_client({"id": "first-guild-command"})
    first_guild = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}"
        "/guilds/guild-contested/commands",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "first_guild", "description": "First guild"}],
    )
    assert first_guild.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith(
        f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-contested/commands"
    )

    _reset_fake_provider_client({"id": "second-guild-command"})
    second_guild = await client.put(
        f"/v1/channels/discord/v10/applications/{other_application_id}"
        "/guilds/guild-contested/commands",
        headers={"Authorization": f"Bot {other['agent_token']}"},
        json=[{"name": "second_guild", "description": "Second guild"}],
    )
    assert second_guild.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith(
        f"/applications/{other_application_id}/guilds/guild-contested/commands"
    )


@pytest.mark.asyncio
async def test_shared_discord_account_command_shadows_and_fanout_are_link_scoped(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"id": "provider-command"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-shared-link-command-isolation",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    link_b_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert link_b_response.status_code == 201, link_b_response.text
    link_b = link_b_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    tenant_user_id = account.user_id
    assert tenant_user_id is not None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    account.user_id = None
    db_session.add_all(
        [
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=UUID(created["agent_link_id"]),
                user_id=tenant_user_id,
                external_chat_id="shared-link-channel-a",
                external_chat_type="guild_text",
                external_chat_name="shared-link-guild-a",
            ),
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=UUID(link_b["id"]),
                user_id=tenant_user_id,
                external_chat_id="shared-link-channel-b",
                external_chat_type="guild_text",
                external_chat_name="shared-link-guild-b",
            ),
        ]
    )
    await db_session.commit()
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    headers_a = {"Authorization": f"Bot {created['agent_token']}"}
    headers_b = {"Authorization": f"Bot {link_b['agent_token']}"}

    stored_a = await client.put(
        command_url,
        headers=headers_a,
        json=[{"name": "agent_a", "description": "Agent A command"}],
    )
    assert stored_a.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith(
        f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/shared-link-guild-a/commands"
    )

    _reset_fake_provider_client({"id": "provider-command"})
    stored_b = await client.put(
        command_url,
        headers=headers_b,
        json=[{"name": "agent_b", "description": "Agent B command"}],
    )
    assert stored_b.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith(
        f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/shared-link-guild-b/commands"
    )
    listed_a = await client.get(command_url, headers=headers_a)
    listed_b = await client.get(command_url, headers=headers_b)
    assert [command["name"] for command in listed_a.json()] == ["agent_a"]
    assert [command["name"] for command in listed_b.json()] == ["agent_b"]
    link_a_row = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    link_b_row = await db_session.get(ChannelBotAgentLink, UUID(link_b["id"]))
    assert link_a_row is not None and link_b_row is not None
    await db_session.refresh(link_a_row)
    await db_session.refresh(link_b_row)
    assert link_a_row.config["discord_agent_commands"]["global"][0]["name"] == "agent_a"
    assert link_b_row.config["discord_agent_commands"]["global"][0]["name"] == "agent_b"

    cross_guild = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}"
        "/guilds/shared-link-guild-b/commands",
        headers=headers_a,
        json=[{"name": "cross", "description": "Must fail"}],
    )
    assert cross_guild.status_code == 403

    _reset_fake_provider_client({"id": "provider-command"})
    unlinked = await client.delete(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}"
    )
    assert unlinked.status_code == 204
    assert len(_FakeProviderClient.calls) == 1
    cleanup_call = _FakeProviderClient.calls[0]
    assert cleanup_call["method"] == "PUT"
    assert cleanup_call["url"].endswith(
        f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/shared-link-guild-a/commands"
    )
    assert cleanup_call["content"] == b"[]"
    assert "shared-link-guild-b" not in cleanup_call["url"]
    _reset_fake_provider_client({"id": "provider-command"})
    updated_b = await client.put(
        command_url,
        headers=headers_b,
        json=[{"name": "agent_b_updated", "description": "Agent B updated"}],
    )
    assert updated_b.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    assert "shared-link-guild-b" in _FakeProviderClient.calls[0]["url"]
    assert "shared-link-guild-a" not in _FakeProviderClient.calls[0]["url"]


@pytest.mark.asyncio
async def test_discord_stale_cleanup_does_not_erase_same_account_new_link_winner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-stale-command-cleanup",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    link_b_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert link_b_response.status_code == 201, link_b_response.text
    link_b = link_b_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    link_a = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert account is not None and link_a is not None
    link_a.config = {
        "discord_agent_commands": {
            "global": [{"name": "stale_agent", "description": "Stale Agent command"}]
        }
    }
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=UUID(link_b["id"]),
            user_id=account.user_id,
            external_chat_id="winner-channel",
            external_chat_type="guild_text",
            external_chat_name="same-account-winner-guild",
        )
    )
    await db_session.commit()
    _reset_fake_provider_client({"id": "must-not-clean"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    await cleanup_discord_guild_commands_after_authority_revoked(
        account_id=account.id,
        bot_agent_link_id=link_a.id,
        guild_ids={"same-account-winner-guild"},
    )

    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_discord_pairing_replays_stored_global_commands_to_new_guild(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"id": "provider-ok"})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-replay-on-pair",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    commands = [{"name": "deploy", "description": "Deploy"}]
    stored = await client.put(
        f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=commands,
    )
    assert stored.status_code == 200
    _reset_fake_provider_client({"id": "provider-ok"})

    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-pair-replay",
            "token": "interaction-pair-replay-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "chan-replay",
            "guild_id": "guild-replay",
            "context": 0,
            "authorizing_integration_owners": {"0": "guild-replay"},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-replay-user"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["data"]["content"].startswith("Server paired.")
    command_calls = [
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "PUT"
        and call["url"].endswith(
            f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-replay/commands"
        )
    ]
    assert len(command_calls) == 1
    assert json.loads(command_calls[0]["content"])[0]["name"] == "deploy"


@pytest.mark.asyncio
async def test_discord_interaction_callback_and_followup_require_recorded_token(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    _reset_fake_provider_client({"id": "discord-upstream"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_discord_channel(
        client,
        name="discord-interaction-ref",
        agent_id=channel_agent.id,
    )
    ingress = await _record_discord_interaction(
        client,
        created=created,
        interaction_id="interaction-1",
        token="interaction-token-1",
        application_id=DISCORD_TEST_APPLICATION_ID,
    )
    assert ingress.status_code == 202
    assert ingress.content == b""
    other = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-interaction-other",
                "provider_token": "discord-provider-token-2",
                "config": _discord_ready_config(),
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()

    headers = {"Authorization": f"Bot {created['agent_token']}"}
    callback = await client.post(
        "/v1/channels/discord/v10/interactions/interaction-1/interaction-token-1/callback",
        headers=headers,
        json={"type": 4, "data": {"content": "pong"}},
    )
    wrong_id = await client.post(
        "/v1/channels/discord/v10/interactions/wrong/interaction-token-1/callback",
        headers=headers,
        json={"type": 4, "data": {"content": "pong"}},
    )
    wrong_tenant = await client.post(
        "/v1/channels/discord/v10/interactions/interaction-1/interaction-token-1/callback",
        headers={"Authorization": f"Bot {other['agent_token']}"},
        json={"type": 4},
    )
    followup = await client.post(
        f"/v1/channels/discord/v10/webhooks/{DISCORD_TEST_APPLICATION_ID}/interaction-token-1",
        headers=headers,
        json={"content": "followup"},
    )
    edit_original = await client.patch(
        f"/v1/channels/discord/v10/webhooks/{DISCORD_TEST_APPLICATION_ID}/interaction-token-1/messages/@original",
        headers=headers,
        json={"content": "edited"},
    )
    wrong_app = await client.post(
        "/v1/channels/discord/v10/webhooks/wrong-app/interaction-token-1",
        headers=headers,
        json={"content": "nope"},
    )
    unknown_token = await client.post(
        "/v1/channels/discord/v10/webhooks/discord-app-123/unknown-token",
        headers=headers,
        json={"content": "nope"},
    )

    assert callback.status_code == 200
    assert wrong_id.status_code == 404
    assert wrong_id.json() == {"code": 10062, "message": "Unknown Interaction"}
    assert wrong_tenant.status_code == 404
    assert followup.status_code == 200
    assert edit_original.status_code == 200
    assert wrong_app.status_code == 404
    assert wrong_app.json() == {"code": 10015, "message": "Unknown Webhook"}
    assert unknown_token.status_code == 404
    assert len(_FakeProviderClient.calls) == 3
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/interactions/interaction-1/interaction-token-1/callback"
    )
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == (
        "Bot discord-provider-token"
    )
    assert _FakeProviderClient.calls[1]["url"].endswith(
        f"/webhooks/{DISCORD_TEST_APPLICATION_ID}/interaction-token-1"
    )
    assert _FakeProviderClient.calls[2]["method"] == "PATCH"


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["callback", "followup"])
@pytest.mark.parametrize("binding_state", ["unpaired", "reassigned", "missing"])
async def test_discord_interaction_reference_requires_current_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str,
    binding_state: str,
):
    _reset_fake_provider_client({"id": "discord-upstream"})
    monkeypatch.setattr(shared_router.httpx, "AsyncClient", _FakeProviderClient)
    created = await _create_paired_discord_channel(
        client, name="discord-reference-revocation", agent_id=channel_agent.id
    )
    ingress = await _record_discord_interaction(
        client,
        created=created,
        interaction_id="revoked-interaction",
        token="revoked-token",
        application_id=DISCORD_TEST_APPLICATION_ID,
    )
    assert ingress.status_code == 202
    binding = await db_session.scalar(
        select(ChannelBinding).where(ChannelBinding.account_id == UUID(created["id"]))
    )
    assert binding is not None
    unpaired = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding.id}")
    assert unpaired.status_code == 200, unpaired.text
    assert unpaired.json()["unpaired"] is True
    if binding_state == "reassigned":
        second = await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
        assert second.status_code == 201, second.text
        pair = await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second.json()["id"], "ttl_seconds": 900},
        )
        assert pair.status_code == 201, pair.text
        repaired = await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json={
                "type": 2,
                "id": "repair-interaction",
                "token": "repair-token",
                "application_id": DISCORD_TEST_APPLICATION_ID,
                "channel_id": "discord-chan-1",
                "guild_id": "discord-guild-1",
                "context": 0,
                "authorizing_integration_owners": {"0": "discord-guild-1"},
                "member": {"permissions": "32", "user": {"id": "discord-pair-user"}},
                "data": {
                    "name": "clawdi_pair",
                    "options": [{"name": "code", "value": pair.json()["code"]}],
                },
            },
        )
        assert repaired.status_code == 200, repaired.text
        assert repaired.json()["data"]["content"].startswith("Server paired.")
        await db_session.refresh(binding)
        assert binding.status == BINDING_STATUS_ACTIVE
        assert str(binding.bot_agent_link_id) == second.json()["id"]
    elif binding_state == "missing":
        # Historical references can lose their Binding through ON DELETE SET NULL.
        await db_session.delete(binding)
        await db_session.commit()

    _reset_fake_provider_client({"id": "must-not-send"})
    path = (
        "interactions/revoked-interaction/revoked-token/callback"
        if endpoint == "callback"
        else f"webhooks/{DISCORD_TEST_APPLICATION_ID}/revoked-token"
    )
    response = await client.post(
        f"/v1/channels/discord/v10/{path}",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"type": 4, "data": {"content": "must not send"}, "content": "must not send"},
    )
    assert (response.status_code, len(_FakeProviderClient.calls)) == (404, 0)


@pytest.mark.asyncio
async def test_discord_shared_profile_shadow_is_link_scoped(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_discord_gateway_sessions(monkeypatch)
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "discord",
            "name": "discord-shared-profile",
            "provider_token": "discord-provider-token",
            "config": _discord_ready_config(),
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    second_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert second_response.status_code == 201, second_response.text
    second = second_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    account.user_id = None
    account.config = {**account.config, "bot_username": "Legacy Bot", "bot_avatar": "legacy"}
    await db_session.commit()
    original_config = dict(account.config)
    headers_a = {"Authorization": f"Bot {created['agent_token']}"}
    headers_b = {"Authorization": f"Bot {second['agent_token']}"}
    patched = await client.patch(
        "/v1/channels/discord/v10/users/@me",
        headers=headers_a,
        json={"username": "Link A", "avatar": None},
    )
    assert patched.status_code == 200, patched.text
    # An omitted avatar preserves an explicit clear, rather than restoring the fallback.
    patched = await client.patch(
        "/v1/channels/discord/v10/users/@me", headers=headers_a, json={"username": "Link A"}
    )
    assert patched.status_code == 200
    for path in ("users/@me", "applications/@me", "oauth2/applications/@me"):
        first = await client.get(f"/v1/channels/discord/v10/{path}", headers=headers_a)
        second_get = await client.get(f"/v1/channels/discord/v10/{path}", headers=headers_b)
        assert first.status_code == second_get.status_code == 200
        user_a = first.json() if path == "users/@me" else first.json()["bot"]
        user_b = second_get.json() if path == "users/@me" else second_get.json()["bot"]
        assert (user_a["username"], user_a["avatar"]) == ("Link A", None)
        assert (user_b["username"], user_b["avatar"]) == ("Legacy Bot", "legacy")

    _install_discord_gateway_test_session_factory(monkeypatch)
    placeholder = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_DISCORD, channel_runtime_account_key(account.id)
    )

    def ready_user(token: str) -> dict[str, Any]:
        with TestClient(app) as sync_client:
            with sync_client.websocket_connect(
                "/v1/channels/discord/gateway?v=10&encoding=json",
                headers={"Authorization": f"Bearer {token}"},
            ) as websocket:
                assert websocket.receive_json()["op"] == 10
                websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
                ready = websocket.receive_json()
                assert ready["t"] == "READY"
                return ready["d"]["user"]

    user_a = ready_user(created["agent_token"])
    user_b = ready_user(second["agent_token"])
    assert (user_a["username"], user_a["avatar"]) == ("Link A", None)
    assert (user_b["username"], user_b["avatar"]) == ("Legacy Bot", "legacy")
    await db_session.refresh(account)
    assert account.config == original_config


@pytest.mark.asyncio
async def test_discord_bot_profile_shadow_is_account_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    account_a = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-profile-a",
                "provider_token": "discord-provider-token-a",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account_b = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-profile-b",
                "provider_token": "discord-provider-token-b",
                "config": _discord_ready_config("223456789012345678"),
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    headers_a = {"Authorization": f"Bot {account_a['agent_token']}"}
    headers_b = {"Authorization": f"Bot {account_b['agent_token']}"}

    default_a = await client.get("/v1/channels/discord/v10/users/@me", headers=headers_a)
    patched_a = await client.patch(
        "/v1/channels/discord/v10/users/@me",
        headers=headers_a,
        json={"username": "Tenant A Bot", "avatar": "data:image/png;base64,abc"},
    )
    get_a = await client.get("/v1/channels/discord/v10/users/@me", headers=headers_a)
    get_b = await client.get("/v1/channels/discord/v10/users/@me", headers=headers_b)
    app_a = await client.get("/v1/channels/discord/v10/applications/@me", headers=headers_a)

    await client.patch(
        "/v1/channels/discord/v10/users/@me",
        headers=headers_b,
        json={"username": "Tenant B Bot"},
    )
    app_b = await client.get("/v1/channels/discord/v10/oauth2/applications/@me", headers=headers_b)

    assert default_a.status_code == 200
    assert default_a.json()["username"] == "discord-profile-a"
    assert patched_a.status_code == 200
    assert patched_a.json()["username"] == "Tenant A Bot"
    assert patched_a.json()["avatar"] == "data:image/png;base64,abc"
    assert get_a.json()["username"] == "Tenant A Bot"
    assert get_b.json()["username"] == "discord-profile-b"
    assert app_a.json()["name"] == "Tenant A Bot"
    assert app_a.json()["bot"]["username"] == "Tenant A Bot"
    assert app_a.json()["bot"]["avatar"] == "data:image/png;base64,abc"
    assert app_b.json()["owner"]["username"] == "Tenant B Bot"
    assert app_b.json()["bot"]["username"] == "Tenant B Bot"


@pytest.mark.asyncio
async def test_discord_guild_rest_requires_bound_guild_scope(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"id": "guild-channel"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_discord_channel(
        client,
        name="discord-guild-rest",
        channel_id="discord-chan-1",
        guild_id="discord-guild-1",
    )
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    allowed = await client.post(
        "/v1/channels/discord/v10/guilds/discord-guild-1/channels",
        headers=headers,
        json={"name": "ops", "type": 0},
    )
    channel_send = await client.post(
        "/v1/channels/discord/v10/channels/discord-chan-1/messages",
        headers=headers,
        json={"content": "hello guild channel"},
    )
    with_message = await client.post(
        "/v1/channels/discord/v10/channels/discord-chan-1/messages/source-message/threads",
        headers=headers,
        json={"name": "hi", "auto_archive_duration": 1440, "rate_limit_per_user": 0},
    )
    without_message = await client.post(
        "/v1/channels/discord/v10/channels/discord-chan-1/threads",
        headers=headers,
        json={"name": "hi", "type": 11, "auto_archive_duration": 1440, "invitable": True},
    )
    blocked = await client.post(
        "/v1/channels/discord/v10/guilds/discord-guild-2/channels",
        headers=headers,
        json={"name": "ops", "type": 0},
    )

    assert allowed.status_code == 200
    assert channel_send.status_code == 200
    assert with_message.status_code == without_message.status_code == 200
    assert channel_send.json()["id"] == "guild-channel"
    assert blocked.status_code == 403
    assert blocked.json() == {"code": 50001, "message": "Missing Access"}
    assert _FakeProviderClient.calls[0]["url"].endswith("/guilds/discord-guild-1/channels")
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == (
        "Bot discord-provider-token"
    )
    assert _FakeProviderClient.calls[1]["url"].endswith("/channels/discord-chan-1/messages")
    assert _FakeProviderClient.calls[2]["url"].endswith(
        "/channels/discord-chan-1/messages/source-message/threads"
    )
    assert _FakeProviderClient.calls[3]["url"].endswith("/channels/discord-chan-1/threads")
    assert json.loads(_FakeProviderClient.calls[2]["content"])["auto_archive_duration"] == 1440
    assert json.loads(_FakeProviderClient.calls[3]["content"])["type"] == 11


@pytest.mark.asyncio
async def test_discord_create_message_preserves_rich_json_query_response_and_ownership(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-rich-message-proxy",
        channel_id="discord-rich-channel",
        guild_id="discord-rich-guild",
    )
    provider_payload = {
        "id": "discord-rich-message",
        "channel_id": "discord-rich-channel",
        "content": "rich message",
        "embeds": [{"title": "Deployment", "color": 0x5865F2}],
        "components": [{"type": 1, "components": []}],
        "attachments": [{"id": "attachment-1", "filename": "report.txt"}],
        "future_response_field": {"preserved": True},
    }
    _reset_fake_provider_client(
        provider_payload,
        headers={
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-cache",
            "cf-ray": "discord-ray-1",
            "retry-after": "2.5",
            "x-ratelimit-bucket": "bucket-1",
            "x-ratelimit-limit": "5",
            "x-ratelimit-remaining": "4",
            "x-ratelimit-reset": "1900000000.25",
            "x-ratelimit-reset-after": "1.0",
            "set-cookie": "provider-session=must-not-leak",
            "server": "provider-internal",
            "x-discord-features": "provider-internal-feature",
        },
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    request_body = (
        b'{  "content": "rich message", "embeds": [{"title": "Deployment"}], '
        b'"components": [{"type": 1, "components": []}], "sticker_ids": ["1"], '
        b'"poll": {"question": {"text": "Ship?"}}, "flags": 4096, '
        b'"future_message_field": {"nested": [1, 2, 3]} }'
    )

    response = await client.post(
        "/v1/channels/discord/v10/channels/discord-rich-channel/messages"
        "?wait=true&future=first&future=second",
        headers={
            "Authorization": f"Bot {created['agent_token']}",
            "Content-Type": "application/json; charset=utf-8",
            "Cookie": "runtime-session=must-not-forward",
            "Proxy-Authorization": "Basic must-not-forward",
            "X-Future-Runtime-Header": "must-not-forward",
        },
        content=request_body,
    )

    assert response.status_code == 200
    assert response.json() == provider_payload
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["cf-ray"] == "discord-ray-1"
    assert response.headers["retry-after"] == "2.5"
    assert response.headers["x-ratelimit-bucket"] == "bucket-1"
    assert response.headers["x-ratelimit-remaining"] == "4"
    assert "set-cookie" not in response.headers
    assert "server" not in response.headers
    assert "x-discord-features" not in response.headers

    assert len(_FakeProviderClient.calls) == 1
    call = _FakeProviderClient.calls[0]
    assert call["method"] == "POST"
    assert call["content"] == request_body
    assert list(call["params"].multi_items()) == [
        ("wait", "true"),
        ("future", "first"),
        ("future", "second"),
    ]
    forwarded_headers = {key.lower(): value for key, value in call["headers"].items()}
    assert forwarded_headers == {
        "authorization": "Bot discord-provider-token",
        "content-type": "application/json; charset=utf-8",
    }

    message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == UUID(created["id"]),
                ChannelMessage.provider_message_id == "discord-rich-message",
            )
        )
    ).scalar_one()
    assert message.bot_agent_link_id == UUID(created["agent_link_id"])
    assert message.binding_id is not None
    assert message.external_chat_id == "discord-rich-channel"
    assert message.text == "rich message"
    assert message.payload is None


@pytest.mark.asyncio
async def test_discord_proxy_forwards_only_allowlisted_protocol_request_headers(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-header-boundary",
        channel_id="discord-header-channel",
        guild_id="discord-header-guild",
    )
    _reset_fake_provider_client({"id": "permission-overwrite"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    response = await client.put(
        "/v1/channels/discord/v10/channels/discord-header-channel/permissions/role-1",
        headers={
            "Authorization": f"Bot {created['agent_token']}",
            "Content-Type": "application/json",
            "X-Audit-Log-Reason": "rotate%20on-call",
            "Cookie": "runtime-session=must-not-forward",
            "Host": "runtime.invalid",
            "Proxy-Authorization": "Basic must-not-forward",
            "Connection": "keep-alive",
            "X-Forwarded-For": "127.0.0.1",
        },
        json={"allow": "1024", "deny": "0", "type": 0},
    )

    assert response.status_code == 200
    forwarded_headers = {
        key.lower(): value for key, value in _FakeProviderClient.calls[0]["headers"].items()
    }
    assert forwarded_headers == {
        "authorization": "Bot discord-provider-token",
        "content-type": "application/json",
        "x-audit-log-reason": "rotate%20on-call",
    }

    empty_body_response = await client.delete(
        "/v1/channels/discord/v10/channels/discord-header-channel/permissions/role-1",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )
    assert empty_body_response.status_code == 200
    assert _FakeProviderClient.calls[1]["content"] == b""


@pytest.mark.asyncio
async def test_discord_create_message_preserves_multipart_attachment_and_unrecorded_reply(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-multipart-message-proxy",
        channel_id="discord-multipart-channel",
        guild_id="discord-multipart-guild",
    )
    _reset_fake_provider_client(
        {
            "id": "discord-multipart-message",
            "channel_id": "discord-multipart-channel",
            "content": "with attachment",
            "attachments": [{"id": "0", "filename": "report.bin"}],
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    boundary = "discord-thin-proxy-boundary"
    payload_json = json.dumps(
        {
            "content": "with attachment",
            "embeds": [{"image": {"url": "attachment://report.bin"}}],
            "attachments": [{"id": 0, "filename": "report.bin"}],
            "message_reference": {
                "message_id": "discord-unrecorded-reference",
                "channel_id": "discord-multipart-channel",
                "guild_id": "discord-multipart-guild",
            },
            "future_multipart_field": {"preserved": True},
        },
        separators=(",", ":"),
    ).encode()
    file_bytes = b"\x00DISCORD-ATTACHMENT\xff\r\n"
    multipart_body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="payload_json"\r\n',
            b"Content-Type: application/json\r\n\r\n",
            payload_json,
            b"\r\n",
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="files[0]"; filename="report.bin"\r\n',
            b"Content-Type: application/octet-stream\r\n\r\n",
            file_bytes,
            f"--{boundary}--\r\n".encode(),
        ]
    )
    content_type = f"multipart/form-data; boundary={boundary}"

    response = await client.post(
        "/v1/channels/discord/v10/channels/discord-multipart-channel/messages",
        headers={
            "Authorization": f"Bot {created['agent_token']}",
            "Content-Type": content_type,
        },
        content=multipart_body,
    )

    assert response.status_code == 200
    assert response.json()["attachments"][0]["filename"] == "report.bin"
    assert len(_FakeProviderClient.calls) == 1
    call = _FakeProviderClient.calls[0]
    assert call["content"] == multipart_body
    assert call["headers"]["Content-Type"] == content_type
    assert file_bytes in call["content"]
    message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.provider_message_id == "discord-multipart-message"
            )
        )
    ).scalar_one()
    assert message.bot_agent_link_id == UUID(created["agent_link_id"])


@pytest.mark.asyncio
async def test_discord_create_message_preserves_files_only_multipart_without_payload_json(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-files-only-message-proxy",
        channel_id="discord-files-only-channel",
        guild_id="discord-files-only-guild",
    )
    provider_body = (
        b'{"id":"discord-files-only-message",'
        b'"channel_id":"discord-files-only-channel",'
        b'"attachments":[{"id":"0","filename":"future.bin"}],'
        b'"future_response_field":{"preserved":true}}'
    )
    _reset_fake_provider_client(
        content=provider_body,
        status_code=201,
        headers={
            "content-type": "application/json",
            "x-ratelimit-bucket": "files-only-bucket",
        },
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    boundary = "discord-files-only-boundary"
    file_bytes = b"\x00FILES-ONLY-DISCORD\xff"
    multipart_body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="files[0]"; filename="future.bin"\r\n',
            b"Content-Type: application/octet-stream\r\n\r\n",
            file_bytes,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    content_type = f"multipart/form-data; boundary={boundary}"

    response = await client.post(
        "/v1/channels/discord/v10/channels/discord-files-only-channel/messages",
        headers={
            "Authorization": f"Bot {created['agent_token']}",
            "Content-Type": content_type,
        },
        content=multipart_body,
    )

    assert response.status_code == 201
    assert response.content == provider_body
    assert response.headers["x-ratelimit-bucket"] == "files-only-bucket"
    assert len(_FakeProviderClient.calls) == 1
    call = _FakeProviderClient.calls[0]
    assert call["content"] == multipart_body
    assert call["headers"]["Content-Type"] == content_type


@pytest.mark.asyncio
async def test_discord_create_message_authorizes_unobserved_same_guild_reference_channel(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-reference-channel-preflight",
        channel_id="discord-reference-target",
        guild_id="discord-reference-guild",
    )
    _DiscordPreparationProviderClient.reset(
        [
            (
                {
                    "id": "discord-unobserved-reference-channel",
                    "guild_id": "discord-reference-guild",
                    "type": 0,
                },
                200,
            ),
            (
                {
                    "id": "discord-reference-reply",
                    "channel_id": "discord-reference-target",
                    "content": "reply across channels",
                },
                201,
            ),
        ]
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _DiscordPreparationProviderClient,
    )

    response = await client.post(
        "/v1/channels/discord/v10/channels/discord-reference-target/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={
            "content": "reply across channels",
            "message_reference": {
                "message_id": "discord-unrecorded-cross-channel-message",
                "channel_id": "discord-unobserved-reference-channel",
                "guild_id": "discord-reference-guild",
            },
        },
    )

    assert response.status_code == 201
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == [
        "GET",
        "POST",
    ]
    assert _DiscordPreparationProviderClient.calls[0]["url"].endswith(
        "/channels/discord-unobserved-reference-channel"
    )
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.account_id == UUID(created["id"]),
                ChannelBindingAlias.alias_external_chat_id
                == "discord-unobserved-reference-channel",
            )
        )
    ).scalar_one()
    assert alias.bot_agent_link_id == UUID(created["agent_link_id"])


@pytest.mark.asyncio
async def test_discord_create_message_rejects_ambiguous_or_malformed_reference_forms(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-reference-parser-boundary",
        channel_id="discord-parser-channel",
        guild_id="discord-parser-guild",
    )
    _reset_fake_provider_client(
        {
            "id": "must-not-send",
            "channel_id": "discord-parser-channel",
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    boundary = "discord-parser-boundary"
    duplicate_payload_json = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="payload_json"\r\n\r\n',
            b"{}\r\n",
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="payload_json"\r\n\r\n',
            b"{}\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    malformed_payload_json = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="payload_json"\r\n\r\n',
            b'{"message_reference":\r\n',
            f"--{boundary}--\r\n".encode(),
        ]
    )
    missing_close_boundary = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="payload_json"\r\n\r\n',
            b"{}\r\n",
        ]
    )
    cases = [
        (
            "application/json",
            b'{"message_reference":',
        ),
        (
            "application/json",
            b'{"message_reference":{},"message_reference":{}}',
        ),
        (
            "application/json",
            b'{"message_reference":{"channel_id":"first","channel_id":"second"}}',
        ),
        (
            f"multipart/form-data; boundary={boundary}",
            duplicate_payload_json,
        ),
        (
            f"multipart/form-data; boundary={boundary}",
            malformed_payload_json,
        ),
        (
            f"multipart/form-data; boundary={boundary}",
            missing_close_boundary,
        ),
    ]

    for content_type, body in cases:
        response = await client.post(
            "/v1/channels/discord/v10/channels/discord-parser-channel/messages",
            headers={
                "Authorization": f"Bot {created['agent_token']}",
                "Content-Type": content_type,
            },
            content=body,
        )
        assert response.status_code == 400
        assert response.json() == {"code": 50035, "message": "Invalid Form Body"}

    unobserved_target = await client.post(
        "/v1/channels/discord/v10/channels/discord-unobserved-parser-channel/messages",
        headers={
            "Authorization": f"Bot {created['agent_token']}",
            "Content-Type": "application/json",
        },
        content=b'{"message_reference":',
    )
    assert unobserved_target.status_code == 400
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_discord_create_message_keeps_provider_success_when_recording_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.discord_rate_limiter",
        DiscordRateLimiter(),
    )
    created = await _create_paired_discord_channel(
        client,
        name="discord-best-effort-outbound-record",
        channel_id="discord-best-effort-channel",
        guild_id="discord-best-effort-guild",
    )
    _reset_fake_provider_client(
        {
            "id": "discord-mismatched-response",
            "channel_id": "discord-other-channel",
            "content": "provider accepted",
        },
        status_code=201,
        headers={
            "content-type": "application/json",
            "x-ratelimit-bucket": "discord-request-mismatch",
        },
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    mismatched = await client.post(
        "/v1/channels/discord/v10/channels/discord-best-effort-channel/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"content": "provider accepted"},
    )
    assert mismatched.status_code == 201
    assert mismatched.json()["channel_id"] == "discord-other-channel"
    assert mismatched.headers["x-ratelimit-bucket"] == "discord-request-mismatch"
    assert (
        await db_session.execute(
            select(ChannelMessage.id).where(
                ChannelMessage.provider_message_id == "discord-mismatched-response"
            )
        )
    ).scalar_one_or_none() is None

    async def fail_recording(*_args, **_kwargs):
        raise SQLAlchemyError("local recording unavailable")

    _reset_fake_provider_client(
        {
            "id": "discord-unrecorded-success",
            "channel_id": "discord-best-effort-channel",
            "content": "provider accepted once",
        },
        status_code=202,
        headers={
            "content-type": "application/json",
            "x-ratelimit-bucket": "discord-request-db-failure",
        },
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.record_discord_outbound_message",
        fail_recording,
    )
    failed_record = await client.post(
        "/v1/channels/discord/v10/channels/discord-best-effort-channel/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"content": "provider accepted once"},
    )

    assert failed_record.status_code == 202
    assert failed_record.json()["id"] == "discord-unrecorded-success"
    assert failed_record.headers["x-ratelimit-bucket"] == "discord-request-db-failure"


@pytest.mark.asyncio
async def test_discord_create_message_transparently_returns_provider_error_and_safe_failure(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.discord_rate_limiter",
        DiscordRateLimiter(),
    )
    created = await _create_paired_discord_channel(
        client,
        name="discord-provider-error-proxy",
        channel_id="discord-error-channel",
        guild_id="discord-error-guild",
    )
    provider_error = {
        "id": "must-not-be-recorded",
        "code": 50035,
        "message": "Invalid Form Body",
        "errors": {"future_field": {"_errors": [{"code": "UNKNOWN_FIELD"}]}},
    }
    _reset_fake_provider_client(
        provider_error,
        status_code=400,
        headers={
            "content-type": "application/json",
            "retry-after": "3",
            "x-ratelimit-scope": "user",
        },
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    await channel_service.close_channel_provider_http_client()

    rejected = await client.post(
        "/v1/channels/discord/v10/channels/discord-error-channel/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"future_field": "provider validates this"},
    )

    assert rejected.status_code == 400
    assert rejected.json() == provider_error
    assert rejected.headers["retry-after"] == "3"
    assert rejected.headers["x-ratelimit-scope"] == "user"
    assert (
        await db_session.execute(
            select(ChannelMessage.id).where(
                ChannelMessage.provider_message_id == "must-not-be-recorded"
            )
        )
    ).scalar_one_or_none() is None

    _FailingProviderClient.calls = []
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FailingProviderClient,
    )
    await channel_service.close_channel_provider_http_client()
    unreachable = await client.post(
        "/v1/channels/discord/v10/channels/discord-error-channel/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"content": "network failure"},
    )

    assert unreachable.status_code == 502
    assert unreachable.json() == {"detail": "discord api unreachable"}
    assert created["agent_token"] not in unreachable.text
    assert "discord-provider-token" not in unreachable.text
    assert "network down" not in unreachable.text


@pytest.mark.asyncio
async def test_discord_create_message_authorizes_unobserved_thread_then_proxies_raw_request(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-thread-message-proxy",
        channel_id="discord-parent-channel",
        guild_id="discord-thread-guild",
    )
    _DiscordPreparationProviderClient.reset(
        [
            (
                {
                    "id": "discord-unobserved-thread",
                    "guild_id": "discord-thread-guild",
                    "parent_id": "discord-parent-channel",
                    "type": 11,
                },
                200,
            ),
            (
                {
                    "id": "discord-thread-message",
                    "channel_id": "discord-unobserved-thread",
                    "content": "thread payload",
                },
                200,
            ),
        ]
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _DiscordPreparationProviderClient,
    )
    raw_body = b'{"content":"thread payload","future_thread_field":true}'

    response = await client.post(
        "/v1/channels/discord/v10/channels/discord-unobserved-thread/messages?future=1",
        headers={
            "Authorization": f"Bot {created['agent_token']}",
            "Content-Type": "application/json",
        },
        content=raw_body,
    )

    assert response.status_code == 200
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == [
        "GET",
        "POST",
    ]
    assert _DiscordPreparationProviderClient.calls[1]["content"] == raw_body
    assert list(_DiscordPreparationProviderClient.calls[1]["params"].multi_items()) == [
        ("future", "1")
    ]
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.account_id == UUID(created["id"]),
                ChannelBindingAlias.alias_external_chat_id == "discord-unobserved-thread",
            )
        )
    ).scalar_one()
    assert alias.bot_agent_link_id == UUID(created["agent_link_id"])


@pytest.mark.asyncio
async def test_discord_create_message_rejects_cross_link_target_and_message_reference(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-create-message-link-boundary",
        channel_id="discord-link-channel-a",
        guild_id="discord-link-guild-a",
        agent_id=channel_agent.id,
    )
    link_b_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert link_b_response.status_code == 201, link_b_response.text
    link_b = link_b_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding_b = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(link_b["id"]),
        user_id=account.user_id,
        external_chat_id="discord-link-guild-b",
        external_chat_type="guild_text",
        external_chat_name="discord-link-guild-b",
    )
    db_session.add(binding_b)
    await db_session.flush()
    db_session.add_all(
        [
            ChannelBindingAlias(
                account_id=account.id,
                bot_agent_link_id=UUID(link_b["id"]),
                binding_id=binding_b.id,
                user_id=account.user_id,
                alias_external_chat_id="discord-link-channel-b",
                alias_kind="discord_channel",
            ),
        ]
    )
    await db_session.commit()
    _reset_fake_provider_client(
        {
            "id": "discord-link-channel-b",
            "guild_id": "discord-link-guild-b",
            "type": 0,
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    headers_a = {"Authorization": f"Bot {created['agent_token']}"}

    cross_reference = await client.post(
        "/v1/channels/discord/v10/channels/discord-link-channel-a/messages",
        headers=headers_a,
        json={
            "content": "must fail",
            "message_reference": {
                "message_id": "discord-unrecorded-link-message-b",
                "channel_id": "discord-link-channel-b",
                "guild_id": "discord-link-guild-b",
            },
        },
    )
    cross_link_channel_only = await client.post(
        "/v1/channels/discord/v10/channels/discord-link-channel-a/messages",
        headers=headers_a,
        json={
            "content": "must fail",
            "message_reference": {
                "message_id": "discord-unrecorded-link-message-b",
                "channel_id": "discord-link-channel-b",
            },
        },
    )
    cross_target = await client.post(
        "/v1/channels/discord/v10/channels/discord-link-channel-b/messages",
        headers=headers_a,
        json={"content": "must also fail"},
    )

    assert cross_reference.status_code == 404
    assert cross_reference.json() == {"code": 10008, "message": "Unknown Message"}
    assert cross_link_channel_only.status_code == 404
    assert cross_link_channel_only.json() == {"code": 10008, "message": "Unknown Message"}
    assert cross_target.status_code == 403
    assert cross_target.json() == {"code": 50001, "message": "Missing Access"}
    assert [call["method"] for call in _FakeProviderClient.calls] == ["GET", "GET"]


@pytest.mark.asyncio
async def test_discord_channel_rest_accepts_bound_channel_alias(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_fake_provider_client({"id": "permission-overwrite"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-channel-alias-rest",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=account.user_id,
        external_chat_id="guild-alias-rest",
        external_chat_type="guild_text",
        external_chat_name="guild-alias-rest",
    )
    db_session.add(binding)
    await db_session.flush()
    db_session.add(
        ChannelBindingAlias(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            binding_id=binding.id,
            user_id=account.user_id,
            alias_external_chat_id="chan-alias-rest",
            alias_kind="discord_channel",
        )
    )
    await db_session.commit()

    response = await client.put(
        "/v1/channels/discord/v10/channels/chan-alias-rest/permissions/role-1",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"allow": "1024", "deny": "0", "type": 0},
    )

    assert response.status_code == 200
    assert _FakeProviderClient.calls[0]["method"] == "PUT"
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/channels/chan-alias-rest/permissions/role-1"
    )
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == (
        "Bot discord-provider-token"
    )


@pytest.mark.asyncio
async def test_discord_channel_rest_resolves_caches_and_reuses_unobserved_guild_channel(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-unobserved-channel-rest",
        channel_id="discord-observed-channel",
        guild_id="discord-bound-guild",
    )
    _reset_fake_provider_client(
        {
            "id": "discord-unobserved-channel",
            "guild_id": "discord-bound-guild",
            "type": 11,
            "parent_id": "discord-observed-channel",
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    channel_get = await client.get(
        "/v1/channels/discord/v10/channels/discord-unobserved-channel",
        headers=headers,
    )
    cached_operation = await client.put(
        "/v1/channels/discord/v10/channels/discord-unobserved-channel/permissions/role-1",
        headers=headers,
        json={"allow": "1024", "deny": "0", "type": 0},
    )

    assert channel_get.status_code == 200
    assert channel_get.json()["guild_id"] == "discord-bound-guild"
    assert cached_operation.status_code == 200
    assert [(call["method"], urlparse(call["url"]).path) for call in _FakeProviderClient.calls] == [
        ("GET", "/api/v10/channels/discord-unobserved-channel"),
        ("PUT", "/api/v10/channels/discord-unobserved-channel/permissions/role-1"),
    ]
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.account_id == UUID(created["id"]),
                ChannelBindingAlias.alias_external_chat_id == "discord-unobserved-channel",
                ChannelBindingAlias.alias_kind == "discord_channel",
            )
        )
    ).scalar_one()
    assert alias.bot_agent_link_id == UUID(created["agent_link_id"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider_payload", "provider_status", "provider_content", "expected_status"),
    [
        ({"id": "unknown-channel", "guild_id": "wrong-guild"}, 200, None, 403),
        ({"id": "unknown-channel", "type": 1}, 200, None, 403),
        ({"id": "different-channel", "guild_id": "bound-guild"}, 200, None, 403),
        ({}, 200, b"not-json", 403),
        ({"message": "private upstream error"}, 500, None, 500),
        ({"retry_after": 7200.5}, 429, None, 429),
    ],
)
async def test_discord_unobserved_channel_lookup_failures_do_not_authorize(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    provider_payload: dict[str, Any],
    provider_status: int,
    provider_content: bytes | None,
    expected_status: int,
):
    monkeypatch.setattr(shared_router, "discord_rate_limiter", DiscordRateLimiter())
    created = await _create_paired_discord_channel(
        client,
        name=f"discord-unobserved-denied-{uuid4().hex}",
        channel_id="observed-channel",
        guild_id="bound-guild",
    )
    _reset_fake_provider_client(
        provider_payload,
        status_code=provider_status,
        content=provider_content,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    response = await client.get(
        "/v1/channels/discord/v10/channels/unknown-channel",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == expected_status
    if expected_status == 403:
        assert response.json() == {"code": 50001, "message": "Missing Access"}
    else:
        assert response.json() == {"detail": "discord api temporarily unavailable"}
        assert "private upstream error" not in response.text
    if expected_status == 429:
        assert float(response.headers["retry-after"]) == 7200.5
    assert len(_FakeProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_discord_unobserved_channel_provider_network_error_fails_closed(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-unobserved-provider-error",
        channel_id="observed-channel",
        guild_id="bound-guild",
    )
    _FailingProviderClient.calls = []
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FailingProviderClient,
    )

    response = await client.get(
        "/v1/channels/discord/v10/channels/unknown-channel",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "discord api unreachable"}
    assert len(_FailingProviderClient.calls) == 1


def test_discord_rate_limiter_blocks_exhausted_route_bucket():
    limiter = DiscordRateLimiter(global_per_second=10)
    headers = {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "60",
        "x-ratelimit-limit": "5",
        "x-ratelimit-bucket": "bucket-1",
    }

    limiter.observe(
        "account-a",
        "POST",
        "/channels/123456789012345678/messages",
        headers,
        200,
    )
    decision = limiter.check(
        "account-a",
        "POST",
        "/channels/123456789012345678/messages",
    )
    other = limiter.check(
        "account-a",
        "POST",
        "/channels/987654321098765432/messages",
    )

    assert decision.allowed is False
    assert decision.retry_after_seconds is not None
    assert other.allowed is True


@pytest.mark.asyncio
async def test_create_discord_channel_returns_provider_webhook(client: httpx.AsyncClient):
    response = await client.post(
        "/v1/channels",
        json={
            "provider": "discord",
            "name": "discord-main",
            "provider_token": "discord-token",
            "config": _discord_ready_config(),
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["provider"] == "discord"
    assert "/v1/channels/discord/" in created["webhook_url"]
    assert created["has_provider_token"] is True
    assert "discord-token" not in response.text


@pytest.mark.parametrize(
    ("name", "expected_kind"),
    [
        ("clawdi_pair", "pair"),
        ("clawdi_unpair", "unpair"),
        ("clawdi_help", "help"),
    ],
)
def test_discord_interaction_parser_accepts_current_reserved_commands(
    name: str,
    expected_kind: str,
):
    command = discord_control_command_from_payload(
        {
            "type": 2,
            "data": {
                "name": name,
                "options": (
                    [{"name": "code", "value": "BCDFGHJKLM"}] if expected_kind == "pair" else []
                ),
            },
        }
    )

    assert command is not None
    assert command.kind == expected_kind
    assert command.code == ("BCDFGHJKLM" if expected_kind == "pair" else None)


@pytest.mark.parametrize("name", ["bot_pair", "bot_unpair", "pair", "unpair"])
def test_discord_interaction_parser_rejects_legacy_and_generic_commands(name: str):
    assert (
        discord_control_command_from_payload(
            {
                "type": 2,
                "data": {
                    "name": name,
                    "options": [{"name": "code", "value": "BCDFGHJKLM"}],
                },
            }
        )
        is None
    )


@pytest.mark.parametrize("content", ["/bot_pair BCDFGHJKLM", "/bot_unpair"])
def test_discord_message_parser_rejects_legacy_text_commands(content: str):
    assert discord_control_command_from_payload({"d": {"content": content}}) is None


def test_discord_message_parser_requires_slash_for_current_commands():
    current = discord_control_command_from_payload({"d": {"content": "/clawdi_pair BCDFGHJKLM"}})

    assert current is not None
    assert current.kind == "pair"
    assert current.code == "BCDFGHJKLM"
    assert (
        discord_control_command_from_payload({"d": {"content": "clawdi_pair BCDFGHJKLM"}}) is None
    )
    assert discord_control_command_from_payload({"d": {"content": "clawdi_unpair"}}) is None


def test_discord_unknown_command_reply_uses_only_current_reserved_commands():
    reply = discord_control_reply_for_command(
        channel_service.ChannelControlCommand(kind="unknown", command="/clawdi_unpair"),
        channel_service.InboundBindingResult(binding=None, command_handled=True),
        guild_id="guild-1",
    )

    assert reply == "Unknown command: /clawdi_unpair. Use /clawdi_help for instructions."
    assert "/bot_" not in reply


@pytest.mark.asyncio
async def test_discord_webhook_does_not_claim_code_for_legacy_interaction(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-legacy-command-rejected",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "legacy-pair-interaction",
            "token": "legacy-pair-token",
            "channel_id": "legacy-pair-channel",
            "guild_id": "legacy-pair-guild",
            "member": {
                "permissions": "32",
                "user": {"id": "legacy-pair-user"},
            },
            "data": {
                "name": "bot_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["content"] == "This server is not paired."
    pair_code = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    assert pair_code is not None
    assert pair_code.status == PAIR_CODE_STATUS_PENDING
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


@pytest.mark.asyncio
async def test_discord_inbound_record_and_unpair_are_linearized(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-producer-lease",
        channel_id="producer-lease-channel",
        guild_id="producer-lease-guild",
    )
    account_id = UUID(created["id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).scalar_one()
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    producer_has_lease = asyncio.Event()
    release_producer_commit = asyncio.Event()
    business_backend_pids: asyncio.Queue[int] = asyncio.Queue()
    original_record = channel_service.record_inbound_messages_for_bindings

    async def paused_record(*args, **kwargs):
        messages = await original_record(*args, **kwargs)
        producer_has_lease.set()
        await release_producer_commit.wait()
        return messages

    async def produce(provider_message_id: str) -> bool:
        async with sessionmaker() as db:
            account = await db.get(ChannelAccount, account_id)
            assert account is not None
            recorded = await record_discord_dispatch(
                db,
                account=account,
                frame={
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "id": provider_message_id,
                        "guild_id": binding.external_chat_id,
                        "channel_id": "producer-lease-channel",
                        "content": "hello",
                        "author": {"id": "user-1", "bot": False},
                    },
                },
            )
            await db.commit()
            return recorded

    with monkeypatch.context() as paused_delivery:
        paused_delivery.setattr(
            channel_service,
            "record_inbound_messages_for_bindings",
            paused_record,
        )
        producer_task: asyncio.Task[bool] | None = None
        unpair_task: asyncio.Task[None] | None = None
        try:
            producer_task = asyncio.create_task(produce("producer-first"))
            await asyncio.wait_for(producer_has_lease.wait(), timeout=2)
            unpair_task = asyncio.create_task(
                _archive_discord_binding_with_identity_lock(
                    sessionmaker,
                    account_id=account_id,
                    binding_id=binding.id,
                    external_chat_id=binding.external_chat_id,
                    backend_pids=business_backend_pids,
                )
            )
            unpair_backend_pid = await asyncio.wait_for(business_backend_pids.get(), timeout=2)
            await asyncio.wait_for(
                wait_for_lock_wait(sessionmaker, unpair_backend_pid),
                timeout=2,
            )
            release_producer_commit.set()
            assert await asyncio.wait_for(producer_task, timeout=2) is True
            await asyncio.wait_for(unpair_task, timeout=2)
        finally:
            release_producer_commit.set()
            pending_tasks = [
                task
                for task in (producer_task, unpair_task)
                if task is not None and not task.done()
            ]
            if pending_tasks:
                for task in pending_tasks:
                    task.cancel()
                await asyncio.gather(*pending_tasks, return_exceptions=True)

    assert await produce("unpair-first") is False
    rows = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account_id,
                    ChannelMessage.provider_message_id.in_(["producer-first", "unpair-first"]),
                )
            )
        ).scalars()
    )
    assert [row.provider_message_id for row in rows] == ["producer-first"]


@pytest.mark.asyncio
async def test_discord_unpaired_tutorial_failure_has_short_retry_then_success_cooldown(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-unpaired-tutorial",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    attempts = 0

    async def send_tutorial(**kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise HTTPException(status_code=502, detail="private provider failure")
        return "tutorial-message", {"id": "tutorial-message", "channel_id": "dm-channel"}

    monkeypatch.setattr(channel_service, "_send_discord_provider_payload", send_tutorial)

    def frame(message_id: str) -> dict[str, Any]:
        return {
            "t": "MESSAGE_CREATE",
            "d": {
                "id": message_id,
                "channel_id": "dm-channel",
                "content": "hello",
                "author": {"id": "discord-user", "bot": False},
            },
        }

    for message_id in ("tutorial-failed", "tutorial-backoff"):
        assert await record_discord_dispatch(db_session, account=account, frame=frame(message_id))
        await db_session.commit()
    assert attempts == 1

    markers = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    func.jsonb_extract_path_text(ChannelMessage.payload, "kind")
                    == "discord_unpaired_tutorial",
                )
            )
        ).scalars()
    )
    for marker in markers:
        marker.created_at = datetime.now(UTC) - timedelta(seconds=31)
    await db_session.commit()

    for message_id in ("tutorial-retry", "tutorial-success-cooldown"):
        assert await record_discord_dispatch(db_session, account=account, frame=frame(message_id))
        await db_session.commit()
    assert attempts == 2


@pytest.mark.asyncio
async def test_discord_pair_winning_identity_lock_suppresses_unpaired_tutorial(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-pair-tutorial-race",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    link_id = UUID(created["agent_link_id"])
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    pair_locked = asyncio.Event()
    finish_pair = asyncio.Event()
    sends = 0

    async def unexpected_send(**kwargs):
        nonlocal sends
        sends += 1
        return None, {}

    monkeypatch.setattr(channel_service, "_send_discord_provider_payload", unexpected_send)

    async def pair() -> None:
        async with sessionmaker() as db:
            await channel_service.lock_channel_binding_identity(
                db,
                account_id=account_id,
                external_chat_id="pair-race-guild",
            )
            pair_locked.set()
            await finish_pair.wait()
            db.add(
                ChannelBinding(
                    account_id=account_id,
                    bot_agent_link_id=link_id,
                    user_id=link.user_id,
                    external_chat_id="pair-race-guild",
                    external_chat_type="guild",
                )
            )
            await db.commit()

    tutorial_backend_pid: asyncio.Future[int] = asyncio.get_running_loop().create_future()

    async def instruct() -> bool:
        async with sessionmaker() as db:
            backend_pid = await db.scalar(text("SELECT pg_backend_pid()"))
            assert isinstance(backend_pid, int)
            tutorial_backend_pid.set_result(backend_pid)
            account = await db.get(ChannelAccount, account_id)
            assert account is not None
            recorded = await record_discord_dispatch(
                db,
                account=account,
                frame={
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "id": "pair-race-message",
                        "guild_id": "pair-race-guild",
                        "channel_id": "pair-race-channel",
                        "content": "<@123456789012345678> hi",
                        "mentions": [{"id": DISCORD_TEST_APPLICATION_ID}],
                        "author": {"id": "discord-user", "bot": False},
                    },
                },
            )
            await db.commit()
            return recorded

    pair_task = asyncio.create_task(pair())
    await pair_locked.wait()
    tutorial_task = asyncio.create_task(instruct())
    try:
        await wait_for_lock_wait(sessionmaker, await asyncio.wait_for(tutorial_backend_pid, 2))
        assert not tutorial_task.done()
    finally:
        finish_pair.set()
        await asyncio.gather(pair_task, tutorial_task, return_exceptions=True)
    await pair_task

    assert await tutorial_task is False
    assert sends == 0


@pytest.mark.asyncio
async def test_discord_message_pair_code_cannot_forge_interaction_authority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-pair",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-1",
                "channel_id": "chan-1",
                "guild_id": "guild-1",
                "content": f"/clawdi_pair {pair['code']}",
                "author": {"id": "discord-msg-pair-user"},
                "member": {"permissions": "32"},
                "type": 2,
                "context": 0,
                "authorizing_integration_owners": {"0": "guild-1"},
                "channel": {"id": "chan-1", "name": "ops"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is False
    pair_code = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    assert pair_code is not None
    assert pair_code.status == PAIR_CODE_STATUS_PENDING
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.json() == []


@pytest.mark.asyncio
async def test_discord_interaction_pair_replays_shadowed_commands_once_for_guild_only(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    fan_out_calls: list[dict[str, Any]] = []

    async def fake_fan_out(
        _db: AsyncSession,
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID,
        application_id: str,
        guild_ids: set[str] | None = None,
        automatic: bool = False,
        force: bool = False,
    ) -> None:
        fan_out_calls.append(
            {
                "account_id": account.id,
                "bot_agent_link_id": bot_agent_link_id,
                "application_id": application_id,
                "guild_ids": guild_ids,
                "automatic": automatic,
                "force": force,
            }
        )

    monkeypatch.setattr(
        "app.routes.channel_routers.discord.fan_out_discord_global_commands",
        fake_fan_out,
    )
    shadowed_command = {
        "id": "shadowed-agent-command",
        "application_id": DISCORD_TEST_APPLICATION_ID,
        "name": "agent_status",
        "description": "Show Agent status.",
        "type": 1,
    }
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-interaction-command-replay",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.config = {"discord_agent_commands": {"global": [shadowed_command]}}
    await db_session.commit()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-command-replay",
            "token": "interaction-command-replay-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "interaction-replay-channel",
            "guild_id": "interaction-replay-guild",
            "context": 0,
            "authorizing_integration_owners": {"0": "interaction-replay-guild"},
            "member": {
                "permissions": "32",
                "user": {"id": "interaction-replay-admin"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["data"]["content"].startswith("Server paired.")
    assert fan_out_calls == [
        {
            "account_id": UUID(created["id"]),
            "bot_agent_link_id": UUID(created["agent_link_id"]),
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "guild_ids": {"interaction-replay-guild"},
            "automatic": False,
            "force": True,
        }
    ]

    dm_created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-dm-no-command-fanout",
                "provider_token": "discord-provider-token-2",
                "config": _discord_ready_config("223456789012345678"),
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    dm_link = await db_session.get(ChannelBotAgentLink, UUID(dm_created["agent_link_id"]))
    assert dm_link is not None
    dm_link.config = {"discord_agent_commands": {"global": [shadowed_command]}}
    await db_session.commit()
    dm_pair = (
        await client.post(
            f"/v1/channels/{dm_created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    dm_paired = await client.post(
        f"/v1/channels/discord/{dm_created['id']}/webhook",
        headers={"x-clawdi-channel-secret": dm_created["webhook_secret"]},
        json={
            "type": 2,
            "id": "dm-no-command-fanout",
            "token": "dm-no-command-fanout-token",
            "application_id": "223456789012345678",
            "channel_id": "dm-no-fanout-channel",
            "user": {"id": "dm-pairing-user"},
            "context": 1,
            "authorizing_integration_owners": {"1": "dm-pairing-user"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": dm_pair["code"]}],
            },
        },
    )

    assert dm_paired.status_code == 200
    assert dm_paired.json()["data"]["content"].startswith("Direct message paired.")
    assert len(fan_out_calls) == 1


@pytest.mark.asyncio
async def test_discord_webhook_inactive_link_records_debug_health(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-webhook-inactive-link",
        channel_id="discord-inactive-channel",
        guild_id="discord-inactive-guild",
    )
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.status = "archived"
    link.archived_at = datetime.now(UTC)
    await db_session.commit()

    inbound = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "discord-inactive-message",
                "channel_id": "discord-inactive-channel",
                "guild_id": "discord-inactive-guild",
                "content": "link is inactive",
                "author": {"id": "discord-inactive-user"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.provider_message_id == "discord-inactive-message"
            )
        )
    ).scalar_one()
    health_response = await client.get("/v1/channels/health")
    activity_response = await client.get(
        f"/v1/channels/{created['id']}/activity",
        params={"external_chat_id": "discord-inactive-guild", "limit": 20},
    )

    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert health_response.status_code == 200, health_response.text
    health = next(
        item for item in health_response.json()["items"] if item["account_id"] == created["id"]
    )
    assert health["health_status"] == "error"
    assert "pending_inbox" not in health["reasons"]
    assert "recent_error" in health["reasons"]
    assert health["pending_inbox"] == 0
    assert health["last_error"] == "channel_operation_failed"
    assert health["last_error_stage"] == "agent_webhook"
    assert health["last_error_outcome"] == "failure"
    assert activity_response.status_code == 200, activity_response.text
    debug_item = next(
        item for item in activity_response.json()["items"] if item["kind"] == "debug_event"
    )
    assert debug_item["stage"] == "agent_webhook"
    assert debug_item["outcome"] == "failure"
    assert debug_item["error"] == "channel_operation_failed"
    assert debug_item["details"]["reason"] == "link_archived"
    assert debug_item["details"]["bot_agent_link_id"] == created["agent_link_id"]
    assert debug_item["details"]["bot_agent_link_status"] == "archived"


@pytest.mark.asyncio
async def test_discord_message_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"id": "discord-pair-reply"})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-message-pair-reply",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-1",
                "channel_id": "chan-1",
                "guild_id": "guild-1",
                "content": f"/clawdi_pair {pair['code']}",
                "author": {"id": "discord-msg-pair-user"},
                "member": {"permissions": "32"},
                "channel": {"id": "chan-1", "name": "ops"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is False
    reply_call = next(
        call
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/channels/chan-1/messages")
    )
    assert reply_call["headers"]["Authorization"] == ("Bot discord-provider-token")
    assert reply_call["json"] == {
        "content": "Discord could not verify this app installation for this server command.",
        "allowed_mentions": {"parse": []},
    }


@pytest.mark.asyncio
async def test_discord_guild_text_pair_without_computed_permissions_fails_closed(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"id": "discord-permission-instruction"})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-text-pair-permissions",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    denied = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "guild-text-pair-denied",
                "channel_id": "guild-thread-invoking",
                "guild_id": "guild-text-pair",
                "channel_type": 11,
                "content": f"/clawdi_pair {pair['code']}",
                "author": {"id": "guild-text-actor"},
            },
        },
    )

    assert denied.status_code == 200
    assert denied.json()["paired"] is False
    assert (
        await db_session.get(ChannelPairCode, UUID(pair["id"]))
    ).status == PAIR_CODE_STATUS_PENDING
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    reply_call = next(
        call
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/channels/guild-thread-invoking/messages")
    )
    assert reply_call["json"]["content"] == (
        "Discord could not verify this app installation for this server command."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("permissions", ["32", "8"])
async def test_discord_guild_interaction_pair_allows_manage_guild_or_administrator(
    client: httpx.AsyncClient,
    permissions: str,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-pair-authority-{permissions}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": f"pair-authority-{permissions}",
            "token": f"pair-authority-token-{permissions}",
            "channel_id": "authority-channel",
            "guild_id": f"authority-guild-{permissions}",
            "context": 0,
            "authorizing_integration_owners": {"0": f"authority-guild-{permissions}"},
            "member": {
                "permissions": permissions,
                "user": {"id": "authority-admin"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["content"].startswith("Server paired.")


@pytest.mark.asyncio
@pytest.mark.parametrize("permissions", ["0", None, "malformed", 32])
async def test_discord_guild_interaction_pair_denies_non_authoritative_permissions(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    permissions: Any,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-pair-denied-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    member: dict[str, Any] = {"user": {"id": "ordinary-member"}}
    if permissions is not None:
        member["permissions"] = permissions

    response = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": f"pair-denied-{uuid4().hex}",
            "token": f"pair-denied-token-{uuid4().hex}",
            "channel_id": "denied-channel",
            "guild_id": "denied-guild",
            "context": 0,
            "authorizing_integration_owners": {"0": "denied-guild"},
            "member": member,
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["content"] == (
        "You need Manage Server permission to pair or unpair this server."
    )
    assert (
        await db_session.get(ChannelPairCode, UUID(pair["id"]))
    ).status == PAIR_CODE_STATUS_PENDING
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


@pytest.mark.asyncio
async def test_discord_guild_unpair_requires_current_authority_and_pairing_actor(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    provider_reply = AsyncMock()
    monkeypatch.setattr(discord_router, "send_control_command_reply", provider_reply)
    created = await _create_paired_discord_channel(
        client,
        name="discord-unpair-two-part-authority",
        channel_id="unpair-authority-channel",
        guild_id="unpair-authority-guild",
    )

    async def unpair(*, actor: str, permissions: str, suffix: str) -> httpx.Response:
        return await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json={
                "type": 2,
                "id": f"unpair-authority-{suffix}",
                "token": f"unpair-authority-token-{suffix}",
                "channel_id": "unpair-authority-channel",
                "guild_id": "unpair-authority-guild",
                "context": 0,
                "authorizing_integration_owners": {"0": "unpair-authority-guild"},
                "member": {
                    "permissions": permissions,
                    "user": {"id": actor},
                },
                "data": {"name": "clawdi_unpair"},
            },
        )

    no_permission = await unpair(
        actor="discord-pair-user",
        permissions="0",
        suffix="no-permission",
    )
    wrong_actor = await unpair(
        actor="different-admin",
        permissions="32",
        suffix="wrong-actor",
    )
    allowed = await unpair(
        actor="discord-pair-user",
        permissions="8",
        suffix="allowed",
    )

    assert no_permission.json()["data"]["content"] == (
        "You need Manage Server permission to pair or unpair this server."
    )
    assert wrong_actor.json()["data"]["content"] == (
        "Only the user who paired this server can change its pairing."
    )
    assert allowed.json()["data"]["content"].startswith("Server unpaired.")
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    provider_reply.assert_not_awaited()


@pytest.mark.asyncio
async def test_discord_guild_cannot_move_to_second_link_until_explicit_unpair_and_alias_repair(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-guild-link-conflict",
        channel_id="link-a-channel",
        guild_id="single-link-guild",
        agent_id=channel_agent.id,
    )
    link_a_id = UUID(created["agent_link_id"])
    link_b = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert link_b.status_code == 201, link_b.text
    link_b_body = link_b.json()
    pair_b = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"agent_link_id": link_b_body["id"], "ttl_seconds": 900},
    )
    assert pair_b.status_code == 201, pair_b.text
    pair_b_body = pair_b.json()

    conflict = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "link-b-conflicting-pair",
            "token": "link-b-conflicting-pair-token",
            "channel_id": "link-a-channel",
            "guild_id": "single-link-guild",
            "context": 0,
            "authorizing_integration_owners": {"0": "single-link-guild"},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-pair-user"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair_b_body["code"]}],
            },
        },
    )

    assert conflict.status_code == 200
    assert conflict.json()["data"]["content"] == (
        "This server is already paired to another Agent. Unpair it first."
    )
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.external_chat_id == "single-link-guild",
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one()
    binding_id = binding.id
    assert binding.bot_agent_link_id == link_a_id
    pair_code = await db_session.get(ChannelPairCode, UUID(pair_b_body["id"]))
    assert pair_code is not None
    assert pair_code.status == PAIR_CODE_STATUS_PENDING

    unpaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "link-a-explicit-unpair",
            "token": "link-a-explicit-unpair-token",
            "channel_id": "link-a-channel",
            "guild_id": "single-link-guild",
            "context": 0,
            "member": {
                "permissions": "32",
                "user": {"id": "discord-pair-user"},
            },
            "data": {"name": "clawdi_unpair"},
        },
    )
    assert unpaired.json()["data"]["content"].startswith("Server unpaired.")

    repaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "link-b-pair-after-unpair",
            "token": "link-b-pair-after-unpair-token",
            "channel_id": "link-b-channel",
            "guild_id": "single-link-guild",
            "context": 0,
            "authorizing_integration_owners": {"0": "single-link-guild"},
            "member": {
                "permissions": "32",
                "user": {"id": "link-b-admin"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair_b_body["code"]}],
            },
        },
    )
    assert repaired.json()["data"]["content"].startswith("Server paired.")

    await db_session.refresh(binding)
    await db_session.refresh(pair_code)
    assert binding.id == binding_id
    assert binding.status == BINDING_STATUS_ACTIVE
    assert binding.bot_agent_link_id == UUID(link_b_body["id"])
    assert pair_code.status == "claimed"
    stale_alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.account_id == UUID(created["id"]),
                ChannelBindingAlias.alias_external_chat_id == "link-a-channel",
            )
        )
    ).scalar_one()
    assert stale_alias.binding_id == binding_id
    assert stale_alias.bot_agent_link_id == UUID(link_b_body["id"])

    _reset_fake_provider_client(
        {
            "id": "link-a-channel",
            "guild_id": "single-link-guild",
            "type": 0,
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    await channel_service.close_channel_provider_http_client()
    old_channel = await client.get(
        "/v1/channels/discord/v10/channels/link-a-channel",
        headers={"Authorization": f"Bot {link_b_body['agent_token']}"},
    )

    assert old_channel.status_code == 200
    assert len(_FakeProviderClient.calls) == 1
    await db_session.refresh(stale_alias)
    assert stale_alias.binding_id == binding_id
    assert stale_alias.bot_agent_link_id == UUID(link_b_body["id"])


@pytest.mark.asyncio
async def test_discord_interaction_unpair_archives_binding_and_cleans_guild_commands(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-unpair",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-pair",
            "token": "token-pair",
            "channel_id": "chan-discord-unpair",
            "guild_id": "guild-discord-unpair",
            "context": 0,
            "authorizing_integration_owners": {"0": "guild-discord-unpair"},
            "channel": {"id": "chan-discord-unpair", "name": "ops", "type": 0},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-user-unpair"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    other_application_id = "223456789012345678"
    other = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-unpair-other-application",
                "provider_token": "discord-other-provider-token",
                "config": _discord_ready_config(other_application_id),
            },
        )
    ).json()
    await _seed_created_channel_link(
        db_session,
        created=other,
        agent=channel_agent,
    )
    other_account = await db_session.get(ChannelAccount, UUID(other["id"]))
    assert other_account is not None
    db_session.add(
        ChannelBinding(
            account_id=other_account.id,
            bot_agent_link_id=UUID(other["agent_link_id"]),
            user_id=other_account.user_id,
            external_chat_id="other-app-channel-same-guild",
            external_chat_type="guild_text",
            external_chat_name="guild-discord-unpair",
        )
    )

    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.config = {
        "discord_agent_commands": {
            "global": [{"name": "agent_status", "description": "Agent status"}]
        }
    }
    await db_session.commit()
    _reset_fake_provider_client({"id": "provider-command"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    unpaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-unpair",
            "token": "token-unpair",
            "channel_id": "chan-discord-unpair",
            "guild_id": "guild-discord-unpair",
            "context": 0,
            "authorizing_integration_owners": {"0": "guild-discord-unpair"},
            "channel": {"id": "chan-discord-unpair", "name": "ops", "type": 0},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-user-unpair"},
            },
            "data": {"name": "clawdi_unpair"},
        },
    )

    assert unpaired.status_code == 200
    assert (
        unpaired.json()["data"]["content"]
        == "Server unpaired. This Discord server is no longer connected to an agent."
    )
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []
    other_bindings = await client.get(f"/v1/channels/{other['id']}/bindings")
    assert other_bindings.status_code == 200
    assert len(other_bindings.json()) == 1
    assert other_bindings.json()[0]["external_chat_id"] == "other-app-channel-same-guild"
    assert other_bindings.json()[0]["external_chat_name"] == "guild-discord-unpair"
    assert len(_FakeProviderClient.calls) == 1
    cleanup_call = _FakeProviderClient.calls[0]
    assert cleanup_call["method"] == "PUT"
    assert cleanup_call["url"].endswith(
        f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-discord-unpair/commands"
    )
    assert other_application_id not in cleanup_call["url"]
    assert cleanup_call["headers"]["Authorization"] == "Bot discord-provider-token"
    assert cleanup_call["content"] == b"[]"


@pytest.mark.asyncio
async def test_discord_unpair_command_cleanup_failure_keeps_authority_revoked(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-unpair-cleanup-failure",
        channel_id="cleanup-failure-channel",
        guild_id="cleanup-failure-guild",
    )
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.config = {
        "discord_agent_commands": {
            "global": [{"name": "agent_status", "description": "Agent status"}]
        }
    }
    await db_session.commit()
    _reset_fake_provider_client({"message": "provider failure"}, status_code=500)
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    unpaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "cleanup-failure-unpair",
            "token": "cleanup-failure-token",
            "channel_id": "cleanup-failure-channel",
            "guild_id": "cleanup-failure-guild",
            "context": 0,
            "authorizing_integration_owners": {"0": "cleanup-failure-guild"},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-pair-user"},
            },
            "data": {"name": "clawdi_unpair"},
        },
    )

    assert unpaired.status_code == 200
    assert unpaired.json()["data"]["content"].startswith("Server unpaired.")
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["content"] == b"[]"


@pytest.mark.asyncio
async def test_discord_guild_binding_delete_revokes_authority_then_cleans_commands(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-control-plane-guild-unpair",
        channel_id="discord-control-plane-guild-channel",
        guild_id="discord-control-plane-guild",
    )
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one()
    link = await db_session.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    assert link is not None
    link.config = {
        "discord_agent_commands": {
            "global": [{"name": "agent_status", "description": "Agent status"}]
        }
    }
    await db_session.commit()
    _reset_fake_provider_client({"id": "discord-control-plane-cleanup"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    response = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding.id}")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "binding_id": str(binding.id),
        "unpaired": True,
        "notification_status": "not_applicable",
        "provider_cleanup_status": "succeeded",
        "warning": None,
    }
    await db_session.refresh(binding)
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert len(_FakeProviderClient.calls) == 1
    cleanup_call = _FakeProviderClient.calls[0]
    assert cleanup_call["method"] == "PUT"
    assert cleanup_call["url"].endswith(
        f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/discord-control-plane-guild/commands"
    )
    assert cleanup_call["content"] == b"[]"


@pytest.mark.asyncio
async def test_discord_dm_binding_delete_revokes_without_guild_cleanup(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-control-plane-dm-unpair",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "discord-control-plane-dm-pair",
            "token": "discord-control-plane-dm-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "discord-control-plane-dm",
            "user": {"id": "discord-control-plane-dm-user"},
            "context": 1,
            "authorizing_integration_owners": {"1": "discord-control-plane-dm-user"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.status_code == 200, paired.text
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one()
    link = await db_session.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    assert link is not None
    link.config = {
        "discord_agent_commands": {
            "global": [{"name": "agent_status", "description": "Agent status"}]
        }
    }
    await db_session.commit()
    _reset_fake_provider_client({"id": "must-not-run-for-dm"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    response = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding.id}")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "binding_id": str(binding.id),
        "unpaired": True,
        "notification_status": "not_applicable",
        "provider_cleanup_status": "not_applicable",
        "warning": None,
    }
    await db_session.refresh(binding)
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_discord_binding_delete_cleanup_failure_warns_after_durable_revocation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-control-plane-cleanup-failure",
        channel_id="discord-control-plane-cleanup-channel",
        guild_id="discord-control-plane-cleanup-guild",
    )
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one()
    link = await db_session.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    assert link is not None
    link.config = {
        "discord_agent_commands": {
            "global": [{"name": "agent_status", "description": "Agent status"}]
        }
    }
    await db_session.commit()
    _reset_fake_provider_client({"message": "provider failure"}, status_code=500)
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )

    response = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding.id}")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "binding_id": str(binding.id),
        "unpaired": True,
        "notification_status": "not_applicable",
        "provider_cleanup_status": "failed",
        "warning": "Chat was unpaired, but Discord server command cleanup did not complete.",
    }
    await db_session.refresh(binding)
    assert binding.status == BINDING_STATUS_ARCHIVED
    audit = await client.get(
        "/v1/audit/events",
        params={"channel_account_id": created["id"], "limit": 20},
    )
    cleanup_event = next(
        item
        for item in audit.json()["items"]
        if item["action"] == "channel.binding.discord_cleanup"
    )
    assert cleanup_event["details"] == {
        "guild_id": "discord-control-plane-cleanup-guild",
        "provider_cleanup_status": "failed",
    }


@pytest.mark.asyncio
async def test_discord_binding_delete_denies_cross_user_account_inactive_link_and_unowned_agent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-control-plane-authority-boundary",
        channel_id="discord-control-plane-authority-channel",
        guild_id="discord-control-plane-authority-guild",
    )
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one()
    link = await db_session.get(ChannelBotAgentLink, binding.bot_agent_link_id)
    assert link is not None
    wrong_account = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-control-plane-wrong-account",
                "provider_token": "discord-provider-token-2",
                "config": _discord_ready_config("223456789012345678"),
            },
        )
    ).json()
    other_user, other_agent = await _create_user_with_channel_agent(
        db_session,
        label="discord-control-plane-other-user",
    )

    wrong_account_response = await client.delete(
        f"/v1/channels/{wrong_account['id']}/bindings/{binding.id}"
    )
    async with _client_for_user(db_session, other_user) as other_client:
        cross_user_response = await other_client.delete(
            f"/v1/channels/{created['id']}/bindings/{binding.id}"
        )

    link.status = BOT_AGENT_LINK_STATUS_ARCHIVED
    link.archived_at = datetime.now(UTC)
    await db_session.commit()
    inactive_link_response = await client.delete(
        f"/v1/channels/{created['id']}/bindings/{binding.id}"
    )

    link.status = BOT_AGENT_LINK_STATUS_ACTIVE
    link.archived_at = None
    link.agent_id = other_agent.id
    await db_session.commit()
    unowned_agent_response = await client.delete(
        f"/v1/channels/{created['id']}/bindings/{binding.id}"
    )

    assert wrong_account_response.status_code == 404
    assert cross_user_response.status_code == 404
    assert inactive_link_response.status_code == 404
    assert unowned_agent_response.status_code == 404
    await db_session.refresh(binding)
    assert binding.status == BINDING_STATUS_ACTIVE


def test_discord_dispatch_routing_key_uses_guild_binding_and_channel_alias_source():
    key = extract_discord_routing_key(
        {
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-2",
                "channel_id": "chan-2",
                "guild_id": "guild-2",
                "channel_type": 0,
            },
        }
    )

    assert key is not None
    assert key.chat_id == "guild-2"
    assert key.scope_id == "guild-2"
    assert key.channel_id == "chan-2"
    assert key.chat_type == "guild_text"


@pytest.mark.asyncio
async def test_discord_guild_binding_routes_other_members_channels_and_threads(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-guild-trust-boundary",
        channel_id="guild-channel-a",
        guild_id="guild-shared",
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None

    channel_frame = {
        "op": 0,
        "t": "MESSAGE_CREATE",
        "s": 51,
        "d": {
            "id": "guild-message-b",
            "channel_id": "guild-channel-b",
            "guild_id": "guild-shared",
            "channel_type": 0,
            "content": "ordinary member in channel B",
            "author": {"id": "ordinary-member-b"},
            "member": {"roles": ["ordinary-role"]},
            "clawdi_test_marker": {"preserved": True},
        },
    }
    thread_frame = {
        "op": 0,
        "t": "MESSAGE_CREATE",
        "s": 52,
        "d": {
            "id": "guild-thread-message",
            "channel_id": "guild-thread-b-1",
            "guild_id": "guild-shared",
            "channel_type": 11,
            "content": "thread reply",
            "author": {"id": "ordinary-member-c"},
        },
    }

    assert await record_discord_dispatch(db_session, account=account, frame=channel_frame)
    assert await record_discord_dispatch(db_session, account=account, frame=thread_frame)
    await db_session.commit()

    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage)
                .where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_message_id.in_(
                        ["guild-message-b", "guild-thread-message"]
                    ),
                )
                .order_by(ChannelMessage.provider_message_id)
            )
        ).scalars()
    )
    assert len(messages) == 2
    assert {message.binding_id for message in messages} == {messages[0].binding_id}
    assert {message.external_chat_id for message in messages} == {"guild-shared"}
    dispatches = {
        message.provider_message_id: discord_gateway_dispatch(message) for message in messages
    }
    assert dispatches["guild-message-b"]["d"] == channel_frame["d"]
    assert dispatches["guild-thread-message"]["d"] == thread_frame["d"]
    assert {
        dispatches["guild-message-b"]["d"]["channel_id"],
        dispatches["guild-thread-message"]["d"]["channel_id"],
    } == {"guild-channel-b", "guild-thread-b-1"}

    aliases = list(
        (
            await db_session.execute(
                select(ChannelBindingAlias).where(
                    ChannelBindingAlias.account_id == account.id,
                    ChannelBindingAlias.alias_external_chat_id.in_(
                        ["guild-channel-b", "guild-thread-b-1"]
                    ),
                )
            )
        ).scalars()
    )
    assert len(aliases) == 2
    assert {alias.binding_id for alias in aliases} == {messages[0].binding_id}


@pytest.mark.asyncio
async def test_discord_dm_round_trip_is_isolated_from_other_dms_and_guilds(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-dm-boundary",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "dm-pair-interaction",
            "token": "dm-pair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "discord-dm-a",
            "user": {"id": "discord-dm-actor"},
            "context": 1,
            "authorizing_integration_owners": {"1": "discord-dm-actor"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.status_code == 200
    assert paired.json()["data"]["content"] == (
        "Direct message paired. This Discord direct message is now connected to your agent."
    )

    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    dm_frame = {
        "op": 0,
        "t": "MESSAGE_CREATE",
        "s": 61,
        "d": {
            "id": "discord-dm-message",
            "channel_id": "discord-dm-a",
            "channel_type": 1,
            "content": "hello from the paired DM",
            "author": {"id": "discord-dm-actor"},
        },
    }
    assert await record_discord_dispatch(db_session, account=account, frame=dm_frame)
    assert await record_discord_dispatch(
        db_session,
        account=account,
        frame={
            "op": 0,
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "discord-other-dm-message",
                "channel_id": "discord-dm-b",
                "channel_type": 1,
                "content": "unpaired DM",
                "author": {"id": "discord-other-dm-actor"},
            },
        },
    )
    assert not await record_discord_dispatch(
        db_session,
        account=account,
        frame={
            "op": 0,
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "discord-guild-collision-message",
                "channel_id": "guild-channel",
                "guild_id": "discord-dm-a",
                "channel_type": 0,
                "content": "must not cross into the DM binding",
                "author": {"id": "guild-member"},
            },
        },
    )
    await db_session.commit()

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "discord-dm-message")
        )
    ).scalar_one()
    assert message.external_chat_id == "discord-dm-a"
    assert discord_gateway_dispatch(message)["d"] == dm_frame["d"]

    _reset_fake_provider_client(
        {
            "id": "discord-dm-reply",
            "channel_id": "discord-dm-a",
            "content": "DM reply",
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    await channel_service.close_channel_provider_http_client()
    cross_guild_reply = await client.post(
        "/v1/channels/discord/v10/channels/discord-dm-a/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={
            "content": "must not cross from DM to guild",
            "message_reference": {
                "message_id": "unrecorded-guild-message",
                "guild_id": "discord-guild-other",
            },
        },
    )
    assert cross_guild_reply.status_code == 404
    assert cross_guild_reply.json() == {"code": 10008, "message": "Unknown Message"}
    assert _FakeProviderClient.calls == []

    reply = await client.post(
        "/v1/channels/discord/v10/channels/discord-dm-a/messages",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"content": "DM reply"},
    )
    assert reply.status_code == 200
    assert reply.json()["channel_id"] == "discord-dm-a"
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith("/channels/discord-dm-a/messages")

    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.config = {
        "discord_agent_commands": {
            "global": [{"name": "agent_status", "description": "Agent status"}]
        }
    }
    await db_session.commit()
    _reset_fake_provider_client({"id": "provider-command"})
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    await channel_service.close_channel_provider_http_client()
    unpaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "dm-unpair-interaction",
            "token": "dm-unpair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "discord-dm-a",
            "user": {"id": "discord-dm-actor"},
            "context": 1,
            "authorizing_integration_owners": {"1": "discord-dm-actor"},
            "data": {"name": "clawdi_unpair"},
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["data"]["content"].startswith("Direct message unpaired.")
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_discord_dispatch_records_bound_message(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-dispatch",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-dispatch-pair",
            "token": "interaction-dispatch-pair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "chan-dispatch",
            "guild_id": "guild-dispatch",
            "context": 0,
            "authorizing_integration_owners": {"0": "guild-dispatch"},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-dispatch-pair-user"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()

    recorded = await record_discord_dispatch(
        db_session,
        account=account,
        frame={
            "op": 0,
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-dispatch-1",
                "channel_id": "chan-dispatch",
                "guild_id": "guild-dispatch",
                "content": "hello from discord",
            },
        },
    )
    await db_session.commit()

    assert recorded is True
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "msg-dispatch-1")
        )
    ).scalar_one()
    assert message.external_chat_id == "guild-dispatch"
    assert message.text == "hello from discord"
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.account_id == UUID(created["id"]),
                ChannelBindingAlias.alias_external_chat_id == "chan-dispatch",
                ChannelBindingAlias.alias_kind == "discord_channel",
            )
        )
    ).scalar_one()
    assert alias.binding_id == message.binding_id
    assert discord_gateway_dispatch(message) == {
        "op": 0,
        "t": "MESSAGE_CREATE",
        "s": message.inbox_sequence,
        "d": {
            "id": "msg-dispatch-1",
            "channel_id": "chan-dispatch",
            "guild_id": "guild-dispatch",
            "content": "hello from discord",
        },
    }


@pytest.mark.asyncio
async def test_discord_pair_preparation_configures_endpoint_then_global_commands_then_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _DiscordPreparationProviderClient.reset(
        [
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "flags": channel_service.DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG,
                    "integration_types_config": {
                        "0": {
                            "oauth2_install_params": {
                                "scopes": ["applications.commands"],
                                "permissions": "0",
                            }
                        },
                        "1": {
                            "oauth2_install_params": {
                                "scopes": ["applications.commands"],
                                "permissions": "0",
                            }
                        },
                    },
                },
                200,
            ),
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "integration_types_config": {
                        "0": {
                            "oauth2_install_params": {
                                "scopes": ["applications.commands", "bot"],
                                "permissions": str(channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS),
                            }
                        },
                        "1": {
                            "oauth2_install_params": {
                                "scopes": ["applications.commands"],
                                "permissions": "0",
                            }
                        },
                    },
                },
                200,
            ),
            (
                [
                    {
                        "id": "810000000000000001",
                        "name": "runtime_status",
                        "type": 1,
                    },
                    {"id": "810000000000000002", "name": "bot_pair", "type": 1},
                    {"id": "810000000000000003", "name": "bot_unpair", "type": 1},
                ],
                200,
            ),
            ({"id": "810000000000000004", "name": "clawdi_pair", "type": 1}, 200),
            ({"id": "810000000000000005", "name": "clawdi_unpair", "type": 1}, 200),
            ({"id": "810000000000000006", "name": "clawdi_help", "type": 1}, 200),
            ({}, 204),
            ({}, 204),
        ]
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _DiscordPreparationProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-fresh-pair-preparation",
                "provider_token": "discord-provider-token",
                "config": {
                    "application_id": DISCORD_TEST_APPLICATION_ID,
                    "public_key": DISCORD_TEST_PUBLIC_KEY,
                    "guild_id": "legacy-guild-must-not-scope-defaults",
                },
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 201, pair.text
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == [
        "GET",
        "PATCH",
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
    ]
    get_call, patch_call, list_call, *reconciliation_calls = _DiscordPreparationProviderClient.calls
    assert get_call["url"].endswith("/applications/@me")
    assert patch_call["json"] == {
        "interactions_endpoint_url": created["webhook_url"],
        "install_params": {
            "scopes": ["applications.commands", "bot"],
            "permissions": str(channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS),
        },
        "integration_types_config": {
            "0": {
                "oauth2_install_params": {
                    "scopes": ["applications.commands", "bot"],
                    "permissions": str(channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS),
                }
            },
            "1": {
                "oauth2_install_params": {
                    "scopes": ["applications.commands"],
                    "permissions": "0",
                }
            },
        },
    }
    expected_global_path = f"/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    assert list_call["url"].endswith(expected_global_path)
    assert "legacy-guild-must-not-scope-defaults" not in list_call["url"]
    delete_calls = [call for call in reconciliation_calls if call["method"] == "DELETE"]
    assert {call["url"].rsplit("/", 1)[-1] for call in delete_calls} == {
        "810000000000000002",
        "810000000000000003",
    }
    assert all("810000000000000001" not in call["url"] for call in delete_calls)
    post_calls = [call for call in reconciliation_calls if call["method"] == "POST"]
    assert [call["json"]["name"] for call in post_calls] == [
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    ]
    pair_command, unpair_command, help_command = [call["json"] for call in post_calls]
    assert pair_command["default_member_permissions"] == "32"
    assert unpair_command["default_member_permissions"] == "32"
    assert pair_command["integration_types"] == [0, 1]
    assert pair_command["contexts"] == [0, 1]
    assert pair_command["description"] == "Pair this server or direct message with Clawdi."
    assert unpair_command["integration_types"] == [0, 1]
    assert unpair_command["contexts"] == [0, 1]
    assert unpair_command["description"] == (
        "Disconnect this server or direct message from Clawdi."
    )
    assert "default_member_permissions" not in help_command
    assert help_command["description"] == "Show safe Clawdi pairing instructions."
    install_url = pair.json()["discord_install_url"]
    assert install_url == (
        "https://discord.com/oauth2/authorize"
        f"?client_id={DISCORD_TEST_APPLICATION_ID}"
        "&integration_type=0"
        "&permissions=309237763136"
        "&scope=bot%20applications.commands"
    )
    bot_permissions = int(parse_qs(urlparse(install_url).query)["permissions"][0])
    assert bot_permissions == sum(1 << bit for bit in (6, 10, 11, 14, 15, 16, 35, 38))
    assert bot_permissions & ((1 << 3) | (1 << 5)) == 0
    assert pair.json()["discord_user_install_url"] == (
        "https://discord.com/oauth2/authorize"
        f"?client_id={DISCORD_TEST_APPLICATION_ID}"
        "&integration_type=1"
        "&scope=applications.commands"
    )
    assert pair.json()["pairing_command"] == f"/clawdi_pair {pair.json()['code']}"
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert account.config["discord_interactions_configured"] is True
    assert (
        account.config["discord_install_config_version"]
        == channel_service.DISCORD_INSTALL_CONFIG_VERSION
    )
    assert account.config["discord_user_install_supported"] is True
    assert (
        account.config["discord_reserved_command_version"]
        == channel_service.DISCORD_RESERVED_COMMAND_VERSION
    )


@pytest.mark.asyncio
async def test_discord_pair_preparation_requires_message_content_intent(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _DiscordPreparationProviderClient.reset(
        [
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "flags": 0,
                    "integration_types_config": {"0": {}},
                },
                200,
            )
        ]
    )
    monkeypatch.setattr(channel_service.httpx, "AsyncClient", _DiscordPreparationProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-message-content-readiness",
                "provider_token": "discord-provider-token",
                "config": {
                    "application_id": DISCORD_TEST_APPLICATION_ID,
                    "public_key": DISCORD_TEST_PUBLIC_KEY,
                },
            },
        )
    ).json()

    pair = await client.post(f"/v1/channels/{created['id']}/pair-codes", json={})

    assert pair.status_code == 400
    assert pair.json() == {
        "detail": "Enable the Message Content Intent for this Discord application, then retry."
    }
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == ["GET"]


@pytest.mark.asyncio
async def test_discord_existing_account_reconciles_reserved_commands_before_pair_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    application_path = f"/applications/{DISCORD_TEST_APPLICATION_ID}"
    global_path = f"{application_path}/commands"
    guild_path = f"{application_path}/guilds/legacy-guild-123/commands"
    _StatefulDiscordCommandClient.reset(
        {
            global_path: [
                {"id": "820000000000000001", "name": "runtime_status", "type": 1},
                {"id": "820000000000000002", "name": "bot_pair", "type": 1},
                {"id": "820000000000000003", "name": "bot_unpair", "type": 1},
            ],
            guild_path: [
                {"id": "830000000000000001", "name": "guild_runtime", "type": 1},
                {"id": "830000000000000002", "name": "bot_pair", "type": 1},
                {"id": "830000000000000003", "name": "bot_unpair", "type": 1},
            ],
        }
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _StatefulDiscordCommandClient,
    )
    legacy_config = _discord_ready_config()
    legacy_config["discord_reserved_command_version"] = 1
    legacy_config["guild_id"] = "legacy-guild-123"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-existing-command-cutover",
                "provider_token": "discord-provider-token",
                "config": legacy_config,
            },
        )
    ).json()

    first_pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert first_pair.status_code == 201, first_pair.text
    assert first_pair.json()["pairing_command"].startswith("/clawdi_pair ")
    assert [call["method"] for call in _StatefulDiscordCommandClient.calls] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
    ]
    delete_calls = [
        call for call in _StatefulDiscordCommandClient.calls if call["method"] == "DELETE"
    ]
    assert {call["url"].rsplit("/", 1)[-1] for call in delete_calls} == {
        "820000000000000002",
        "820000000000000003",
        "830000000000000002",
        "830000000000000003",
    }
    assert all("820000000000000001" not in call["url"] for call in delete_calls)
    assert all("830000000000000001" not in call["url"] for call in delete_calls)
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[global_path]
    } == {
        "runtime_status",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    }
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[guild_path]
    } == {
        "guild_runtime",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    }
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert (
        account.config["discord_reserved_command_version"]
        == channel_service.DISCORD_RESERVED_COMMAND_VERSION
    )

    second_pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert second_pair.status_code == 201, second_pair.text
    assert len(_StatefulDiscordCommandClient.calls) == 12


@pytest.mark.asyncio
async def test_discord_reserved_command_reconciliation_failure_creates_no_pair_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)
    stale_config = _discord_ready_config()
    stale_config["discord_reserved_command_version"] = "1"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-cutover-failure",
                "provider_token": "discord-provider-token",
                "config": stale_config,
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 502
    assert pair.json()["detail"] == "discord api unreachable"
    assert len(_FailingProviderClient.calls) == 1
    assert _FailingProviderClient.calls[0]["method"] == "GET"
    pair_codes = list(
        (
            await db_session.execute(
                select(ChannelPairCode).where(ChannelPairCode.account_id == UUID(created["id"]))
            )
        ).scalars()
    )
    assert pair_codes == []


@pytest.mark.asyncio
async def test_discord_reserved_upsert_failure_performs_no_legacy_deletes(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _DiscordPreparationProviderClient.reset(
        [
            (
                [
                    {"id": "860000000000000001", "name": "runtime_status", "type": 1},
                    {"id": "860000000000000002", "name": "bot_pair", "type": 1},
                    {"id": "860000000000000003", "name": "bot_unpair", "type": 1},
                ],
                200,
            ),
            ({"id": "860000000000000004", "name": "clawdi_pair", "type": 1}, 200),
            ({"message": "upsert failed"}, 500),
        ]
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _DiscordPreparationProviderClient,
    )
    stale_config = _discord_ready_config()
    stale_config["discord_reserved_command_version"] = 1
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-upsert-failure",
                "provider_token": "discord-provider-token",
                "config": stale_config,
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 502
    assert pair.json()["detail"] == "discord api rejected commands"
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == [
        "GET",
        "POST",
        "POST",
    ]
    assert all(call["method"] != "DELETE" for call in _DiscordPreparationProviderClient.calls)
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert account.config["discord_reserved_command_version"] == 1
    pair_codes = list(
        (
            await db_session.execute(
                select(ChannelPairCode).where(ChannelPairCode.account_id == UUID(created["id"]))
            )
        ).scalars()
    )
    assert pair_codes == []


@pytest.mark.asyncio
async def test_discord_reserved_delete_not_found_is_idempotent_success(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    global_path = f"/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    _StatefulDiscordCommandClient.reset(
        {
            global_path: [
                {"id": "870000000000000001", "name": "runtime_status", "type": 1},
                {"id": "870000000000000002", "name": "bot_pair", "type": 1},
                {"id": "870000000000000003", "name": "bot_unpair", "type": 1},
            ]
        },
        delete_statuses_by_id={"870000000000000002": [404]},
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _StatefulDiscordCommandClient,
    )
    stale_config = _discord_ready_config()
    stale_config["discord_reserved_command_version"] = 1
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-delete-not-found",
                "provider_token": "discord-provider-token",
                "config": stale_config,
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 201, pair.text
    assert [call["method"] for call in _StatefulDiscordCommandClient.calls] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
    ]
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[global_path]
    } == {
        "runtime_status",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    }
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert (
        account.config["discord_reserved_command_version"]
        == channel_service.DISCORD_RESERVED_COMMAND_VERSION
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("delete_status", "expected_status", "expected_detail"),
    [
        (500, 502, "discord api rejected commands"),
        (429, 429, "discord command sync is rate limited"),
    ],
)
async def test_discord_reserved_delete_failure_retries_to_convergence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    delete_status: int,
    expected_status: int,
    expected_detail: str,
):
    clock = [1_000.0]
    monkeypatch.setattr(
        channel_service,
        "discord_rate_limiter",
        DiscordRateLimiter(now=lambda: clock[0]),
    )
    global_path = f"/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    _StatefulDiscordCommandClient.reset(
        {
            global_path: [
                {"id": "880000000000000001", "name": "runtime_status", "type": 1},
                {"id": "880000000000000002", "name": "bot_pair", "type": 1},
                {"id": "880000000000000003", "name": "bot_unpair", "type": 1},
            ]
        },
        delete_statuses_by_id={"880000000000000002": [delete_status]},
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _StatefulDiscordCommandClient,
    )
    stale_config = _discord_ready_config()
    stale_config["discord_reserved_command_version"] = 1
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-delete-retry",
                "provider_token": "discord-provider-token",
                "config": stale_config,
            },
        )
    ).json()

    failed_pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert failed_pair.status_code == expected_status
    assert failed_pair.json()["detail"] == expected_detail
    if delete_status == 429:
        assert failed_pair.headers["Retry-After"] == "0"
    assert [call["method"] for call in _StatefulDiscordCommandClient.calls] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
    ]
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[global_path]
    } == {
        "runtime_status",
        "bot_pair",
        "bot_unpair",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    }
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert account.config["discord_reserved_command_version"] == 1
    pair_codes = list(
        (
            await db_session.execute(
                select(ChannelPairCode).where(ChannelPairCode.account_id == UUID(created["id"]))
            )
        ).scalars()
    )
    assert pair_codes == []

    if delete_status == 429:
        clock[0] += 1.1
    converged_pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert converged_pair.status_code == 201, converged_pair.text
    assert [call["method"] for call in _StatefulDiscordCommandClient.calls[5:]] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
    ]
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[global_path]
    } == {
        "runtime_status",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    }
    await db_session.refresh(account)
    assert (
        account.config["discord_reserved_command_version"]
        == channel_service.DISCORD_RESERVED_COMMAND_VERSION
    )


@pytest.mark.asyncio
async def test_discord_reserved_command_version_waits_for_global_and_guild_success(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        channel_service,
        "discord_rate_limiter",
        DiscordRateLimiter(now=lambda: 1_000.0),
    )
    _DiscordPreparationProviderClient.reset(
        [
            (
                [
                    {"id": "850000000000000001", "name": "bot_pair", "type": 1},
                    {"id": "850000000000000002", "name": "bot_unpair", "type": 1},
                ],
                200,
            ),
            ({"id": "850000000000000003", "name": "clawdi_pair", "type": 1}, 200),
            ({"id": "850000000000000004", "name": "clawdi_unpair", "type": 1}, 200),
            ({"id": "850000000000000005", "name": "clawdi_help", "type": 1}, 200),
            ({}, 204),
            ({}, 204),
            ({"message": "rate limited", "retry_after": 0}, 429),
        ]
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _DiscordPreparationProviderClient,
    )
    stale_config = _discord_ready_config()
    stale_config["discord_reserved_command_version"] = 0
    stale_config["guild_id"] = "legacy-guild-rate-limited"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-cutover-partial-failure",
                "provider_token": "discord-provider-token",
                "config": stale_config,
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 429
    assert pair.json()["detail"] == "discord command sync is rate limited"
    assert pair.headers["Retry-After"] == "0"
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
        "GET",
    ]
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert account.config["discord_reserved_command_version"] == 0
    pair_codes = list(
        (
            await db_session.execute(
                select(ChannelPairCode).where(ChannelPairCode.account_id == UUID(created["id"]))
            )
        ).scalars()
    )
    assert pair_codes == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("responses", "expected_status"),
    [
        ([({"id": "223456789012345678"}, 200)], 409),
        (
            [
                (
                    {
                        "id": DISCORD_TEST_APPLICATION_ID,
                        "flags": channel_service.DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG,
                    },
                    200,
                ),
                ({"message": "invalid interactions endpoint"}, 400),
            ],
            502,
        ),
    ],
)
async def test_discord_pair_preparation_identity_or_validation_failure_creates_no_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    responses: list[tuple[dict[str, Any], int]],
    expected_status: int,
):
    _DiscordPreparationProviderClient.reset(responses)
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _DiscordPreparationProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-pair-preparation-failure-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": {
                    "application_id": DISCORD_TEST_APPLICATION_ID,
                    "public_key": DISCORD_TEST_PUBLIC_KEY,
                },
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == expected_status
    codes = list(
        (
            await db_session.execute(
                select(ChannelPairCode).where(ChannelPairCode.account_id == UUID(created["id"]))
            )
        ).scalars()
    )
    assert codes == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patched_integration_types",
    [
        {},
        {
            "0": {
                "oauth2_install_params": {
                    "scopes": ["applications.commands"],
                    "permissions": str(channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS),
                }
            }
        },
        {
            "0": {
                "oauth2_install_params": {
                    "scopes": ["applications.commands", "bot"],
                    "permissions": "0",
                }
            }
        },
        {
            "0": {
                "oauth2_install_params": {
                    "scopes": ["applications.commands", "bot"],
                    "permissions": str(channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS),
                }
            },
            "1": {
                "oauth2_install_params": {
                    "scopes": ["applications.commands", "bot"],
                    "permissions": "0",
                }
            },
        },
    ],
)
async def test_discord_pair_preparation_requires_exact_persisted_install_contract(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    patched_integration_types: dict[str, Any],
) -> None:
    initial_integration_types = {
        "0": {
            "oauth2_install_params": {
                "scopes": ["applications.commands"],
                "permissions": "0",
            }
        },
        "1": {
            "oauth2_install_params": {
                "scopes": ["applications.commands"],
                "permissions": "0",
            }
        },
    }
    _DiscordPreparationProviderClient.reset(
        [
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "flags": channel_service.DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG,
                    "integration_types_config": initial_integration_types,
                },
                200,
            ),
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "integration_types_config": patched_integration_types,
                },
                200,
            ),
        ]
    )
    monkeypatch.setattr(channel_service.httpx, "AsyncClient", _DiscordPreparationProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-install-contract-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": {
                    "application_id": DISCORD_TEST_APPLICATION_ID,
                    "public_key": DISCORD_TEST_PUBLIC_KEY,
                },
            },
        )
    ).json()

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 502
    assert [call["method"] for call in _DiscordPreparationProviderClient.calls] == [
        "GET",
        "PATCH",
    ]
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert channel_service.discord_install_config_is_current(account) is False
    assert channel_service.discord_user_install_url(account) is None
    pair_codes = list(
        (
            await db_session.execute(
                select(ChannelPairCode).where(ChannelPairCode.account_id == UUID(created["id"]))
            )
        ).scalars()
    )
    assert pair_codes == []


@pytest.mark.asyncio
async def test_discord_default_command_sync_reconciles_only_reserved_commands(
    client: httpx.AsyncClient,
    monkeypatch,
):
    guild_path = f"/applications/{DISCORD_TEST_APPLICATION_ID}/guilds/guild-123/commands"
    _StatefulDiscordCommandClient.reset(
        {
            guild_path: [
                {"id": "840000000000000001", "name": "guild_runtime", "type": 1},
                {"id": "840000000000000002", "name": "bot_pair", "type": 1},
                {"id": "840000000000000003", "name": "bot_unpair", "type": 1},
            ]
        }
    )
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _StatefulDiscordCommandClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-commands",
                "provider_token": "discord-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    response = await client.post(
        f"/v1/channels/{created['id']}/commands/sync",
        json={"guild_id": "guild-123"},
    )

    assert response.status_code == 200
    assert response.json()["provider"] == "discord"
    assert [call["method"] for call in _StatefulDiscordCommandClient.calls] == [
        "GET",
        "POST",
        "POST",
        "POST",
        "DELETE",
        "DELETE",
    ]
    assert all(
        call["url"].endswith(guild_path)
        for call in _StatefulDiscordCommandClient.calls
        if call["method"] != "DELETE"
    )
    delete_calls = [
        call for call in _StatefulDiscordCommandClient.calls if call["method"] == "DELETE"
    ]
    assert {call["url"].rsplit("/", 1)[-1] for call in delete_calls} == {
        "840000000000000002",
        "840000000000000003",
    }
    assert all("840000000000000001" not in call["url"] for call in delete_calls)
    post_calls = [call for call in _StatefulDiscordCommandClient.calls if call["method"] == "POST"]
    assert all(call["headers"]["Authorization"] == "Bot discord-token" for call in post_calls)
    pair_command, unpair_command, help_command = [call["json"] for call in post_calls]
    assert pair_command["name"] == "clawdi_pair"
    assert pair_command["default_member_permissions"] == "32"
    assert pair_command["options"][0]["name"] == "code"
    assert "integration_types" not in pair_command
    assert "contexts" not in pair_command
    assert unpair_command["name"] == "clawdi_unpair"
    assert unpair_command["default_member_permissions"] == "32"
    assert "integration_types" not in unpair_command
    assert "contexts" not in unpair_command
    assert help_command["name"] == "clawdi_help"
    assert "default_member_permissions" not in help_command
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[guild_path]
    } == {
        "guild_runtime",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    }


@pytest.mark.asyncio
async def test_discord_default_command_sync_handles_network_failure(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-command-network-failure",
                "provider_token": "discord-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    response = await client.post(f"/v1/channels/{created['id']}/commands/sync", json={})

    assert response.status_code == 502
    assert response.json()["detail"] == "discord api unreachable"
    assert len(_FailingProviderClient.calls) == 1
    assert _FailingProviderClient.calls[0]["method"] == "GET"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name",
    [
        "bot_pair",
        "bot_unpair",
        "bot_status",
        "clawdi_pair",
        "clawdi_unpair",
        "clawdi_help",
    ],
)
async def test_discord_custom_command_sync_rejects_reserved_names(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
):
    _FakeProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-reserved-command-{name}",
                "provider_token": "discord-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    response = await client.post(
        f"/v1/channels/{created['id']}/commands/sync",
        json={"commands": [{"name": name, "description": "Reserved command"}]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "discord command name is reserved"
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_discord_send_uses_provider_rest_api(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    monkeypatch.setattr(channel_service, "discord_rate_limiter", DiscordRateLimiter())
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"id": "discord-msg-1"}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-send",
                "provider_token": "discord-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "chan-2", "text": "deploy done"},
    )

    assert sent.status_code == 201
    assert sent.json()["provider_message_id"] is None
    assert sent.json()["delivery_status"] == "pending"

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == UUID(sent.json()["delivery_id"])

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.id == UUID(sent.json()["id"]))
        )
    ).scalar_one()
    assert message.provider_message_id == "discord-msg-1"
    assert _FakeProviderClient.calls[0]["url"].endswith("/channels/chan-2/messages")
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == "Bot discord-token"
    assert _FakeProviderClient.calls[0]["json"]["content"] == "deploy done"


@pytest.mark.parametrize(
    ("payload", "guild_id", "external_user_id", "expected"),
    [
        (
            {
                "type": 2,
                "context": 0,
                "authorizing_integration_owners": {"0": "guild-contract"},
                "data": {"name": "clawdi_pair"},
            },
            "guild-contract",
            "guild-actor",
            None,
        ),
        (
            {
                "type": 2,
                "context": 1,
                "authorizing_integration_owners": {"1": "dm-actor"},
                "data": {"name": "clawdi_pair"},
            },
            None,
            "dm-actor",
            None,
        ),
        (
            {"type": 2, "context": 2, "data": {"name": "clawdi_pair"}},
            "guild-contract",
            "guild-actor",
            channel_service.DISCORD_GUILD_INSTALL_REQUIRED,
        ),
        (
            {
                "type": 2,
                "authorizing_integration_owners": {"0": "guild-contract"},
                "data": {"name": "clawdi_pair"},
            },
            "guild-contract",
            "guild-actor",
            channel_service.DISCORD_GUILD_INSTALL_REQUIRED,
        ),
        (
            {
                "type": 2,
                "context": "0",
                "authorizing_integration_owners": {"0": "guild-contract"},
                "data": {"name": "clawdi_pair"},
            },
            "guild-contract",
            "guild-actor",
            channel_service.DISCORD_GUILD_INSTALL_REQUIRED,
        ),
        (
            {
                "type": 2,
                "context": 0,
                "authorizing_integration_owners": {"1": "guild-actor"},
                "data": {"name": "clawdi_pair"},
            },
            "guild-contract",
            "guild-actor",
            channel_service.DISCORD_GUILD_INSTALL_REQUIRED,
        ),
        (
            {
                "type": 2,
                "context": 0,
                "authorizing_integration_owners": {"0": "other-guild"},
                "data": {"name": "clawdi_pair"},
            },
            "guild-contract",
            "guild-actor",
            channel_service.DISCORD_GUILD_INSTALL_REQUIRED,
        ),
        (
            {
                "type": 2,
                "context": 1,
                "authorizing_integration_owners": {"0": "some-guild"},
                "data": {"name": "clawdi_pair"},
            },
            None,
            "dm-actor",
            channel_service.DISCORD_USER_INSTALL_REQUIRED,
        ),
        (
            {
                "type": 2,
                "context": 1,
                "authorizing_integration_owners": {"1": "other-user"},
                "data": {"name": "clawdi_pair"},
            },
            None,
            "dm-actor",
            channel_service.DISCORD_USER_INSTALL_REQUIRED,
        ),
    ],
)
def test_discord_pair_install_contract_requires_matching_context_and_owner(
    payload: dict[str, Any],
    guild_id: str | None,
    external_user_id: str,
    expected: str | None,
) -> None:
    command = channel_service.ChannelControlCommand(kind="pair", code="BCDFGHJKLM")

    assert (
        channel_service._discord_pair_install_admission(
            payload,
            command=command,
            guild_id=guild_id,
            external_user_id=external_user_id,
            trusted_interaction=True,
        )[0]
        == expected
    )


@pytest.mark.asyncio
async def test_public_discord_unbound_dm_controls_ack_without_tenant_messages(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    application_id = "723456789012345678"
    created = await _create_public_discord_account(
        client,
        monkeypatch,
        name="discord-public-unbound-dm-controls",
        application_id=application_id,
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert account.visibility == CHANNEL_VISIBILITY_PUBLIC
    assert account.user_id is None

    async def invoke(
        interaction_id: str,
        name: str,
        *,
        options: list[dict[str, Any]] | None = None,
        authorizing_user_id: str = "public-unbound-user",
    ) -> httpx.Response:
        return await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json={
                "type": 2,
                "id": interaction_id,
                "token": f"{interaction_id}-token",
                "application_id": application_id,
                "channel_id": "public-unbound-dm",
                "context": 1,
                "authorizing_integration_owners": {"1": authorizing_user_id},
                "user": {
                    "id": "public-unbound-user",
                    "global_name": "Public DM User",
                },
                "data": {
                    "name": name,
                    **({"options": options} if options is not None else {}),
                },
            },
        )

    help_response = await invoke("public-unbound-help", "clawdi_help")
    unpair_response = await invoke("public-unbound-unpair", "clawdi_unpair")
    missing_pair_response = await invoke(
        "public-unbound-missing-pair",
        "clawdi_pair",
        options=[],
    )
    invalid_pair_response = await invoke(
        "public-unbound-invalid-pair",
        "clawdi_pair",
        options=[{"name": "code", "value": "BCDFGHJKLM"}],
    )
    denied_pair_response = await invoke(
        "public-unbound-denied-pair",
        "clawdi_pair",
        options=[{"name": "code", "value": "BCDFGHJKLM"}],
        authorizing_user_id="different-user",
    )
    unroutable_component = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 3,
            "id": "public-unbound-component-without-channel",
            "token": "public-unbound-component-without-channel-token",
            "application_id": application_id,
            "context": 1,
            "authorizing_integration_owners": {"1": "public-unbound-user"},
            "user": {"id": "public-unbound-user"},
            "data": {"custom_id": "missing-channel", "component_type": 2},
        },
    )
    unroutable_autocomplete = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 4,
            "id": "public-unbound-autocomplete-without-channel",
            "token": "public-unbound-autocomplete-without-channel-token",
            "application_id": application_id,
            "context": 1,
            "authorizing_integration_owners": {"1": "public-unbound-user"},
            "user": {"id": "public-unbound-user"},
            "data": {"name": "missing_channel"},
        },
    )

    assert help_response.status_code == 200
    assert help_response.json() == {
        "type": 4,
        "data": {
            "content": channel_service.channel_control_help_reply(),
            "flags": 64,
        },
    }
    assert unpair_response.status_code == 200
    assert unpair_response.json()["data"]["content"] == "This direct message is not paired."
    assert missing_pair_response.status_code == 200
    assert missing_pair_response.json()["data"]["content"] == "Usage: /clawdi_pair <code>"
    assert invalid_pair_response.status_code == 200
    assert invalid_pair_response.json()["data"]["content"] == "Pairing failed: invalid."
    assert denied_pair_response.status_code == 200
    assert denied_pair_response.json()["data"]["content"] == (
        "Discord could not verify User Install for this direct-message command."
    )
    assert unroutable_component.json() == {
        "type": 4,
        "data": {"content": "Discord could not route this interaction.", "flags": 64},
    }
    assert unroutable_autocomplete.json() == {"type": 8, "data": {"choices": []}}
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ChannelMessage)
            .where(ChannelMessage.account_id == account.id)
        )
        == 0
    )


@pytest.mark.asyncio
async def test_public_discord_dm_pair_handoff_unpair_and_duplicate_are_recorded_correctly(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    application_id = "823456789012345678"
    created = await _create_public_discord_account(
        client,
        monkeypatch,
        name="discord-public-dm-pair-dedupe",
        application_id=application_id,
    )
    linked = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(channel_agent.id)},
    )
    assert linked.status_code == 201, linked.text
    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"agent_link_id": linked.json()["id"], "ttl_seconds": 900},
    )
    assert pair.status_code == 201, pair.text
    interaction = {
        "type": 2,
        "id": "public-dm-pair-interaction",
        "token": "public-dm-pair-token",
        "application_id": application_id,
        "channel_id": "public-paired-dm",
        "context": 1,
        "authorizing_integration_owners": {"1": "public-pair-user"},
        "user": {
            "id": "public-pair-user",
            "global_name": "Paired Public User",
        },
        "data": {
            "name": "clawdi_pair",
            "options": [{"name": "code", "value": pair.json()["code"]}],
        },
    }
    webhook_url = f"/v1/channels/discord/{created['id']}/webhook"
    headers = {"x-clawdi-channel-secret": created["webhook_secret"]}

    paired = await client.post(webhook_url, headers=headers, json=interaction)
    duplicate = await client.post(webhook_url, headers=headers, json=interaction)

    assert paired.status_code == 200
    assert paired.json()["data"]["content"].startswith("Direct message paired.")
    assert duplicate.status_code == 200
    assert duplicate.json()["data"]["content"] == "This interaction was already handled."
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == "public-paired-dm"
    assert bindings[0]["external_chat_type"] == "dm"
    assert bindings[0]["external_chat_name"] == "Paired Public User"
    binding_id = UUID(bindings[0]["id"])

    forwarded_interactions = [
        (2, {"name": "agent_command"}),
        (3, {"custom_id": "agent-component", "component_type": 2}),
        (4, {"name": "agent_autocomplete"}),
        (5, {"custom_id": "agent-modal", "components": []}),
    ]
    forwarded_ids: list[str] = []
    forwarded_payloads: dict[str, dict[str, Any]] = {}
    for interaction_type, interaction_data in forwarded_interactions:
        interaction_id = f"public-dm-agent-interaction-{interaction_type}"
        forwarded_ids.append(interaction_id)
        forwarded_payload = {
            "type": interaction_type,
            "id": interaction_id,
            "token": f"{interaction_id}-token",
            "application_id": application_id,
            "channel_id": "public-paired-dm",
            "context": 1,
            "authorizing_integration_owners": {"1": "public-pair-user"},
            "user": {
                "id": "public-pair-user",
                "global_name": "Paired Public User",
            },
            "data": interaction_data,
        }
        forwarded_payloads[interaction_id] = forwarded_payload
        forwarded = await client.post(
            webhook_url,
            headers=headers,
            json=forwarded_payload,
        )
        assert forwarded.status_code == 202
        assert forwarded.content == b""

    unpaired = await client.post(
        webhook_url,
        headers=headers,
        json={
            "type": 2,
            "id": "public-dm-unpair-interaction",
            "token": "public-dm-unpair-token",
            "application_id": application_id,
            "channel_id": "public-paired-dm",
            "context": 1,
            "authorizing_integration_owners": {"1": "public-pair-user"},
            "user": {
                "id": "public-pair-user",
                "global_name": "Renamed Public User",
            },
            "data": {"name": "clawdi_unpair"},
        },
    )

    assert unpaired.status_code == 200
    assert unpaired.json()["data"]["content"].startswith("Direct message unpaired.")
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    archived_binding = await db_session.get(ChannelBinding, binding_id)
    assert archived_binding is not None
    assert archived_binding.status == BINDING_STATUS_ARCHIVED
    assert archived_binding.external_chat_name == "Renamed Public User"

    unbound_interactions = [
        (2, {"name": "unbound_agent_command"}),
        (3, {"custom_id": "unbound-component", "component_type": 2}),
        (4, {"name": "unbound_autocomplete"}),
        (5, {"custom_id": "unbound-modal", "components": []}),
    ]
    unbound_responses: dict[int, httpx.Response] = {}
    for interaction_type, interaction_data in unbound_interactions:
        unbound_responses[interaction_type] = await client.post(
            webhook_url,
            headers=headers,
            json={
                "type": interaction_type,
                "id": f"public-unbound-interaction-{interaction_type}",
                "token": f"public-unbound-interaction-{interaction_type}-token",
                "application_id": application_id,
                "channel_id": "public-paired-dm",
                "context": 1,
                "authorizing_integration_owners": {"1": "public-pair-user"},
                "user": {"id": "public-pair-user"},
                "data": interaction_data,
            },
        )
    assert unbound_responses[2].json() == {
        "type": 4,
        "data": {"content": "This direct message is not paired.", "flags": 64},
    }
    assert unbound_responses[3].json() == {
        "type": 4,
        "data": {"content": "This direct message is not paired.", "flags": 64},
    }
    assert unbound_responses[4].json() == {"type": 8, "data": {"choices": []}}
    assert unbound_responses[5].json() == {
        "type": 4,
        "data": {"content": "This direct message is not paired.", "flags": 64},
    }
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_message_id.in_(
                        [
                            "public-dm-pair-interaction",
                            "public-dm-unpair-interaction",
                            *forwarded_ids,
                        ]
                    ),
                )
            )
        ).scalars()
    )
    assert len(messages) == 6
    assert {message.binding_id for message in messages} == {binding_id}
    assert {message.user_id for message in messages} == {channel_agent.user_id}
    forwarded_messages = {
        message.provider_message_id: message
        for message in messages
        if message.provider_message_id in forwarded_payloads
    }
    for interaction_id, payload in forwarded_payloads.items():
        dispatch = discord_gateway_dispatch(forwarded_messages[interaction_id])
        assert dispatch["op"] == 0
        assert dispatch["t"] == "INTERACTION_CREATE"
        assert dispatch["d"] == payload
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ChannelMessage)
            .where(ChannelMessage.account_id == UUID(created["id"]))
        )
        == 6
    )


@pytest.mark.asyncio
async def test_public_discord_unpaired_dm_tutorial_uses_platform_marker_without_message_rows(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = await _create_public_discord_account(
        client,
        monkeypatch,
        name="discord-public-unpaired-dm-tutorial",
        application_id="923456789012345678",
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    sent: list[dict[str, Any]] = []

    async def send_tutorial(**kwargs: Any) -> None:
        sent.append(kwargs)

    monkeypatch.setattr(
        channel_service,
        "send_platform_unbound_channel_message",
        send_tutorial,
    )

    def frame(
        message_id: str,
        *,
        message_type: int,
        bot: bool = False,
        webhook_id: str | None = None,
    ) -> dict[str, Any]:
        event = {
            "op": 0,
            "t": "MESSAGE_CREATE",
            "d": {
                "id": message_id,
                "channel_id": "public-tutorial-dm",
                "content": "hello",
                "type": message_type,
                "author": {
                    "id": "public-tutorial-user",
                    "global_name": "Tutorial User",
                    "bot": bot,
                },
            },
        }
        if webhook_id is not None:
            event["d"]["webhook_id"] = webhook_id
        return event

    assert not await record_discord_dispatch(
        db_session,
        account=account,
        frame=frame("tutorial-bot-reply", message_type=19, bot=True),
    )
    assert not await record_discord_dispatch(
        db_session,
        account=account,
        frame=frame("tutorial-webhook-reply", message_type=19, webhook_id="webhook-1"),
    )
    assert not await record_discord_dispatch(
        db_session,
        account=account,
        frame=frame("tutorial-system", message_type=6),
    )

    assert await record_discord_dispatch(
        db_session,
        account=account,
        frame=frame("tutorial-reply", message_type=19),
    )
    await db_session.commit()
    assert await record_discord_dispatch(
        db_session,
        account=account,
        frame=frame("tutorial-default", message_type=0),
    )
    await db_session.commit()

    assert sent == [
        {
            "account": account,
            "external_chat_id": "public-tutorial-dm",
            "text": (
                "This Discord chat is not paired. Create a Discord pairing code in Clawdi, "
                "then run /clawdi_pair <code>."
            ),
        }
    ]
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ChannelMessage)
            .where(ChannelMessage.account_id == account.id)
        )
        == 0
    )


@pytest.mark.asyncio
async def test_discord_secret_only_interaction_cannot_claim_pair_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(discord_router, "verify_discord_signature", lambda **_kwargs: False)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-secret-only-admission",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "forged-secret-only-interaction",
            "token": "forged-secret-only-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "forged-secret-only-channel",
            "guild_id": "forged-secret-only-guild",
            "context": 0,
            "authorizing_integration_owners": {"0": "forged-secret-only-guild"},
            "member": {
                "permissions": "32",
                "user": {
                    "id": "forged-secret-only-user",
                    "global_name": "Forged display name",
                    "username": "forged-display-name",
                },
            },
            "channel": {"id": "forged-secret-only-channel", "name": "Forged channel"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["content"] == (
        "Discord could not verify this app installation for this server command."
    )
    pair_code = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    assert pair_code is not None
    assert pair_code.status == PAIR_CODE_STATUS_PENDING
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


@pytest.mark.asyncio
async def test_discord_signed_guild_pair_persists_provider_name_and_routes_by_id(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "named-guild-id"
    guild_name = "Clawdi Community"

    async def named_membership(
        _account: ChannelAccount,
        *,
        guild_id: str,
    ) -> channel_service.DiscordGuildMembershipCheck:
        assert guild_id == "named-guild-id"
        return channel_service.DiscordGuildMembershipCheck(guild_name=guild_name)

    monkeypatch.setattr(
        channel_service,
        "discord_bot_guild_membership_check",
        named_membership,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-named-guild",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 300},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "named-guild-interaction",
            "token": "named-guild-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "named-guild-channel",
            "guild_id": guild_id,
            "context": 0,
            "authorizing_integration_owners": {"0": guild_id},
            "member": {
                "permissions": "32",
                "user": {"id": "named-guild-admin"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert response.status_code == 200, response.text
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == guild_id
    assert bindings[0]["external_chat_type"] == "guild"
    assert bindings[0]["external_chat_name"] == guild_name
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    binding = await db_session.get(ChannelBinding, UUID(bindings[0]["id"]))
    assert account is not None
    assert binding is not None
    assert shared_router.discord_binding_guild_id(binding) == guild_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("user", "expected_name"),
    [
        (
            {
                "id": "named-dm-user",
                "global_name": "Paco Display",
                "username": "paco_username",
            },
            "Paco Display",
        ),
        (
            {"id": "named-dm-user", "global_name": None, "username": "paco_username"},
            "paco_username",
        ),
        (
            {"id": "named-dm-user", "global_name": "   ", "username": "paco_username"},
            "paco_username",
        ),
    ],
)
async def test_discord_signed_dm_pair_persists_invoking_user_name(
    client: httpx.AsyncClient,
    user: dict[str, Any],
    expected_name: str,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-named-dm-{expected_name}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 300},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": f"named-dm-interaction-{expected_name}",
            "token": f"named-dm-token-{expected_name}",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": f"named-dm-channel-{expected_name}",
            "context": 1,
            "authorizing_integration_owners": {"1": "named-dm-user"},
            "user": user,
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    assert response.status_code == 200, response.text
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == f"named-dm-channel-{expected_name}"
    assert bindings[0]["external_chat_type"] == "dm"
    assert bindings[0]["external_chat_name"] == expected_name


@pytest.mark.asyncio
async def test_discord_trusted_gateway_dm_lazily_heals_existing_name_without_bad_overwrite(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    channel_id = "legacy-dm-channel-id"
    actor_id = "legacy-dm-actor"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-legacy-dm-name",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 300},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "legacy-dm-pair",
            "token": "legacy-dm-pair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": channel_id,
            "context": 1,
            "authorizing_integration_owners": {"1": actor_id},
            "user": {"id": actor_id},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.status_code == 200, paired.text
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == UUID(created["id"]))
        )
    ).scalar_one()
    binding.external_chat_name = channel_id
    await db_session.commit()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None

    assert await record_discord_dispatch(
        db_session,
        account=account,
        frame={
            "op": 0,
            "t": "MESSAGE_CREATE",
            "s": 1,
            "d": {
                "id": "legacy-dm-name-heal",
                "channel_id": channel_id,
                "channel_type": 1,
                "content": "trusted DM",
                "author": {
                    "id": actor_id,
                    "global_name": "  Trusted Display  ",
                    "username": "trusted_username",
                },
            },
        },
    )
    await db_session.commit()
    await db_session.refresh(binding)
    assert binding.external_chat_name == "Trusted Display"

    assert await record_discord_dispatch(
        db_session,
        account=account,
        frame={
            "op": 0,
            "t": "MESSAGE_CREATE",
            "s": 2,
            "d": {
                "id": "legacy-dm-name-fallback",
                "channel_id": channel_id,
                "channel_type": 1,
                "content": "fallback DM",
                "author": {
                    "id": actor_id,
                    "global_name": "   ",
                    "username": channel_id,
                },
            },
        },
    )
    await db_session.commit()
    await db_session.refresh(binding)
    assert binding.external_chat_name == "Trusted Display"


@pytest.mark.asyncio
async def test_discord_secret_only_dm_payload_cannot_replace_existing_display_name(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel_id = "secret-only-existing-dm"
    actor_id = "secret-only-existing-actor"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-secret-only-existing-name",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 300},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "secret-only-existing-pair",
            "token": "secret-only-existing-pair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": channel_id,
            "context": 1,
            "authorizing_integration_owners": {"1": actor_id},
            "user": {"id": actor_id, "global_name": "Trusted Existing"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.status_code == 200, paired.text
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == UUID(created["id"]))
        )
    ).scalar_one()
    assert binding.external_chat_name == "Trusted Existing"
    monkeypatch.setattr(discord_router, "verify_discord_signature", lambda **_kwargs: False)

    forged = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "id": "secret-only-existing-forged-message",
            "channel_id": channel_id,
            "channel_type": 1,
            "content": "forged metadata",
            "author": {
                "id": actor_id,
                "global_name": "Forged Display",
                "username": "forged_username",
            },
            "channel": {"id": channel_id, "name": "Forged Channel"},
        },
    )

    assert forged.status_code == 200, forged.text
    await db_session.refresh(binding)
    assert binding.external_chat_name == "Trusted Existing"


@pytest.mark.asyncio
async def test_discord_guild_pair_membership_preflight_fails_closed_without_claim(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-membership-preflight",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    for suffix, denied_reason in (
        ("absent", channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED),
        ("unavailable", channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE),
    ):

        async def denied_membership(
            _account: ChannelAccount,
            *,
            guild_id: str,
            reason: str = denied_reason,
        ) -> channel_service.DiscordGuildMembershipCheck:
            assert guild_id == f"membership-{suffix}-guild"
            return channel_service.DiscordGuildMembershipCheck(denied_reason=reason)

        monkeypatch.setattr(
            channel_service,
            "discord_bot_guild_membership_check",
            denied_membership,
        )
        pair = (
            await client.post(
                f"/v1/channels/{created['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()
        response = await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json={
                "type": 2,
                "id": f"membership-{suffix}-interaction",
                "token": f"membership-{suffix}-token",
                "application_id": DISCORD_TEST_APPLICATION_ID,
                "channel_id": f"membership-{suffix}-channel",
                "guild_id": f"membership-{suffix}-guild",
                "context": 0,
                "authorizing_integration_owners": {"0": f"membership-{suffix}-guild"},
                "member": {
                    "permissions": "32",
                    "user": {"id": "membership-admin"},
                },
                "data": {
                    "name": "clawdi_pair",
                    "options": [{"name": "code", "value": pair["code"]}],
                },
            },
        )
        assert response.status_code == 200
        pair_code = await db_session.get(ChannelPairCode, UUID(pair["id"]))
        assert pair_code is not None
        assert pair_code.status == PAIR_CODE_STATUS_PENDING

    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "payload", "headers", "expected"),
    [
        (
            200,
            {"id": "membership-real-guild", "name": "Clawdi Community"},
            {},
            None,
        ),
        (
            200,
            {"id": "membership-real-guild", "name": "   "},
            {},
            None,
        ),
        (
            200,
            {"id": "wrong-guild"},
            {},
            channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE,
        ),
        (
            302,
            {},
            {},
            channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE,
        ),
        (
            403,
            {},
            {},
            channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED,
        ),
        (
            404,
            {},
            {},
            channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_REQUIRED,
        ),
        (
            429,
            {"retry_after": 17.0},
            {},
            channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE,
        ),
        (
            503,
            {},
            {},
            channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE,
        ),
    ],
)
async def test_discord_membership_helper_classifies_real_provider_responses(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    payload: dict[str, Any],
    headers: dict[str, str],
    expected: str | None,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-membership-helper-{status_code}-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    limiter = DiscordRateLimiter(now=lambda: 100.0)

    class MembershipClient(_FakeProviderClient):
        async def get(self, url, **kwargs):
            self.calls.append({"method": "GET", "url": url, **kwargs})
            return _FakeProviderResponse(
                payload,
                status_code=status_code,
                headers=headers,
            )

    MembershipClient.calls = []
    monkeypatch.setattr(channel_service, "discord_rate_limiter", limiter)
    monkeypatch.setattr(channel_service.httpx, "AsyncClient", MembershipClient)

    result = await _REAL_DISCORD_BOT_GUILD_MEMBERSHIP_CHECK(
        account,
        guild_id="membership-real-guild",
    )

    assert result.denied_reason == expected
    expected_guild_name = (
        payload.get("name", "").strip()
        if expected is None and isinstance(payload.get("name"), str)
        else None
    )
    assert result.guild_name == (expected_guild_name or None)
    assert len(MembershipClient.calls) == 1
    if status_code == 429:
        decision = limiter.check(
            str(account.id),
            "GET",
            "/guilds/membership-real-guild",
        )
        assert decision.allowed is False
        assert decision.retry_after_seconds == pytest.approx(17.0)


@pytest.mark.asyncio
async def test_discord_membership_helper_network_failure_is_unavailable(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-membership-network",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None

    class NetworkFailureClient(_FakeProviderClient):
        async def get(self, url, **kwargs):
            raise httpx.ConnectError("membership network failure")

    monkeypatch.setattr(channel_service, "discord_rate_limiter", DiscordRateLimiter())
    monkeypatch.setattr(channel_service.httpx, "AsyncClient", NetworkFailureClient)

    assert (
        await _REAL_DISCORD_BOT_GUILD_MEMBERSHIP_CHECK(
            account,
            guild_id="membership-network-guild",
        )
    ).denied_reason == channel_service.DISCORD_BOT_GUILD_MEMBERSHIP_UNAVAILABLE


@pytest.mark.asyncio
async def test_discord_owner_missing_unpair_cleanup_skips_manage_guild_and_membership(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = await _create_paired_discord_channel(
        client,
        name="discord-owner-missing-cleanup",
        channel_id="owner-missing-channel",
        guild_id="owner-missing-guild",
    )

    async def membership_must_not_run(
        _account: ChannelAccount,
        *,
        guild_id: str,
    ) -> channel_service.DiscordGuildMembershipCheck:
        raise AssertionError(f"unpair attempted membership check for {guild_id}")

    monkeypatch.setattr(
        channel_service,
        "discord_bot_guild_membership_check",
        membership_must_not_run,
    )

    async def provider_success(**_kwargs: Any) -> shared_router.DiscordProviderResult:
        return shared_router.DiscordProviderResult(
            content=b"[]",
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(shared_router, "request_discord_provider", provider_success)

    async def unpair(actor: str, owners: dict[str, str] | None) -> httpx.Response:
        payload: dict[str, Any] = {
            "type": 2,
            "id": f"owner-missing-unpair-{actor}-{uuid4().hex}",
            "token": f"owner-missing-token-{uuid4().hex}",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "owner-missing-channel",
            "guild_id": "owner-missing-guild",
            "context": 0,
            "member": {"permissions": "0", "user": {"id": actor}},
            "data": {"name": "clawdi_unpair"},
        }
        if owners is not None:
            payload["authorizing_integration_owners"] = owners
        return await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json=payload,
        )

    wrong_actor = await unpair("other-actor", None)
    mismatched_owner = await unpair("discord-pair-user", {"0": "different-guild"})
    cleanup = await unpair("discord-pair-user", None)

    assert wrong_actor.json()["data"]["content"] == (
        "Only the user who paired this server can change its pairing."
    )
    assert mismatched_owner.json()["data"]["content"] == (
        "Discord could not verify this app installation for this server command."
    )
    assert cleanup.json()["data"]["content"].startswith("Server unpaired.")
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


@pytest.mark.asyncio
async def test_discord_replayed_unpair_cannot_archive_a_replacement_binding(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "replayed-unpair-guild"
    channel_id = "replayed-unpair-channel"
    actor_id = "discord-pair-user"
    created = await _create_paired_discord_channel(
        client,
        name="discord-replayed-unpair",
        channel_id=channel_id,
        guild_id=guild_id,
    )

    async def provider_success(**_kwargs: Any) -> shared_router.DiscordProviderResult:
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", provider_success)
    original_unpair = {
        "type": 2,
        "id": "replayed-unpair-interaction",
        "token": "replayed-unpair-token",
        "application_id": DISCORD_TEST_APPLICATION_ID,
        "channel_id": channel_id,
        "guild_id": guild_id,
        "context": 0,
        "authorizing_integration_owners": {"0": guild_id},
        "member": {
            "permissions": "32",
            "user": {"id": actor_id},
        },
        "data": {"name": "clawdi_unpair"},
    }
    first_unpair = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json=original_unpair,
    )
    assert first_unpair.json()["data"]["content"].startswith("Server unpaired.")

    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    replacement_pair = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "replacement-pair-interaction",
            "token": "replacement-pair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": channel_id,
            "guild_id": guild_id,
            "context": 0,
            "authorizing_integration_owners": {"0": guild_id},
            "member": {
                "permissions": "32",
                "user": {"id": actor_id},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert replacement_pair.json()["data"]["content"].startswith("Server paired.")

    replay = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json=original_unpair,
    )

    assert replay.json()["data"]["content"] == "This interaction was already handled."
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == guild_id


@pytest.mark.asyncio
async def test_discord_concurrent_replayed_unpair_waits_for_event_commit_and_repair(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "concurrent-replayed-unpair-guild"
    channel_id = "concurrent-replayed-unpair-channel"
    actor_id = "discord-pair-user"
    created = await _create_paired_discord_channel(
        client,
        name="discord-concurrent-replayed-unpair",
        channel_id=channel_id,
        guild_id=guild_id,
    )
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    original_unpair = {
        "type": 2,
        "id": "concurrent-replayed-unpair-interaction",
        "token": "concurrent-replayed-unpair-token",
        "application_id": DISCORD_TEST_APPLICATION_ID,
        "channel_id": channel_id,
        "guild_id": guild_id,
        "context": 0,
        "authorizing_integration_owners": {"0": guild_id},
        "member": {"permissions": "32", "user": {"id": actor_id}},
        "data": {"name": "clawdi_unpair"},
    }
    replacement_pair = {
        "type": 2,
        "id": "concurrent-replacement-pair-interaction",
        "token": "concurrent-replacement-pair-token",
        "application_id": DISCORD_TEST_APPLICATION_ID,
        "channel_id": channel_id,
        "guild_id": guild_id,
        "context": 0,
        "authorizing_integration_owners": {"0": guild_id},
        "member": {"permissions": "32", "user": {"id": actor_id}},
        "data": {
            "name": "clawdi_pair",
            "options": [{"name": "code", "value": pair["code"]}],
        },
    }
    original_record = discord_router.record_inbound_messages_for_bindings
    unpair_before_event_commit = asyncio.Event()
    release_unpair_commit = asyncio.Event()
    paused = False

    async def pause_first_unpair_before_event_commit(*args: Any, **kwargs: Any):
        nonlocal paused
        binding_result = kwargs["binding_result"]
        if binding_result.unpaired and not paused:
            paused = True
            unpair_before_event_commit.set()
            await release_unpair_commit.wait()
        return await original_record(*args, **kwargs)

    monkeypatch.setattr(
        discord_router,
        "record_inbound_messages_for_bindings",
        pause_first_unpair_before_event_commit,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    original_get_session_override = app.dependency_overrides[get_session]

    request_backend_pids: asyncio.Queue[int] = asyncio.Queue()

    async def independent_request_session() -> AsyncIterator[AsyncSession]:
        async with sessionmaker() as request_db:
            backend_pid = await request_db.scalar(text("SELECT pg_backend_pid()"))
            assert isinstance(backend_pid, int)
            request_backend_pids.put_nowait(backend_pid)
            yield request_db

    await db_session.rollback()
    app.dependency_overrides[get_session] = independent_request_session

    async def post_interaction(payload: dict[str, Any]) -> httpx.Response:
        return await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json=payload,
        )

    try:
        first_unpair_task = asyncio.create_task(post_interaction(original_unpair))
        await asyncio.wait_for(unpair_before_event_commit.wait(), timeout=2)
        await asyncio.wait_for(request_backend_pids.get(), timeout=2)
        replacement_pair_task = asyncio.create_task(post_interaction(replacement_pair))
        await wait_for_lock_wait(
            sessionmaker, await asyncio.wait_for(request_backend_pids.get(), timeout=2)
        )
        replay_task = asyncio.create_task(post_interaction(original_unpair))
        await wait_for_lock_wait(
            sessionmaker, await asyncio.wait_for(request_backend_pids.get(), timeout=2)
        )
        release_unpair_commit.set()

        first_unpair, repaired, replay = await asyncio.gather(
            first_unpair_task,
            replacement_pair_task,
            replay_task,
        )
    finally:
        release_unpair_commit.set()
        app.dependency_overrides[get_session] = original_get_session_override
    assert first_unpair.json()["data"]["content"].startswith("Server unpaired.")
    assert repaired.json()["data"]["content"].startswith("Server paired.")
    assert replay.json()["data"]["content"] == "This interaction was already handled."
    async with sessionmaker() as verification_db:
        active_bindings = list(
            (
                await verification_db.execute(
                    select(ChannelBinding).where(
                        ChannelBinding.account_id == UUID(created["id"]),
                        ChannelBinding.status == BINDING_STATUS_ACTIVE,
                    )
                )
            ).scalars()
        )
    assert len(active_bindings) == 1
    assert active_bindings[0].external_chat_id == guild_id


@pytest.mark.asyncio
async def test_discord_dm_owner_missing_unpair_cleanup_requires_original_actor(
    client: httpx.AsyncClient,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-dm-owner-missing-cleanup",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "dm-owner-missing-pair",
            "token": "dm-owner-missing-pair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "dm-owner-missing-channel",
            "context": 1,
            "authorizing_integration_owners": {"1": "dm-owner"},
            "user": {"id": "dm-owner"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.json()["data"]["content"].startswith("Direct message paired.")

    async def unpair(actor: str, owners: dict[str, str] | None) -> httpx.Response:
        payload: dict[str, Any] = {
            "type": 2,
            "id": f"dm-owner-missing-unpair-{uuid4().hex}",
            "token": f"dm-owner-missing-unpair-token-{uuid4().hex}",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "dm-owner-missing-channel",
            "context": 1,
            "user": {"id": actor},
            "data": {"name": "clawdi_unpair"},
        }
        if owners is not None:
            payload["authorizing_integration_owners"] = owners
        return await client.post(
            f"/v1/channels/discord/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json=payload,
        )

    wrong_actor = await unpair("other-dm-user", None)
    mismatched_owner = await unpair("dm-owner", {"1": "other-dm-user"})
    cleanup = await unpair("dm-owner", None)

    assert wrong_actor.json()["data"]["content"] == (
        "Only the user who paired this direct message can change its pairing."
    )
    assert mismatched_owner.json()["data"]["content"] == (
        "Discord could not verify User Install for this direct-message command."
    )
    assert cleanup.json()["data"]["content"].startswith("Direct message unpaired.")
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


@pytest.mark.asyncio
async def test_discord_guild_only_install_capability_stays_guild_only(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _DiscordPreparationProviderClient.reset(
        [
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "flags": channel_service.DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG,
                    "integration_types_config": {
                        "0": {
                            "oauth2_install_params": {
                                "scopes": ["applications.commands"],
                                "permissions": "0",
                            },
                            "preserved_field": True,
                        }
                    },
                },
                200,
            ),
            (
                {
                    "id": DISCORD_TEST_APPLICATION_ID,
                    "integration_types_config": {
                        "0": {
                            "oauth2_install_params": {
                                "scopes": ["applications.commands", "bot"],
                                "permissions": str(channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS),
                            },
                            "preserved_field": True,
                        }
                    },
                },
                200,
            ),
            ([], 200),
            ({"id": "910000000000000001", "name": "clawdi_pair", "type": 1}, 200),
            ({"id": "910000000000000002", "name": "clawdi_unpair", "type": 1}, 200),
            ({"id": "910000000000000003", "name": "clawdi_help", "type": 1}, 200),
        ]
    )
    monkeypatch.setattr(channel_service.httpx, "AsyncClient", _DiscordPreparationProviderClient)
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "discord",
            "name": "discord-guild-only-capability",
            "provider_token": "discord-provider-token",
            "config": {
                "application_id": DISCORD_TEST_APPLICATION_ID,
                "public_key": DISCORD_TEST_PUBLIC_KEY,
                "discord_install_config_version": (channel_service.DISCORD_INSTALL_CONFIG_VERSION),
                "discord_user_install_supported": True,
            },
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    assert channel_service.discord_user_install_url(account) is None

    pair = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair.status_code == 201, pair.text
    patch_call = _DiscordPreparationProviderClient.calls[1]
    assert patch_call["method"] == "PATCH"
    assert set(patch_call["json"]["integration_types_config"]) == {"0"}
    assert patch_call["json"]["integration_types_config"]["0"]["preserved_field"] is True
    assert pair.json()["discord_user_install_url"] is None
    await db_session.refresh(account)
    assert account.config["discord_user_install_supported"] is False
    post_calls = [
        call for call in _DiscordPreparationProviderClient.calls if call["method"] == "POST"
    ]
    assert len(post_calls) == 3
    for call in post_calls:
        assert call["json"]["integration_types"] == [0]
        assert call["json"]["contexts"] == [0]
        assert "direct message" not in call["json"]["description"]


@pytest.mark.asyncio
async def test_discord_pair_code_rejects_duplicate_verified_application_identity(
    client: httpx.AsyncClient,
) -> None:
    await _create_paired_discord_channel(
        client,
        name="discord-application-owner",
        channel_id="application-owner-channel",
        guild_id="application-owner-guild",
    )
    duplicate = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-application-duplicate",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    pair_code = await client.post(
        f"/v1/channels/{duplicate['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )

    assert pair_code.status_code == 409
    assert pair_code.json()["detail"] == (
        "This Discord application is already connected to another channel."
    )


@pytest.mark.asyncio
async def test_discord_legacy_duplicate_application_is_contested_across_accounts(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
) -> None:
    guild_id = "legacy-duplicate-application-guild"
    first = await _create_paired_discord_channel(
        client,
        name="discord-legacy-application-first",
        channel_id="legacy-application-first-channel",
        guild_id=guild_id,
        agent_id=channel_agent.id,
    )
    second_application_id = "223456789012345678"
    second = await _create_paired_discord_channel(
        client,
        name="discord-legacy-application-second",
        channel_id="legacy-application-second-channel",
        guild_id=guild_id,
        application_id=second_application_id,
        agent_id=second_channel_agent.id,
    )
    second_account = await db_session.get(ChannelAccount, UUID(second["id"]))
    assert second_account is not None
    config = dict(second_account.config) if isinstance(second_account.config, dict) else {}
    config["application_id"] = DISCORD_TEST_APPLICATION_ID
    second_account.config = config
    await db_session.commit()

    first_account = await db_session.get(ChannelAccount, UUID(first["id"]))
    first_link = await db_session.get(ChannelBotAgentLink, UUID(first["agent_link_id"]))
    second_link = await db_session.get(ChannelBotAgentLink, UUID(second["agent_link_id"]))
    assert first_account is not None
    assert first_link is not None
    assert second_link is not None
    owners = await shared_router._discord_guild_owner_principals(
        db_session,
        application_id=DISCORD_TEST_APPLICATION_ID,
        guild_id=guild_id,
    )

    assert owners == {
        (UUID(first["id"]), first_link.id),
        (UUID(second["id"]), second_link.id),
    }
    assert not await shared_router.discord_guild_owned_by_link(
        db_session,
        account=first_account,
        bot_agent_link_id=first_link.id,
        guild_id=guild_id,
    )
    assert (
        await shared_router.discord_uncontested_guilds_for_link(
            db_session,
            account=first_account,
            bot_agent_link_id=first_link.id,
        )
        == []
    )


@pytest.mark.asyncio
async def test_discord_admin_token_change_invalidates_verified_install_capability(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
) -> None:
    created_response = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_DISCORD,
        name="discord-token-capability-invalidation",
        visibility="private",
        provider_token="discord-provider-token",
        config=_discord_ready_config(),
    )
    assert created_response.status_code == 201, created_response.text
    account = await db_session.get(ChannelAccount, UUID(created_response.json()["id"]))
    assert account is not None
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config["discord_install_config_version"] = channel_service.DISCORD_INSTALL_CONFIG_VERSION
    config["discord_user_install_supported"] = True
    account.config = config
    await db_session.commit()

    admin_key = f"admin-{uuid4().hex}"
    original_admin_key = settings.admin_api_key
    settings.admin_api_key = admin_key
    try:
        replaced = await client.patch(
            f"/v1/admin/channels/{account.id}",
            headers={"X-Admin-Key": admin_key},
            json={"provider_token": "replacement-discord-provider-token"},
        )
    finally:
        settings.admin_api_key = original_admin_key

    assert replaced.status_code == 200, replaced.text
    await db_session.refresh(account)
    assert channel_service.discord_install_config_is_current(account) is False
    assert channel_service.discord_user_install_url(account) is None
    assert "discord_install_config_version" not in account.config
    assert "discord_user_install_supported" not in account.config


def test_discord_minimal_bot_permissions_are_exact_text_and_public_thread_baseline() -> None:
    permissions = channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS

    expected_permission_bits = {
        "ADD_REACTIONS": 6,
        "VIEW_CHANNEL": 10,
        "SEND_MESSAGES": 11,
        "EMBED_LINKS": 14,
        "ATTACH_FILES": 15,
        "READ_MESSAGE_HISTORY": 16,
        "CREATE_PUBLIC_THREADS": 35,
        "SEND_MESSAGES_IN_THREADS": 38,
    }
    assert permissions == sum(1 << bit for bit in expected_permission_bits.values())
    assert permissions == 309_237_763_136

    excluded_bits = (3, 4, 5, 13, 17, 20, 21, 28, 29, 30, 31, 33, 34, 36, 40, 43, 44, 49)
    for excluded_bit in excluded_bits:
        assert permissions & (1 << excluded_bit) == 0


def test_discord_message_content_intent_readiness_accepts_limited_or_approved_flags() -> None:
    channel_service._require_discord_message_content_intent(
        {"flags": channel_service.DISCORD_GATEWAY_MESSAGE_CONTENT_LIMITED_FLAG}
    )
    channel_service._require_discord_message_content_intent(
        {"flags": channel_service.DISCORD_GATEWAY_MESSAGE_CONTENT_FLAG}
    )

    for payload in ({}, {"flags": 0}, {"flags": True}, {"flags": "524288"}):
        with pytest.raises(HTTPException) as exc_info:
            channel_service._require_discord_message_content_intent(payload)
        assert exc_info.value.status_code == 400
        assert exc_info.value.detail == (
            "Enable the Message Content Intent for this Discord application, then retry."
        )


@pytest.mark.asyncio
async def test_discord_individual_command_mutations_coalesce_once_per_guild(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_ids = {"coalesced-command-guild-a", "coalesced-command-guild-b"}
    created = await _create_paired_discord_channel(
        client,
        name="discord-coalesced-command-mutations",
        channel_id="coalesced-command-channel",
        guild_id="coalesced-command-guild-a",
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=account.user_id,
            external_chat_id="coalesced-command-guild-b",
            external_chat_type="guild_text",
            external_chat_name="coalesced-command-guild-b",
            paired_external_user_id="discord-pair-user",
        )
    )
    await db_session.commit()
    provider_calls: list[dict[str, Any]] = []

    async def provider_success(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", provider_success)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    first = await client.post(
        command_url,
        headers=headers,
        json={"name": "first", "description": "First command"},
    )
    second = await client.post(
        command_url,
        headers=headers,
        json={"name": "second", "description": "Second command"},
    )
    updated = await client.patch(
        f"{command_url}/{second.json()['id']}",
        headers=headers,
        json={"description": "Updated second command"},
    )
    deleted = await client.delete(
        f"{command_url}/{first.json()['id']}",
        headers=headers,
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert updated.status_code == 200
    assert deleted.status_code == 204
    assert provider_calls == []

    link_id = UUID(created["agent_link_id"])
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)
    assert await worker.run_once() == 0
    assert provider_calls == []

    await _make_discord_projection_due(db_session, link_id=link_id)
    assert await worker.run_once() == 2
    assert {
        call["path"].split("/guilds/", 1)[1].split("/", 1)[0] for call in provider_calls
    } == guild_ids
    assert all(
        json.loads(call["body"])
        == [{"name": "second", "description": "Updated second command", "type": 1}]
        for call in provider_calls
    )
    listed = await client.get(command_url, headers=headers)
    assert [command["name"] for command in listed.json()] == ["second"]


@pytest.mark.asyncio
async def test_discord_prod_timeline_reconciles_shadow_after_guild_create(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "prod-timeline-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-prod-timeline",
        channel_id="prod-timeline-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []
    responses = [
        _discord_provider_result(502, {"message": "temporary upstream failure"}),
        _discord_provider_result(200, []),
    ]

    async def sequenced_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "request_discord_provider", sequenced_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    commands = [
        {"name": f"agent_command_{index}", "description": f"Agent command {index}"}
        for index in range(9)
    ]

    failed = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=commands,
    )
    stale_get = await client.get(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert failed.status_code == 502
    assert stale_get.status_code == 200
    assert stale_get.json() == []
    link_id = UUID(created["agent_link_id"])
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    assert len(link.config["discord_agent_commands"]["global"]) == 9
    assert guild_id not in link.config.get("discord_command_materializations", {})
    assert link.config["discord_command_retries"][guild_id]["status_code"] == 502

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)
    assert await worker.run_once() == 0
    assert len(provider_calls) == 1

    assert (
        await reconcile_discord_guild_commands(
            sessionmaker,
            account_id=UUID(created["id"]),
            guild_id=guild_id,
        )
        == 1
    )
    materialized_get = await client.get(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )
    assert [command["name"] for command in materialized_get.json()] == [
        command["name"] for command in commands
    ]
    assert len(provider_calls) == 2
    assert json.loads(provider_calls[1]["body"]) == [
        shared_router._discord_guild_command_provider_payload(command)
        for command in materialized_get.json()
    ]

    # Discord emits GUILD_CREATE for all available Guilds after READY and
    # reconnect. A current receipt must make that lifecycle replay a no-op.
    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            {
                "op": 0,
                "t": "GUILD_CREATE",
                "s": 902,
                "d": {"id": guild_id, "unavailable": False},
            },
            gateway_session_id="prod-timeline-reconnect",
        )
        is False
    )
    assert len(provider_calls) == 2

    assert await worker.run_once() == 0
    assert len(provider_calls) == 2


@pytest.mark.asyncio
async def test_discord_individual_delete_tombstone_coalesces_and_recovers(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "delete-tombstone-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-delete-tombstone",
        channel_id="delete-tombstone-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []
    responses = [
        _discord_provider_result(200, []),
        _discord_provider_result(502, {"message": "temporary delete failure"}),
        _discord_provider_result(200, []),
    ]

    async def sequenced_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "request_discord_provider", sequenced_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    stored = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[
            {"name": "ephemeral", "description": "Ephemeral command"},
            {"name": "temporary", "description": "Temporary command"},
        ],
    )
    assert stored.status_code == 200
    stored_commands = stored.json()

    for command in stored_commands:
        deleted = await client.delete(
            f"{command_url}/{command['id']}",
            headers={"Authorization": f"Bot {created['agent_token']}"},
        )
        assert deleted.status_code == 204
    retry_delete = await client.delete(
        f"{command_url}/{stored_commands[0]['id']}",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert retry_delete.status_code == 404
    assert len(provider_calls) == 1
    link_id = UUID(created["agent_link_id"])
    await _make_discord_projection_due(db_session, link_id=link_id)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 0
    assert len(provider_calls) == 2
    assert provider_calls[1]["body"] == b"[]"
    await _make_discord_retry_due(
        db_session,
        link_id=link_id,
        guild_id=guild_id,
    )

    assert await worker.run_once() == 1
    assert len(provider_calls) == 3
    assert provider_calls[2]["body"] == b"[]"
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    await db_session.refresh(link)
    empty_fingerprint = shared_router.discord_guild_command_fingerprint(
        [],
        application_id=DISCORD_TEST_APPLICATION_ID,
    )
    assert link.config["discord_agent_commands"]["global"] == []
    assert link.config["discord_command_materializations"][guild_id] == empty_fingerprint
    assert guild_id not in link.config["discord_command_retries"]


@pytest.mark.asyncio
async def test_discord_429_retry_after_blocks_poll_until_due(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "rate-limited-command-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-command-rate-limit",
        channel_id="rate-limited-command-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []
    responses = [
        _discord_provider_result(
            429,
            {"retry_after": 17.0},
            headers={"Retry-After": "41"},
        ),
        _discord_provider_result(200, []),
    ]

    async def sequenced_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "request_discord_provider", sequenced_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    rate_limited = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "rate_limited", "description": "Rate limited command"}],
    )

    assert rate_limited.status_code == 429
    assert float(rate_limited.headers["Retry-After"]) == pytest.approx(41.0)
    link_id = UUID(created["agent_link_id"])
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    retry = link.config["discord_command_retries"][guild_id]
    due_at = datetime.fromisoformat(retry["next_retry_at"])
    assert due_at - datetime.now(UTC) > timedelta(seconds=39)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 0
    assert len(provider_calls) == 1
    await _make_discord_retry_due(db_session, link_id=link_id, guild_id=guild_id)
    assert await worker.run_once() == 1
    assert len(provider_calls) == 2

    body_only = _discord_provider_result(429, {"retry_after": 23.5})
    assert shared_router.discord_retry_after_seconds(body_only) == pytest.approx(23.5)


def test_discord_429_without_valid_retry_after_uses_bounded_backoff() -> None:
    before = datetime.now(UTC)
    retry = shared_router._discord_command_retry_state(
        previous=None,
        fingerprint="rate-limit-without-delay",
        status_code=429,
        result=_discord_provider_result(
            429,
            {"retry_after": "invalid"},
            headers={"Retry-After": "invalid"},
        ),
    )
    after = datetime.now(UTC)

    assert retry["blocked"] is False
    assert retry["attempts"] == 1
    due_at = datetime.fromisoformat(retry["next_retry_at"])
    assert before + timedelta(seconds=30) <= due_at <= after + timedelta(seconds=30)


@pytest.mark.asyncio
async def test_discord_403_command_retry_is_blocked_without_tight_poll(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "blocked-command-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-command-blocked",
        channel_id="blocked-command-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []

    async def forbidden_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(403, {"message": "Missing Access"})

    monkeypatch.setattr(shared_router, "request_discord_provider", forbidden_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    rejected = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "blocked", "description": "Blocked command"}],
    )

    assert rejected.status_code == 502
    link_id = UUID(created["agent_link_id"])
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    retry = link.config["discord_command_retries"][guild_id]
    assert retry["status_code"] == 403
    assert retry["blocked"] is True
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 0
    assert await worker.run_once() == 0
    assert len(provider_calls) == 1


@pytest.mark.asyncio
async def test_discord_verified_token_repair_rearms_blocked_command_retry(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "credential-repair-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-credential-repair",
        channel_id="credential-repair-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []
    responses = [
        _discord_provider_result(403, {"message": "Missing Access"}),
        _discord_provider_result(200, []),
    ]

    async def sequenced_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "request_discord_provider", sequenced_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    rejected = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "repairable", "description": "Repairable command"}],
    )
    assert rejected.status_code == 502

    admin_key = f"admin-{uuid4().hex}"
    original_admin_key = settings.admin_api_key
    settings.admin_api_key = admin_key
    try:
        repaired = await client.patch(
            f"/v1/admin/channels/{created['id']}",
            headers={"X-Admin-Key": admin_key},
            json={"provider_token": "replacement-discord-provider-token"},
        )
    finally:
        settings.admin_api_key = original_admin_key
    assert repaired.status_code == 200, repaired.text

    link_id = UUID(created["agent_link_id"])
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    retry = link.config["discord_command_retries"][guild_id]
    assert retry["blocked"] is False
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 1
    assert len(provider_calls) == 2
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    assert guild_id not in link.config["discord_command_retries"]


@pytest.mark.asyncio
async def test_discord_multi_guild_partial_failure_converges_independently(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_a = "multi-command-guild-a"
    guild_b = "multi-command-guild-b"
    created = await _create_paired_discord_channel(
        client,
        name="discord-command-multi-guild",
        channel_id="multi-command-channel-a",
        guild_id=guild_a,
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=account.user_id,
            external_chat_id=guild_b,
            external_chat_type="guild_text",
            external_chat_name=guild_b,
            paired_external_user_id="discord-pair-user",
        )
    )
    await db_session.commit()
    provider_calls: list[dict[str, Any]] = []
    guild_b_attempts = 0

    async def partial_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        nonlocal guild_b_attempts
        provider_calls.append(kwargs)
        path = kwargs["path"]
        if guild_b in path:
            guild_b_attempts += 1
            if guild_b_attempts == 1:
                return _discord_provider_result(502, {"message": "temporary guild failure"})
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", partial_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    partially_failed = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "multi", "description": "Multi guild command"}],
    )

    assert partially_failed.status_code == 502
    link_id = UUID(created["agent_link_id"])
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    assert guild_a in link.config["discord_command_materializations"]
    assert guild_b not in link.config["discord_command_materializations"]
    assert guild_b in link.config["discord_command_retries"]
    await _make_discord_retry_due(db_session, link_id=link_id, guild_id=guild_b)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 1
    assert [guild_a in call["path"] for call in provider_calls].count(True) == 1
    assert [guild_b in call["path"] for call in provider_calls].count(True) == 2
    assert await worker.run_once() == 0
    assert len(provider_calls) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
async def test_discord_dm_only_command_mutations_leave_shadow_unchanged(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    method: str,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-dm-command-boundary-{method.lower()}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": f"dm-command-boundary-pair-{method}",
            "token": f"dm-command-boundary-token-{method}",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": f"dm-command-boundary-{method.lower()}",
            "context": 1,
            "authorizing_integration_owners": {"1": "dm-command-owner"},
            "user": {"id": "dm-command-owner"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.json()["data"]["content"].startswith("Direct message paired.")
    link_id = UUID(created["agent_link_id"])
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    before = json.loads(json.dumps(link.config)) if isinstance(link.config, dict) else None
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    request_url = f"{command_url}/missing" if method == "PATCH" else command_url
    response = await client.request(
        method,
        request_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json={"name": "dm_only", "description": "Must not be stored"},
    )

    assert response.status_code == 409
    await db_session.refresh(link)
    assert link.config == before


@pytest.mark.asyncio
async def test_discord_reserved_command_429_preserves_retry_after_and_limiter(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-reserved-command-rate-limit",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()

    class ReservedRateLimitClient(_FakeProviderClient):
        async def request(self, method, url, **kwargs):
            self.calls.append({"method": method, "url": url, **kwargs})
            return _FakeProviderResponse(
                {"retry_after": 29.0},
                status_code=429,
                headers={},
            )

    ReservedRateLimitClient.calls = []
    monkeypatch.setattr(channel_service, "discord_rate_limiter", DiscordRateLimiter())
    monkeypatch.setattr(channel_service.httpx, "AsyncClient", ReservedRateLimitClient)

    first = await client.post(f"/v1/channels/{created['id']}/commands/sync", json={})
    second = await client.post(f"/v1/channels/{created['id']}/commands/sync", json={})

    assert first.status_code == 429
    assert first.headers["Retry-After"] == "29.0"
    assert second.status_code == 429
    assert float(second.headers["Retry-After"]) > 28
    assert len(ReservedRateLimitClient.calls) == 1


@pytest.mark.asyncio
async def test_discord_projection_lock_prevents_stale_put_after_new_desired_state(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "projection-lock-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-projection-lock",
        channel_id="projection-lock-channel",
        guild_id=guild_id,
    )
    link_id = UUID(created["agent_link_id"])
    account_id = UUID(created["id"])
    v1 = [{"name": "version_one", "description": "Version one"}]
    v2 = [{"name": "version_two", "description": "Version two"}]
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    link.config = {"discord_agent_commands": {"global": v1}}
    await db_session.commit()
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    provider_versions: list[str] = []

    async def blocked_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        commands = json.loads(kwargs["body"])
        provider_versions.append(commands[0]["name"])
        if commands[0]["name"] == "version_one":
            first_started.set()
            await release_first.wait()
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", blocked_provider)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def materialize_current() -> int:
        async with sessionmaker() as session:
            account = await session.get(ChannelAccount, account_id)
            assert account is not None
            return await shared_router.fan_out_discord_global_commands(
                session,
                account=account,
                bot_agent_link_id=link_id,
                application_id=DISCORD_TEST_APPLICATION_ID,
                force=True,
            )

    writer_backend_pid: asyncio.Future[int] = asyncio.get_running_loop().create_future()

    async def store_v2_and_materialize() -> int:
        async with sessionmaker() as session:
            backend_pid = await session.scalar(text("SELECT pg_backend_pid()"))
            assert isinstance(backend_pid, int)
            writer_backend_pid.set_result(backend_pid)
            current_link = await session.get(ChannelBotAgentLink, link_id)
            assert current_link is not None
            await session.refresh(current_link, with_for_update=True)
            config = dict(current_link.config) if isinstance(current_link.config, dict) else {}
            config["discord_agent_commands"] = {"global": v2}
            current_link.config = config
            await session.commit()
        return await materialize_current()

    first_task = asyncio.create_task(materialize_current())
    await asyncio.wait_for(first_started.wait(), timeout=2)
    second_task = asyncio.create_task(store_v2_and_materialize())
    try:
        await wait_for_lock_wait(sessionmaker, await asyncio.wait_for(writer_backend_pid, 2))
        assert provider_versions == ["version_one"]
    finally:
        release_first.set()
        await asyncio.gather(first_task, second_task, return_exceptions=True)

    assert await first_task == 1
    assert await second_task == 1
    assert provider_versions == ["version_one", "version_two"]
    await db_session.rollback()
    final_link = await db_session.get(ChannelBotAgentLink, link_id)
    assert final_link is not None
    await db_session.refresh(final_link)
    desired = final_link.config["discord_agent_commands"]["global"]
    assert desired == v2
    assert final_link.config["discord_command_materializations"][guild_id] == (
        shared_router.discord_guild_command_fingerprint(
            v2,
            application_id=DISCORD_TEST_APPLICATION_ID,
        )
    )


@pytest.mark.asyncio
async def test_discord_admin_rejects_application_identity_change(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    replacement_application_id = "223456789012345678"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-application-change",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    original_config = dict(account.config) if isinstance(account.config, dict) else None

    admin_key = f"admin-{uuid4().hex}"
    original_admin_key = settings.admin_api_key
    settings.admin_api_key = admin_key
    try:
        replaced = await client.patch(
            f"/v1/admin/channels/{account_id}",
            headers={"X-Admin-Key": admin_key},
            json={"config": _discord_ready_config(replacement_application_id)},
        )
    finally:
        settings.admin_api_key = original_admin_key

    assert replaced.status_code == 409
    assert replaced.json()["detail"] == (
        "Discord application identity cannot be changed in place; recreate the channel instead."
    )
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    assert account.config == original_config


@pytest.mark.asyncio
async def test_discord_admin_rejects_token_for_different_application(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-token-identity-change",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    original_ciphertext = account.encrypted_provider_token
    original_nonce = account.provider_token_nonce

    async def reject_replacement_token(**_kwargs: Any) -> dict[str, Any]:
        raise HTTPException(
            status_code=409,
            detail="Discord bot token belongs to a different application.",
        )

    monkeypatch.setattr(
        admin_router,
        "verify_discord_application_token_identity",
        reject_replacement_token,
    )
    admin_key = f"admin-{uuid4().hex}"
    original_admin_key = settings.admin_api_key
    settings.admin_api_key = admin_key
    try:
        replaced = await client.patch(
            f"/v1/admin/channels/{account_id}",
            headers={"X-Admin-Key": admin_key},
            json={"provider_token": "different-application-token"},
        )
    finally:
        settings.admin_api_key = original_admin_key

    assert replaced.status_code == 409
    await db_session.rollback()
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    assert account.encrypted_provider_token == original_ciphertext
    assert account.provider_token_nonce == original_nonce


def test_discord_materialization_fingerprint_is_application_bound() -> None:
    commands = [{"name": "application_bound", "description": "Application-bound command"}]

    first = shared_router.discord_guild_command_fingerprint(
        commands,
        application_id=DISCORD_TEST_APPLICATION_ID,
    )
    second = shared_router.discord_guild_command_fingerprint(
        commands,
        application_id="223456789012345678",
    )

    assert first != second


@pytest.mark.asyncio
async def test_discord_archived_binding_cleanup_is_recovered_by_worker(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "archived-cleanup-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-archived-cleanup",
        channel_id="archived-cleanup-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []
    responses = [
        _discord_provider_result(200, []),
        _discord_provider_result(502, {"message": "temporary cleanup failure"}),
        _discord_provider_result(200, []),
    ]

    async def sequenced_provider(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "request_discord_provider", sequenced_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    stored = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "cleanup_me", "description": "Cleanup command"}],
    )
    assert stored.status_code == 200

    unpaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "archived-cleanup-unpair",
            "token": "archived-cleanup-unpair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": "archived-cleanup-channel",
            "guild_id": guild_id,
            "context": 0,
            "authorizing_integration_owners": {"0": guild_id},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-pair-user"},
            },
            "data": {"name": "clawdi_unpair"},
        },
    )

    assert unpaired.json()["data"]["content"].startswith("Server unpaired.")
    assert len(provider_calls) == 2
    link_id = UUID(created["agent_link_id"])
    await _make_discord_retry_due(db_session, link_id=link_id, guild_id=guild_id)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)
    assert await worker.run_once() == 0
    assert len(provider_calls) == 3
    assert provider_calls[-1]["body"] == b"[]"
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    assert link.config["discord_command_materializations"][guild_id] == (
        shared_router.discord_guild_command_fingerprint(
            [],
            application_id=DISCORD_TEST_APPLICATION_ID,
        )
    )
    assert guild_id not in link.config["discord_command_retries"]


@pytest.mark.asyncio
async def test_discord_worker_recovers_cleanup_when_crash_left_no_link_state(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "cleanup-without-link-state-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-cleanup-without-link-state",
        channel_id="cleanup-without-link-state-channel",
        guild_id=guild_id,
    )
    link_id = UUID(created["agent_link_id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.bot_agent_link_id == link_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
    ).scalar_one()
    binding.status = BINDING_STATUS_ARCHIVED
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    link.config = None
    await db_session.commit()
    provider_calls: list[dict[str, Any]] = []

    async def provider_success(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", provider_success)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 0
    assert len(provider_calls) == 1
    assert provider_calls[0]["body"] == b"[]"
    assert await worker.run_once() == 0
    assert len(provider_calls) == 1


@pytest.mark.asyncio
async def test_discord_offline_interactions_reply_ephemerally_without_dedup(
    client,
    db_session,
    channel_agent,
    channel_runtime_head,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-offline-interactions",
        agent_id=channel_agent.id,
    )
    now = datetime.now(UTC)
    await channel_runtime_head(
        channel_agent,
        received_at=now - timedelta(hours=1),
        freshness_deadline=now - timedelta(minutes=11),
    )
    _clear_fake_provider_calls()
    for interaction_id in ("offline-interaction-1", "offline-interaction-2"):
        response = await _record_discord_interaction(
            client,
            created=created,
            interaction_id=interaction_id,
            token=f"{interaction_id}-token",
            application_id=DISCORD_TEST_APPLICATION_ID,
        )
        assert response.status_code == 200
        assert response.json() == {
            "type": 4,
            "data": {"content": channel_service.AGENT_OFFLINE_REPLY, "flags": 64},
        }
    assert _FakeProviderClient.calls == []
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_message_id.in_(
                        ["offline-interaction-1", "offline-interaction-2"]
                    ),
                )
            )
        ).scalars()
    )
    assert len(messages) == 2
    assert all(message.delivered_at is not None for message in messages)
