from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
    ChannelSecret,
)
from app.models.runtime_observation import V2RuntimeEnvironmentFence
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import public as public_router
from app.services import channels as channel_service
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.runtime_observation import retire_runtime_environment
from tests.channel_helpers import (
    _AmbiguousDiscordCreateMessageClient,
    _clear_fake_provider_calls,
    _discord_ready_config,
    _FailingProviderClient,
    _FakeProviderClient,
    _reset_fake_provider_client,
)

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
async def test_send_channel_message_uses_binding(client: httpx.AsyncClient, monkeypatch):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-send",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    webhook = (
        await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "message": {
                    "message_id": 42,
                    "text": f"/clawdi_pair {pair['code']}",
                    "chat": {"id": 111, "type": "private"},
                }
            },
        )
    ).json()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"binding_id": webhook["binding_id"], "text": "deploy done"},
    )

    assert sent.status_code == 201
    assert sent.json()["direction"] == "outbound"
    assert sent.json()["external_chat_id"] == "111"
    assert sent.json()["provider_message_id"] is None
    assert sent.json()["delivery_status"] == "pending"
    assert sent.json()["delivery_id"]


@pytest.mark.asyncio
async def test_delete_channel_fails_pending_outbound_deliveries(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-delete-outbox",
                "provider_token": "123456:telegram-secret",
                "secrets": {"signing_key": "delete-me"},
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "111", "text": "delete before delivery"},
    )

    deleted = await client.delete(f"/v1/channels/{created['id']}")

    assert deleted.status_code == 204
    delivery = (
        await db_session.execute(
            select(ChannelDelivery).where(ChannelDelivery.id == UUID(sent.json()["delivery_id"]))
        )
    ).scalar_one()
    assert delivery.status == DELIVERY_STATUS_FAILED
    assert delivery.locked_at is None
    assert delivery.locked_by is None
    assert delivery.last_error == "channel_account_inactive"
    account = await db_session.get(ChannelAccount, UUID(created["id"]), populate_existing=True)
    assert account is not None
    assert account.encrypted_provider_token is None
    assert account.provider_token_nonce is None
    assert (
        await db_session.scalar(
            select(func.count(ChannelSecret.id)).where(
                ChannelSecret.account_id == UUID(created["id"])
            )
        )
        == 0
    )


@pytest.mark.asyncio
async def test_channel_delivery_worker_retries_provider_failures(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-retry",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "111", "text": "retry me"},
    )

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()

    assert delivered_id == UUID(sent.json()["delivery_id"])
    delivery = (
        await db_session.execute(
            select(ChannelDelivery).where(ChannelDelivery.id == UUID(sent.json()["delivery_id"]))
        )
    ).scalar_one()
    assert delivery.status == "pending"
    assert delivery.attempts == 1
    assert delivery.last_error == "channel_provider_unreachable"


@pytest.mark.asyncio
async def test_channel_delivery_does_not_persist_provider_response_secrets(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    marker = "delivery-provider-secret-marker"

    async def provider_response_with_secrets(**_kwargs):
        return "702", {
            "ok": True,
            "result": {
                "message_id": 702,
                "authorization": f"Bot {marker}",
                "document": {
                    "file_url": f"https://cdn.example/file?signature={marker}",
                },
                "text": marker,
            },
        }

    monkeypatch.setattr(
        channel_service,
        "send_provider_outbound_payload",
        provider_response_with_secrets,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"telegram-safe-provider-response-{uuid4().hex}",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "111", "text": "persist safe metadata only"},
    )

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()

    assert delivered_id == UUID(sent.json()["delivery_id"])
    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == delivered_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    message = await db_session.get(
        ChannelMessage,
        UUID(sent.json()["id"]),
        populate_existing=True,
    )
    assert message is not None
    assert delivery.provider_response == {
        "provider": "telegram",
        "accepted": True,
        "provider_message_id": "702",
    }
    assert marker not in str(delivery.provider_response)
    assert marker not in str(message.payload)


