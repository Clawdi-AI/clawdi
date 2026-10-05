from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_STATUS_DISABLED,
    CHANNEL_VISIBILITY_PUBLIC,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    DELIVERY_STATUS_SUCCEEDED,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    PAIR_CODE_STATUS_CLAIMED,
    PAIR_CODE_STATUS_PENDING,
    PAIR_CODE_STATUS_REVOKED,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
    ChannelWhatsAppAuthCert,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import V2RuntimeEnvironmentFence
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import public as public_router
from app.routes.channel_routers import telegram as telegram_router
from app.schemas.channel import ChannelAccountCreate, ChannelAgentLinkCreate
from app.services import channels as channel_service
from app.services import whatsapp_provider_bridge as whatsapp_provider_bridge_service
from app.services.channel_debug_events import record_channel_debug_event
from app.services.channels import (
    decrypt_agent_link_token,
    discord_control_reply_for_command,
    encrypt_optional_token,
    generate_agent_token,
    generate_pair_code,
    hash_token,
    parse_channel_control_command,
    send_provider_outbound_payload,
)
from app.services.runtime_observation import retire_runtime_environment
from app.services.runtime_state_cleanup import cleanup_retired_runtime_state
from app.services.url_security import UnsafeOutboundUrlError
from app.services.whatsapp_baileys import (
    load_or_create_whatsapp_auth_cert,
    mint_whatsapp_agent_credential,
    whatsapp_text_message_proto,
)
from app.services.whatsapp_native_transport import (
    WhatsAppProviderMessageEvent,
    WhatsAppSidecarHealth,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_provider_bridge import (
    persist_whatsapp_provider_event,
    register_whatsapp_provider_transport,
    unregister_whatsapp_provider_transport,
)
from tests.channel_helpers import (
    DISCORD_TEST_APPLICATION_ID,
    TELEGRAM_AGENT_TOKEN_RE,
    _clear_fake_provider_calls,
    _client_for_api_key,
    _client_for_user,
    _converge_hosted_runtime,
    _create_admin_channel,
    _create_paired_telegram_channel,
    _create_public_channel_with_links,
    _create_public_telegram_account_for_user,
    _create_user_with_channel_agent,
    _create_whatsapp_pair_target,
    _discord_ready_config,
    _FakeProviderClient,
    _paired_telegram_shared_chat,
    _reset_fake_provider_client,
    _seed_created_channel_link,
    _seed_existing_channel_link,
    _seed_historical_platform_whatsapp_account,
    _telegram_agent_headers,
    _telegram_bot_path,
    _WhatsAppPairLinkRegistry,
    _WhatsAppPairLinkSidecar,
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
async def test_create_channel_masks_provider_token(client: httpx.AsyncClient):
    response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": "ops-phone",
            "provider_token": "123456:telegram-secret",
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["provider"] == "telegram"
    assert created["name"] == "ops-phone"
    assert created["has_provider_token"] is True
    assert TELEGRAM_AGENT_TOKEN_RE.fullmatch(created["agent_token"])
    assert created["webhook_secret"]
    assert "telegram-secret" not in response.text


def test_provider_link_replace_opt_in_is_non_nullable_and_defaults_false():
    account = ChannelAccountCreate(provider=CHANNEL_PROVIDER_TELEGRAM, name="Schema test")
    link = ChannelAgentLinkCreate()

    assert account.replace_existing_provider_link is False
    assert link.replace_existing_provider_link is False

    with pytest.raises(ValidationError):
        ChannelAccountCreate.model_validate(
            {
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": "Schema test",
                "replace_existing_provider_link": None,
            }
        )
    with pytest.raises(ValidationError):
        ChannelAgentLinkCreate.model_validate({"replace_existing_provider_link": None})
    with pytest.raises(ValidationError, match="agent_id is required"):
        ChannelAgentLinkCreate(replace_existing_provider_link=True)


@pytest.mark.asyncio
async def test_list_channels_supports_content_etag(client: httpx.AsyncClient):
    first = await client.get("/v1/channels")
    assert first.status_code == 200
    etag = first.headers.get("etag")
    assert etag is not None
    assert first.headers["cache-control"] == "no-store"

    not_modified = await client.get("/v1/channels", headers={"If-None-Match": etag})
    assert not_modified.status_code == 304
    assert not_modified.headers["etag"] == etag
    assert not_modified.headers["cache-control"] == "no-store"

    created = await client.post(
        "/v1/channels",
        json={"provider": "telegram", "name": f"etag-channel-{uuid4().hex}"},
    )
    assert created.status_code == 201

    changed = await client.get("/v1/channels", headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag
    assert any(item["id"] == created.json()["id"] for item in changed.json())


@pytest.mark.asyncio
async def test_rotate_channel_agent_link_token_replaces_one_time_token(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"rotate-token-{uuid4().hex}",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    old_token = created["agent_token"]

    rotated = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )

    assert rotated.status_code == 200, rotated.text
    body = rotated.json()
    assert body["id"] == created["agent_link_id"]
    assert TELEGRAM_AGENT_TOKEN_RE.fullmatch(body["agent_token"])
    assert body["agent_token"] != old_token
    link = (
        await db_session.execute(
            select(ChannelBotAgentLink).where(
                ChannelBotAgentLink.id == UUID(created["agent_link_id"])
            )
        )
    ).scalar_one()
    assert link.agent_token_hash == hash_token(body["agent_token"])
    assert link.agent_token_hash != hash_token(old_token)
    assert decrypt_agent_link_token(link) == body["agent_token"]


@pytest.mark.asyncio
async def test_channel_control_plane_actions_write_redacted_audit_events(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    provider_token = "123456:telegram-secret"
    extra_secret = "channel-extra-secret"
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"audit-channel-{uuid4().hex}",
            "provider_token": provider_token,
            "secrets": {"bot_token": extra_secret},
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    initial_agent_token = created["agent_token"]

    rotated_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )
    assert rotated_response.status_code == 200, rotated_response.text
    rotated_agent_token = rotated_response.json()["agent_token"]

    _reset_fake_provider_client({"ok": True, "result": True})
    with monkeypatch.context() as provider_mock:
        provider_mock.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
        pair_response = await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    assert pair_response.status_code == 201, pair_response.text
    pair_code = pair_response.json()["code"]

    audit_response = await client.get(
        "/v1/audit/events",
        params={"channel_account_id": created["id"], "limit": 20},
    )
    assert audit_response.status_code == 200, audit_response.text
    payload = audit_response.json()
    actions = {event["action"] for event in payload["items"]}
    assert {
        "channel.account.create",
        "channel.agent_link.credential_rotate",
        "channel.pair_code.create",
    }.issubset(actions)

    create_event = next(
        event for event in payload["items"] if event["action"] == "channel.account.create"
    )
    assert create_event["target_user_id"] == str(seed_user.id)
    assert create_event["channel_account_id"] == created["id"]
    assert create_event["details"]["provider"] == "telegram"
    assert create_event["details"]["has_provider_credential"] is True

    audit_text = json.dumps(payload)
    assert provider_token not in audit_text
    assert extra_secret not in audit_text
    assert created["webhook_secret"] not in audit_text
    assert initial_agent_token not in audit_text
    assert rotated_agent_token not in audit_text
    assert pair_code not in audit_text

    other_user, _other_agent = await _create_user_with_channel_agent(
        db_session,
        label="audit-other",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        other_response = await other_client.get(
            "/v1/audit/events",
            params={"channel_account_id": created["id"], "limit": 20},
        )

    assert other_response.status_code == 200, other_response.text
    assert other_response.json()["items"] == []


@pytest.mark.asyncio
async def test_channel_activity_lists_messages_deliveries_and_debug_events_safely(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    provider_token = "123456:activity-provider-token"
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"activity-channel-{uuid4().hex}",
            "provider_token": provider_token,
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()

    outbound_response = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "activity-chat", "text": "activity outbound"},
    )
    assert outbound_response.status_code == 201, outbound_response.text
    outbound = outbound_response.json()
    delivery = await db_session.get(ChannelDelivery, UUID(outbound["delivery_id"]))
    assert delivery is not None
    delivery.status = DELIVERY_STATUS_FAILED
    delivery.attempts = 2
    delivery.last_error = "provider timed out"

    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=seed_user.id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id="activity-chat",
            provider_message_id="provider-message-1",
            text="activity inbound",
            payload={"providerToken": provider_token},
        )
    )
    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="telegram",
        direction="outbound",
        stage="delivery",
        outcome="failure",
        external_chat_id="activity-chat",
        status_code=503,
        error="provider failed",
        details={
            "providerToken": provider_token,
            "nested": {"authorization": f"Bearer {provider_token}"},
        },
    )
    await db_session.commit()

    response = await client.get(
        f"/v1/channels/{created['id']}/activity",
        params={"external_chat_id": "activity-chat", "limit": 20},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    items = payload["items"]
    assert {item["kind"] for item in items} == {"message", "debug_event"}
    outbound_item = next(item for item in items if item["text"] == "activity outbound")
    assert outbound_item["delivery_id"] == outbound["delivery_id"]
    assert outbound_item["delivery_status"] == DELIVERY_STATUS_FAILED
    assert outbound_item["delivery_attempts"] == 2
    assert outbound_item["delivery_last_error"] == "channel_delivery_failed"
    inbound_item = next(item for item in items if item["text"] == "activity inbound")
    assert inbound_item["direction"] == MESSAGE_DIRECTION_INBOUND
    assert inbound_item["provider_message_id"] == "provider-message-1"
    debug_item = next(item for item in items if item["kind"] == "debug_event")
    assert debug_item["stage"] == "delivery"
    assert debug_item["outcome"] == "failure"
    assert debug_item["status_code"] == 503
    assert debug_item["error"] == "channel_operation_failed"
    assert debug_item["details"]["providerToken"] == "[redacted]"
    assert debug_item["details"]["nested"]["authorization"] == "[redacted]"
    assert provider_token not in response.text
    assert "webhook_secret" not in response.text
    assert "agent_token" not in response.text
    assert "providerPayload" not in response.text


@pytest.mark.asyncio
async def test_public_channel_activity_is_scoped_to_event_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"public-activity-{uuid4().hex}",
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    tenant_user_id = account.user_id
    assert tenant_user_id is not None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    account.user_id = None
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=tenant_user_id,
            direction=MESSAGE_DIRECTION_OUTBOUND,
            external_chat_id="owner-chat",
            provider_message_id=None,
            text="owner-only activity",
            payload={"delivery": "pending"},
        )
    )
    await db_session.commit()

    other_user, _other_agent = await _create_user_with_channel_agent(
        db_session,
        label="activity-other",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        other_response = await other_client.get(f"/v1/channels/{created['id']}/activity")

    assert other_response.status_code == 200, other_response.text
    assert other_response.json()["items"] == []


@pytest.mark.asyncio
async def test_channel_health_summarizes_delivery_and_debug_state(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created_response = await client.post(
        "/v1/channels",
        json={"provider": "telegram", "name": f"health-channel-{uuid4().hex}"},
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="health-chat",
        external_chat_type="private",
        external_chat_name="Health Chat",
    )
    archived_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="historical-health-chat",
        external_chat_type="private",
        external_chat_name="Historical Health Chat",
        status=BINDING_STATUS_ARCHIVED,
    )
    db_session.add_all([binding, archived_binding])
    await db_session.flush()
    db_session.add_all(
        [
            ChannelMessage(
                account_id=account.id,
                bot_agent_link_id=UUID(created["agent_link_id"]),
                binding_id=binding.id,
                user_id=seed_user.id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=binding.external_chat_id,
                provider_message_id="health-inbound-1",
                text="needs delivery",
                payload={},
            ),
            ChannelMessage(
                account_id=account.id,
                bot_agent_link_id=UUID(created["agent_link_id"]),
                binding_id=archived_binding.id,
                user_id=seed_user.id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=archived_binding.external_chat_id,
                provider_message_id="historical-health-inbound",
                text="must not affect health",
                payload={},
            ),
        ]
    )
    await db_session.commit()

    failed_response = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "failed-chat", "text": "failed outbound"},
    )
    assert failed_response.status_code == 201, failed_response.text
    failed_delivery = await db_session.get(
        ChannelDelivery,
        UUID(failed_response.json()["delivery_id"]),
    )
    assert failed_delivery is not None
    failed_delivery.status = DELIVERY_STATUS_FAILED
    failed_delivery.attempts = 3
    failed_delivery.last_error = "provider rejected request"

    pending_response = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "pending-chat", "text": "pending outbound"},
    )
    assert pending_response.status_code == 201, pending_response.text

    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="telegram",
        direction="outbound",
        stage="delivery",
        outcome="failure",
        error="rate limited",
    )
    await db_session.commit()

    response = await client.get("/v1/channels/health")

    assert response.status_code == 200, response.text
    health = next(item for item in response.json()["items"] if item["account_id"] == created["id"])
    assert health["provider"] == "telegram"
    assert health["health_status"] == "error"
    assert "failed_deliveries" in health["reasons"]
    assert "pending_deliveries" in health["reasons"]
    assert "pending_inbox" in health["reasons"]
    assert "recent_error" in health["reasons"]
    assert health["pending_inbox"] == 1
    assert health["oldest_pending_inbox_at"] is not None
    assert health["pending_deliveries"] == 1
    assert health["failed_deliveries"] == 1
    assert health["last_error"] in {
        "channel_operation_failed",
        "channel_delivery_failed",
    }
    assert health["last_error_stage"] in {"delivery", None}
    assert health["last_message_at"] is not None
    assert health["last_event_at"] is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure_age", "expected_status", "expected_reasons", "expected_failed_deliveries"),
    [
        pytest.param(timedelta(days=10), "ok", [], 0, id="historical-failure"),
        pytest.param(
            timedelta(minutes=1),
            "error",
            ["failed_deliveries", "recent_error"],
            1,
            id="current-failure",
        ),
    ],
)
async def test_whatsapp_channel_health_only_surfaces_current_delivery_failures(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    failure_age: timedelta,
    expected_status: str,
    expected_reasons: list[str],
    expected_failed_deliveries: int,
):
    class ConnectedWhatsAppTransport:
        connected = True

        async def relay_outbound_message(self, message):
            return None

        async def relay_raw_node(self, node):
            return None

        async def query_iq(self, node, timeout_ms):
            return None

    created_response = await client.post(
        "/v1/channels",
        json={"provider": "whatsapp", "name": f"health-whatsapp-{uuid4().hex}"},
    )
    assert created_response.status_code == 201, created_response.text
    account_id = UUID(created_response.json()["id"])
    failure_at = datetime.now(UTC) - failure_age
    message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=None,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id="15551234567@s.whatsapp.net",
        provider_message_id=None,
        text="failed outbound",
        payload={"delivery": DELIVERY_STATUS_FAILED},
        created_at=failure_at,
        updated_at=failure_at,
    )
    db_session.add(message)
    await db_session.flush()
    db_session.add(
        ChannelDelivery(
            account_id=account_id,
            bot_agent_link_id=None,
            message_id=message.id,
            user_id=seed_user.id,
            status=DELIVERY_STATUS_FAILED,
            attempts=5,
            max_attempts=5,
            next_attempt_at=failure_at,
            last_error="provider rejected request",
            created_at=failure_at,
            updated_at=failure_at,
        )
    )
    await db_session.commit()

    register_whatsapp_provider_transport(account_id, ConnectedWhatsAppTransport())
    try:
        response = await client.get("/v1/channels/health")
    finally:
        unregister_whatsapp_provider_transport(account_id)

    assert response.status_code == 200, response.text
    health = next(
        item for item in response.json()["items"] if item["account_id"] == str(account_id)
    )
    assert health["health_status"] == expected_status
    assert health["reasons"] == expected_reasons
    assert health["pending_deliveries"] == 0
    assert health["in_progress_deliveries"] == 0
    assert health["failed_deliveries"] == expected_failed_deliveries
    assert health["last_error"] == "channel_delivery_failed"
    assert health["native_transport"]["available"] is True


@pytest.mark.asyncio
async def test_whatsapp_channel_health_graces_transport_reconnection_after_restart(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    class ConnectedWhatsAppTransport:
        connected = True

        async def relay_outbound_message(self, message):
            return None

        async def relay_raw_node(self, node):
            return None

        async def query_iq(self, node, timeout_ms):
            return None

    clock = [1_000.0]
    monkeypatch.setattr(
        whatsapp_provider_bridge_service,
        "_PROVIDER_TRANSPORTS_STARTED_AT",
        clock[0],
    )
    monkeypatch.setattr(
        whatsapp_provider_bridge_service,
        "_PROVIDER_TRANSPORT_UNAVAILABLE_SINCE",
        {},
    )
    monkeypatch.setattr(
        whatsapp_provider_bridge_service,
        "_transport_clock",
        lambda: clock[0],
    )
    created_response = await client.post(
        "/v1/channels",
        json={"provider": "whatsapp", "name": f"health-reconnect-{uuid4().hex}"},
    )
    assert created_response.status_code == 201, created_response.text
    account_id = UUID(created_response.json()["id"])

    try:
        reconnecting_response = await client.get("/v1/channels/health")
        reconnecting = next(
            item
            for item in reconnecting_response.json()["items"]
            if item["account_id"] == str(account_id)
        )
        assert reconnecting["health_status"] == "warning"
        assert reconnecting["reasons"] == ["native_transport_reconnecting"]
        assert reconnecting["native_transport"]["reconnecting"] is True

        clock[0] += 301
        unavailable_response = await client.get("/v1/channels/health")
        unavailable = next(
            item
            for item in unavailable_response.json()["items"]
            if item["account_id"] == str(account_id)
        )
        assert unavailable["health_status"] == "error"
        assert unavailable["reasons"] == ["native_transport_unavailable"]
        assert unavailable["native_transport"]["reconnecting"] is False

        register_whatsapp_provider_transport(account_id, ConnectedWhatsAppTransport())
        connected_response = await client.get("/v1/channels/health")
        connected = next(
            item
            for item in connected_response.json()["items"]
            if item["account_id"] == str(account_id)
        )
        assert connected["health_status"] == "ok"
        assert connected["reasons"] == []
        assert connected["native_transport"]["available"] is True
    finally:
        unregister_whatsapp_provider_transport(account_id)


@pytest.mark.asyncio
async def test_non_whatsapp_channel_health_expires_failures_and_clears_them_after_success(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"health-window-{uuid4().hex}",
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    account_id = UUID(created["id"])
    link_id = UUID(created["agent_link_id"])
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    now = datetime.now(UTC)

    historical_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link_id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id="historical-failure",
        text="historical failure",
        payload={},
        created_at=now - timedelta(days=10),
        updated_at=now - timedelta(days=10),
    )
    recent_failed_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link_id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id="recent-failure",
        text="recent failure",
        payload={},
        created_at=now - timedelta(minutes=2),
        updated_at=now - timedelta(minutes=2),
    )
    successful_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link_id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id="successful-delivery",
        text="success",
        payload={},
        created_at=now - timedelta(minutes=1),
        updated_at=now - timedelta(minutes=1),
    )
    db_session.add_all([historical_message, recent_failed_message, successful_message])
    await db_session.flush()
    db_session.add_all(
        [
            ChannelDelivery(
                account_id=account_id,
                bot_agent_link_id=link_id,
                message_id=historical_message.id,
                user_id=seed_user.id,
                status=DELIVERY_STATUS_FAILED,
                attempts=5,
                max_attempts=5,
                next_attempt_at=now - timedelta(days=10),
                last_error="historical provider failure",
                created_at=now - timedelta(days=10),
                updated_at=now - timedelta(days=10),
            ),
            ChannelDelivery(
                account_id=account_id,
                bot_agent_link_id=link_id,
                message_id=recent_failed_message.id,
                user_id=seed_user.id,
                status=DELIVERY_STATUS_FAILED,
                attempts=5,
                max_attempts=5,
                next_attempt_at=now - timedelta(minutes=2),
                last_error="recent provider failure",
                created_at=now - timedelta(minutes=2),
                updated_at=now - timedelta(minutes=2),
            ),
            ChannelDelivery(
                account_id=account_id,
                bot_agent_link_id=link_id,
                message_id=successful_message.id,
                user_id=seed_user.id,
                status=DELIVERY_STATUS_SUCCEEDED,
                attempts=1,
                max_attempts=5,
                next_attempt_at=now - timedelta(minutes=1),
                created_at=now - timedelta(minutes=1),
                updated_at=now - timedelta(minutes=1),
            ),
        ]
    )
    await db_session.commit()

    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="telegram",
        direction="outbound",
        stage="delivery",
        outcome="failure",
        error="provider rejected request",
    )
    await db_session.commit()
    failed_response = await client.get("/v1/channels/health")
    assert failed_response.status_code == 200, failed_response.text
    failed_health = next(
        item for item in failed_response.json()["items"] if item["account_id"] == created["id"]
    )
    assert "recent_error" in failed_health["reasons"]

    await record_channel_debug_event(
        db_session,
        account=account,
        user_id=seed_user.id,
        provider="telegram",
        direction="outbound",
        stage="delivery",
        outcome="success",
    )
    await db_session.commit()
    response = await client.get("/v1/channels/health")

    assert response.status_code == 200, response.text
    health = next(item for item in response.json()["items"] if item["account_id"] == created["id"])
    assert health["failed_deliveries"] == 0
    assert "failed_deliveries" not in health["reasons"]
    assert "recent_error" not in health["reasons"]
    assert health["last_error"] is None


@pytest.mark.asyncio
async def test_channel_health_requires_fresh_converged_runtime_evidence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"health-runtime-{uuid4().hex}",
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()

    observation = await _converge_hosted_runtime(
        db_session,
        user=seed_user,
        agent_id=channel_agent.id,
    )
    assert observation.observed_at is not None
    observed_at = observation.observed_at

    fresh_response = await client.get("/v1/channels/health")
    fresh = next(
        item for item in fresh_response.json()["items"] if item["account_id"] == created["id"]
    )
    assert fresh["health_status"] == "ok"
    assert fresh["reasons"] == []

    observation.observed_at = observed_at - timedelta(
        seconds=settings.runtime_observation_freshness_seconds + 1
    )
    await db_session.commit()
    stale_response = await client.get("/v1/channels/health")
    stale = next(
        item for item in stale_response.json()["items"] if item["account_id"] == created["id"]
    )
    assert stale["health_status"] == "warning"
    assert "runtime_observation_stale" in stale["reasons"]


@pytest.mark.asyncio
async def test_channel_health_reports_an_unlinked_channel_without_implying_runtime_wait(
    client: httpx.AsyncClient,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"health-unlinked-{uuid4().hex}",
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()

    unlinked_response = await client.delete(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}"
    )
    assert unlinked_response.status_code == 204, unlinked_response.text

    response = await client.get("/v1/channels/health")
    assert response.status_code == 200, response.text
    health = next(item for item in response.json()["items"] if item["account_id"] == created["id"])
    assert health["health_status"] == "warning"
    assert health["reasons"] == ["agent_not_linked"]


@pytest.mark.asyncio
async def test_channel_health_select_count_is_constant_across_accounts(
    client: httpx.AsyncClient,
    engine,
):
    async def create_account(index: int) -> None:
        response = await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"health-query-count-{index}-{uuid4().hex}",
            },
        )
        assert response.status_code == 201, response.text

    async def health_select_count() -> int:
        select_count = 0

        def count_selects(_conn, _cursor, statement, _parameters, _context, _executemany):
            nonlocal select_count
            if statement.lstrip().upper().startswith("SELECT"):
                select_count += 1

        sqlalchemy_event.listen(engine.sync_engine, "before_cursor_execute", count_selects)
        try:
            response = await client.get("/v1/channels/health")
        finally:
            sqlalchemy_event.remove(engine.sync_engine, "before_cursor_execute", count_selects)
        assert response.status_code == 200, response.text
        return select_count

    await create_account(0)
    one_account_count = await health_select_count()
    for index in range(1, 5):
        await create_account(index)
    five_account_count = await health_select_count()

    assert one_account_count == 10
    assert five_account_count == one_account_count


@pytest.mark.asyncio
async def test_channel_health_includes_public_bound_channels_without_cross_user_counts(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"shared-health-{uuid4().hex}"},
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.user_id = None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    owner_message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id="owner-health-chat",
        provider_message_id=None,
        text="owner failed",
        payload={"delivery": DELIVERY_STATUS_PENDING},
    )
    db_session.add(owner_message)
    await db_session.flush()
    db_session.add(
        ChannelDelivery(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            message_id=owner_message.id,
            user_id=seed_user.id,
            status=DELIVERY_STATUS_FAILED,
            next_attempt_at=datetime.now(UTC),
            last_error="owner-only failure",
        )
    )
    other_user, other_agent = await _create_user_with_channel_agent(
        db_session,
        label="health-other",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        other_link_response = await other_client.post(
            f"/v1/channels/{account.id}/agent-links",
            json={"agent_id": str(other_agent.id)},
        )
    assert other_link_response.status_code == 201, other_link_response.text
    other_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(other_link_response.json()["id"]),
        user_id=other_user.id,
        external_chat_id="other-health-chat",
        external_chat_type="private",
        external_chat_name="Other Health Chat",
    )
    db_session.add(other_binding)
    await db_session.flush()
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(other_link_response.json()["id"]),
            binding_id=other_binding.id,
            user_id=other_user.id,
            direction=MESSAGE_DIRECTION_INBOUND,
            external_chat_id=other_binding.external_chat_id,
            provider_message_id="other-inbound-1",
            text="other pending inbox",
            payload={},
        )
    )
    await db_session.commit()

    async with _client_for_user(db_session, other_user) as other_client:
        response = await other_client.get("/v1/channels/health")

    assert response.status_code == 200, response.text
    health = next(item for item in response.json()["items"] if item["account_id"] == created["id"])
    assert health["health_status"] == "warning"
    assert health["pending_inbox"] == 1
    assert health["failed_deliveries"] == 0
    assert health["last_error"] is None
    assert "owner-only failure" not in response.text


@pytest.mark.asyncio
async def test_environment_bound_key_cannot_list_control_plane_channels(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    channel_name = f"unbound-only-{uuid4().hex}"
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": channel_name,
            "provider_token": "123456:telegram-secret",
        },
    )
    assert created_response.status_code == 201, created_response.text

    api_key = ApiKey(user_id=seed_user.id, environment_id=channel_agent.id, label="hosted")
    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        listed = await runtime_client.get("/v1/channels")

    assert listed.status_code == 403, listed.text
    assert channel_name not in listed.text
    assert "telegram-secret" not in listed.text


@pytest.mark.asyncio
async def test_user_created_channel_is_private_to_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"private-{uuid4().hex}"},
        )
    ).json()
    assert created["visibility"] == "private"

    other_user, other_agent = await _create_user_with_channel_agent(
        db_session,
        label="private-other",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        listed = await other_client.get("/v1/channels")
        assert listed.status_code == 200
        assert all(item["id"] != created["id"] for item in listed.json())

        fetched = await other_client.get(f"/v1/channels/{created['id']}")
        linked = await other_client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(other_agent.id)},
        )
        paired = await other_client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_id": str(other_agent.id), "ttl_seconds": 900},
        )

    assert fetched.status_code == 404
    assert linked.status_code == 404
    assert paired.status_code == 404


@pytest.mark.asyncio
async def test_channel_bot_pool_lists_public_bots_and_owned_private_bots(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    private = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"pool-private-{uuid4().hex}"},
        )
    ).json()
    public = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"pool-public-{uuid4().hex}",
    )
    assert public.status_code == 201, public.text
    public_body = public.json()
    disabled_private = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"pool-disabled-{uuid4().hex}"},
        )
    ).json()
    disabled_account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(disabled_private["id"]))
        )
    ).scalar_one()
    disabled_account.status = CHANNEL_STATUS_DISABLED
    await db_session.flush()
    disabled_whatsapp = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": f"pool-disabled-wa-{uuid4().hex}"},
        )
    ).json()
    disabled_whatsapp_account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(disabled_whatsapp["id"]))
        )
    ).scalar_one()
    disabled_whatsapp_account.status = CHANNEL_STATUS_DISABLED

    private_account = await db_session.get(ChannelAccount, UUID(private["id"]))
    public_account = await db_session.get(ChannelAccount, UUID(public_body["id"]))
    assert private_account is not None
    assert public_account is not None
    public_account.created_at = datetime(2026, 1, 1, tzinfo=UTC)
    private_account.created_at = datetime(2026, 1, 2, tzinfo=UTC)
    await db_session.flush()

    pool = await client.get("/v1/channels/bot-pool")
    assert pool.status_code == 200
    telegram = pool.json()["providers"]["telegram"]
    relevant_ids = [
        item["id"] for item in telegram if item["id"] in {private["id"], public_body["id"]}
    ]
    assert relevant_ids == [public_body["id"], private["id"]]
    pool_by_id = {item["id"]: item for item in telegram}
    assert pool_by_id[private["id"]]["visibility"] == "private"
    assert pool_by_id[private["id"]]["access"] == "owner"
    assert pool_by_id[private["id"]]["max_links"] is None
    assert pool_by_id[private["id"]]["available"] is True
    assert pool_by_id[private["id"]]["capabilities"] == {
        "link_agent": True,
        "pair_chat": True,
        "send_message": True,
        "manage_account": True,
        "sync_commands": True,
    }
    assert pool_by_id[public_body["id"]]["visibility"] == "public"
    assert pool_by_id[public_body["id"]]["access"] == "public"
    assert pool_by_id[public_body["id"]]["max_links"] is None
    assert pool_by_id[public_body["id"]]["link_count"] == 0
    assert pool_by_id[public_body["id"]]["available"] is True
    assert pool_by_id[public_body["id"]]["capabilities"] == {
        "link_agent": True,
        "pair_chat": True,
        "send_message": True,
        "manage_account": False,
        "sync_commands": False,
    }

    other_user, _other_agent = await _create_user_with_channel_agent(
        db_session,
        label="pool-other",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        other_pool = await other_client.get("/v1/channels/bot-pool")
    assert other_pool.status_code == 200
    other_telegram = other_pool.json()["providers"]["telegram"]
    other_ids = {item["id"] for item in other_telegram}
    assert public_body["id"] in other_ids
    assert private["id"] not in other_ids
    assert disabled_private["id"] not in pool_by_id
    other_public = next(item for item in other_telegram if item["id"] == public_body["id"])
    assert other_public["access"] == "public"

    disabled_detail = await client.get(f"/v1/channels/{disabled_private['id']}")
    disabled_links = await client.get(f"/v1/channels/{disabled_private['id']}/agent-links")
    disabled_link_create = await client.post(
        f"/v1/channels/{disabled_private['id']}/agent-links",
        json={},
    )
    disabled_pair = await client.post(
        f"/v1/channels/{disabled_private['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )
    disabled_send = await client.post(
        f"/v1/channels/{disabled_private['id']}/messages",
        json={"external_chat_id": "12345", "text": "hello"},
    )
    disabled_whatsapp_credential = await client.post(
        f"/v1/channels/whatsapp/{disabled_whatsapp['id']}/tenant-creds",
        json={},
    )
    disabled_whatsapp_auth_cert = await client.get(
        f"/v1/channels/whatsapp/{disabled_whatsapp['id']}/auth-cert"
    )
    assert disabled_detail.status_code == 200
    assert disabled_links.status_code == 200
    assert disabled_link_create.status_code == 404
    assert disabled_pair.status_code == 404
    assert disabled_send.status_code == 404
    assert disabled_whatsapp_credential.status_code == 404
    assert disabled_whatsapp_auth_cert.status_code == 404


@pytest.mark.asyncio
async def test_public_bot_pool_capacity_rejects_new_agent_links(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"public-capacity-{uuid4().hex}",
        config={"max_links": 1},
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="pool-cap-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="pool-cap-b")

    async with _client_for_user(db_session, user_a) as client_a:
        first_link = await client_a.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent_a.id)},
        )
        pool_after_first = await client_a.get("/v1/channels/bot-pool")
    async with _client_for_user(db_session, user_b) as client_b:
        pool_for_second = await client_b.get("/v1/channels/bot-pool")
        second_link = await client_b.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent_b.id)},
        )
        second_pair = await client_b.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"agent_id": str(agent_b.id), "ttl_seconds": 900},
        )

    assert first_link.status_code == 201, first_link.text
    first_item = next(
        item
        for item in pool_after_first.json()["providers"]["telegram"]
        if item["id"] == account_id
    )
    second_item = next(
        item for item in pool_for_second.json()["providers"]["telegram"] if item["id"] == account_id
    )
    assert first_item["link_count"] == 1
    assert first_item["max_links"] == 1
    assert first_item["available"] is False
    assert first_item["capabilities"]["link_agent"] is False
    assert first_item["capabilities"]["pair_chat"] is False
    assert second_item["available"] is False
    assert second_link.status_code == 409
    assert second_link.json()["detail"] == "channel bot link capacity reached"
    assert second_pair.status_code == 409
    assert second_pair.json()["detail"] == "channel bot link capacity reached"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_type", "provider"),
    [
        ("hermes", CHANNEL_PROVIDER_TELEGRAM),
        ("hermes", CHANNEL_PROVIDER_DISCORD),
        ("openclaw", CHANNEL_PROVIDER_TELEGRAM),
        ("openclaw", CHANNEL_PROVIDER_DISCORD),
    ],
)
async def test_hosted_agent_rejects_second_provider_account_but_keeps_existing_link_working(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
    agent_type: str,
    provider: str,
):
    if provider == CHANNEL_PROVIDER_DISCORD:

        async def fake_configure_discord_application(account: ChannelAccount):
            return {"id": DISCORD_TEST_APPLICATION_ID}

        async def fake_sync_channel_commands(**kwargs):
            return []

        monkeypatch.setattr(
            "app.routes.admin.configure_discord_application",
            fake_configure_discord_application,
        )
        monkeypatch.setattr(
            "app.routes.admin.sync_channel_commands",
            fake_sync_channel_commands,
        )
    discord_credentials = (
        {
            "provider_token": f"discord-provider-token-{uuid4().hex}",
            "config": _discord_ready_config(),
        }
        if provider == CHANNEL_PROVIDER_DISCORD
        else {}
    )
    first_account = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=provider,
        name=f"{agent_type}-{provider}-first-{uuid4().hex}",
        **discord_credentials,
    )
    second_account = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=provider,
        name=f"{agent_type}-{provider}-second-{uuid4().hex}",
        **discord_credentials,
    )
    assert first_account.status_code == 201, first_account.text
    assert second_account.status_code == 201, second_account.text
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"{agent_type}-{provider}",
        agent_type=agent_type,
    )

    async with _client_for_user(db_session, user) as user_client:
        first_link = await user_client.post(
            f"/v1/channels/{first_account.json()['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )
        idempotent_link = await user_client.post(
            f"/v1/channels/{first_account.json()['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )
        second_link = await user_client.post(
            f"/v1/channels/{second_account.json()['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )
        pair_code = await user_client.post(
            f"/v1/channels/{first_account.json()['id']}/pair-codes",
            json={"agent_link_id": first_link.json()["id"], "ttl_seconds": 900},
        )
        rotated = await user_client.post(
            f"/v1/channels/{first_account.json()['id']}/agent-links/{first_link.json()['id']}/token"
        )
    eligible_agent_ids = await channel_service.list_strict_v2_hosted_channel_agent_ids(
        db_session,
        user_id=user.id,
        provider=provider,
    )

    assert first_link.status_code == 201, first_link.text
    assert idempotent_link.status_code == 201, idempotent_link.text
    assert idempotent_link.json()["id"] == first_link.json()["id"]
    assert idempotent_link.json()["agent_token"] is None
    assert second_link.status_code == 409
    label = "Telegram" if provider == CHANNEL_PROVIDER_TELEGRAM else "Discord"
    assert second_link.json()["detail"] == (
        f"This Agent already has a {label} bot. Unlink it before connecting another."
    )
    assert pair_code.status_code == 201, pair_code.text
    assert pair_code.json()["agent_link_id"] == first_link.json()["id"]
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["agent_token"] != first_link.json()["agent_token"]
    assert agent.id not in eligible_agent_ids


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_type", "provider"),
    [
        ("hermes", CHANNEL_PROVIDER_TELEGRAM),
        ("hermes", CHANNEL_PROVIDER_DISCORD),
        ("openclaw", CHANNEL_PROVIDER_TELEGRAM),
        ("openclaw", CHANNEL_PROVIDER_DISCORD),
    ],
)
async def test_agent_link_replace_opt_in_atomically_archives_the_existing_provider_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
    agent_type: str,
    provider: str,
):
    if provider == CHANNEL_PROVIDER_DISCORD:

        async def fake_configure_discord_application(account: ChannelAccount):
            return {"id": DISCORD_TEST_APPLICATION_ID}

        async def fake_sync_channel_commands(**kwargs):
            return []

        monkeypatch.setattr(
            "app.routes.admin.configure_discord_application",
            fake_configure_discord_application,
        )
        monkeypatch.setattr(
            "app.routes.admin.sync_channel_commands",
            fake_sync_channel_commands,
        )
    discord_credentials = (
        {
            "provider_token": f"discord-replacement-token-{uuid4().hex}",
            "config": _discord_ready_config(),
        }
        if provider == CHANNEL_PROVIDER_DISCORD
        else {}
    )
    first_account_response = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=provider,
        name=f"{agent_type}-{provider}-replace-first-{uuid4().hex}",
        **discord_credentials,
    )
    second_account_response = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=provider,
        name=f"{agent_type}-{provider}-replace-second-{uuid4().hex}",
        **discord_credentials,
    )
    assert first_account_response.status_code == 201, first_account_response.text
    assert second_account_response.status_code == 201, second_account_response.text
    first_account_id = UUID(first_account_response.json()["id"])
    second_account_id = UUID(second_account_response.json()["id"])
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"{agent_type}-{provider}-replace",
        agent_type=agent_type,
    )

    async with _client_for_user(db_session, user) as user_client:
        first_response = await user_client.post(
            f"/v1/channels/{first_account_id}/agent-links",
            json={"agent_id": str(agent.id)},
        )
    assert first_response.status_code == 201, first_response.text
    first_link = await db_session.get(ChannelBotAgentLink, UUID(first_response.json()["id"]))
    assert first_link is not None
    binding = ChannelBinding(
        account_id=first_account_id,
        bot_agent_link_id=first_link.id,
        user_id=user.id,
        external_chat_id=f"replacement-chat-{uuid4().hex}",
        external_chat_type="private",
        external_chat_name="Replacement cleanup",
    )
    pair_code = ChannelPairCode(
        account_id=first_account_id,
        bot_agent_link_id=first_link.id,
        user_id=user.id,
        code_hash=hash_token(f"replacement-{uuid4()}"),
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    credential = ChannelAgentCredential(
        account_id=first_account_id,
        bot_agent_link_id=first_link.id,
        user_id=user.id,
        provider=provider,
        identity_pub_key_hash=hash_token(f"replacement-credential-{uuid4()}"),
        identity_public_key=b"replacement-public-key",
        synthetic_jid=f"replacement-{uuid4().hex}@example.test",
        encrypted_credentials=b"replacement-encrypted-credentials",
        credential_nonce=b"replacement-credential-nonce",
    )
    db_session.add_all((binding, pair_code, credential))
    await db_session.commit()

    async with _client_for_user(db_session, user) as user_client:
        replacement = await user_client.post(
            f"/v1/channels/{second_account_id}/agent-links",
            json={
                "agent_id": str(agent.id),
                "replace_existing_provider_link": True,
            },
        )
        idempotent = await user_client.post(
            f"/v1/channels/{second_account_id}/agent-links",
            json={
                "agent_id": str(agent.id),
                "replace_existing_provider_link": True,
            },
        )
        active_links = await user_client.get(
            "/v1/channels/agent-links",
            params={"agent_id": str(agent.id)},
        )

    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["account_id"] == str(second_account_id)
    assert replacement.json()["agent_token"] is not None
    assert idempotent.status_code == 201, idempotent.text
    assert idempotent.json()["id"] == replacement.json()["id"]
    assert idempotent.json()["agent_token"] is None
    assert active_links.status_code == 200, active_links.text
    assert [item["account_id"] for item in active_links.json()] == [str(second_account_id)]

    for row in (first_link, binding, pair_code, credential):
        await db_session.refresh(row)
    assert first_link.status == BOT_AGENT_LINK_STATUS_ARCHIVED
    assert first_link.archived_at is not None
    assert first_link.agent_token_hash is None
    assert first_link.encrypted_agent_token is None
    assert first_link.agent_token_nonce is None
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert pair_code.status == PAIR_CODE_STATUS_REVOKED
    assert credential.revoked_at is not None


@pytest.mark.asyncio
async def test_create_channel_replace_opt_in_links_the_new_custom_bot(
    db_session: AsyncSession,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="create-channel-provider-replace",
        agent_type="openclaw",
    )
    async with _client_for_user(db_session, user) as user_client:
        first = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": f"create-replace-first-{uuid4().hex}",
                "agent_id": str(agent.id),
            },
        )
        replacement = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": f"create-replace-second-{uuid4().hex}",
                "agent_id": str(agent.id),
                "replace_existing_provider_link": True,
            },
        )

    assert first.status_code == 201, first.text
    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["agent_id"] == str(agent.id)
    assert replacement.json()["agent_link_id"] is not None
    first_link = await db_session.get(ChannelBotAgentLink, UUID(first.json()["agent_link_id"]))
    replacement_link = await db_session.get(
        ChannelBotAgentLink,
        UUID(replacement.json()["agent_link_id"]),
    )
    assert first_link is not None
    assert first_link.status == BOT_AGENT_LINK_STATUS_ARCHIVED
    assert first_link.archived_at is not None
    assert replacement_link is not None
    assert replacement_link.status == BOT_AGENT_LINK_STATUS_ACTIVE
    assert replacement_link.archived_at is None