@pytest.mark.asyncio
async def test_discord_delivery_retry_reuses_official_enforced_nonce(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    # https://discord.com/developers/docs/resources/message#create-message
    # documents a <=25 character nonce plus enforce_nonce duplicate return.
    _AmbiguousDiscordCreateMessageClient.calls = []
    _AmbiguousDiscordCreateMessageClient.attempts = 0
    monkeypatch.setattr(
        channel_service.httpx,
        "AsyncClient",
        _AmbiguousDiscordCreateMessageClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-durable-nonce-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "123456789012345678", "text": "send once"},
    )
    delivery_id = UUID(sent.json()["delivery_id"])
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = ChannelDeliveryWorker(sessionmaker)

    assert await worker.run_once() == delivery_id
    delivery = await db_session.get(ChannelDelivery, delivery_id, populate_existing=True)
    assert delivery is not None
    assert delivery.status == DELIVERY_STATUS_PENDING
    assert delivery.last_error == "channel_provider_unreachable"
    delivery.next_attempt_at = datetime(2000, 1, 1, tzinfo=UTC)
    await db_session.commit()

    assert await worker.run_once() == delivery_id
    await db_session.refresh(delivery)

    assert delivery.status == "succeeded"
    assert len(_AmbiguousDiscordCreateMessageClient.calls) == 2
    first_payload = _AmbiguousDiscordCreateMessageClient.calls[0]["json"]
    second_payload = _AmbiguousDiscordCreateMessageClient.calls[1]["json"]
    assert first_payload == second_payload
    assert first_payload["content"] == "send once"
    assert first_payload["allowed_mentions"] == {"parse": []}
    assert first_payload["enforce_nonce"] is True
    assert len(first_payload["nonce"]) == 22


@pytest.mark.asyncio
async def test_discord_delivery_429_remains_pending_until_retry_after(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    async def rate_limited_provider(**_kwargs):
        raise HTTPException(
            status_code=429,
            detail="discord api rate limited",
            headers={"Retry-After": "7.5"},
        )

    monkeypatch.setattr(
        channel_service,
        "send_provider_outbound_payload",
        rate_limited_provider,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-delivery-429-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "123456789012345678", "text": "retry after"},
    )
    delivery_id = UUID(sent.json()["delivery_id"])
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    started_at = datetime.now(UTC)

    assert await ChannelDeliveryWorker(sessionmaker).run_once() == delivery_id

    delivery = await db_session.get(ChannelDelivery, delivery_id, populate_existing=True)
    assert delivery is not None
    assert delivery.status == DELIVERY_STATUS_PENDING
    assert delivery.last_error == "channel_provider_rate_limited"
    assert delivery.next_attempt_at >= started_at + timedelta(seconds=7)
    activity = await client.get(f"/v1/channels/{created['id']}/activity")
    health = await client.get("/v1/channels/health")
    activity_delivery = next(
        item for item in activity.json()["items"] if item["delivery_id"] == str(delivery_id)
    )
    health_item = next(
        item for item in health.json()["items"] if item["account_id"] == created["id"]
    )
    assert activity_delivery["delivery_last_error"] == "channel_provider_rate_limited"
    assert health_item["last_error"] == "channel_provider_rate_limited"


@pytest.mark.asyncio
async def test_channel_delivery_unknown_exception_detail_is_stored_and_returned_as_code(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    marker = "delivery-error-secret-marker"

    async def provider_failure_with_secret(**_kwargs):
        raise HTTPException(
            status_code=502,
            detail=f"Authorization: Bot {marker} postgresql://user:pass@db.example/app",
        )

    monkeypatch.setattr(
        channel_service,
        "send_provider_outbound_payload",
        provider_failure_with_secret,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-safe-delivery-error-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    sent_response = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"external_chat_id": "123456789012345678", "text": "fail safely"},
    )
    assert sent_response.status_code == 201, sent_response.text

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    activity = await client.get(f"/v1/channels/{created['id']}/activity")
    health = await client.get("/v1/channels/health")

    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == delivered_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivery.last_error == "channel_delivery_failed"
    assert marker not in str(delivery.last_error)
    assert activity.status_code == 200
    activity_item = next(
        item for item in activity.json()["items"] if item["delivery_id"] == str(delivered_id)
    )
    assert activity_item["delivery_last_error"] == "channel_delivery_failed"
    health_item = next(
        item for item in health.json()["items"] if item["account_id"] == created["id"]
    )
    assert health_item["last_error"] == "channel_delivery_failed"
    assert marker not in activity.text
    assert marker not in health.text