@pytest.mark.asyncio
async def test_provider_link_replacement_rolls_back_when_a_downstream_step_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    first_account_response = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"rollback-replace-first-{uuid4().hex}",
    )
    second_account_response = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"rollback-replace-second-{uuid4().hex}",
    )
    assert first_account_response.status_code == 201, first_account_response.text
    assert second_account_response.status_code == 201, second_account_response.text
    first_account_id = UUID(first_account_response.json()["id"])
    second_account_id = UUID(second_account_response.json()["id"])
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="rollback-provider-replace",
        agent_type="openclaw",
    )
    first_link, first_token = await _seed_existing_channel_link(
        db_session,
        account_id=str(first_account_id),
        agent=agent,
    )
    binding = ChannelBinding(
        account_id=first_account_id,
        bot_agent_link_id=first_link.id,
        user_id=user.id,
        external_chat_id=f"rollback-chat-{uuid4().hex}",
        external_chat_type="private",
    )
    db_session.add(binding)
    await db_session.commit()
    session_factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    with pytest.raises(RuntimeError, match="downstream replacement failure"):
        async with session_factory() as replacement_session:
            async with replacement_session.begin():
                replacement_account = await replacement_session.get(
                    ChannelAccount,
                    second_account_id,
                )
                assert replacement_account is not None
                await channel_service.get_or_create_bot_agent_link(
                    replacement_session,
                    account=replacement_account,
                    agent_id=agent.id,
                    user_id=user.id,
                    replace_existing_provider_link=True,
                )
                raise RuntimeError("downstream replacement failure")

    async with session_factory() as verification_session:
        restored_link = await verification_session.get(ChannelBotAgentLink, first_link.id)
        restored_binding = await verification_session.get(ChannelBinding, binding.id)
        replacement_links = list(
            (
                await verification_session.execute(
                    select(ChannelBotAgentLink).where(
                        ChannelBotAgentLink.account_id == second_account_id,
                        ChannelBotAgentLink.agent_id == agent.id,
                        ChannelBotAgentLink.archived_at.is_(None),
                    )
                )
            ).scalars()
        )
    assert restored_link is not None
    assert restored_link.status == BOT_AGENT_LINK_STATUS_ACTIVE
    assert restored_link.archived_at is None
    assert decrypt_agent_link_token(restored_link) == first_token
    assert restored_binding is not None
    assert restored_binding.status == BINDING_STATUS_ACTIVE
    assert replacement_links == []


@pytest.mark.asyncio
async def test_concurrent_second_provider_link_is_serialized(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    first_account = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"concurrent-provider-first-{uuid4().hex}",
    )
    second_account = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"concurrent-provider-second-{uuid4().hex}",
    )
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="concurrent-provider-link",
        agent_type="openclaw",
    )
    session_factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def create_link(account_id: str) -> tuple[str, str]:
        async with session_factory() as session:
            account = await session.get(ChannelAccount, UUID(account_id))
            assert account is not None
            try:
                link, _token = await channel_service.get_or_create_bot_agent_link(
                    session,
                    account=account,
                    agent_id=agent.id,
                    user_id=user.id,
                )
                await session.commit()
                return "created", str(link.id)
            except HTTPException as exc:
                await session.rollback()
                return "rejected", str(exc.detail)

    results = await asyncio.gather(
        create_link(first_account.json()["id"]),
        create_link(second_account.json()["id"]),
    )

    assert sorted(result[0] for result in results) == ["created", "rejected"]
    assert next(detail for outcome, detail in results if outcome == "rejected") == (
        "This Agent already has a Telegram bot. Unlink it before connecting another."
    )


@pytest.mark.asyncio
async def test_one_bot_account_can_link_and_pair_chats_to_multiple_agents(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    account_response = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"shared-bot-multiple-agents-{uuid4().hex}",
    )
    assert account_response.status_code == 201, account_response.text
    account = account_response.json()
    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="shared-bot-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="shared-bot-b")

    async with _client_for_user(db_session, user_a) as client_a:
        link_a = await client_a.post(
            f"/v1/channels/{account['id']}/agent-links",
            json={"agent_id": str(agent_a.id)},
        )
        pair_a = await client_a.post(
            f"/v1/channels/{account['id']}/pair-codes",
            json={"agent_link_id": link_a.json()["id"], "ttl_seconds": 900},
        )
    async with _client_for_user(db_session, user_b) as client_b:
        link_b = await client_b.post(
            f"/v1/channels/{account['id']}/agent-links",
            json={"agent_id": str(agent_b.id)},
        )
        pair_b = await client_b.post(
            f"/v1/channels/{account['id']}/pair-codes",
            json={"agent_link_id": link_b.json()["id"], "ttl_seconds": 900},
        )

    assert link_a.status_code == 201, link_a.text
    assert link_b.status_code == 201, link_b.text
    assert pair_a.status_code == 201, pair_a.text
    assert pair_b.status_code == 201, pair_b.text
    for update_id, chat_id, code in (
        (9101, 501, pair_a.json()["code"]),
        (9102, 502, pair_b.json()["code"]),
    ):
        paired = await client.post(
            f"/v1/channels/telegram/{account['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": f"/clawdi_pair {code}",
                    "chat": {"id": chat_id, "type": "private"},
                    "from": {"id": chat_id},
                },
            },
        )
        assert paired.status_code == 200, paired.text
        assert paired.json()["paired"] is True

    bindings = list(
        (
            await db_session.execute(
                select(ChannelBinding).where(ChannelBinding.account_id == UUID(account["id"]))
            )
        ).scalars()
    )
    assert {(binding.external_chat_id, binding.bot_agent_link_id) for binding in bindings} == {
        ("501", UUID(link_a.json()["id"])),
        ("502", UUID(link_b.json()["id"])),
    }


@pytest.mark.asyncio
async def test_interrupted_link_archive_is_completed_before_replacement(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"interrupted-link-archive-{uuid4().hex}",
    )
    assert created.status_code == 201, created.text
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="interrupted-link-archive",
        agent_type="openclaw",
    )
    interrupted = ChannelBotAgentLink(
        account_id=UUID(created.json()["id"]),
        user_id=user.id,
        agent_id=agent.id,
        status="archived",
        archived_at=None,
    )
    db_session.add(interrupted)
    await db_session.commit()

    async with _client_for_user(db_session, user) as user_client:
        replacement = await user_client.post(
            f"/v1/channels/{created.json()['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )

    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["id"] != str(interrupted.id)
    await db_session.refresh(interrupted)
    assert interrupted.archived_at is not None


@pytest.mark.asyncio
async def test_historical_duplicate_managed_accounts_are_visible_but_fail_closed_until_unlinked(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch: pytest.MonkeyPatch,
):
    first = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"historical-duplicate-first-{uuid4().hex}",
    )
    second = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"historical-duplicate-second-{uuid4().hex}",
    )
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="historical-duplicate-managed-accounts",
        agent_type="openclaw",
    )
    first_link, first_token = await _seed_existing_channel_link(
        db_session,
        account_id=first.json()["id"],
        agent=agent,
    )
    second_link, second_token = await _seed_existing_channel_link(
        db_session,
        account_id=second.json()["id"],
        agent=agent,
    )
    pair_code = ChannelPairCode(
        account_id=UUID(second.json()["id"]),
        bot_agent_link_id=second_link.id,
        user_id=user.id,
        code_hash=hash_token("X7V9Q2M4KC"),
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    legacy_binding = ChannelBinding(
        account_id=UUID(first.json()["id"]),
        bot_agent_link_id=first_link.id,
        user_id=user.id,
        external_chat_id="duplicate-ingress-chat",
        external_chat_type="private",
        external_chat_name="Historical duplicate ingress",
    )
    db_session.add_all((pair_code, legacy_binding))
    await db_session.commit()
    first_account = await db_session.get(ChannelAccount, UUID(first.json()["id"]))
    second_account = await db_session.get(ChannelAccount, UUID(second.json()["id"]))
    assert first_account is not None
    assert second_account is not None

    agent_deliveries: list[dict[str, Any]] = []

    async def _record_agent_delivery(_link, payload):
        agent_deliveries.append(payload)
        return True

    monkeypatch.setattr(
        telegram_router,
        "deliver_telegram_agent_webhook",
        _record_agent_delivery,
    )
    ingress_delivered = await telegram_router._deliver_telegram_agent_webhook_for_binding(
        db_session,
        account=first_account,
        binding=legacy_binding,
        payload={"update_id": 99101},
    )

    claim = await channel_service.claim_pair_code(
        db_session,
        account=second_account,
        raw_code="X7V9Q2M4KC",
        external_chat_id="duplicate-account-chat",
        external_chat_type="private",
        external_chat_name="Second bot chat",
        external_user_id="duplicate-user",
    )
    await db_session.commit()
    async with _client_for_user(db_session, user) as user_client:
        visible_duplicates = await user_client.get(
            "/v1/channels/agent-links",
            params={"agent_id": str(agent.id)},
        )
        idempotent = await user_client.post(
            f"/v1/channels/{first.json()['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )
        duplicate_pair = await user_client.post(
            f"/v1/channels/{second.json()['id']}/pair-codes",
            json={"agent_link_id": str(second_link.id), "ttl_seconds": 900},
        )
        duplicate_rotate = await user_client.post(
            f"/v1/channels/{second.json()['id']}/agent-links/{second_link.id}/token"
        )
    first_auth = await client.post(
        _telegram_bot_path(
            {"id": first.json()["id"], "agent_token": first_token},
            "getMe",
        ),
        headers={"Authorization": f"Bearer {first_token}"},
    )
    second_auth = await client.post(
        _telegram_bot_path(
            {"id": second.json()["id"], "agent_token": second_token},
            "getMe",
        ),
        headers={"Authorization": f"Bearer {second_token}"},
    )

    assert claim.binding is None
    assert claim.reason == "invalid"
    assert ingress_delivered is False
    assert agent_deliveries == []
    await db_session.refresh(pair_code)
    assert pair_code.status == PAIR_CODE_STATUS_REVOKED
    assert visible_duplicates.status_code == 200
    assert {item["id"] for item in visible_duplicates.json()} == {
        str(first_link.id),
        str(second_link.id),
    }
    assert idempotent.status_code == 201
    assert idempotent.json()["id"] == str(first_link.id)
    remediation = (
        "This Agent has multiple active Telegram bots. Unlink the extras until only one remains."
    )
    assert duplicate_pair.status_code == 409
    assert duplicate_pair.json()["detail"] == remediation
    assert duplicate_rotate.status_code == 409
    assert duplicate_rotate.json()["detail"] == remediation
    assert first_auth.status_code == 409
    assert first_auth.json()["detail"] == remediation
    assert second_auth.status_code == 409
    assert second_auth.json()["detail"] == remediation
    assert first_link.id != second_link.id

    async with _client_for_user(db_session, user) as user_client:
        unlinked = await user_client.delete(
            f"/v1/channels/{second.json()['id']}/agent-links/{second_link.id}"
        )
        remaining_links = await user_client.get(
            "/v1/channels/agent-links",
            params={"agent_id": str(agent.id)},
        )
        rotated = await user_client.post(
            f"/v1/channels/{first.json()['id']}/agent-links/{first_link.id}/token"
        )
    assert unlinked.status_code == 204
    assert [item["id"] for item in remaining_links.json()] == [str(first_link.id)]
    assert rotated.status_code == 200, rotated.text


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_type", ["codex", "claude_code", "openclaw", "hermes"])
async def test_channel_agent_link_rejects_agents_without_strict_v2_authority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    agent_type: str,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"local-{agent_type}",
        agent_type=agent_type,
        hosted=False,
    )
    account = await _create_public_telegram_account_for_user(
        client,
        user=user,
        label=f"strict-link-{agent_type}",
    )

    async with _client_for_user(db_session, user) as user_client:
        response = await user_client.post(
            f"/v1/channels/{account['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL
    links = list(
        (
            await db_session.execute(
                select(ChannelBotAgentLink).where(
                    ChannelBotAgentLink.account_id == UUID(account["id"]),
                    ChannelBotAgentLink.agent_id == agent.id,
                )
            )
        ).scalars()
    )
    assert links == []


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_type", ["openclaw", "hermes"])
async def test_channel_agent_link_accepts_strict_v2_runtime_agents(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    agent_type: str,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"strict-{agent_type}",
        agent_type=agent_type,
    )
    account = await _create_public_telegram_account_for_user(
        client,
        user=user,
        label=f"strict-link-{agent_type}",
    )

    async with _client_for_user(db_session, user) as user_client:
        response = await user_client.post(
            f"/v1/channels/{account['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )

    assert response.status_code == 201, response.text
    assert response.json()["agent_id"] == str(agent.id)


@pytest.mark.asyncio
async def test_channel_agent_link_rejects_non_object_runtime_state_without_500(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="non-object-runtime-authority",
        agent_type="openclaw",
    )
    await db_session.execute(
        update(HostedRuntimeState)
        .where(HostedRuntimeState.environment_id == agent.id)
        .values(runtimes=[])
    )
    await db_session.commit()
    account = await _create_public_telegram_account_for_user(
        client,
        user=user,
        label="non-object-runtime-authority",
    )

    async with _client_for_user(db_session, user) as user_client:
        response = await user_client.post(
            f"/v1/channels/{account['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL


@pytest.mark.asyncio
async def test_channel_link_admission_serializes_behind_runtime_retirement(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"retirement-admission-{uuid4().hex}",
    )
    assert created.status_code == 201, created.text
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="retirement-admission",
        agent_type="openclaw",
    )
    fence = await db_session.get(V2RuntimeEnvironmentFence, agent.id)
    assert fence is not None
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with session_factory() as retirement_session:
        await retire_runtime_environment(
            retirement_session,
            environment_id=agent.id,
            expected_deployment_id=fence.deployment_id,
            retirement_id="channel-link-retirement",
            owner_id=user.id,
        )

        link_backend_pid: asyncio.Future[int] = asyncio.get_running_loop().create_future()

        async def create_link_after_retirement_lock():
            async with session_factory() as link_session:
                backend_pid = await link_session.scalar(text("SELECT pg_backend_pid()"))
                assert isinstance(backend_pid, int)
                link_backend_pid.set_result(backend_pid)
                account = await link_session.get(ChannelAccount, UUID(created.json()["id"]))
                assert account is not None
                return await channel_service.get_or_create_bot_agent_link(
                    link_session,
                    account=account,
                    agent_id=agent.id,
                    user_id=user.id,
                )

        pending_link = asyncio.create_task(create_link_after_retirement_lock())
        await wait_for_lock_wait(session_factory, await asyncio.wait_for(link_backend_pid, 2))
        assert not pending_link.done()
        await retirement_session.commit()

    with pytest.raises(HTTPException) as rejected:
        await asyncio.wait_for(pending_link, timeout=5)
    assert rejected.value.status_code == 409
    links = list(
        (
            await db_session.execute(
                select(ChannelBotAgentLink).where(
                    ChannelBotAgentLink.account_id == UUID(created.json()["id"]),
                    ChannelBotAgentLink.agent_id == agent.id,
                )
            )
        ).scalars()
    )
    assert links == []


@pytest.mark.asyncio
async def test_runtime_retirement_cleanup_archives_channel_authority_and_repairs_replay(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": CHANNEL_PROVIDER_TELEGRAM,
            "name": f"runtime-retirement-{uuid4().hex}",
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    account_id = UUID(created["id"])
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None

    now = datetime.now(UTC)
    binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        external_chat_id=f"retirement-chat-{uuid4().hex}",
        external_chat_type="private",
        status=BINDING_STATUS_ACTIVE,
    )
    pair_code = ChannelPairCode(
        account_id=account_id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        code_hash=hash_token(f"retirement-{uuid4()}"),
        expires_at=now + timedelta(minutes=15),
    )
    credential = ChannelAgentCredential(
        account_id=account_id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        identity_pub_key_hash=hash_token(f"retirement-credential-{uuid4()}"),
        identity_public_key=b"retirement-public-key",
        synthetic_jid=f"retirement-{uuid4().hex}@example.test",
        encrypted_credentials=b"retirement-encrypted-credentials",
        credential_nonce=b"retirement-credential-nonce",
    )
    db_session.add_all((binding, pair_code, credential))
    await db_session.flush()
    inbound_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link.id,
        binding_id=binding.id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        text="queued inbound",
        payload={},
    )
    outbound_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link.id,
        binding_id=binding.id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=binding.external_chat_id,
        text="queued outbound",
        payload={},
    )
    db_session.add_all((inbound_message, outbound_message))
    await db_session.flush()
    delivery = ChannelDelivery(
        account_id=account_id,
        bot_agent_link_id=link.id,
        message_id=outbound_message.id,
        user_id=seed_user.id,
        status=DELIVERY_STATUS_PENDING,
        next_attempt_at=now,
    )
    db_session.add(delivery)
    await db_session.commit()

    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    fence = await db_session.get(V2RuntimeEnvironmentFence, channel_agent.id)
    assert state is not None
    assert fence is not None
    deployment_id = state.deployment_id
    retirement_id = f"channel-cleanup-{channel_agent.id}"
    cleanup_id = f"channel-cleanup-receipt-{channel_agent.id}"
    await retire_runtime_environment(
        db_session,
        environment_id=channel_agent.id,
        expected_deployment_id=deployment_id,
        retirement_id=retirement_id,
        owner_id=seed_user.id,
    )
    await db_session.commit()

    receipt, receipt_created, runtime_state_deleted = await cleanup_retired_runtime_state(
        db_session,
        environment_id=channel_agent.id,
        expected_deployment_binding=deployment_id,
        retirement_id=retirement_id,
        cleanup_id=cleanup_id,
    )
    await db_session.commit()

    for row in (link, binding, pair_code, credential, inbound_message, delivery):
        await db_session.refresh(row)
    assert receipt_created is True
    assert runtime_state_deleted is True
    assert link.status == BOT_AGENT_LINK_STATUS_ARCHIVED
    assert link.archived_at is not None
    assert link.agent_token_hash is None
    assert link.encrypted_agent_token is None
    assert link.agent_token_nonce is None
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert pair_code.status == PAIR_CODE_STATUS_REVOKED
    assert credential.revoked_at is not None
    assert inbound_message.delivered_at is not None
    assert delivery.status == DELIVERY_STATUS_FAILED
    assert delivery.last_error == "channel_agent_link_archived"
    assert await db_session.get(HostedRuntimeState, channel_agent.id) is None

    historical_link = ChannelBotAgentLink(
        account_id=account_id,
        user_id=seed_user.id,
        agent_id=channel_agent.id,
    )
    channel_service.store_agent_link_token(
        historical_link,
        generate_agent_token(CHANNEL_PROVIDER_TELEGRAM),
    )
    db_session.add(historical_link)
    await db_session.flush()
    historical_binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=historical_link.id,
        user_id=seed_user.id,
        external_chat_id=f"historical-retirement-chat-{uuid4().hex}",
        external_chat_type="private",
        status=BINDING_STATUS_ACTIVE,
    )
    db_session.add(historical_binding)
    await db_session.commit()

    replayed_receipt, replay_created, replay_state_deleted = await cleanup_retired_runtime_state(
        db_session,
        environment_id=channel_agent.id,
        expected_deployment_binding=deployment_id,
        retirement_id=retirement_id,
        cleanup_id=cleanup_id,
    )
    await db_session.commit()

    await db_session.refresh(historical_link)
    await db_session.refresh(historical_binding)
    assert replayed_receipt == receipt
    assert replay_created is False
    assert replay_state_deleted is False
    assert historical_link.status == BOT_AGENT_LINK_STATUS_ARCHIVED
    assert historical_link.archived_at is not None
    assert historical_binding.status == BINDING_STATUS_ARCHIVED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_authority",
    [
        "missing_state",
        "missing_fence",
        "retired_fence",
        "wrong_owner",
        "wrong_deployment",
        "runtime_mismatch",
        "multiple_runtimes",
        "invalid_runtime",
    ],
)
async def test_strict_v2_channel_agent_authority_fails_closed(
    db_session: AsyncSession,
    invalid_authority: str,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"invalid-authority-{invalid_authority}",
        agent_type="openclaw",
    )
    state = await db_session.get(HostedRuntimeState, agent.id)
    fence = await db_session.get(V2RuntimeEnvironmentFence, agent.id)
    assert state is not None
    assert fence is not None

    candidate_state: HostedRuntimeState | None = state
    candidate_fence: V2RuntimeEnvironmentFence | None = fence
    if invalid_authority == "missing_state":
        candidate_state = None
    elif invalid_authority == "missing_fence":
        candidate_fence = None
    elif invalid_authority == "retired_fence":
        fence.state = "retired"
    elif invalid_authority == "wrong_owner":
        fence.owner_id = uuid4()
    elif invalid_authority == "wrong_deployment":
        fence.deployment_id = f"other-{uuid4().hex}"
    elif invalid_authority == "runtime_mismatch":
        state.runtimes = {"hermes": state.runtimes["openclaw"]}
    elif invalid_authority == "multiple_runtimes":
        state.runtimes = {
            "openclaw": state.runtimes["openclaw"],
            "hermes": state.runtimes["openclaw"],
        }
    elif invalid_authority == "invalid_runtime":
        state.runtimes = {"openclaw": {"enabled": True, "providerMode": "invalid"}}

    assert not channel_service.is_strict_v2_hosted_channel_agent(
        agent,
        candidate_state,
        candidate_fence,
    )
    await db_session.rollback()


@pytest.mark.asyncio
async def test_channel_create_and_cli_fallback_reject_local_agent_without_residual_account(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="local-channel-create",
        agent_type="openclaw",
        hosted=False,
    )
    explicit_name = f"local-explicit-{uuid4().hex}"
    cli_name = f"local-cli-{uuid4().hex}"
    api_key = ApiKey(user_id=user.id, environment_id=agent.id, label="local-cli")

    async with _client_for_user(db_session, user) as user_client:
        explicit = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": explicit_name,
                "agent_id": str(agent.id),
            },
        )
    async with _client_for_api_key(db_session, user, api_key) as cli_client:
        cli = await cli_client.post(
            "/v1/channels",
            json={"provider": CHANNEL_PROVIDER_TELEGRAM, "name": cli_name},
        )

    assert explicit.status_code == 409
    assert cli.status_code == 409
    assert explicit.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL
    assert cli.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL
    accounts = list(
        (
            await db_session.execute(
                select(ChannelAccount).where(
                    ChannelAccount.user_id == user.id,
                    ChannelAccount.name.in_([explicit_name, cli_name]),
                )
            )
        ).scalars()
    )
    assert accounts == []


@pytest.mark.asyncio
async def test_web_channel_create_does_not_auto_link_sole_local_agent(
    db_session: AsyncSession,
):
    user, _agent = await _create_user_with_channel_agent(
        db_session,
        label="local-web-fallback",
        agent_type="openclaw",
        hosted=False,
    )
    name = f"local-web-{uuid4().hex}"

    async with _client_for_user(db_session, user) as user_client:
        response = await user_client.post(
            "/v1/channels",
            json={"provider": CHANNEL_PROVIDER_TELEGRAM, "name": name},
        )

    assert response.status_code == 201, response.text
    assert response.json()["agent_id"] is None
    assert response.json()["agent_link_id"] is None


@pytest.mark.asyncio
async def test_web_channel_create_explicit_null_does_not_auto_link_sole_cloud_agent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    response = await client.post(
        "/v1/channels",
        json={
            "provider": CHANNEL_PROVIDER_TELEGRAM,
            "name": f"cloud-inventory-{uuid4().hex}",
            "agent_id": None,
        },
    )

    assert response.status_code == 201, response.text
    created = response.json()
    assert created["agent_id"] is None
    assert created["agent_link_id"] is None
    link = (
        await db_session.execute(
            select(ChannelBotAgentLink).where(
                ChannelBotAgentLink.account_id == UUID(created["id"]),
                ChannelBotAgentLink.agent_id == channel_agent.id,
            )
        )
    ).scalar_one_or_none()
    assert link is None


@pytest.mark.asyncio
async def test_pair_code_agent_id_cannot_create_link_for_local_agent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="local-pair-agent-id",
        agent_type="openclaw",
        hosted=False,
    )
    account = await _create_public_telegram_account_for_user(
        client,
        user=user,
        label="strict-pair-agent-id",
    )

    async with _client_for_user(db_session, user) as user_client:
        response = await user_client.post(
            f"/v1/channels/{account['id']}/pair-codes",
            json={"agent_id": str(agent.id), "ttl_seconds": 900},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL
    links = list(
        (
            await db_session.execute(
                select(ChannelBotAgentLink).where(
                    ChannelBotAgentLink.account_id == UUID(account["id"]),
                    ChannelBotAgentLink.agent_id == agent.id,
                )
            )
        ).scalars()
    )
    assert links == []


@pytest.mark.asyncio
async def test_historical_local_link_remains_listable_and_cleanable_but_cannot_pair(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="historical-local-link",
        agent_type="openclaw",
        hosted=False,
    )
    account_body = await _create_public_telegram_account_for_user(
        client,
        user=user,
        label="historical-local-link",
    )
    account_id = UUID(account_body["id"])
    link = ChannelBotAgentLink(
        account_id=account_id,
        user_id=user.id,
        agent_id=agent.id,
    )
    historical_agent_token = generate_agent_token(CHANNEL_PROVIDER_TELEGRAM)
    channel_service.store_agent_link_token(link, historical_agent_token)
    db_session.add(link)
    await db_session.flush()
    binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=link.id,
        user_id=user.id,
        external_chat_id="historical-chat",
        external_chat_type="private",
        external_chat_name="Cleanup chat",
    )
    db_session.add(binding)
    await db_session.commit()

    bot_api = await client.post(
        _telegram_bot_path(
            {"id": str(account_id), "agent_token": historical_agent_token},
            "getMe",
        ),
        headers={"Authorization": f"Bearer {historical_agent_token}"},
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": account_body["webhook_secret"]},
        json={
            "update_id": 9001,
            "message": {
                "message_id": 9002,
                "text": "must not reach a local runtime",
                "chat": {"id": "historical-chat", "type": "private"},
                "from": {"id": 9003, "is_bot": False},
            },
        },
    )

    async with _client_for_user(db_session, user) as user_client:
        channel_links = await user_client.get(f"/v1/channels/{account_id}/agent-links")
        agent_links = await user_client.get(
            "/v1/channels/agent-links",
            params={"agent_id": str(agent.id)},
        )
        bindings = await user_client.get(f"/v1/channels/{account_id}/bindings")
        pair_by_link = await user_client.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"agent_link_id": str(link.id), "ttl_seconds": 900},
        )
        pair_implicit = await user_client.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"ttl_seconds": 900},
        )
        rotate = await user_client.post(f"/v1/channels/{account_id}/agent-links/{link.id}/token")
        unpair = await user_client.delete(f"/v1/channels/{account_id}/bindings/{binding.id}")
        unlink = await user_client.delete(f"/v1/channels/{account_id}/agent-links/{link.id}")

    assert channel_links.status_code == 200
    assert [item["id"] for item in channel_links.json()] == [str(link.id)]
    assert agent_links.status_code == 200
    assert [item["id"] for item in agent_links.json()] == [str(link.id)]
    assert bindings.status_code == 200
    assert [item["id"] for item in bindings.json()] == [str(binding.id)]
    assert pair_by_link.status_code == 409
    assert pair_implicit.status_code == 409
    assert rotate.status_code == 409
    assert pair_by_link.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL
    assert rotate.json()["detail"] == channel_service.STRICT_V2_AGENT_LINK_DETAIL
    assert bot_api.status_code == 401
    assert inbound.status_code == 200
    assert inbound.json()["binding_id"] is None
    inbound_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.provider_event_id == "update:9001",
            )
        )
    ).scalar_one_or_none()
    assert inbound_message is None
    assert unpair.status_code == 200, unpair.text
    assert unpair.json()["unpaired"] is True
    assert unlink.status_code == 204
    await db_session.refresh(binding)
    await db_session.refresh(link)
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert link.status == BOT_AGENT_LINK_STATUS_ARCHIVED