@pytest.mark.asyncio
async def test_channel_delivery_does_not_send_after_claimed_link_is_archived(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-claimed-link-archive",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    binding = ChannelBinding(
        account_id=UUID(created["id"]),
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="111",
        external_chat_type="private",
        external_chat_name="Test Chat",
        status=BINDING_STATUS_ACTIVE,
    )
    db_session.add(binding)
    await db_session.commit()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"binding_id": str(binding.id), "text": "do not leak"},
    )
    assert sent.status_code == 201, sent.text
    delivery_id = UUID(sent.json()["delivery_id"])

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    async with sessionmaker() as worker_db:
        delivery = (
            await worker_db.execute(
                select(ChannelDelivery).where(ChannelDelivery.id == delivery_id).with_for_update()
            )
        ).scalar_one()
        delivery.status = DELIVERY_STATUS_IN_PROGRESS
        delivery.locked_at = datetime.now(UTC)
        delivery.locked_by = "claimed-link-archive-test"
        delivery.attempts += 1
        await worker_db.flush()
        await worker_db.commit()

        deleted = await client.delete(
            f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}"
        )
        assert deleted.status_code == 204, deleted.text
        _clear_fake_provider_calls()

        await channel_service.deliver_channel_delivery(worker_db, delivery=delivery)
        await worker_db.commit()

    assert _FakeProviderClient.calls == []
    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == delivery_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivery.status == DELIVERY_STATUS_FAILED
    assert delivery.locked_at is None
    assert delivery.locked_by is None
    assert delivery.last_error == "channel_agent_link_archived"


@pytest.mark.asyncio
async def test_channel_delivery_does_not_send_after_runtime_is_retired(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 702}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-runtime-retired-outbox",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    binding = ChannelBinding(
        account_id=UUID(created["id"]),
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="111",
        external_chat_type="private",
        external_chat_name="Test Chat",
        status=BINDING_STATUS_ACTIVE,
    )
    db_session.add(binding)
    await db_session.commit()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"binding_id": str(binding.id), "text": "must stop at retirement"},
    )
    assert sent.status_code == 201, sent.text

    fence = await db_session.get(V2RuntimeEnvironmentFence, channel_agent.id)
    assert fence is not None
    await retire_runtime_environment(
        db_session,
        environment_id=channel_agent.id,
        expected_deployment_id=fence.deployment_id,
        retirement_id="channel-delivery-retirement",
        owner_id=seed_user.id,
    )
    await db_session.commit()
    _clear_fake_provider_calls()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()

    assert delivered_id == UUID(sent.json()["delivery_id"])
    assert _FakeProviderClient.calls == []
    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == delivered_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivery.status == DELIVERY_STATUS_FAILED
    assert delivery.last_error == "channel_agent_link_authority_missing"


@pytest.mark.asyncio
async def test_channel_delivery_does_not_send_after_binding_is_unpaired(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 701}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient", _FakeProviderClient
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-binding-unpair-outbox",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    binding = ChannelBinding(
        account_id=UUID(created["id"]),
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="111",
        external_chat_type="private",
        external_chat_name="Test Chat",
        status=BINDING_STATUS_ACTIVE,
    )
    db_session.add(binding)
    await db_session.commit()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"binding_id": str(binding.id), "text": "must be cancelled"},
    )
    assert sent.status_code == 201, sent.text

    unpaired = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding.id}")
    assert unpaired.status_code == 200, unpaired.text
    _clear_fake_provider_calls()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()

    assert delivered_id == UUID(sent.json()["delivery_id"])
    assert _FakeProviderClient.calls == []
    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == UUID(sent.json()["delivery_id"]))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivery.status == DELIVERY_STATUS_FAILED
    assert delivery.last_error == "channel_binding_inactive"