@pytest.mark.asyncio
async def test_historical_pending_pair_code_cannot_create_new_chat_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="historical-pending-pair-code",
        agent_type="openclaw",
        hosted=False,
    )
    account_body = await _create_public_telegram_account_for_user(
        client,
        user=user,
        label="historical-pending-pair-code",
    )
    account_id = UUID(account_body["id"])
    link = ChannelBotAgentLink(
        account_id=account_id,
        user_id=user.id,
        agent_id=agent.id,
    )
    db_session.add(link)
    await db_session.flush()
    pair_code = ChannelPairCode(
        account_id=account_id,
        bot_agent_link_id=link.id,
        user_id=user.id,
        code_hash=hash_token("PAIRHISTORICAL01"),
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    db_session.add(pair_code)
    await db_session.commit()
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None

    claim = await channel_service.claim_pair_code(
        db_session,
        account=account,
        raw_code="PAIRHISTORICAL01",
        external_chat_id="new-chat-after-fix",
        external_chat_type="private",
        external_chat_name="Must not pair",
        external_user_id="historical-user",
    )
    await db_session.commit()

    assert claim.binding is None
    assert claim.reason == "invalid"
    await db_session.refresh(pair_code)
    assert pair_code.status == PAIR_CODE_STATUS_REVOKED
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.external_chat_id == "new-chat-after-fix",
            )
        )
    ).scalar_one_or_none()
    assert binding is None


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_type", ["hermes", "openclaw"])
async def test_whatsapp_managed_link_and_pair_admission_is_enabled_with_single_account_limit(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    agent_type: str,
):
    account = await _seed_historical_platform_whatsapp_account(
        db_session,
        name=f"{agent_type}-whatsapp-enabled-{uuid4().hex}",
    )
    account_id = str(account.id)
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"{agent_type}-whatsapp-enabled",
        agent_type=agent_type,
    )

    async with _client_for_user(db_session, user) as user_client:
        link = await user_client.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent.id)},
        )
        pair = await user_client.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"agent_link_id": link.json()["id"], "ttl_seconds": 900},
        )
        second_account = await _seed_historical_platform_whatsapp_account(
            db_session,
            name=f"{agent_type}-whatsapp-second-{uuid4().hex}",
        )
        second_link = await user_client.post(
            f"/v1/channels/{second_account.id}/agent-links",
            json={"agent_id": str(agent.id)},
        )

    assert link.status_code == 201, link.text
    assert pair.status_code == 201, pair.text
    assert pair.json()["agent_link_id"] == link.json()["id"]
    assert second_link.status_code == 409
    assert second_link.json()["detail"] == (
        "This Agent already has a WhatsApp bot. Unlink it before connecting another."
    )
    existing = list(
        (
            await db_session.execute(
                select(ChannelBotAgentLink).where(
                    ChannelBotAgentLink.account_id == UUID(account_id),
                    ChannelBotAgentLink.agent_id == agent.id,
                    ChannelBotAgentLink.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    assert len(existing) == 1
    assert str(existing[0].id) == link.json()["id"]


@pytest.mark.asyncio
async def test_delete_channel_agent_link_archives_link_and_releases_capacity(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"public-unlink-{uuid4().hex}",
        config={"max_links": 1},
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="pool-unlink-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="pool-unlink-b")

    async with _client_for_user(db_session, user_a) as client_a:
        first_link = await client_a.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent_a.id)},
        )
        assert first_link.status_code == 201, first_link.text
        first_link_id = first_link.json()["id"]
        active_link = await db_session.get(ChannelBotAgentLink, UUID(first_link_id))
        assert active_link is not None
        assert active_link.encrypted_agent_token is not None
        assert active_link.agent_token_nonce is not None
        full_pool = await client_a.get("/v1/channels/bot-pool")
        deleted = await client_a.delete(f"/v1/channels/{account_id}/agent-links/{first_link_id}")
        second_delete = await client_a.delete(
            f"/v1/channels/{account_id}/agent-links/{first_link_id}"
        )
        missing_delete = await client_a.delete(f"/v1/channels/{account_id}/agent-links/{uuid4()}")

        links_after = await client_a.get(f"/v1/channels/{account_id}/agent-links")
        pool_after_delete = await client_a.get("/v1/channels/bot-pool")
        audit_response = await client_a.get(
            "/v1/audit/events",
            params={"channel_account_id": account_id, "limit": 20},
        )
    async with _client_for_user(db_session, user_b) as client_b:
        second_link = await client_b.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent_b.id)},
        )

    before_item = next(
        item for item in full_pool.json()["providers"]["telegram"] if item["id"] == account_id
    )
    assert before_item["link_count"] == 1
    assert before_item["available"] is False

    assert deleted.status_code == 204, deleted.text
    assert second_delete.status_code == 204, second_delete.text
    assert missing_delete.status_code == 204, missing_delete.text
    assert links_after.status_code == 200, links_after.text
    assert links_after.json() == []
    after_item = next(
        item
        for item in pool_after_delete.json()["providers"]["telegram"]
        if item["id"] == account_id
    )
    assert after_item["link_count"] == 0
    assert after_item["available"] is True
    assert second_link.status_code == 201, second_link.text

    audit_response_body = audit_response.json()
    archive_events = [
        event
        for event in audit_response_body["items"]
        if event["action"] == "channel.agent_link.archive" and event["resource_id"] == first_link_id
    ]
    assert len(archive_events) == 1
    archive_event = archive_events[0]
    assert archive_event["resource_type"] == "channel_agent_link"
    assert archive_event["resource_id"] == first_link_id
    assert archive_event["channel_agent_link_id"] == first_link_id
    assert archive_event["details"]["agent_id"] == str(agent_a.id)

    archived_link = await db_session.get(ChannelBotAgentLink, UUID(first_link_id))
    assert archived_link is not None
    assert archived_link.status == BOT_AGENT_LINK_STATUS_ARCHIVED
    assert archived_link.archived_at is not None
    assert archived_link.agent_token_hash is None
    assert archived_link.encrypted_agent_token is None
    assert archived_link.agent_token_nonce is None


@pytest.mark.asyncio
async def test_delete_channel_agent_link_cleans_only_link_scoped_runtime_state(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"agent-link-state-delete-{uuid4().hex}",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    target_link_id = UUID(created["agent_link_id"])
    sibling_link_response = await client.post(
        f"/v1/channels/{account_id}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert sibling_link_response.status_code == 201, sibling_link_response.text
    sibling_link_id = UUID(sibling_link_response.json()["id"])

    now = datetime.now(UTC)
    target_pair_code = ChannelPairCode(
        account_id=account_id,
        bot_agent_link_id=target_link_id,
        user_id=seed_user.id,
        code_hash=hash_token(f"target-{uuid4()}"),
        expires_at=now + timedelta(minutes=15),
    )
    sibling_pair_code = ChannelPairCode(
        account_id=account_id,
        bot_agent_link_id=sibling_link_id,
        user_id=seed_user.id,
        code_hash=hash_token(f"sibling-{uuid4()}"),
        expires_at=now + timedelta(minutes=15),
    )
    target_binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=target_link_id,
        user_id=seed_user.id,
        external_chat_id=f"target-chat-{uuid4().hex}",
        external_chat_type="private",
        external_chat_name="Target",
        status=BINDING_STATUS_ACTIVE,
    )
    sibling_binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=sibling_link_id,
        user_id=seed_user.id,
        external_chat_id=f"sibling-chat-{uuid4().hex}",
        external_chat_type="private",
        external_chat_name="Sibling",
        status=BINDING_STATUS_ACTIVE,
    )
    db_session.add_all(
        [
            target_pair_code,
            sibling_pair_code,
            target_binding,
            sibling_binding,
        ]
    )
    await db_session.flush()

    target_pending_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=target_link_id,
        binding_id=target_binding.id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=target_binding.external_chat_id,
        text="queued target",
        payload={"delivery": DELIVERY_STATUS_PENDING},
    )
    target_in_progress_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=target_link_id,
        binding_id=target_binding.id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=target_binding.external_chat_id,
        text="locked target",
        payload={"delivery": DELIVERY_STATUS_IN_PROGRESS},
    )
    sibling_message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=sibling_link_id,
        binding_id=sibling_binding.id,
        user_id=seed_user.id,
        direction=MESSAGE_DIRECTION_OUTBOUND,
        external_chat_id=sibling_binding.external_chat_id,
        text="queued sibling",
        payload={"delivery": DELIVERY_STATUS_PENDING},
    )
    db_session.add_all([target_pending_message, target_in_progress_message, sibling_message])
    await db_session.flush()

    target_pending_delivery = ChannelDelivery(
        account_id=account_id,
        bot_agent_link_id=target_link_id,
        message_id=target_pending_message.id,
        user_id=seed_user.id,
        status=DELIVERY_STATUS_PENDING,
        next_attempt_at=now,
    )
    target_in_progress_delivery = ChannelDelivery(
        account_id=account_id,
        bot_agent_link_id=target_link_id,
        message_id=target_in_progress_message.id,
        user_id=seed_user.id,
        status=DELIVERY_STATUS_IN_PROGRESS,
        next_attempt_at=now,
        locked_at=now,
        locked_by="test-worker",
    )
    sibling_delivery = ChannelDelivery(
        account_id=account_id,
        bot_agent_link_id=sibling_link_id,
        message_id=sibling_message.id,
        user_id=seed_user.id,
        status=DELIVERY_STATUS_PENDING,
        next_attempt_at=now,
    )
    db_session.add_all([target_pending_delivery, target_in_progress_delivery, sibling_delivery])
    await db_session.commit()

    deleted = await client.delete(f"/v1/channels/{account_id}/agent-links/{target_link_id}")

    assert deleted.status_code == 204, deleted.text
    for row in (
        target_pair_code,
        sibling_pair_code,
        target_binding,
        sibling_binding,
        target_pending_delivery,
        target_in_progress_delivery,
        sibling_delivery,
    ):
        await db_session.refresh(row)

    assert target_pair_code.status == PAIR_CODE_STATUS_REVOKED
    assert sibling_pair_code.status == PAIR_CODE_STATUS_PENDING
    assert target_binding.status == BINDING_STATUS_ARCHIVED
    assert sibling_binding.status == BINDING_STATUS_ACTIVE
    assert target_pending_delivery.status == DELIVERY_STATUS_FAILED
    assert target_pending_delivery.last_error == "channel_agent_link_archived"
    assert target_in_progress_delivery.status == DELIVERY_STATUS_FAILED
    assert target_in_progress_delivery.locked_at is None
    assert target_in_progress_delivery.locked_by is None
    assert target_in_progress_delivery.last_error == "channel_agent_link_archived"
    assert sibling_delivery.status == DELIVERY_STATUS_PENDING
    assert sibling_delivery.last_error is None


@pytest.mark.asyncio
async def test_channel_agent_link_is_connected_only_after_runtime_convergence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"link-convergence-{uuid4().hex}",
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()

    connecting = await client.get(f"/v1/channels/{created['id']}/agent-links")
    assert connecting.status_code == 200, connecting.text
    assert connecting.json()[0]["runtime_status"] == "connecting"

    await _converge_hosted_runtime(
        db_session,
        user=seed_user,
        agent_id=channel_agent.id,
    )
    connected = await client.get(
        "/v1/channels/agent-links",
        params={"agent_id": str(channel_agent.id)},
    )
    assert connected.status_code == 200, connected.text
    item = next(link for link in connected.json() if link["account_id"] == created["id"])
    assert item["runtime_status"] == "connected"

    rotated = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["runtime_status"] == "connecting"

    reconciling = await client.get(f"/v1/channels/{created['id']}/agent-links")
    assert reconciling.status_code == 200, reconciling.text
    assert reconciling.json()[0]["runtime_status"] == "connecting"


@pytest.mark.asyncio
async def test_list_channel_agent_links_by_agent_returns_linked_channel_summaries(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    engine,
    seed_user,
    channel_agent,
    second_channel_agent,
):
    private = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"agent-links-private-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    other_private = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"agent-links-other-{uuid4().hex}",
                "provider_token": "discord-provider-token-2",
                "config": _discord_ready_config("223456789012345678"),
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    public = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"agent-links-public-{uuid4().hex}",
    )
    assert public.status_code == 201, public.text
    public_body = public.json()
    public_link = await client.post(
        f"/v1/channels/{public_body['id']}/agent-links",
        json={"agent_id": str(channel_agent.id)},
    )
    assert public_link.status_code == 201, public_link.text

    other_user, other_agent = await _create_user_with_channel_agent(
        db_session,
        label="agent-links-other-user",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        other_user_link = await other_client.post(
            f"/v1/channels/{public_body['id']}/agent-links",
            json={"agent_id": str(other_agent.id)},
        )
        other_user_listing = await other_client.get(
            "/v1/channels/agent-links",
            params={"agent_id": str(channel_agent.id)},
        )
    assert other_user_link.status_code == 201, other_user_link.text

    db_session.add_all(
        [
            ChannelBinding(
                account_id=UUID(private["id"]),
                bot_agent_link_id=UUID(private["agent_link_id"]),
                user_id=seed_user.id,
                external_chat_id="agent-links-private-active",
                status=BINDING_STATUS_ACTIVE,
            ),
            ChannelBinding(
                account_id=UUID(public_body["id"]),
                bot_agent_link_id=UUID(public_link.json()["id"]),
                user_id=seed_user.id,
                external_chat_id="agent-links-public-active",
                status=BINDING_STATUS_ACTIVE,
            ),
            ChannelBinding(
                account_id=UUID(public_body["id"]),
                bot_agent_link_id=UUID(public_link.json()["id"]),
                user_id=seed_user.id,
                external_chat_id="agent-links-public-archived",
                status=BINDING_STATUS_ARCHIVED,
            ),
            ChannelBinding(
                account_id=UUID(public_body["id"]),
                bot_agent_link_id=UUID(other_user_link.json()["id"]),
                user_id=other_user.id,
                external_chat_id="agent-links-other-user-active",
                status=BINDING_STATUS_ACTIVE,
            ),
        ]
    )
    await db_session.commit()

    select_count = 0

    def count_selects(_conn, _cursor, statement, _parameters, _context, _executemany):
        nonlocal select_count
        if statement.lstrip().upper().startswith("SELECT"):
            select_count += 1

    sqlalchemy_event.listen(engine.sync_engine, "before_cursor_execute", count_selects)
    try:
        listed = await client.get(
            "/v1/channels/agent-links",
            params={"agent_id": str(channel_agent.id)},
        )
    finally:
        sqlalchemy_event.remove(engine.sync_engine, "before_cursor_execute", count_selects)

    assert listed.status_code == 200, listed.text
    body = listed.json()
    by_account_id = {item["account_id"]: item for item in body}
    assert set(by_account_id) == {private["id"], public_body["id"]}
    private_item = by_account_id[private["id"]]
    public_item = by_account_id[public_body["id"]]
    assert private_item["id"] == private["agent_link_id"]
    assert private_item["agent_id"] == str(channel_agent.id)
    assert private_item["status"] == "active"
    assert private_item["runtime_status"] == "connecting"
    assert private_item["agent_token"] is None
    assert private_item["account"]["id"] == private["id"]
    assert private_item["account"]["name"] == private["name"]
    assert private_item["account"]["visibility"] == "private"
    assert private_item["binding_count"] == 1
    assert public_item["id"] == public_link.json()["id"]
    assert public_item["account"]["id"] == public_body["id"]
    assert public_item["account"]["visibility"] == "public"
    assert public_item["binding_count"] == 1
    assert other_private["id"] not in by_account_id
    assert other_user_listing.status_code == 404
    # Constant query budget: base listing queries plus one batched connection-issue lookup.
    assert select_count == 4


@pytest.mark.asyncio
async def test_public_bot_account_is_admin_managed_even_for_seed_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"username": "ClawdiPublicBoundaryBot"}})
    monkeypatch.setattr(settings, "public_api_url", "https://cloud.example.test")
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"public-owned-boundary-{uuid4().hex}",
        provider_token="123456:telegram-secret",
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]

    _FakeProviderClient.calls = []

    sync = await client.post(f"/v1/channels/{account_id}/commands/sync", json={})
    delete = await client.delete(f"/v1/channels/{account_id}")
    link = await client.post(
        f"/v1/channels/{account_id}/agent-links",
        json={"agent_id": str(channel_agent.id)},
    )
    pair = await client.post(
        f"/v1/channels/{account_id}/pair-codes",
        json={"agent_id": str(channel_agent.id), "ttl_seconds": 900},
    )

    assert sync.status_code == 404
    assert delete.status_code == 404
    assert link.status_code == 201
    assert link.json()["agent_id"] == str(channel_agent.id)
    assert pair.status_code == 201
    assert pair.json()["agent_id"] == str(channel_agent.id)
    assert len(_FakeProviderClient.calls) == 1
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/setMyCommands")
    assert _FakeProviderClient.calls[0]["json"]["commands"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
        {"command": "clawdi_help", "description": "Show safe Clawdi pairing instructions."},
    ]
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(account_id))
        )
    ).scalar_one()
    assert account.archived_at is None
    assert account.visibility == "public"


@pytest.mark.asyncio
async def test_explicit_link_channel_reference_uses_public_link_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"public-reference-owner-{uuid4().hex}",
    )
    assert created.status_code == 201, created.text
    account_id = UUID(created.json()["id"])
    link_user, link_agent = await _create_user_with_channel_agent(
        db_session,
        label="public-reference-link",
    )
    async with _client_for_user(db_session, link_user) as link_client:
        linked = await link_client.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(link_agent.id)},
        )
    assert linked.status_code == 201, linked.text
    link_id = UUID(linked.json()["id"])
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    assert account.user_id is None

    reference = await channel_service.record_channel_agent_reference(
        db_session,
        account=account,
        bot_agent_link_id=link_id,
        ref_kind="test_public_link_reference",
        ref_value="public-link-file",
    )
    await db_session.commit()

    assert reference.user_id == link_user.id
    assert reference.bot_agent_link_id == link_id

    reference.user_id = seed_user.id
    await db_session.commit()
    repaired_reference = await channel_service.record_channel_agent_reference(
        db_session,
        account=account,
        bot_agent_link_id=link_id,
        ref_kind="test_public_link_reference",
        ref_value="public-link-file",
    )
    await db_session.commit()

    assert repaired_reference.id == reference.id
    assert repaired_reference.user_id == link_user.id


@pytest.mark.asyncio
async def test_explicit_cross_account_link_reference_is_rejected(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    first = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"reference-account-first-{uuid4().hex}",
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    second = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"reference-account-second-{uuid4().hex}",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(first["id"]))
    assert account is not None

    with pytest.raises(
        ValueError,
        match="bot agent link does not belong to channel account",
    ):
        await channel_service.record_channel_agent_reference(
            db_session,
            account=account,
            bot_agent_link_id=UUID(second["agent_link_id"]),
            ref_kind="test_cross_account_reference",
            ref_value="foreign-link-file",
        )


@pytest.mark.asyncio
async def test_channel_reference_context_rejects_mismatched_links(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    account, links = await _create_public_channel_with_links(
        client,
        db_session,
        seed_user,
        label="reference-context",
    )
    first_link, second_link = links
    first_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=first_link.id,
        user_id=first_link.user_id,
        external_chat_id="reference-context-first",
        status=BINDING_STATUS_ACTIVE,
    )
    second_message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=second_link.id,
        user_id=second_link.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id="reference-context-second",
        payload={},
    )
    db_session.add_all([first_binding, second_message])
    await db_session.commit()

    contexts = (
        {"binding": first_binding, "message": second_message},
        {"binding": first_binding, "bot_agent_link_id": second_link.id},
        {"message": second_message, "bot_agent_link_id": first_link.id},
    )
    for context in contexts:
        with pytest.raises(
            ValueError,
            match="channel reference link context does not match",
        ):
            await channel_service.record_channel_agent_reference(
                db_session,
                account=account,
                ref_kind="test_mismatched_reference_context",
                ref_value="mismatched-reference",
                **context,
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("use_link", [True, False], ids=["link-scoped", "unlinked"])
async def test_concurrent_channel_reference_recording_converges(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    use_link: bool,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"concurrent-reference-{use_link}-{uuid4().hex}",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    link_id = UUID(created["agent_link_id"]) if use_link else None
    ref_kind = f"test_concurrent_reference_{use_link}"
    ref_value = "same-reference"
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    start = asyncio.Event()
    ready_count = 0

    async def record() -> UUID:
        nonlocal ready_count
        async with sessionmaker() as session:
            account = await session.get(ChannelAccount, account_id)
            assert account is not None
            ready_count += 1
            if ready_count == 2:
                start.set()
            await start.wait()
            reference = await channel_service.record_channel_agent_reference(
                session,
                account=account,
                bot_agent_link_id=link_id,
                ref_kind=ref_kind,
                ref_value=ref_value,
            )
            await session.commit()
            return reference.id

    reference_ids = await asyncio.gather(record(), record())
    references = list(
        (
            await db_session.execute(
                select(ChannelAgentReference).where(
                    ChannelAgentReference.account_id == account_id,
                    ChannelAgentReference.bot_agent_link_id == link_id,
                    ChannelAgentReference.ref_kind == ref_kind,
                    ChannelAgentReference.ref_value == ref_value,
                )
            )
        ).scalars()
    )

    assert reference_ids[0] == reference_ids[1]
    assert len(references) == 1


@pytest.mark.asyncio
async def test_hard_deleted_links_preserve_duplicate_unlinked_reference_history(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    account, links = await _create_public_channel_with_links(
        client,
        db_session,
        seed_user,
        label="reference-link-deletion",
    )
    references = [
        await channel_service.record_channel_agent_reference(
            db_session,
            account=account,
            bot_agent_link_id=link.id,
            ref_kind="test_link_deletion_reference",
            ref_value="shared-reference",
        )
        for link in links
    ]
    await db_session.commit()
    reference_ids = {reference.id for reference in references}

    for link in links:
        await db_session.delete(link)
    await db_session.commit()
    db_session.expire_all()

    preserved = list(
        (
            await db_session.execute(
                select(ChannelAgentReference).where(
                    ChannelAgentReference.id.in_(reference_ids),
                )
            )
        ).scalars()
    )
    assert {reference.id for reference in preserved} == reference_ids
    assert all(reference.bot_agent_link_id is None for reference in preserved)


@pytest.mark.asyncio
async def test_existing_duplicate_unlinked_references_are_read_and_updated_deterministically(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"duplicate-unlinked-reference-{uuid4().hex}",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    older = ChannelAgentReference(
        account_id=account.id,
        user_id=account.user_id,
        provider=account.provider,
        ref_kind="test_duplicate_unlinked_reference",
        ref_value="duplicate-reference",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    newer = ChannelAgentReference(
        account_id=account.id,
        user_id=account.user_id,
        provider=account.provider,
        ref_kind="test_duplicate_unlinked_reference",
        ref_value="duplicate-reference",
        created_at=datetime(2026, 1, 2, tzinfo=UTC),
        updated_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    db_session.add_all([older, newer])
    await db_session.commit()

    assert await channel_service.channel_agent_reference_exists(
        db_session,
        account=account,
        ref_kind="test_duplicate_unlinked_reference",
        ref_value="duplicate-reference",
    )
    selected = await channel_service.get_channel_agent_reference(
        db_session,
        account=account,
        ref_kind="test_duplicate_unlinked_reference",
        ref_value="duplicate-reference",
    )
    assert selected is not None
    assert selected.id == newer.id
    assert (
        await channel_service.get_channel_agent_reference(
            db_session,
            account=account,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            ref_kind="test_duplicate_unlinked_reference",
            ref_value="duplicate-reference",
        )
        is None
    )

    canonical = await channel_service.record_channel_agent_reference(
        db_session,
        account=account,
        ref_kind="test_duplicate_unlinked_reference",
        ref_value="duplicate-reference",
        metadata={"canonical": True},
    )
    await db_session.commit()
    preserved = list(
        (
            await db_session.execute(
                select(ChannelAgentReference).where(
                    ChannelAgentReference.account_id == account.id,
                    ChannelAgentReference.bot_agent_link_id.is_(None),
                    ChannelAgentReference.ref_kind == "test_duplicate_unlinked_reference",
                    ChannelAgentReference.ref_value == "duplicate-reference",
                )
            )
        ).scalars()
    )

    assert canonical.id == newer.id
    assert len(preserved) == 2
    assert older.metadata_ is None
    assert newer.metadata_ == {"canonical": True}


@pytest.mark.asyncio
async def test_public_preset_channel_links_and_bindings_are_user_scoped(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"public-telegram-{uuid4().hex}",
    )
    assert created.status_code == 201, created.text
    admin_body = created.json()
    account_id = UUID(admin_body["id"])
    public_secret = admin_body["webhook_secret"]

    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="public-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="public-b")

    async with _client_for_user(db_session, user_a) as client_a:
        listed = await client_a.get("/v1/channels")
        assert listed.status_code == 200
        assert all(item["id"] != str(account_id) for item in listed.json())

        pool = await client_a.get("/v1/channels/bot-pool")
        assert pool.status_code == 200
        public_item = next(
            item for item in pool.json()["providers"]["telegram"] if item["id"] == str(account_id)
        )
        assert public_item["visibility"] == "public"
        assert public_item["access"] == "public"

        pair = await client_a.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"agent_id": str(agent_a.id), "ttl_seconds": 900},
        )
        assert pair.status_code == 201
        pair_body = pair.json()

    pair_webhook = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": public_secret},
        json={
            "update_id": 7001,
            "message": {
                "message_id": 7001,
                "text": f"/clawdi_pair {pair_body['code']}",
                "chat": {"id": 99001, "type": "private", "first_name": "A"},
            },
        },
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": public_secret},
        json={
            "update_id": 7002,
            "message": {
                "message_id": 7002,
                "text": "hello public bot",
                "chat": {"id": 99001, "type": "private", "first_name": "A"},
            },
        },
    )
    assert pair_webhook.status_code == 200
    assert pair_webhook.json()["paired"] is True
    assert inbound.status_code == 200

    link = (
        await db_session.execute(
            select(ChannelBotAgentLink).where(
                ChannelBotAgentLink.id == UUID(pair_body["agent_link_id"])
            )
        )
    ).scalar_one()
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.external_chat_id == "99001",
            )
        )
    ).scalar_one()
    message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.provider_message_id == "7002",
            )
        )
    ).scalar_one()
    assert link.user_id == user_a.id
    assert binding.user_id == user_a.id
    assert message.user_id == user_a.id

    async with _client_for_user(db_session, user_b) as client_b:
        fetched = await client_b.get(f"/v1/channels/{account_id}")
        assert fetched.status_code == 200
        assert fetched.json()["visibility"] == "public"

        links = await client_b.get(f"/v1/channels/{account_id}/agent-links")
        bindings = await client_b.get(f"/v1/channels/{account_id}/bindings")
        rotate = await client_b.post(
            f"/v1/channels/{account_id}/agent-links/{link.id}/token",
        )
        send_unowned = await client_b.post(
            f"/v1/channels/{account_id}/messages",
            json={"external_chat_id": "99001", "text": "wrong user"},
        )
        own_link = await client_b.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent_b.id)},
        )

    assert links.status_code == 200
    assert links.json() == []
    assert bindings.status_code == 200
    assert bindings.json() == []
    assert rotate.status_code == 404
    assert send_unowned.status_code == 403
    assert own_link.status_code == 201
    assert own_link.json()["agent_id"] == str(agent_b.id)