@pytest.mark.asyncio
async def test_channel_delivery_link_lock_contention_does_not_exhaust_attempts(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 703}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-link-lock-contention",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    contention_seen = asyncio.Event()
    original_lock_active_delivery_link = channel_service._lock_active_delivery_link

    async def lock_active_delivery_link_with_signal(
        db: AsyncSession,
        delivery: ChannelDelivery,
    ):
        try:
            return await original_lock_active_delivery_link(db, delivery)
        except HTTPException as exc:
            if (
                exc.status_code == 503
                and exc.detail == channel_service.DELIVERY_LINK_LOCK_CONTENTION_ERROR
            ):
                contention_seen.set()
            raise

    monkeypatch.setattr(
        channel_service,
        "_lock_active_delivery_link",
        lock_active_delivery_link_with_signal,
    )
    binding = ChannelBinding(
        account_id=UUID(created["id"]),
        bot_agent_link_id=UUID(created["agent_link_id"]),
        user_id=seed_user.id,
        external_chat_id="111",
        external_chat_type="private",
        external_chat_name="Test Chat",
        status=BINDING_STATUS_ACTIVE,
    )
    db_session.add(binding)
    await db_session.commit()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
        json={"binding_id": str(binding.id), "text": "send after contention"},
    )
    assert sent.status_code == 201, sent.text
    delivery_id = UUID(sent.json()["delivery_id"])
    delivery = (
        await db_session.execute(select(ChannelDelivery).where(ChannelDelivery.id == delivery_id))
    ).scalar_one()
    assert delivery.bot_agent_link_id == UUID(created["agent_link_id"])
    delivery.attempts = 1
    delivery.max_attempts = 2
    delivery.next_attempt_at = datetime(2000, 1, 1, tzinfo=UTC)
    await db_session.commit()

    async def claim_delivery(worker_db: AsyncSession, *, worker_id: str) -> ChannelDelivery:
        claimed = (
            await worker_db.execute(
                select(ChannelDelivery).where(ChannelDelivery.id == delivery_id).with_for_update()
            )
        ).scalar_one()
        assert claimed.status == DELIVERY_STATUS_PENDING
        claimed.status = DELIVERY_STATUS_IN_PROGRESS
        claimed.locked_at = datetime.now(UTC)
        claimed.locked_by = worker_id
        claimed.attempts += 1
        await worker_db.flush()
        return claimed

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def run_claimed_delivery(*, worker_id: str) -> None:
        async with sessionmaker() as worker_db:
            claimed = await claim_delivery(worker_db, worker_id=worker_id)
            await channel_service.deliver_channel_delivery(worker_db, delivery=claimed)
            await worker_db.commit()

    async with sessionmaker() as link_lock_db:
        contended_task: asyncio.Task[None] | None = None
        try:
            async with link_lock_db.begin():
                locked_link = (
                    await link_lock_db.execute(
                        select(ChannelBotAgentLink)
                        .where(ChannelBotAgentLink.id == UUID(created["agent_link_id"]))
                        .with_for_update()
                    )
                ).scalar_one()
                assert locked_link.status == "active"

                async with sessionmaker() as probe_db:
                    skipped_link = (
                        await probe_db.execute(
                            select(ChannelBotAgentLink.id)
                            .where(ChannelBotAgentLink.id == UUID(created["agent_link_id"]))
                            .with_for_update(skip_locked=True)
                        )
                    ).scalar_one_or_none()
                    assert skipped_link is None
                    await probe_db.rollback()

                contended_task = asyncio.create_task(
                    run_claimed_delivery(worker_id="link-contention-test")
                )
                await asyncio.wait_for(contention_seen.wait(), timeout=5.0)
        except Exception:
            if contended_task is not None and not contended_task.done():
                contended_task.cancel()
                try:
                    await contended_task
                except asyncio.CancelledError:
                    pass
            raise

        assert contended_task is not None
        await contended_task

    contended_delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == delivery_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert contended_delivery.status == DELIVERY_STATUS_PENDING
    assert contended_delivery.attempts == 1
    assert contended_delivery.locked_at is None
    assert contended_delivery.locked_by is None
    assert contended_delivery.last_error == "channel_agent_link_update_contended"
    assert _FakeProviderClient.calls == []

    contended_delivery.next_attempt_at = datetime(2000, 1, 1, tzinfo=UTC)
    await db_session.commit()

    async with sessionmaker() as worker_db:
        claimed = await claim_delivery(worker_db, worker_id="link-contention-send-test")
        await channel_service.deliver_channel_delivery(worker_db, delivery=claimed)
        await worker_db.commit()

    assert len(_FakeProviderClient.calls) == 1
    delivered = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == delivery_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivered.status == "succeeded"
    assert delivered.attempts == 2
    assert delivered.last_error is None