@pytest.mark.asyncio
async def test_control_plane_list_hides_historical_credentials_and_unlink_revokes_them(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    seeded_account = await _seed_historical_platform_whatsapp_account(
        db_session,
        name=f"runtime-whatsapp-{uuid4().hex}",
    )
    account_id = str(seeded_account.id)
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="runtime-wa-creds",
        agent_type="claude_code",
        hosted=False,
    )
    link, _token = await _seed_existing_channel_link(
        db_session,
        account_id=account_id,
        agent=agent,
    )
    account = await db_session.get(ChannelAccount, UUID(account_id))
    assert account is not None
    # Seed historical persisted state without reopening tenant-credential admission.
    await load_or_create_whatsapp_auth_cert(db_session, account=account)
    first = await mint_whatsapp_agent_credential(
        db_session,
        account=account,
        bot_agent_link_id=link.id,
        user_id=user.id,
        phone_user="15551234567",
    )
    await db_session.commit()
    second = await mint_whatsapp_agent_credential(
        db_session,
        account=account,
        bot_agent_link_id=link.id,
        user_id=user.id,
        phone_user="15557654321",
    )
    await db_session.commit()
    await db_session.refresh(first.credential)
    await db_session.refresh(second.credential)

    async with _client_for_user(db_session, user) as user_client:
        browser_list = await user_client.get("/v1/channels")

    assert browser_list.status_code == 200, browser_list.text
    assert "runtime_credentials" not in browser_list.text
    assert "advSecretKey" not in browser_list.text

    active_credentials = (
        (
            await db_session.execute(
                select(ChannelAgentCredential).where(
                    ChannelAgentCredential.account_id == UUID(account_id),
                    ChannelAgentCredential.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    assert {str(credential.id) for credential in active_credentials} == {
        str(first.credential.id),
        str(second.credential.id),
    }

    async with _client_for_user(db_session, user) as user_client:
        deleted = await user_client.delete(f"/v1/channels/{account_id}/agent-links/{link.id}")
    assert deleted.status_code == 204, deleted.text

    active_credentials_after_unlink = (
        (
            await db_session.execute(
                select(ChannelAgentCredential).where(
                    ChannelAgentCredential.account_id == UUID(account_id),
                    ChannelAgentCredential.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    assert active_credentials_after_unlink == []


@pytest.mark.asyncio
async def test_whatsapp_agent_link_maintains_synthetic_credential_lifecycle(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    runtime_signals: list[tuple[UUID, UUID]] = []

    async def record_runtime_signal(_db, user_id: UUID, environment_id: UUID) -> bool:
        runtime_signals.append((user_id, environment_id))
        return True

    monkeypatch.setattr(
        public_router,
        "queue_environment_runtime_manifest_changed",
        record_runtime_signal,
    )
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="runtime-wa-synthetic",
        agent_type="openclaw",
    )
    async with _client_for_user(db_session, user) as user_client:
        created_response = await user_client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": f"runtime-wa-{uuid4().hex}"},
        )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    async with _client_for_user(db_session, user) as user_client:
        linked = await user_client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(agent.id)},
        )
    assert linked.status_code == 201, linked.text
    assert runtime_signals == [(user.id, agent.id)]
    link = await db_session.get(ChannelBotAgentLink, UUID(linked.json()["id"]))
    assert link is not None
    credential = await db_session.scalar(
        select(ChannelAgentCredential).where(
            ChannelAgentCredential.account_id == UUID(created["id"]),
            ChannelAgentCredential.bot_agent_link_id == link.id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
    )
    assert credential is not None
    credential.revoked_at = datetime.now(UTC)
    await db_session.commit()

    runtime_signals.clear()
    async with _client_for_user(db_session, user) as user_client:
        credential_repaired_pair_code = await user_client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": str(link.id), "ttl_seconds": 900},
        )
    assert credential_repaired_pair_code.status_code == 201, credential_repaired_pair_code.text
    assert runtime_signals == [(user.id, agent.id)]
    repaired_credential = await db_session.scalar(
        select(ChannelAgentCredential).where(
            ChannelAgentCredential.account_id == UUID(created["id"]),
            ChannelAgentCredential.bot_agent_link_id == link.id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
    )
    assert repaired_credential is not None
    repaired_credential_id = repaired_credential.id
    auth_cert = await db_session.scalar(
        select(ChannelWhatsAppAuthCert).where(
            ChannelWhatsAppAuthCert.account_id == UUID(created["id"])
        )
    )
    assert auth_cert is not None
    await db_session.delete(auth_cert)
    await db_session.commit()

    runtime_signals.clear()
    async with _client_for_user(db_session, user) as user_client:
        auth_cert_repaired_pair_code = await user_client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": str(link.id), "ttl_seconds": 900},
        )
    assert auth_cert_repaired_pair_code.status_code == 201, auth_cert_repaired_pair_code.text
    assert runtime_signals == [(user.id, agent.id)]
    active_credential_ids = set(
        await db_session.scalars(
            select(ChannelAgentCredential.id).where(
                ChannelAgentCredential.account_id == UUID(created["id"]),
                ChannelAgentCredential.bot_agent_link_id == link.id,
                ChannelAgentCredential.revoked_at.is_(None),
            )
        )
    )
    assert active_credential_ids == {repaired_credential_id}
    assert (
        await db_session.scalar(
            select(ChannelWhatsAppAuthCert.id).where(
                ChannelWhatsAppAuthCert.account_id == UUID(created["id"])
            )
        )
        is not None
    )

    async with _client_for_user(db_session, user) as user_client:
        browser_list = await user_client.get("/v1/channels")
        public_mint = await user_client.post(
            f"/v1/channels/whatsapp/{created['id']}/tenant-creds",
            json={},
        )
    assert "runtime_credentials" not in browser_list.text
    assert public_mint.status_code == 404

    async with _client_for_user(db_session, user) as user_client:
        deleted = await user_client.delete(f"/v1/channels/{created['id']}/agent-links/{link.id}")
    assert deleted.status_code == 204, deleted.text

    active_after_unlink = await db_session.scalar(
        select(func.count(ChannelAgentCredential.id)).where(
            ChannelAgentCredential.account_id == UUID(created["id"]),
            ChannelAgentCredential.bot_agent_link_id == link.id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
    )
    assert active_after_unlink == 0


@pytest.mark.asyncio
async def test_group_pairing_can_only_be_changed_by_pairing_actor(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    real_httpx_async_client = httpx.AsyncClient
    _reset_fake_provider_client({"ok": True, "result": {"username": "ClawdiPublicGroupBot"}})
    with monkeypatch.context() as provider_mock:
        provider_mock.setattr(settings, "public_api_url", "https://cloud.example.test")
        provider_mock.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
        created = await _create_admin_channel(
            client,
            target_clerk_id=seed_user.clerk_id,
            provider="telegram",
            name=f"public-group-telegram-{uuid4().hex}",
            provider_token="123456:telegram-secret",
        )
    assert created.status_code == 201, created.text
    channel = created.json()
    account_id = UUID(channel["id"])
    webhook_secret = channel["webhook_secret"]
    _reset_fake_provider_client({"ok": True, "result": True})

    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="pair-owner-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="pair-owner-b")

    async with _client_for_user(db_session, user_a) as client_a:
        with monkeypatch.context() as provider_mock:
            provider_mock.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
            pair_a = await client_a.post(
                f"/v1/channels/{account_id}/pair-codes",
                json={"agent_id": str(agent_a.id), "ttl_seconds": 900},
            )
        pair_a_again = await client_a.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"agent_id": str(agent_a.id), "ttl_seconds": 900},
        )
    assert pair_a.status_code == 201
    assert pair_a_again.status_code == 201

    async with _client_for_user(db_session, user_b) as client_b:
        pair_b = await client_b.post(
            f"/v1/channels/{account_id}/pair-codes",
            json={"agent_id": str(agent_b.id), "ttl_seconds": 900},
        )
    assert pair_b.status_code == 201

    _reset_fake_provider_client({"ok": True, "result": {"message_id": 8100}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)

    def group_command(message_id: int, text: str, actor_id: int) -> dict[str, Any]:
        return {
            "update_id": message_id,
            "message": {
                "message_id": message_id,
                "from": {"id": actor_id, "is_bot": False, "first_name": f"U{actor_id}"},
                "text": text,
                "chat": {"id": -99002, "type": "supergroup", "title": "Ops"},
            },
        }

    paired_a = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8101, f"/clawdi_pair {pair_a.json()['code']}", 1111),
    )
    assert paired_a.status_code == 200
    assert paired_a.json()["paired"] is True

    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.external_chat_id == "-99002",
                ChannelBinding.status == "active",
            )
        )
    ).scalar_one()
    assert binding.user_id == user_a.id
    assert binding.paired_external_user_id == "1111"

    bob_unpair = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8102, "/clawdi_unpair", 2222),
    )
    assert bob_unpair.status_code == 200
    assert bob_unpair.json()["unpaired"] is False
    await db_session.refresh(binding)
    assert binding.status == "active"
    assert binding.user_id == user_a.id
    bob_unpair_reply = (
        await db_session.execute(
            select(ChannelMessage)
            .where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                ChannelMessage.text == "Only the user who paired this chat can change its pairing.",
            )
            .order_by(ChannelMessage.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    assert bob_unpair_reply is None

    bob_takeover = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8103, f"/clawdi_pair {pair_b.json()['code']}", 2222),
    )
    assert bob_takeover.status_code == 200
    assert bob_takeover.json()["paired"] is False
    await db_session.refresh(binding)
    assert binding.status == "active"
    assert binding.user_id == user_a.id
    bob_takeover_reply = (
        await db_session.execute(
            select(ChannelMessage)
            .where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
                ChannelMessage.text == "Only the user who paired this chat can change its pairing.",
            )
            .order_by(ChannelMessage.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    assert bob_takeover_reply is None

    pair_code_b = (
        await db_session.execute(
            select(ChannelPairCode).where(ChannelPairCode.id == UUID(pair_b.json()["id"]))
        )
    ).scalar_one()
    assert pair_code_b.status == "pending"
    assert pair_code_b.claimed_external_chat_id is None
    assert pair_code_b.claimed_external_user_id is None

    alice_unpair = await client.post(
        f"/v1/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8104, "/clawdi_unpair", 1111),
    )
    assert alice_unpair.status_code == 200
    assert alice_unpair.json()["unpaired"] is True
    await db_session.refresh(binding)
    assert binding.status == "archived"

    session_factory = async_sessionmaker(db_session.bind, expire_on_commit=False)
    previous_session_override = app.dependency_overrides[get_session]

    async def concurrent_session_override():
        async with session_factory() as request_session:
            yield request_session

    app.dependency_overrides[get_session] = concurrent_session_override
    try:
        async with real_httpx_async_client(
            transport=client._transport,
            base_url=str(client.base_url),
        ) as concurrent:
            claim_a, claim_b = await asyncio.gather(
                concurrent.post(
                    f"/v1/channels/telegram/{account_id}/webhook",
                    headers={"x-telegram-bot-api-secret-token": webhook_secret},
                    json=group_command(8105, f"/clawdi_pair {pair_a_again.json()['code']}", 1111),
                ),
                concurrent.post(
                    f"/v1/channels/telegram/{account_id}/webhook",
                    headers={"x-telegram-bot-api-secret-token": webhook_secret},
                    json=group_command(8106, f"/clawdi_pair {pair_b.json()['code']}", 2222),
                ),
            )
    finally:
        app.dependency_overrides[get_session] = previous_session_override
    assert claim_a.status_code == 200
    assert claim_b.status_code == 200
    assert sorted([claim_a.json()["paired"], claim_b.json()["paired"]]) == [False, True]

    active_binding = (
        await db_session.execute(
            select(ChannelBinding)
            .where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.external_chat_id == "-99002",
                ChannelBinding.status == "active",
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    pair_code_a_again = await db_session.get(
        ChannelPairCode,
        UUID(pair_a_again.json()["id"]),
        populate_existing=True,
    )
    await db_session.refresh(pair_code_b)
    assert pair_code_a_again is not None
    claimed_codes = [code for code in (pair_code_a_again, pair_code_b) if code.status == "claimed"]
    assert len(claimed_codes) == 1
    assert {pair_code_a_again.status, pair_code_b.status} == {"claimed", "pending"}
    winner = claimed_codes[0]
    assert winner.claimed_external_chat_id == "-99002"
    assert winner.claimed_external_user_id in {"1111", "2222"}
    assert active_binding.paired_external_user_id == winner.claimed_external_user_id
    assert active_binding.user_id == (
        user_a.id if winner.claimed_external_user_id == "1111" else user_b.id
    )


@pytest.mark.asyncio
async def test_group_pairing_requires_external_actor(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-group-missing-actor"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 8201,
            "message": {
                "message_id": 8201,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": -99003, "type": "supergroup", "title": "Ops"},
            },
        },
    )
    assert paired.status_code == 200
    assert paired.json()["paired"] is False

    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []
    pair_code = (
        await db_session.execute(
            select(ChannelPairCode).where(ChannelPairCode.id == UUID(pair["id"]))
        )
    ).scalar_one()
    assert pair_code.status == "pending"
    assert pair_code.claimed_external_chat_id is None
    assert pair_code.claimed_external_user_id is None


@pytest.mark.asyncio
async def test_pair_code_binding_race_returns_controlled_failure(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"telegram-race-{uuid4().hex}"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    async def _raise_integrity_error(*_args, **_kwargs):
        raise IntegrityError("insert channel binding", {}, Exception("unique active binding"))

    monkeypatch.setattr(channel_service, "get_or_create_binding", _raise_integrity_error)

    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is False
    assert paired.json()["binding_id"] is None
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []
    pair_code = (
        await db_session.execute(
            select(ChannelPairCode).where(ChannelPairCode.id == UUID(pair["id"]))
        )
    ).scalar_one()
    assert pair_code.status == "pending"
    assert pair_code.claimed_external_chat_id is None


@pytest.mark.asyncio
async def test_channel_send_uses_current_chat_route_after_repair(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    created, _workspace_pair, chat_id = await _paired_telegram_shared_chat(
        client,
        channel_agent,
        second_channel_agent,
    )
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()

    by_chat = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": chat_id, "text": "by-chat"},
    )
    explicit = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"binding_id": bindings[0]["id"], "text": "explicit"},
    )

    assert by_chat.status_code == 201
    assert by_chat.json()["external_chat_id"] == chat_id
    assert explicit.status_code == 201
    assert explicit.json()["external_chat_id"] == chat_id


@pytest.mark.asyncio
async def test_provider_send_rejects_existing_private_config_url(monkeypatch):
    _reset_fake_provider_client()
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _FakeProviderClient,
    )
    ciphertext, nonce = encrypt_optional_token("discord-token")
    account = ChannelAccount(
        provider="discord",
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        config={"api_base_url": "https://127.0.0.1/api/v10"},
    )

    with pytest.raises(HTTPException) as exc:
        await send_provider_outbound_payload(
            account=account,
            external_chat_id="123",
            text="blocked",
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "discord provider url must be a public https URL"
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider", "response_payload"),
    [
        ("discord", {}),
        ("telegram", {"ok": True, "result": {}}),
    ],
)
async def test_provider_send_rejects_success_without_provider_message_id(
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
    response_payload: dict[str, object],
) -> None:
    real_client = httpx.AsyncClient

    def provider_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response_payload)

    def client_factory(*_args: object, **_kwargs: object) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(provider_handler))

    async def allow_test_url(_url: str, *, label: str) -> None:
        expected_label = (
            "discord api base url" if provider == "discord" else "telegram provider url"
        )
        assert label == expected_label

    monkeypatch.setattr(channel_service.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(channel_service, "validate_channel_http_url", allow_test_url)
    ciphertext, nonce = encrypt_optional_token("provider-token")
    account = ChannelAccount(
        provider=provider,
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
    )

    with pytest.raises(HTTPException) as exc_info:
        await send_provider_outbound_payload(
            account=account,
            external_chat_id="123",
            text="hello",
        )

    assert exc_info.value.status_code == 502
    assert "provider-token" not in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_channel_command_sync_url_error_does_not_leak_validator_detail(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-sensitive-service-url-error"},
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    ciphertext, nonce = encrypt_optional_token("telegram-provider-token")
    account.encrypted_provider_token = ciphertext
    account.provider_token_nonce = nonce
    await db_session.commit()
    marker = "10.0.0.9 postgresql://user:password@db.internal/app"

    async def reject_sensitive_url(_url: str, *, label: str) -> None:
        assert label == "telegram api base url"
        raise UnsafeOutboundUrlError(marker)

    monkeypatch.setattr(channel_service, "validate_channel_http_url", reject_sensitive_url)

    response = await client.post(f"/v1/channels/{created['id']}/commands/sync", json={})

    assert response.status_code == 400
    assert response.json() == {"detail": "telegram provider url must be a public https URL"}
    assert marker not in response.text


@pytest.mark.asyncio
async def test_shared_account_runtime_placeholder_authenticates_each_link_token(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-shared-runtime-auth",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    sdk_path = _telegram_bot_path(created, "getMe")

    first_auth = await client.post(sdk_path, headers=_telegram_agent_headers(created), json={})
    second_auth = await client.post(sdk_path, headers=_telegram_agent_headers(second), json={})

    assert first_auth.status_code == 200
    assert second_auth.status_code == 200
    assert first_auth.json()["ok"] is True
    assert second_auth.json()["ok"] is True


@pytest.mark.asyncio
async def test_channel_request_parsing_rejects_malformed_json_and_non_object_body(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-request-parse",
        chat_id="42",
        provider_token=None,
    )

    malformed = await client.post(
        _telegram_bot_path(created, "getMe"),
        headers=_telegram_agent_headers(created, {"content-type": "application/json"}),
        content=b"{",
    )
    non_object = await client.post(
        _telegram_bot_path(created, "getMe"),
        headers=_telegram_agent_headers(created),
        json=[],
    )

    assert malformed.status_code == 400
    assert malformed.json()["detail"] == "invalid json"
    assert non_object.status_code == 400
    assert non_object.json()["detail"] == "json object required"


@pytest.mark.asyncio
async def test_channel_request_parsing_accepts_query_boolean_wire_values(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-form-parse",
        chat_id="42",
        provider_token=None,
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "queued",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/webhook"},
    )

    deleted = await client.get(
        _telegram_bot_path(created, "deleteWebhook"),
        headers=_telegram_agent_headers(created),
        params={"drop_pending_updates": "true"},
    )
    updates = await client.get(
        _telegram_bot_path(created, "getUpdates"), headers=_telegram_agent_headers(created)
    )

    assert deleted.status_code == 200
    assert updates.json() == {"ok": True, "result": []}


@pytest.mark.asyncio
async def test_legacy_channel_router_root_routes_are_absent(client: httpx.AsyncClient):
    checks = [
        ("POST", "/bot123456:token/getMe"),
        ("GET", "/api/v10/gateway/bot"),
        ("GET", "/api/v1/server/info"),
        ("GET", "/channels/telegram"),
        ("GET", "/socket.io/"),
        ("GET", "/media/file.jpg"),
        ("POST", "/api/channels/migrations/legacy-router/import-tenant"),
    ]

    for method, path in checks:
        response = await client.request(method, path)
        assert response.status_code == 404, path


@pytest.mark.asyncio
async def test_channel_bindings_include_binding_scoped_last_message_at(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "binding-activity"},
        )
    ).json()
    account_id = UUID(created["id"])
    agent_link_id = UUID(created["agent_link_id"])
    active_binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=agent_link_id,
        user_id=seed_user.id,
        external_chat_id="active-chat",
        external_chat_type="private",
        external_chat_name="Active chat",
    )
    quiet_binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=agent_link_id,
        user_id=seed_user.id,
        external_chat_id="quiet-chat",
        external_chat_type="private",
        external_chat_name="Quiet chat",
    )
    db_session.add_all([active_binding, quiet_binding])
    await db_session.flush()
    earlier = datetime(2026, 7, 30, 9, 0, tzinfo=UTC)
    latest = datetime(2026, 7, 30, 10, 0, tzinfo=UTC)
    db_session.add_all(
        [
            ChannelMessage(
                account_id=account_id,
                bot_agent_link_id=agent_link_id,
                binding_id=active_binding.id,
                user_id=seed_user.id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=active_binding.external_chat_id,
                text="earlier bound message",
                created_at=earlier,
            ),
            ChannelMessage(
                account_id=account_id,
                bot_agent_link_id=agent_link_id,
                binding_id=active_binding.id,
                user_id=seed_user.id,
                direction=MESSAGE_DIRECTION_OUTBOUND,
                external_chat_id=active_binding.external_chat_id,
                text="latest bound message",
                created_at=latest,
            ),
            ChannelMessage(
                account_id=account_id,
                bot_agent_link_id=agent_link_id,
                user_id=seed_user.id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=quiet_binding.external_chat_id,
                text="newer unbound account message",
                created_at=latest + timedelta(hours=1),
            ),
        ]
    )
    await db_session.commit()

    response = await client.get(f"/v1/channels/{created['id']}/bindings")

    assert response.status_code == 200, response.text
    bindings = {item["external_chat_id"]: item for item in response.json()}
    assert datetime.fromisoformat(bindings["active-chat"]["last_message_at"]) == latest
    assert bindings["quiet-chat"]["last_message_at"] is None


@pytest.mark.asyncio
async def test_whatsapp_pair_code_returns_click_to_chat_for_bound_public_managed_pn(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created, link = await _create_whatsapp_pair_target(client, agent_id=channel_agent.id)
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    account.user_id = None
    account.config = {
        "connection_mode": "baileys_managed",
        "sidecar_config_revision": "trusted-managed-revision",
    }
    await db_session.commit()
    sidecar = _WhatsAppPairLinkSidecar(
        WhatsAppSidecarHealth(
            status="connected",
            connected=True,
            registered=True,
            account_jid="15551234567:17@s.whatsapp.net",
        )
    )
    registry = _WhatsAppPairLinkRegistry(account_id=account.id, client=sidecar)
    monkeypatch.setattr(public_router, "get_active_whatsapp_sidecar_clients", lambda: registry)

    response = await client.post(
        f"/v1/channels/{account.id}/pair-codes",
        json={"agent_link_id": link["id"], "ttl_seconds": 900},
    )

    assert response.status_code == 201, response.text
    pair = response.json()
    expected = f"https://wa.me/15551234567?text=%2Fclawdi_pair%20{pair['code']}"
    assert pair["pairing_command"] == f"/clawdi_pair {pair['code']}"
    assert pair["deep_link"] == expected
    assert pair["qr_payload"] == expected
    assert sidecar.health_calls == 1
    assert "s.whatsapp.net" not in response.text


@pytest.mark.asyncio
async def test_whatsapp_pair_code_uses_durable_phone_when_sidecar_is_unavailable(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created, link = await _create_whatsapp_pair_target(client, agent_id=channel_agent.id)
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    account.user_id = None
    account.config = {
        "connection_mode": "baileys_managed",
        "sidecar_config_revision": "trusted-managed-revision",
        "phone_number": "15551234567",
    }
    await db_session.commit()
    sidecar = _WhatsAppPairLinkSidecar(WhatsAppSidecarUnavailableError("unavailable"))
    registry = _WhatsAppPairLinkRegistry(account_id=account.id, client=sidecar)
    monkeypatch.setattr(public_router, "get_active_whatsapp_sidecar_clients", lambda: registry)

    response = await client.post(
        f"/v1/channels/{account.id}/pair-codes",
        json={"agent_link_id": link["id"], "ttl_seconds": 900},
    )

    assert response.status_code == 201, response.text
    pair = response.json()
    expected = f"https://wa.me/15551234567?text=%2Fclawdi_pair%20{pair['code']}"
    assert pair["deep_link"] == expected
    assert pair["qr_payload"] == expected
    assert pair["pairing_command"] == f"/clawdi_pair {pair['code']}"
    assert sidecar.health_calls == 0


@pytest.mark.asyncio
async def test_whatsapp_pair_code_never_links_to_a_private_custom_identity(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created, link = await _create_whatsapp_pair_target(client, agent_id=channel_agent.id)
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.config = {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": str(account.id),
        "sidecar_config_revision": "trusted-managed-revision",
    }
    await db_session.commit()
    sidecar = _WhatsAppPairLinkSidecar(
        WhatsAppSidecarHealth(
            status="connected",
            connected=True,
            registered=True,
            account_jid="15559876543@s.whatsapp.net",
            account_lid="900000000000001@lid",
        )
    )
    registry = _WhatsAppPairLinkRegistry(account_id=account.id, client=sidecar)
    monkeypatch.setattr(public_router, "get_active_whatsapp_sidecar_clients", lambda: registry)

    response = await client.post(
        f"/v1/channels/{account.id}/pair-codes",
        json={"agent_link_id": link["id"], "ttl_seconds": 900},
    )

    assert response.status_code == 201, response.text
    pair = response.json()
    assert pair["deep_link"] is None
    assert pair["qr_payload"] is None
    assert sidecar.health_calls == 1


def test_parse_channel_control_command_matches_strict_canonical_shapes():
    assert parse_channel_control_command("/clawdi_pair ABCDEF1234").code == "ABCDEF1234"
    assert parse_channel_control_command("/clawdi_pair@shared_bot ABC123").code == "ABC123"
    assert parse_channel_control_command("/clawdi_pair ABC123 thanks").code == ""
    assert parse_channel_control_command("/clawdi_pair ABC123\n•").code == ""
    assert parse_channel_control_command("/clawdi_pair").code == ""
    assert parse_channel_control_command("/clawdi_unpair").kind == "unpair"
    assert parse_channel_control_command("/clawdi_unpair@shared_bot").kind == "unpair"
    assert parse_channel_control_command("/clawdi_unpair now").kind == "unknown"
    assert parse_channel_control_command("/clawdi_help").kind == "help"
    assert parse_channel_control_command("/clawdi_help@shared_bot").kind == "help"
    assert parse_channel_control_command("/clawdi_help now").kind == "unknown"
    assert parse_channel_control_command("/start BCDFGHJKLM").code == "BCDFGHJKLM"
    assert parse_channel_control_command("/start@shared_bot BCDFGHJKLM").code == "BCDFGHJKLM"
    # Pending codes issued before the shorter-code rollout remain claimable
    # through Telegram deep links until their stored expiry.
    assert parse_channel_control_command("/start PAIRABCDEF1234").code == "PAIRABCDEF1234"
    assert parse_channel_control_command("/start PAIRABCDEF1234 thanks") is None
    assert parse_channel_control_command("/start OLD_PAIR_CODE") is None
    assert parse_channel_control_command("/start") is None
    assert parse_channel_control_command("hello world") is None

    unknown = parse_channel_control_command("/clawdi_foo bar")
    assert unknown is not None
    assert unknown.kind == "unknown"
    assert unknown.command == "/clawdi_foo"


def test_channel_control_help_reply_is_shared_safe_plain_text(monkeypatch):
    monkeypatch.setattr(channel_service.settings, "web_origin", "https://console.example.test/")
    expected = (
        "To connect this chat to an agent:\n"
        "1. Open https://console.example.test.\n"
        "2. Choose your agent, open Channels, and select Pair.\n"
        "3. Send /clawdi_pair <code> here.\n\n"
        "To disconnect this chat, send /clawdi_unpair."
    )
    command = channel_service.ChannelControlCommand(kind="help")
    result = channel_service.InboundBindingResult(binding=None, command_handled=True)

    assert channel_service.channel_control_help_reply() == expected
    assert channel_service.pairing_reply_for_command(command, result) == expected
    assert discord_control_reply_for_command(command, result, guild_id=None) == expected
    assert discord_control_reply_for_command(command, result, guild_id="guild") == expected


@pytest.mark.parametrize(
    "text",
    [
        "/bot_pair BCDFGHJKLM",
        "/bot_pair@shared_bot BCDFGHJKLM",
        "/bot_unpair",
        "/bot_unpair@shared_bot",
    ],
)
def test_parse_channel_control_command_rejects_legacy_aliases(text: str):
    assert parse_channel_control_command(text) is None


def test_generate_pair_code_uses_unambiguous_50_bit_shape_and_varies():
    codes = {generate_pair_code() for _ in range(32)}

    assert len(codes) == 32
    assert all(len(code) == 10 for code in codes)
    assert all(set(code) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for code in codes)


@pytest.mark.asyncio
async def test_pair_code_defaults_to_five_minutes_and_expires_without_claim(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "pair-code-five-minute-default"},
        )
    ).json()
    requested_at = datetime.now(UTC)

    pair_response = await client.post(f"/v1/channels/{created['id']}/pair-codes", json={})

    assert pair_response.status_code == 201, pair_response.text
    pair = pair_response.json()
    expires_at = datetime.fromisoformat(pair["expires_at"])
    assert timedelta(seconds=295) <= expires_at - requested_at <= timedelta(seconds=305)
    pair_row = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert pair_row is not None
    assert account is not None
    pair_row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db_session.commit()

    claim = await channel_service.claim_pair_code(
        db_session,
        account=account,
        raw_code=pair["code"],
        external_chat_id="expired-pair-code-chat",
        external_chat_type="private",
        external_chat_name="Expired",
        external_user_id="expired-pair-code-user",
    )

    assert claim.binding is None
    assert claim.reason == "expired"
    await db_session.refresh(pair_row)
    assert pair_row.status == PAIR_CODE_STATUS_PENDING


@pytest.mark.asyncio
async def test_pair_code_generation_retries_hash_collision_without_aborting_request(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "pair-code-hash-collision"},
        )
    ).json()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    colliding_code = "BCDFGHJKLM"
    replacement_code = "NPQRSTVWXY"
    db_session.add(
        ChannelPairCode(
            account_id=UUID(created["id"]),
            bot_agent_link_id=link.id,
            user_id=link.user_id,
            code_hash=hash_token(colliding_code),
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )
    )
    await db_session.commit()
    generated_codes = iter((colliding_code, replacement_code))
    monkeypatch.setattr(channel_service, "generate_pair_code", lambda: next(generated_codes))

    response = await client.post(f"/v1/channels/{created['id']}/pair-codes", json={})

    assert response.status_code == 201, response.text
    assert response.json()["code"] == replacement_code
    stored_hashes = set(
        (
            await db_session.execute(
                select(ChannelPairCode.code_hash).where(
                    ChannelPairCode.account_id == UUID(created["id"])
                )
            )
        ).scalars()
    )
    assert stored_hashes == {hash_token(colliding_code), hash_token(replacement_code)}


@pytest.mark.asyncio
async def test_pair_code_generation_stops_after_bounded_hash_collisions(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "pair-code-bounded-collision"},
        )
    ).json()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    colliding_code = "BCDFGHJKLM"
    db_session.add(
        ChannelPairCode(
            account_id=UUID(created["id"]),
            bot_agent_link_id=link.id,
            user_id=link.user_id,
            code_hash=hash_token(colliding_code),
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )
    )
    await db_session.commit()
    generation_count = 0

    def colliding_generator() -> str:
        nonlocal generation_count
        generation_count += 1
        return colliding_code

    monkeypatch.setattr(channel_service, "generate_pair_code", colliding_generator)

    response = await client.post(f"/v1/channels/{created['id']}/pair-codes", json={})

    assert response.status_code == 500, response.text
    assert response.json()["detail"] == "could not allocate a unique pair code"
    assert generation_count == channel_service.PAIR_CODE_GENERATION_ATTEMPTS
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ChannelPairCode)
            .where(ChannelPairCode.account_id == UUID(created["id"]))
        )
        == 1
    )


@pytest.mark.asyncio
async def test_pair_code_concurrent_claim_is_single_use(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "pair-code-concurrent-single-use"},
        )
    ).json()
    pair = (await client.post(f"/v1/channels/{created['id']}/pair-codes", json={})).json()
    account_id = UUID(created["id"])
    session_factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def claim(chat_id: str) -> channel_service.PairCodeClaimResult:
        async with session_factory() as claim_db:
            account = await claim_db.get(ChannelAccount, account_id)
            assert account is not None
            result = await channel_service.claim_pair_code(
                claim_db,
                account=account,
                raw_code=pair["code"],
                external_chat_id=chat_id,
                external_chat_type="private",
                external_chat_name=chat_id,
                external_user_id=f"user-{chat_id}",
            )
            await claim_db.commit()
            return result

    first, second = await asyncio.gather(claim("single-use-a"), claim("single-use-b"))

    assert sorted(result.reason or "claimed" for result in (first, second)) == [
        "already_used",
        "claimed",
    ]
    bindings = list(
        (
            await db_session.execute(
                select(ChannelBinding)
                .where(ChannelBinding.account_id == account_id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )
    assert len(bindings) == 1
    pair_row = await db_session.get(ChannelPairCode, UUID(pair["id"]), populate_existing=True)
    assert pair_row is not None
    assert pair_row.status == PAIR_CODE_STATUS_CLAIMED
    assert pair_row.claimed_external_chat_id == bindings[0].external_chat_id


@pytest.mark.asyncio
async def test_pair_code_claim_locks_fence_before_link_and_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "pair-code-runtime-lock-order"},
        )
    ).json()
    pair = (await client.post(f"/v1/channels/{created['id']}/pair-codes", json={})).json()
    account_id = UUID(created["id"])
    pair_code_id = UUID(pair["id"])
    link_id = UUID(created["agent_link_id"])
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    fence_id = link.agent_id

    fence_locked = asyncio.Event()
    release_claim = asyncio.Event()
    original_fence_lock = channel_service._lock_bot_agent_link_runtime_fence

    async def pause_after_fence_lock(*args: Any, **kwargs: Any) -> UUID | None:
        environment_id = await original_fence_lock(*args, **kwargs)
        fence_locked.set()
        await release_claim.wait()
        return environment_id

    monkeypatch.setattr(
        channel_service,
        "_lock_bot_agent_link_runtime_fence",
        pause_after_fence_lock,
    )
    session_factory = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def claim() -> channel_service.PairCodeClaimResult:
        async with session_factory() as claim_db:
            account = await claim_db.get(ChannelAccount, account_id)
            assert account is not None
            result = await channel_service.claim_pair_code(
                claim_db,
                account=account,
                raw_code=pair["code"],
                external_chat_id="runtime-lock-order-chat",
                external_chat_type="private",
                external_chat_name="Runtime lock order",
                external_user_id="runtime-lock-order-user",
            )
            await claim_db.commit()
            return result

    claim_task = asyncio.create_task(claim())
    try:
        await asyncio.wait_for(fence_locked.wait(), timeout=2)
        async with session_factory() as observer:
            with pytest.raises(SQLAlchemyError) as fence_lock_error:
                await observer.scalar(
                    select(V2RuntimeEnvironmentFence)
                    .where(V2RuntimeEnvironmentFence.environment_id == fence_id)
                    .with_for_update(nowait=True)
                )
            assert getattr(fence_lock_error.value.orig, "sqlstate", None) == "55P03"
            await observer.rollback()

        async with session_factory() as observer:
            locked_link = await observer.scalar(
                select(ChannelBotAgentLink)
                .where(ChannelBotAgentLink.id == link_id)
                .with_for_update(nowait=True)
            )
            locked_pair_code = await observer.scalar(
                select(ChannelPairCode)
                .where(ChannelPairCode.id == pair_code_id)
                .with_for_update(nowait=True)
            )
            assert locked_link is not None
            assert locked_pair_code is not None
            await observer.rollback()
    finally:
        release_claim.set()
        result = await asyncio.wait_for(claim_task, timeout=2)

    assert result.binding is not None


@pytest.mark.asyncio
async def test_same_external_chat_id_is_isolated_across_channel_providers(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch,
):
    shared_chat_id = "15550001111@s.whatsapp.net"
    channel_specs = [
        (
            "telegram",
            {
                "provider": "telegram",
                "name": "telegram-shared-chat",
                "provider_token": "123456:telegram-provider-token",
            },
        ),
        (
            "discord",
            {
                "provider": "discord",
                "name": "discord-shared-chat",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        ),
        (
            "whatsapp",
            {
                "provider": "whatsapp",
                "name": "whatsapp-shared-chat",
            },
        ),
    ]
    created_by_provider = {
        provider: (await client.post("/v1/channels", json=body)).json()
        for provider, body in channel_specs
    }
    await _seed_created_channel_link(
        db_session,
        created=created_by_provider["whatsapp"],
        agent=channel_agent,
    )
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    pair_codes = {
        provider: (
            await client.post(
                f"/v1/channels/{created['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()["code"]
        for provider, created in created_by_provider.items()
    }

    telegram = created_by_provider["telegram"]
    await client.post(
        f"/v1/channels/telegram/{telegram['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": telegram["webhook_secret"]},
        json={
            "update_id": 401,
            "message": {
                "message_id": 401,
                "text": f"/clawdi_pair {pair_codes['telegram']}",
                "chat": {"id": shared_chat_id, "type": "private"},
            },
        },
    )
    discord = created_by_provider["discord"]
    await client.post(
        f"/v1/channels/discord/{discord['id']}/webhook",
        headers={"x-clawdi-channel-secret": discord["webhook_secret"]},
        json={
            "type": 2,
            "id": "discord-shared-msg",
            "token": "discord-shared-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": shared_chat_id,
            "context": 1,
            "authorizing_integration_owners": {"1": "shared-discord-sender"},
            "user": {"id": "shared-discord-sender"},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair_codes["discord"]}],
            },
        },
    )
    whatsapp = created_by_provider["whatsapp"]
    await persist_whatsapp_provider_event(
        db_session,
        account_id=UUID(whatsapp["id"]),
        event=WhatsAppProviderMessageEvent(
            sequence=1,
            message_id="wamid.shared",
            remote_jid=shared_chat_id,
            remote_jid_alt=None,
            participant=None,
            participant_alt=None,
            push_name=None,
            message_timestamp=1_700_000_000,
            message_proto=whatsapp_text_message_proto(f"/clawdi_pair {pair_codes['whatsapp']}"),
        ),
    )

    bindings_by_provider = {}
    for provider, created in created_by_provider.items():
        bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
        assert bindings.status_code == 200
        bindings_by_provider[provider] = bindings.json()

    assert set(bindings_by_provider) == {"telegram", "discord", "whatsapp"}
    assert {bindings[0]["external_chat_id"] for bindings in bindings_by_provider.values()} == {
        shared_chat_id
    }
    assert len({bindings[0]["account_id"] for bindings in bindings_by_provider.values()}) == len(
        bindings_by_provider
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider",
    [CHANNEL_PROVIDER_TELEGRAM, CHANNEL_PROVIDER_DISCORD],
)
async def test_delete_non_whatsapp_channel_ignores_whatsapp_custom_config_collision(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    provider: str,
):
    config: dict[str, Any] = {
        "connection_mode": "baileys_custom",
        "sidecar_account_id": "not-a-whatsapp-slot",
        "sidecar_config_revision": "not-a-whatsapp-revision",
    }
    if provider == CHANNEL_PROVIDER_DISCORD:
        config.update(_discord_ready_config())
    created = await client.post(
        "/v1/channels",
        json={
            "provider": provider,
            "name": f"{provider}-whatsapp-config-collision-{uuid4().hex}",
            "provider_token": (
                "123456:telegram-secret"
                if provider == CHANNEL_PROVIDER_TELEGRAM
                else "discord-provider-token"
            ),
            "config": config,
        },
    )
    assert created.status_code == 201, created.text
    account_id = UUID(created.json()["id"])

    deleted = await client.delete(f"/v1/channels/{account_id}")

    assert deleted.status_code == 204, deleted.text
    account = await db_session.get(ChannelAccount, account_id, populate_existing=True)
    assert account is not None
    assert account.archived_at is not None


@pytest.mark.asyncio
async def test_archived_agent_cannot_route_channels_and_reactivation_restores_authority(
    client, db_session, seed_user, channel_agent
):
    from fastapi import HTTPException

    from app.services.agent_lifecycle import (
        archive_agent_and_project,
        reactivate_agent_and_project,
    )
    from app.services.channels import get_strict_v2_hosted_channel_agent_or_409

    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": CHANNEL_PROVIDER_TELEGRAM,
            "name": f"recoverable-agent-{uuid4().hex}",
            "agent_id": str(channel_agent.id),
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    binding = ChannelBinding(
        account_id=UUID(created["id"]),
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        external_chat_id=f"recoverable-agent-chat-{uuid4().hex}",
        external_chat_type="private",
    )
    db_session.add(binding)
    await db_session.commit()

    await archive_agent_and_project(db_session, agent=channel_agent)
    await db_session.commit()
    await db_session.refresh(link)
    await db_session.refresh(binding)
    assert link.status == BOT_AGENT_LINK_STATUS_ACTIVE
    assert link.archived_at is None
    assert binding.status == BINDING_STATUS_ACTIVE
    with pytest.raises(HTTPException) as exc_info:
        await get_strict_v2_hosted_channel_agent_or_409(
            db_session,
            agent_id=channel_agent.id,
            user_id=seed_user.id,
        )
    assert exc_info.value.status_code == 409

    await reactivate_agent_and_project(db_session, agent=channel_agent)
    await db_session.commit()
    await db_session.refresh(link)
    await db_session.refresh(binding)
    assert link.status == BOT_AGENT_LINK_STATUS_ACTIVE
    assert link.archived_at is None
    assert binding.status == BINDING_STATUS_ACTIVE
    restored = await get_strict_v2_hosted_channel_agent_or_409(
        db_session,
        agent_id=channel_agent.id,
        user_id=seed_user.id,
    )
    assert restored.id == channel_agent.id
