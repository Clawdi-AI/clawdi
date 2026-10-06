from __future__ import annotations

import asyncio
import json
import socket
import threading
import zlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
import zstandard as zstd
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.websockets import WebSocketDisconnect

from app.core.config import settings
from app.main import app
from app.models.channel import (
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_VISIBILITY_PUBLIC,
    MESSAGE_DIRECTION_INBOUND,
    PAIR_CODE_STATUS_PENDING,
    ChannelAccount,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
)
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import public as public_router
from app.routes.channel_routers import shared as shared_router
from app.routes.channel_routers.discord import (
    _discord_gateway_authority,
    _discord_gateway_url,
    _discord_guild_create_payload,
)
from app.services import channels as channel_service
from app.services import sync_events
from app.services.channel_wakeups import notify_channel_inbound_message_enqueued
from app.services.channels import (
    ChannelAgentContext,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
)
from app.services.discord_advisory_session import DiscordAdvisorySession
from app.services.discord_gateway_worker import (
    DISCORD_DEFAULT_INTENTS,
    DiscordGatewayWorker,
    _GatewayState,
    _send_heartbeat,
    discord_gateway_advisory_lock_key,
    discord_gateway_intents,
    discord_gateway_uri,
    discord_identify_payload,
    discord_resume_payload,
    record_discord_gateway_dispatch,
)
from tests.channel_helpers import (
    DISCORD_TEST_APPLICATION_ID,
    _archive_discord_binding_with_identity_lock,
    _clear_fake_provider_calls,
    _create_paired_discord_channel,
    _discord_gateway_protocol_agent,
    _discord_provider_result,
    _discord_ready_config,
    _FakeDiscordGatewayConnect,
    _FakeDiscordGatewaySocket,
    _install_discord_gateway_protocol_fakes,
    _install_discord_gateway_test_session_factory,
    _reset_discord_gateway_sessions,
    _reset_fake_provider_client,
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
async def test_user_channel_config_rejects_insecure_discord_gateway_url(
    client: httpx.AsyncClient,
):
    response = await client.post(
        "/v1/channels",
        json={
            "provider": "discord",
            "name": "discord-insecure-gateway-url",
            "provider_token": "discord-token",
            "config": {
                **_discord_ready_config(),
                "gateway_url": "ws://gateway.discord.gg",
            },
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "discord gateway_url must be a public wss URL"


def test_discord_gateway_capability_accepts_runtime_placeholder(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)
    agent = _discord_gateway_protocol_agent()
    websocket_path = urlparse(_discord_gateway_url(agent)).path
    placeholder = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_DISCORD,
        channel_runtime_account_key(agent.account.id),
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(f"{websocket_path}?v=10&encoding=json") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
            ready = websocket.receive_json()

    assert ready["t"] == "READY"
    resume_url = urlparse(ready["d"]["resume_gateway_url"])
    assert resume_url.path.startswith("/v1/channels/discord/gateway/")
    assert resume_url.path.rpartition("/")[2]


def test_discord_gateway_link_authorization_accepts_runtime_placeholder(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)
    agent = _discord_gateway_protocol_agent()
    placeholder = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_DISCORD,
        channel_runtime_account_key(agent.account.id),
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?v=10&encoding=json",
            headers={"Authorization": "Bearer valid-discord-token"},
        ) as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            guild = websocket.receive_json()
            channel = websocket.receive_json()

    assert ready["t"] == "READY"
    assert guild["t"] == "GUILD_CREATE"
    assert ready["d"]["resume_gateway_url"] == settings.channel_discord_gateway_url

    # discord.py reconnects to the external URL, which the egress sidecar rewrites
    # back to this canonical endpoint and authenticates with the same Link header.
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway",
            headers={"Authorization": "Bearer valid-discord-token"},
        ) as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {"token": placeholder, "session_id": session_id, "seq": channel["s"]},
                }
            )
            assert websocket.receive_json()["t"] == "RESUMED"


def test_discord_gateway_link_authorization_rejects_wrong_placeholder(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?v=10&encoding=json",
            headers={"Authorization": "Bearer valid-discord-token"},
        ) as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "clawdi_wrong-placeholder", "intents": 0}})
            with pytest.raises(WebSocketDisconnect) as raised:
                websocket.receive_json()

    assert raised.value.code == 4004


@pytest.mark.asyncio
async def test_discord_gateway_shared_account_link_bearers_are_isolated(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_discord_gateway_sessions(monkeypatch)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-shared-gateway-isolation",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    second_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(second_channel_agent.id)},
    )
    assert second_response.status_code == 201, second_response.text
    second = second_response.json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    link_a = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    link_b = await db_session.get(ChannelBotAgentLink, UUID(second["id"]))
    assert account is not None and link_a is not None and link_b is not None
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    account.user_id = None
    binding_a = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link_a.id,
        user_id=link_a.user_id,
        external_chat_id="shared-gateway-channel-a",
        external_chat_type="guild_text",
        external_chat_name="shared-gateway-guild-a",
    )
    binding_b = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link_b.id,
        user_id=link_b.user_id,
        external_chat_id="shared-gateway-channel-b",
        external_chat_type="guild_text",
        external_chat_name="shared-gateway-guild-b",
    )
    db_session.add_all([binding_a, binding_b])
    await db_session.flush()
    db_session.add_all(
        [
            ChannelBindingAlias(
                account_id=account.id,
                bot_agent_link_id=link_a.id,
                user_id=link_a.user_id,
                binding_id=binding_a.id,
                alias_kind="discord_channel",
                alias_external_chat_id="shared-gateway-channel-a",
            ),
            ChannelBindingAlias(
                account_id=account.id,
                bot_agent_link_id=link_b.id,
                user_id=link_b.user_id,
                binding_id=binding_b.id,
                alias_kind="discord_channel",
                alias_external_chat_id="shared-gateway-channel-b",
            ),
        ]
    )
    await db_session.commit()
    _install_discord_gateway_test_session_factory(monkeypatch)
    placeholder = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_DISCORD,
        channel_runtime_account_key(account.id),
    )

    async def fake_provider_request(*, account, method: str, path: str, **kwargs):
        channel_id = path.rpartition("/")[2]
        suffix = channel_id.rpartition("-")[2]
        return shared_router.DiscordProviderResult(
            content=json.dumps(
                {
                    "id": channel_id,
                    "guild_id": f"shared-gateway-guild-{suffix}",
                    "type": 0,
                    "name": channel_id,
                }
            ).encode(),
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(discord_router, "request_discord_provider", fake_provider_request)

    def identify(bearer: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        with TestClient(app) as sync_client:
            with sync_client.websocket_connect(
                "/v1/channels/discord/gateway?v=10&encoding=json",
                headers={"Authorization": f"Bearer {bearer}"},
            ) as websocket:
                assert websocket.receive_json()["op"] == 10
                websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
                return (
                    websocket.receive_json(),
                    websocket.receive_json(),
                    websocket.receive_json(),
                )

    ready_a, guild_a, channel_a = identify(created["agent_token"])
    ready_b, guild_b, channel_b = identify(second["agent_token"])

    assert ready_a["d"]["resume_gateway_url"] == settings.channel_discord_gateway_url
    assert ready_b["d"]["resume_gateway_url"] == settings.channel_discord_gateway_url
    assert ready_a["d"]["guilds"] == [{"id": "shared-gateway-guild-a", "unavailable": False}]
    assert ready_b["d"]["guilds"] == [{"id": "shared-gateway-guild-b", "unavailable": False}]
    assert guild_a["d"]["channels"] == guild_b["d"]["channels"] == []
    assert channel_a["t"] == channel_b["t"] == "CHANNEL_CREATE"
    assert channel_a["d"]["id"] == "shared-gateway-channel-a"
    assert channel_b["d"]["id"] == "shared-gateway-channel-b"
    assert "/v1/channels/discord/gateway" not in ready_a["d"]["resume_gateway_url"]

    # Simulate discord.py reconnecting to the external resume URL: egress rewrites
    # it to /gateway and re-injects the same Link bearer. Session ownership then
    # proves the resumed connection cannot cross-select the sibling Link.
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway",
            headers={"Authorization": f"Bearer {created['agent_token']}"},
        ) as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": placeholder,
                        "session_id": ready_a["d"]["session_id"],
                        "seq": channel_a["s"],
                    },
                }
            )
            assert websocket.receive_json()["t"] == "RESUMED"

    capability_a_path = urlparse(
        _discord_gateway_url(ChannelAgentContext(account=account, link=link_a))
    ).path
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            capability_a_path,
            headers={"Authorization": f"Bearer {second['agent_token']}"},
        ) as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
            with pytest.raises(WebSocketDisconnect) as raised:
                websocket.receive_json()
    assert raised.value.code == 4004

    rotated = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )
    assert rotated.status_code == 200, rotated.text
    for rejected_bearer in (created["agent_token"], "wrong-link-bearer", second["agent_token"]):
        if rejected_bearer == second["agent_token"]:
            link_b.status = BOT_AGENT_LINK_STATUS_ARCHIVED
            link_b.archived_at = datetime.now(UTC)
            await db_session.commit()
        with TestClient(app) as sync_client:
            with sync_client.websocket_connect(
                "/v1/channels/discord/gateway",
                headers={"Authorization": f"Bearer {rejected_bearer}"},
            ) as websocket:
                assert websocket.receive_json()["op"] == 10
                websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
                with pytest.raises(WebSocketDisconnect) as raised:
                    websocket.receive_json()
        assert raised.value.code == 4004


def test_discord_gateway_helpers_build_protocol_payloads():
    assert discord_gateway_uri("wss://gateway.discord.gg") == (
        "wss://gateway.discord.gg/?v=10&encoding=json"
    )
    assert discord_gateway_uri(" wss://gateway.discord.gg ") == (
        "wss://gateway.discord.gg/?v=10&encoding=json"
    )
    assert discord_gateway_uri("wss://example.test/gateway?compress=zlib-stream").startswith(
        "wss://example.test/gateway?compress=zlib-stream&v=10&encoding=json"
    )

    payload = discord_identify_payload(token="discord-token", intents=513)
    assert payload == {
        "op": 2,
        "d": {
            "token": "discord-token",
            "intents": 513,
            "properties": {"os": "linux", "browser": "clawdi", "device": "clawdi"},
        },
    }
    assert discord_resume_payload(
        token="discord-token",
        session_id="gateway-session",
        sequence=42,
    ) == {
        "op": 6,
        "d": {
            "token": "discord-token",
            "session_id": "gateway-session",
            "seq": 42,
        },
    }
    assert discord_gateway_intents(ChannelAccount(config=None)) == DISCORD_DEFAULT_INTENTS
    assert DISCORD_DEFAULT_INTENTS == sum(1 << bit for bit in (0, 9, 10, 12, 13, 15))
    assert discord_gateway_intents(ChannelAccount(config={"gateway_intents": "513"})) == 513
    lock_key = discord_gateway_advisory_lock_key(UUID("00000000-0000-0000-0000-000000000001"))
    assert 0 <= lock_key <= 0x7FFF_FFFF_FFFF_FFFF


@pytest.mark.asyncio
async def test_discord_gateway_worker_resumes_and_falls_back_after_invalid_session(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-worker-resume-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    first_stop = asyncio.Event()
    resume_stop = asyncio.Event()
    fallback_stop = asyncio.Event()
    first_socket = _FakeDiscordGatewaySocket(
        [
            {"op": 10, "d": {"heartbeat_interval": 60_000}},
            {
                "op": 0,
                "t": "READY",
                "s": 11,
                "d": {
                    "session_id": "gateway-session",
                    "resume_gateway_url": "wss://gateway.discord.gg/resume",
                },
            },
        ],
        first_stop,
    )
    resume_socket = _FakeDiscordGatewaySocket(
        [
            {"op": 10, "d": {"heartbeat_interval": 60_000}},
            {"op": 9, "d": False},
        ],
        resume_stop,
    )
    fallback_socket = _FakeDiscordGatewaySocket(
        [
            {"op": 10, "d": {"heartbeat_interval": 60_000}},
            {
                "op": 0,
                "t": "READY",
                "s": 1,
                "d": {
                    "session_id": "new-gateway-session",
                    "resume_gateway_url": "wss://gateway.discord.gg/new-resume",
                },
            },
        ],
        fallback_stop,
    )
    connect_factory = _FakeDiscordGatewayConnect([first_socket, resume_socket, fallback_socket])
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordGatewayWorker(sessionmaker, connect_factory=connect_factory)
    state = _GatewayState()

    await worker._connect_and_record(account_id, first_stop, state)
    with pytest.raises(RuntimeError, match="invalidated gateway session"):
        await worker._connect_and_record(account_id, resume_stop, state)
    await worker._connect_and_record(account_id, fallback_stop, state)

    assert first_socket.sent[0]["op"] == 2
    assert state.session_id == "new-gateway-session"
    assert state.sequence == 1
    assert resume_socket.sent[0] == {
        "op": 6,
        "d": {
            "token": "discord-provider-token",
            "session_id": "gateway-session",
            "seq": 11,
        },
    }
    assert fallback_socket.sent[0]["op"] == 2
    assert connect_factory.uris[0].startswith("wss://gateway.discord.gg/")
    assert connect_factory.uris[1].startswith("wss://gateway.discord.gg/resume")
    assert connect_factory.uris[2].startswith("wss://gateway.discord.gg/")


@pytest.mark.asyncio
async def test_discord_gateway_worker_resumes_from_last_durably_committed_dispatch(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": f"discord-worker-durable-sequence-{uuid4().hex}",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    account_id = UUID(created["id"])
    persist_started = asyncio.Event()
    allow_failure = asyncio.Event()
    failed_once = False
    committed_event_ids: set[str] = set()
    observed_sequences: list[int] = []

    async def record_with_one_failure(
        _sessionmaker,
        _account_id: UUID,
        frame: dict[str, Any],
        *,
        gateway_session_id: str | None = None,
    ) -> bool:
        nonlocal failed_once
        sequence = frame.get("s")
        assert isinstance(sequence, int)
        observed_sequences.append(sequence)
        event_id = str(frame.get("d", {}).get("id", frame.get("t")))
        if sequence == 12 and not failed_once:
            failed_once = True
            persist_started.set()
            await allow_failure.wait()
            raise SQLAlchemyError("simulated durable admission failure")
        if event_id in committed_event_ids:
            return False
        committed_event_ids.add(event_id)
        return True

    monkeypatch.setattr(
        "app.services.discord_gateway_worker.record_discord_gateway_dispatch",
        record_with_one_failure,
    )
    first_stop = asyncio.Event()
    resume_stop = asyncio.Event()
    first_socket = _FakeDiscordGatewaySocket(
        [
            {"op": 10, "d": {"heartbeat_interval": 60_000}},
            {
                "op": 0,
                "t": "READY",
                "s": 11,
                "d": {
                    "session_id": "durable-sequence-session",
                    "resume_gateway_url": "wss://gateway.discord.gg/resume",
                },
            },
            {
                "op": 0,
                "t": "MESSAGE_CREATE",
                "s": 12,
                "d": {"id": "durable-message-12", "channel_id": "channel-1"},
            },
        ],
        first_stop,
    )
    resume_socket = _FakeDiscordGatewaySocket(
        [
            {"op": 10, "d": {"heartbeat_interval": 60_000}},
            {
                "op": 0,
                "t": "MESSAGE_CREATE",
                "s": 12,
                "d": {"id": "durable-message-12", "channel_id": "channel-1"},
            },
            {
                "op": 0,
                "t": "MESSAGE_CREATE",
                "s": 12,
                "d": {"id": "durable-message-12", "channel_id": "channel-1"},
            },
        ],
        resume_stop,
    )
    worker = DiscordGatewayWorker(
        async_sessionmaker(db_session.bind, expire_on_commit=False),
        connect_factory=_FakeDiscordGatewayConnect([first_socket, resume_socket]),
    )
    state = _GatewayState()

    first_connection = asyncio.create_task(
        worker._connect_and_record(account_id, first_stop, state)
    )
    await persist_started.wait()
    assert state.sequence == 11
    await _send_heartbeat(first_socket, state)
    assert first_socket.sent[-1] == {"op": 1, "d": 11}
    allow_failure.set()
    with pytest.raises(SQLAlchemyError, match="durable admission failure"):
        await first_connection

    assert state.sequence == 11
    await worker._connect_and_record(account_id, resume_stop, state)

    assert resume_socket.sent[0] == {
        "op": 6,
        "d": {
            "token": "discord-provider-token",
            "session_id": "durable-sequence-session",
            "seq": 11,
        },
    }
    assert state.sequence == 12
    assert observed_sequences == [11, 12, 12, 12]
    assert committed_event_ids == {"READY", "durable-message-12"}


@pytest.mark.asyncio
async def test_discord_gateway_projection_uses_active_aliases_and_minimal_guild(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-ready-guilds",
        channel_id="ready-channel-1",
        guild_id="ready-guild-1",
    )
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()

    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account.id)
        )
    ).scalar_one()
    guilds, channels = await _discord_gateway_authority(
        db_session,
        account=account,
        bot_agent_link_id=binding.bot_agent_link_id,
    )

    assert guilds == {"ready-guild-1": "ready-guild-1"}
    assert channels == {"ready-channel-1": "ready-guild-1"}
    assert _discord_guild_create_payload(
        guild_id="ready-guild-1",
        guild_name="ready-guild-1",
        sequence=2,
    ) == {
        "op": 0,
        "t": "GUILD_CREATE",
        "s": 2,
        "d": {
            "id": "ready-guild-1",
            "name": "ready-guild-1",
            "unavailable": False,
            "channels": [],
            "threads": [],
            "members": [],
        },
    }


def test_discord_gateway_rejects_unsupported_encoding_and_compress():
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?encoding=etf"
        ) as websocket:
            with pytest.raises(WebSocketDisconnect) as exc:
                websocket.receive_json()
            assert exc.value.code == 4012

        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?encoding=json&compress=brotli"
        ) as websocket:
            with pytest.raises(WebSocketDisconnect) as exc:
                websocket.receive_json()
            assert exc.value.code == 4012


def test_discord_gateway_zlib_stream_compresses_outbound_frames(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)
    inflater = zlib.decompressobj()

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?encoding=json&compress=zlib-stream"
        ) as websocket:
            hello = json.loads(inflater.decompress(websocket.receive_bytes()).decode("utf-8"))
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = json.loads(inflater.decompress(websocket.receive_bytes()).decode("utf-8"))

    assert hello["op"] == 10
    assert ready["t"] == "READY"
    assert ready["d"]["v"] == 10


def test_discord_gateway_zstd_stream_compresses_outbound_frames(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)
    inflater = zstd.ZstdDecompressor().decompressobj()

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?encoding=json&compress=zstd-stream"
        ) as websocket:
            hello = json.loads(inflater.decompress(websocket.receive_bytes()).decode("utf-8"))
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = json.loads(inflater.decompress(websocket.receive_bytes()).decode("utf-8"))

    assert hello["op"] == 10
    assert ready["t"] == "READY"
    assert ready["d"]["v"] == 10


def test_discord_gateway_resume_validates_session_id_and_token(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            channel = websocket.receive_json()
            assert channel["t"] == "CHANNEL_CREATE"

        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "valid-discord-token",
                        "session_id": session_id,
                        "seq": channel["s"],
                    },
                }
            )
            assert websocket.receive_json()["t"] == "RESUMED"

        _reset_discord_gateway_sessions(monkeypatch)
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "valid-discord-token",
                        "session_id": "missing-session",
                        "seq": 0,
                    },
                }
            )
            assert websocket.receive_json() == {"op": 9, "d": False}

        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "wrong-token",
                        "session_id": session_id,
                        "seq": 0,
                    },
                }
            )
            assert websocket.receive_json() == {"op": 9, "d": False}


def test_discord_gateway_resume_replays_buffered_dispatches(monkeypatch):
    _install_discord_gateway_protocol_fakes(
        monkeypatch,
        events=[
            ChannelMessage(
                inbox_sequence=11,
                external_chat_id="chan-protocol-1",
                provider_message_id="msg-replay-1",
                text="missed dispatch",
                payload={
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "channel_id": "chan-protocol-1",
                        "guild_id": "guild-protocol-1",
                        "content": "missed dispatch",
                    },
                },
            )
        ],
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            channel = websocket.receive_json()
            assert channel["t"] == "CHANNEL_CREATE"
            assert websocket.receive_json()["d"]["content"] == "missed dispatch"

        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "valid-discord-token",
                        "session_id": session_id,
                        "seq": channel["s"],
                    },
                }
            )
            replayed = websocket.receive_json()
            resumed = websocket.receive_json()

        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "valid-discord-token",
                        "session_id": session_id,
                        "seq": replayed["s"],
                    },
                }
            )
            resumed_again = websocket.receive_json()

    assert replayed["t"] == "MESSAGE_CREATE"
    assert replayed["d"]["content"] == "missed dispatch"
    assert resumed["t"] == "RESUMED"
    assert resumed_again["t"] == "RESUMED"
    assert resumed_again["s"] > resumed["s"]


@pytest.mark.asyncio
async def test_discord_gateway_new_identify_replays_unacknowledged_db_message_after_restart(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_discord_gateway_sessions(monkeypatch)
    channel_id = "restart-replay-channel"
    guild_id = "restart-replay-guild"
    created = await _create_paired_discord_channel(
        client,
        name=f"discord-restart-replay-{uuid4().hex}",
        channel_id=channel_id,
        guild_id=guild_id,
    )
    account_id = UUID(created["id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).scalar_one()
    message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        binding_id=binding.id,
        user_id=binding.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="restart-replay-message",
        text="replay after restart",
        payload={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "restart-replay-message",
                "channel_id": channel_id,
                "guild_id": guild_id,
                "content": "replay after restart",
                "author": {"id": "restart-user"},
            },
        },
    )
    db_session.add(message)
    await db_session.commit()

    async def fake_provider_request(*, account, method: str, path: str, **_kwargs):
        assert path == f"channels/{channel_id}"
        return shared_router.DiscordProviderResult(
            content=json.dumps(
                {"id": channel_id, "guild_id": guild_id, "type": 0, "name": "restart"}
            ).encode(),
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(discord_router, "request_discord_provider", fake_provider_request)
    _install_discord_gateway_test_session_factory(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
            ready = websocket.receive_json()
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["t"] == "CHANNEL_CREATE"
            first_dispatch = websocket.receive_json()
            assert first_dispatch["d"]["id"] == "restart-replay-message"

    await db_session.refresh(message)
    assert message.delivered_at is None

    # Process-local Resume state is gone, but the durable pending row remains.
    _reset_discord_gateway_sessions(monkeypatch)
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": created["agent_token"],
                        "session_id": ready["d"]["session_id"],
                        "seq": first_dispatch["s"],
                    },
                }
            )
            assert websocket.receive_json() == {"op": 9, "d": False}
            websocket.send_json({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
            assert websocket.receive_json()["t"] == "READY"
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["t"] == "CHANNEL_CREATE"
            replayed = websocket.receive_json()
            assert replayed["d"]["id"] == "restart-replay-message"
            websocket.send_json({"op": 1, "d": replayed["s"]})
            assert websocket.receive_json() == {"op": 11, "d": None}

    await db_session.refresh(message)
    assert message.delivered_at is not None


@pytest.mark.asyncio
async def test_discord_gateway_drops_scrubbed_interaction_and_delivers_next_message(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_discord_gateway_sessions(monkeypatch)
    channel_id = "scrubbed-interaction-channel"
    guild_id = "scrubbed-interaction-guild"
    created = await _create_paired_discord_channel(
        client,
        name=f"discord-scrubbed-interaction-{uuid4().hex}",
        channel_id=channel_id,
        guild_id=guild_id,
    )
    account_id = UUID(created["id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).scalar_one()
    common = {
        "account_id": account_id,
        "bot_agent_link_id": UUID(created["agent_link_id"]),
        "binding_id": binding.id,
        "user_id": binding.user_id,
        "direction": MESSAGE_DIRECTION_INBOUND,
        "external_chat_id": binding.external_chat_id,
    }
    scrubbed = ChannelMessage(
        **common,
        provider_message_id="scrubbed-interaction",
        payload={
            "t": "INTERACTION_CREATE",
            "d": {
                "id": "scrubbed-interaction",
                "application_id": DISCORD_TEST_APPLICATION_ID,
                "channel_id": channel_id,
                "guild_id": guild_id,
                "data": {"name": "expired"},
            },
        },
    )
    valid = ChannelMessage(
        **common,
        provider_message_id="message-after-scrubbed-interaction",
        text="still deliver this",
        payload={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "message-after-scrubbed-interaction",
                "channel_id": channel_id,
                "guild_id": guild_id,
                "content": "still deliver this",
                "author": {"id": "scrubbed-interaction-user"},
            },
        },
    )
    db_session.add_all([scrubbed, valid])
    await db_session.commit()

    async def fake_provider_request(*, account, method: str, path: str, **_kwargs):
        assert path == f"channels/{channel_id}"
        return shared_router.DiscordProviderResult(
            content=json.dumps(
                {"id": channel_id, "guild_id": guild_id, "type": 0, "name": "scrubbed"}
            ).encode(),
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(discord_router, "request_discord_provider", fake_provider_request)
    _install_discord_gateway_test_session_factory(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
            assert websocket.receive_json()["t"] == "READY"
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["t"] == "CHANNEL_CREATE"
            dispatch = websocket.receive_json()
            assert dispatch["t"] == "MESSAGE_CREATE"
            assert dispatch["d"]["id"] == "message-after-scrubbed-interaction"
            websocket.send_json({"op": 1, "d": dispatch["s"]})
            assert websocket.receive_json() == {"op": 11, "d": None}

    await db_session.refresh(scrubbed)
    await db_session.refresh(valid)
    assert scrubbed.delivered_at is not None
    assert valid.delivered_at is not None


@pytest.mark.asyncio
async def test_discord_gateway_resume_sequence_acks_and_replays_exact_db_message(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_discord_gateway_sessions(monkeypatch)
    channel_id = "resume-ack-channel"
    guild_id = "resume-ack-guild"
    created = await _create_paired_discord_channel(
        client,
        name=f"discord-resume-ack-{uuid4().hex}",
        channel_id=channel_id,
        guild_id=guild_id,
    )
    account_id = UUID(created["id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).scalar_one()
    message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
        binding_id=binding.id,
        user_id=binding.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="resume-ack-message",
        payload={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "resume-ack-message",
                "channel_id": channel_id,
                "guild_id": guild_id,
                "content": "resume me",
                "author": {"id": "resume-user"},
            },
        },
    )
    db_session.add(message)
    await db_session.commit()

    async def fake_provider_request(*, account, method: str, path: str, **_kwargs):
        return shared_router.DiscordProviderResult(
            content=json.dumps(
                {"id": channel_id, "guild_id": guild_id, "type": 0, "name": "resume"}
            ).encode(),
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(discord_router, "request_discord_provider", fake_provider_request)
    _install_discord_gateway_test_session_factory(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
            ready = websocket.receive_json()
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            channel = websocket.receive_json()
            dispatch = websocket.receive_json()

    # Model cancellation after the frame/checkpoint was registered and sent but
    # before the connection-local durable inbox cursor was advanced.
    session_id = ready["d"]["session_id"]
    session_state = discord_router._DISCORD_GATEWAY_SESSIONS.connect(session_id)
    assert session_state is not None
    discord_router._DISCORD_GATEWAY_SESSIONS.disconnect(session_id)
    session_state["last_inbox_sequence"] = 0

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": created["agent_token"],
                        "session_id": ready["d"]["session_id"],
                        "seq": channel["s"],
                    },
                }
            )
            replayed = websocket.receive_json()
            assert replayed == dispatch
            resumed = websocket.receive_json()
            assert resumed["t"] == "RESUMED"
            websocket.send_json({"op": 1, "d": channel["s"]})
            # The pending DB row is already represented by the replayed
            # checkpoint, so it must not be dequeued a second time here.
            assert websocket.receive_json() == {"op": 11, "d": None}

    await db_session.refresh(message)
    assert message.delivered_at is None

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": created["agent_token"],
                        "session_id": ready["d"]["session_id"],
                        "seq": replayed["s"],
                    },
                }
            )
            assert websocket.receive_json()["t"] == "RESUMED"

    await db_session.refresh(message)
    assert message.delivered_at is not None


def test_discord_gateway_thread_only_alias_is_hydrated_before_message(monkeypatch):
    events = [
        ChannelMessage(
            inbox_sequence=10,
            external_chat_id="guild-protocol-1",
            provider_message_id="thread-update-1",
            payload={
                "t": "THREAD_UPDATE",
                "d": {
                    "id": "thread-only-1",
                    "guild_id": "guild-protocol-1",
                    "parent_id": "unbound-forum-parent",
                    "type": 11,
                    "thread_metadata": {"archived": True},
                },
            },
        ),
        ChannelMessage(
            inbox_sequence=11,
            external_chat_id="guild-protocol-1",
            provider_message_id="thread-message-1",
            payload={
                "t": "MESSAGE_CREATE",
                "d": {
                    "id": "thread-message-1",
                    "channel_id": "thread-only-1",
                    "guild_id": "guild-protocol-1",
                    "content": "inside an existing forum post",
                },
            },
        ),
    ]
    provider_paths = _install_discord_gateway_protocol_fakes(
        monkeypatch,
        events=events,
        channels={"thread-only-1": "guild-protocol-1"},
        provider_channels={
            "thread-only-1": {
                "id": "thread-only-1",
                "guild_id": "guild-protocol-1",
                "parent_id": "unbound-forum-parent",
                "type": 11,
                "name": "forum post",
                "thread_metadata": {"archived": False, "auto_archive_duration": 1440},
            }
        },
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            frames = [websocket.receive_json() for _ in range(6)]

    assert [frame["t"] for frame in frames] == [
        "READY",
        "GUILD_CREATE",
        "THREAD_CREATE",
        "THREAD_UPDATE",
        "THREAD_CREATE",
        "MESSAGE_CREATE",
    ]
    assert frames[1]["d"]["channels"] == frames[1]["d"]["threads"] == []
    assert frames[2]["d"]["parent_id"] == frames[4]["d"]["parent_id"] == ("unbound-forum-parent")
    assert frames[3]["d"]["thread_metadata"]["archived"] is True
    assert "THREAD_DELETE" not in {frame["t"] for frame in frames}
    assert provider_paths == ["channels/thread-only-1", "channels/thread-only-1"]


@pytest.mark.parametrize("channel_type", [1, 3])
def test_discord_gateway_ready_projects_exact_private_channel(monkeypatch, channel_type: int):
    private = {
        "id": f"private-{channel_type}",
        "type": channel_type,
        "name": "Pairing DM" if channel_type == 3 else None,
        "recipients": [{"id": "user-1", "username": "Ada"}],
        "last_message_id": "message-1",
    }
    provider_paths = _install_discord_gateway_protocol_fakes(
        monkeypatch,
        guilds={},
        channels={private["id"]: None},
        provider_channels={private["id"]: private},
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()

    assert ready["d"]["private_channels"] == [private]
    assert provider_paths == [f"channels/{private['id']}"]


@pytest.mark.parametrize("channel_type", [15, 16])
def test_discord_gateway_preserves_forum_and_media_channel_types(monkeypatch, channel_type: int):
    provider_paths = _install_discord_gateway_protocol_fakes(
        monkeypatch,
        channels={"special-channel": "guild-protocol-1"},
        provider_channels={
            "special-channel": {
                "id": "special-channel",
                "guild_id": "guild-protocol-1",
                "type": channel_type,
                "name": "special",
                "available_tags": [],
            }
        },
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            websocket.receive_json()
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready, guild, channel = [websocket.receive_json() for _ in range(3)]

    assert [ready["t"], guild["t"], channel["t"]] == [
        "READY",
        "GUILD_CREATE",
        "CHANNEL_CREATE",
    ]
    assert channel["d"]["type"] == channel_type
    assert provider_paths == ["channels/special-channel"]


def test_discord_gateway_new_alias_converges_before_queued_message(monkeypatch):
    guilds: dict[str, str] = {}
    channels: dict[str, str | None] = {}
    provider_channels: dict[str, dict[str, Any]] = {}
    events: list[ChannelMessage] = []
    provider_paths = _install_discord_gateway_protocol_fakes(
        monkeypatch,
        events=events,
        guilds=guilds,
        channels=channels,
        provider_channels=provider_channels,
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            websocket.receive_json()
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            assert websocket.receive_json()["t"] == "READY"

            guilds["new-guild"] = "New Guild"
            channels["new-thread"] = "new-guild"
            provider_channels["new-thread"] = {
                "id": "new-thread",
                "guild_id": "new-guild",
                "parent_id": "unbound-parent",
                "type": 12,
                "name": "new private thread",
                "thread_metadata": {"archived": False},
            }
            events.append(
                ChannelMessage(
                    inbox_sequence=12,
                    external_chat_id="new-guild",
                    provider_message_id="new-message",
                    payload={
                        "t": "MESSAGE_CREATE",
                        "d": {
                            "id": "new-message",
                            "guild_id": "new-guild",
                            "channel_id": "new-thread",
                            "content": "paired after identify",
                        },
                    },
                )
            )
            frames = [websocket.receive_json() for _ in range(3)]

    assert [frame["t"] for frame in frames] == [
        "GUILD_CREATE",
        "THREAD_CREATE",
        "MESSAGE_CREATE",
    ]
    assert provider_paths == ["channels/new-thread"]


def test_discord_gateway_terminal_alias_failure_does_not_block_later_event(monkeypatch):
    events = [
        ChannelMessage(
            inbox_sequence=11,
            external_chat_id="guild-protocol-1",
            provider_message_id=f"message-{channel_id}",
            payload={
                "t": "MESSAGE_CREATE",
                "d": {
                    "id": f"message-{channel_id}",
                    "guild_id": "guild-protocol-1",
                    "channel_id": channel_id,
                    "content": channel_id,
                },
            },
        )
        for channel_id in ("missing-channel", "valid-channel")
    ]
    channels = {
        "missing-channel": "guild-protocol-1",
        "valid-channel": "guild-protocol-1",
    }
    _install_discord_gateway_protocol_fakes(
        monkeypatch,
        events=events,
        channels=channels,
        provider_channels={"missing-channel": {}, "valid-channel": {}},
    )
    calls: list[str] = []
    missing_calls = 0
    rate_limited = threading.Event()
    now = 0.0

    async def provider_request(*, account, method: str, path: str, **kwargs):
        nonlocal missing_calls
        channel_id = path.rpartition("/")[2]
        calls.append(channel_id)
        if channel_id == "missing-channel":
            missing_calls += 1
            if missing_calls == 2:
                rate_limited.set()
                raise HTTPException(
                    status_code=429,
                    detail="provider detail must stay private",
                    headers={"retry-after": "7200.5"},
                )
            if missing_calls > 2:
                raise HTTPException(status_code=400, detail="permanent provider request failure")
            return _discord_provider_result(404, {"message": "Unknown Channel"})
        return _discord_provider_result(
            200,
            {
                "id": channel_id,
                "guild_id": "guild-protocol-1",
                "type": 0,
                "name": "valid",
            },
        )

    monkeypatch.setattr(discord_router, "request_discord_provider", provider_request)
    monkeypatch.setattr(discord_router, "monotonic", lambda: now)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            websocket.receive_json()
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            frames = [websocket.receive_json() for _ in range(3)]
            assert rate_limited.wait(1)
            now = 7200.4
            websocket.send_json({"op": 1, "d": frames[-1]["s"]})
            assert websocket.receive_json() == {"op": 11, "d": None}
            now = 7200.6
            websocket.send_json({"op": 1, "d": frames[-1]["s"]})
            tail = [websocket.receive_json() for _ in range(2)]
            assert {"op": 11, "d": None} in tail
            frames.append(next(frame for frame in tail if frame.get("op") == 0))

    assert [frame["t"] for frame in frames] == [
        "READY",
        "GUILD_CREATE",
        "CHANNEL_CREATE",
        "MESSAGE_CREATE",
    ]
    assert calls == ["missing-channel", "valid-channel", "missing-channel", "missing-channel"]


@pytest.mark.asyncio
async def test_discord_gateway_send_and_unpair_are_linearized(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-send-lease",
        channel_id="send-lease-channel",
        guild_id="send-lease-guild",
    )
    account_id = UUID(created["id"])
    link_id = UUID(created["agent_link_id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.external_chat_id == "send-lease-guild",
            )
        )
    ).scalar_one()
    message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link_id,
        binding_id=binding.id,
        user_id=binding.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="send-lease-message",
        payload={"t": "MESSAGE_CREATE", "d": {"channel_id": "send-lease-channel"}},
    )
    db_session.add(message)
    await db_session.commit()
    await db_session.refresh(message)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    send_started = asyncio.Event()
    allow_send = asyncio.Event()
    business_backend_pids: asyncio.Queue[int] = asyncio.Queue()
    frames: list[str] = []

    async def send() -> int:
        frames.append("frame")
        send_started.set()
        await allow_send.wait()
        return 42

    send_task: asyncio.Task[tuple[str, int | None]] | None = None
    unpair_task: asyncio.Task[None] | None = None
    try:
        send_task = asyncio.create_task(
            discord_router._send_discord_gateway_message(
                account_id=account_id,
                bot_agent_link_id=link_id,
                message=message,
                send=send,
            )
        )
        await asyncio.wait_for(send_started.wait(), timeout=2)
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
        allow_send.set()
        assert await asyncio.wait_for(send_task, timeout=2) == ("sent", 42)
        await asyncio.wait_for(unpair_task, timeout=2)
    finally:
        allow_send.set()
        pending_tasks = [
            task for task in (send_task, unpair_task) if task is not None and not task.done()
        ]
        if pending_tasks:
            for task in pending_tasks:
                task.cancel()
            await asyncio.gather(*pending_tasks, return_exceptions=True)

    assert frames == ["frame"]
    await db_session.refresh(message)
    assert message.delivered_at is None

    async with sessionmaker() as ack_db:
        assert (
            await channel_service.ack_discord_gateway_messages(
                ack_db,
                account_id=account_id,
                bot_agent_link_id=link_id,
                message_ids=[message.id],
            )
            == 1
        )
        await ack_db.commit()
    await db_session.refresh(message)
    assert message.delivered_at is not None

    second = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link_id,
        binding_id=binding.id,
        user_id=binding.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="after-unpair",
        payload={"t": "MESSAGE_CREATE", "d": {"channel_id": "send-lease-channel"}},
    )
    db_session.add(second)
    await db_session.commit()
    await db_session.refresh(second)
    assert await discord_router._send_discord_gateway_message(
        account_id=account_id,
        bot_agent_link_id=link_id,
        message=second,
        send=lambda: frames.append("leaked"),
    ) == ("dropped", None)
    assert frames == ["frame"]


@pytest.mark.asyncio
async def test_discord_gateway_multiple_connections_send_each_event_once(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_discord_channel(
        client,
        name="discord-send-once",
        channel_id="send-once-channel",
        guild_id="send-once-guild",
    )
    account_id = UUID(created["id"])
    link_id = UUID(created["agent_link_id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).scalar_one()
    message = ChannelMessage(
        account_id=account_id,
        bot_agent_link_id=link_id,
        binding_id=binding.id,
        user_id=binding.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id=binding.external_chat_id,
        provider_message_id="send-once-message",
        payload={"t": "MESSAGE_CREATE", "d": {"channel_id": "send-once-channel"}},
    )
    db_session.add(message)
    await db_session.commit()
    await db_session.refresh(message)
    sends = 0
    send_started = asyncio.Event()
    release_send = asyncio.Event()

    async def send() -> int:
        nonlocal sends
        sends += 1
        send_started.set()
        await release_send.wait()
        return 42

    async with asyncio.timeout(1):
        first = asyncio.create_task(
            discord_router._send_discord_gateway_message(
                account_id=account_id,
                bot_agent_link_id=link_id,
                message=message,
                send=send,
            )
        )
        try:
            await send_started.wait()
            second = await discord_router._send_discord_gateway_message(
                account_id=account_id,
                bot_agent_link_id=link_id,
                message=message,
                send=send,
            )
        finally:
            release_send.set()
            first_result = await first

    assert sorted([first_result, second]) == [("consumed", None), ("sent", 42)]
    assert sends == 1


def test_discord_gateway_resume_rejects_sequence_older_than_buffer(monkeypatch):
    monkeypatch.setattr("app.routes.channel_routers.discord._DISCORD_GATEWAY_RESUME_BUFFER_SIZE", 1)
    _install_discord_gateway_protocol_fakes(
        monkeypatch,
        events=[
            ChannelMessage(
                inbox_sequence=11,
                external_chat_id="chan-protocol-1",
                provider_message_id="msg-replay-1",
                text="event one",
                payload={
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "channel_id": "chan-protocol-1",
                        "guild_id": "guild-protocol-1",
                        "content": "event one",
                    },
                },
            ),
            ChannelMessage(
                inbox_sequence=12,
                external_chat_id="chan-protocol-1",
                provider_message_id="msg-replay-2",
                text="event two",
                payload={
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "channel_id": "chan-protocol-1",
                        "guild_id": "guild-protocol-1",
                        "content": "event two",
                    },
                },
            ),
        ],
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["t"] == "CHANNEL_CREATE"
            assert websocket.receive_json()["d"]["content"] == "event one"
            websocket.send_json({"op": 1, "d": 4})
            assert websocket.receive_json() == {"op": 11, "d": None}
            assert websocket.receive_json()["d"]["content"] == "event two"

        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "valid-discord-token",
                        "session_id": session_id,
                        "seq": 2,
                    },
                }
            )
            assert websocket.receive_json() == {"op": 9, "d": False}


def test_discord_gateway_resume_accepts_latest_sequence_after_ready_eviction(monkeypatch):
    monkeypatch.setattr("app.routes.channel_routers.discord._DISCORD_GATEWAY_RESUME_BUFFER_SIZE", 1)
    _install_discord_gateway_protocol_fakes(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            assert ready["t"] == "READY"
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            latest = websocket.receive_json()
            assert latest["t"] == "CHANNEL_CREATE"

        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": "valid-discord-token",
                        "session_id": ready["d"]["session_id"],
                        "seq": latest["s"],
                    },
                }
            )
            assert websocket.receive_json()["t"] == "RESUMED"


@pytest.mark.asyncio
async def test_discord_gateway_interaction_cannot_pair_or_create_side_effects(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-gateway-pair",
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

    async def membership_must_not_run(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Gateway interaction reached pairing admission")

    monkeypatch.setattr(
        channel_service,
        "discord_bot_guild_membership_check",
        membership_must_not_run,
    )

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    recorded = await record_discord_gateway_dispatch(
        sessionmaker,
        UUID(created["id"]),
        {
            "op": 0,
            "t": "INTERACTION_CREATE",
            "s": 42,
            "d": {
                "type": 2,
                "id": "interaction-gateway-pair",
                "token": "interaction-gateway-pair-token",
                "application_id": DISCORD_TEST_APPLICATION_ID,
                "channel_id": "chan-gateway-pair",
                "guild_id": "guild-gateway",
                "context": 0,
                "authorizing_integration_owners": {"0": "guild-gateway"},
                "member": {
                    "permissions": "32",
                    "user": {"id": "discord-gateway-pair-user"},
                },
                "data": {
                    "name": "clawdi_pair",
                    "options": [{"name": "code", "value": pair["code"]}],
                },
            },
        },
    )

    assert recorded is False
    for model in (ChannelBinding, ChannelMessage, ChannelAgentReference, ChannelDelivery):
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(model)
                .where(model.account_id == UUID(created["id"]))
            )
            == 0
        )
    pair_code = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    assert pair_code is not None
    assert pair_code.status == PAIR_CODE_STATUS_PENDING


@pytest.mark.asyncio
async def test_discord_gateway_interaction_cannot_unpair_or_create_side_effects(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    guild_id = "gateway-replayed-unpair-guild"
    channel_id = "gateway-replayed-unpair-channel"
    actor_id = "discord-pair-user"
    created = await _create_paired_discord_channel(
        client,
        name="discord-gateway-replayed-unpair",
        channel_id=channel_id,
        guild_id=guild_id,
    )
    account_id = UUID(created["id"])
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    before_counts = {
        model: await db_session.scalar(
            select(func.count()).select_from(model).where(model.account_id == account_id)
        )
        for model in (ChannelMessage, ChannelAgentReference, ChannelDelivery)
    }
    gateway_unpair = {
        "op": 0,
        "t": "INTERACTION_CREATE",
        "s": 801,
        "d": {
            "type": 2,
            "id": "gateway-replayed-unpair-interaction",
            "token": "gateway-replayed-unpair-token",
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
        },
    }
    assert not await record_discord_gateway_dispatch(
        sessionmaker,
        account_id,
        gateway_unpair,
    )
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == guild_id
    for model, before in before_counts.items():
        assert (
            await db_session.scalar(
                select(func.count()).select_from(model).where(model.account_id == account_id)
            )
            == before
        )


@pytest.mark.asyncio
async def test_discord_gateway_guild_create_triggers_reconcile_without_reconnect(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "discord",
                "name": "discord-guild-create-trigger",
                "provider_token": "discord-provider-token",
                "config": _discord_ready_config(),
            },
        )
    ).json()
    calls: list[tuple[UUID, str]] = []

    async def record_reconcile(
        _sessionmaker: async_sessionmaker[AsyncSession],
        *,
        account_id: UUID,
        guild_id: str,
    ) -> int:
        calls.append((account_id, guild_id))
        return 1

    monkeypatch.setattr(
        "app.services.discord_gateway_worker.reconcile_discord_guild_commands",
        record_reconcile,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    recorded = await record_discord_gateway_dispatch(
        sessionmaker,
        UUID(created["id"]),
        {
            "op": 0,
            "t": "GUILD_CREATE",
            "s": 77,
            "d": {"id": "guild-create-trigger", "unavailable": False},
        },
    )

    assert recorded is False
    assert calls == [(UUID(created["id"]), "guild-create-trigger")]

    async def failed_reconcile(
        _sessionmaker: async_sessionmaker[AsyncSession],
        *,
        account_id: UUID,
        guild_id: str,
    ) -> int:
        raise RuntimeError(f"reconcile failed for {account_id}/{guild_id}")

    monkeypatch.setattr(
        "app.services.discord_gateway_worker.reconcile_discord_guild_commands",
        failed_reconcile,
    )
    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            {
                "op": 0,
                "t": "GUILD_CREATE",
                "s": 78,
                "d": {"id": "guild-create-trigger", "unavailable": False},
            },
        )
        is False
    )


@pytest.mark.asyncio
async def test_discord_gateway_guild_create_lazily_heals_legacy_name_and_keeps_id_authority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "legacy-guild-id"
    created = await _create_paired_discord_channel(
        client,
        name="discord-legacy-guild-name",
        channel_id="legacy-guild-channel",
        guild_id=guild_id,
    )
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account.id)
        )
    ).scalar_one()
    binding.external_chat_type = "guild_text"
    binding.external_chat_name = guild_id
    await db_session.commit()
    reconciled_guild_ids: list[str] = []

    async def capture_reconcile(
        _sessionmaker: async_sessionmaker[AsyncSession],
        *,
        account_id: UUID,
        guild_id: str,
    ) -> int:
        assert account_id == account.id
        reconciled_guild_ids.append(guild_id)
        return 1

    monkeypatch.setattr(
        "app.services.discord_gateway_worker.reconcile_discord_guild_commands",
        capture_reconcile,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            account.id,
            {
                "op": 0,
                "t": "GUILD_CREATE",
                "s": 81,
                "d": {"id": guild_id, "name": "  Renamed Guild  ", "unavailable": False},
            },
        )
        is False
    )
    await db_session.refresh(binding)
    assert binding.external_chat_type == "guild"
    assert binding.external_chat_name == "Renamed Guild"
    assert binding.external_chat_id == guild_id
    assert shared_router.discord_binding_guild_id(binding) == guild_id
    assert reconciled_guild_ids == [guild_id]

    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            account.id,
            {
                "op": 0,
                "t": "GUILD_CREATE",
                "s": 82,
                "d": {"id": guild_id, "name": guild_id, "unavailable": False},
            },
        )
        is False
    )
    await db_session.refresh(binding)
    assert binding.external_chat_name == "Renamed Guild"
    assert reconciled_guild_ids == [guild_id, guild_id]


@pytest.mark.asyncio
async def test_discord_gateway_guild_delete_unavailable_does_nothing(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "temporarily-unavailable-guild"
    created = await _create_paired_discord_channel(
        client,
        name="discord-temporarily-unavailable-guild",
        channel_id="temporarily-unavailable-channel",
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []

    async def provider_must_not_run(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", provider_must_not_run)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            {
                "op": 0,
                "t": "GUILD_DELETE",
                "s": 101,
                "d": {"id": guild_id, "unavailable": True},
            },
            gateway_session_id="guild-delete-unavailable-session",
        )
        is True
    )
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert provider_calls == []


@pytest.mark.asyncio
async def test_discord_gateway_guild_delete_archives_cleans_and_is_replay_safe(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    guild_id = "departed-guild"
    channel_id = "departed-guild-channel"
    created = await _create_paired_discord_channel(
        client,
        name="discord-departed-guild",
        channel_id=channel_id,
        guild_id=guild_id,
    )
    provider_calls: list[dict[str, Any]] = []

    async def provider_success(**kwargs: Any) -> shared_router.DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "request_discord_provider", provider_success)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    deleted = {
        "op": 0,
        "t": "GUILD_DELETE",
        "s": 202,
        "d": {"id": guild_id, "unavailable": False},
    }

    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            deleted,
            gateway_session_id="guild-delete-session",
        )
        is True
    )
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []
    assert len(provider_calls) == 1
    assert provider_calls[0]["body"] == b"[]"

    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    repaired = await client.post(
        f"/v1/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "departed-guild-repair",
            "token": "departed-guild-repair-token",
            "application_id": DISCORD_TEST_APPLICATION_ID,
            "channel_id": channel_id,
            "guild_id": guild_id,
            "context": 0,
            "authorizing_integration_owners": {"0": guild_id},
            "member": {"permissions": "32", "user": {"id": "discord-pair-user"}},
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert repaired.json()["data"]["content"].startswith("Server paired.")
    provider_calls.clear()

    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            deleted,
            gateway_session_id="guild-delete-session",
        )
        is True
    )
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == guild_id
    assert provider_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_listener", [False, True])
async def test_discord_gateway_commit_delivery_phases(
    client, db_session, monkeypatch, legacy_listener
):
    """Real commits and TCP WebSockets; phases start after an empty inbox query."""
    import statistics
    from time import perf_counter

    import uvicorn
    from websockets.asyncio.client import connect

    from app.services.sync_events import start_postgres_listener, stop_postgres_listener
    from tests.conftest import create_env_with_project

    _reset_discord_gateway_sessions(monkeypatch)
    if legacy_listener:
        # Released listeners match the entire payload as an account key. The
        # new Link payload misses that key; real DB polling must still deliver.
        def legacy_notification(_pid, _channel, payload):
            sync_events.channel_inbound_messages_enqueued.signal(payload)

        monkeypatch.setattr(
            sync_events, "_on_channel_inbound_message_enqueued", legacy_notification
        )
    monkeypatch.setattr(settings, "discord_gateway_poll_interval_seconds", 1.0)
    created = await _create_paired_discord_channel(client, name=f"gateway-phases-{uuid4().hex}")
    account_id = UUID(created["id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account_id)
        )
    ).scalar_one()
    other_agent = await create_env_with_project(
        db_session,
        user_id=binding.user_id,
        machine_id=f"phase-other-{uuid4().hex}",
        machine_name="Other phase agent",
    )
    other_link = ChannelBotAgentLink(
        account_id=account_id, user_id=binding.user_id, agent_id=other_agent.id
    )
    db_session.add(other_link)
    await db_session.flush()
    other_binding = ChannelBinding(
        account_id=account_id,
        bot_agent_link_id=other_link.id,
        user_id=binding.user_id,
        external_chat_id="other-phase-guild",
        external_chat_type="guild",
    )
    db_session.add(other_binding)
    await db_session.commit()
    gateway_engine = create_async_engine(settings.database_url)
    monkeypatch.setattr(
        discord_router,
        "async_session_factory",
        async_sessionmaker(gateway_engine, expire_on_commit=False),
    )
    consumer_locks = DiscordAdvisorySession(gateway_engine)
    monkeypatch.setattr(app.state, "discord_gateway_locks", consumer_locks, raising=False)
    sql_count = 0
    empty_queries = asyncio.Queue()
    original_dequeue = discord_router.dequeue_discord_gateway_events

    def count_sql(*_args):
        nonlocal sql_count
        sql_count += 1

    async def observed_dequeue(*args, **kwargs):
        values = await original_dequeue(*args, **kwargs)
        if not values:
            empty_queries.put_nowait(perf_counter())
        return values

    async def provider(*, path, **_kwargs):
        assert path == "channels/discord-chan-1"
        return shared_router.DiscordProviderResult(
            content=json.dumps(
                {
                    "id": "discord-chan-1",
                    "guild_id": "discord-guild-1",
                    "type": 0,
                    "name": "phase-test",
                }
            ).encode(),
            status_code=200,
            media_type="application/json",
        )

    sqlalchemy_event.listen(gateway_engine.sync_engine, "before_cursor_execute", count_sql)
    monkeypatch.setattr(discord_router, "dequeue_discord_gateway_events", observed_dequeue)
    monkeypatch.setattr(discord_router, "request_discord_provider", provider)
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="error"))
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    samples = []
    try:
        await start_postgres_listener()
        async with asyncio.timeout(10):
            while not server.started:
                await asyncio.sleep(0.01)
        async with connect(f"ws://127.0.0.1:{port}/v1/channels/discord/gateway") as ws:

            async def receive():
                return json.loads(await asyncio.wait_for(ws.recv(), 5))

            assert (await receive())["op"] == 10
            await ws.send(
                json.dumps({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
            )
            assert (await receive())["t"] == "READY"
            assert (await receive())["t"] == "GUILD_CREATE"
            assert (await receive())["t"] == "CHANNEL_CREATE"
            for index, phase in enumerate([0.05, 0.25, 0.5, 0.75, 0.95] * 3 + [0.05]):
                if index == 15:
                    await stop_postgres_listener()
                while not empty_queries.empty():
                    empty_queries.get_nowait()
                # Heartbeat gives each sample a fresh empty-query boundary.
                await ws.send(json.dumps({"op": 1, "d": None}))
                assert (await receive())["op"] == 11
                idle_at = await asyncio.wait_for(empty_queries.get(), 5)
                await asyncio.sleep(max(0, idle_at + phase - perf_counter()))
                message = ChannelMessage(
                    account_id=account_id,
                    bot_agent_link_id=UUID(created["agent_link_id"]),
                    binding_id=binding.id,
                    user_id=binding.user_id,
                    direction=MESSAGE_DIRECTION_INBOUND,
                    external_chat_id=binding.external_chat_id,
                    provider_message_id=f"phase-{index}",
                    payload={
                        "t": "MESSAGE_CREATE",
                        "d": {
                            "id": f"phase-{index}",
                            "channel_id": "discord-chan-1",
                            "guild_id": "discord-guild-1",
                            "content": "phase test",
                            "author": {"id": "phase-user"},
                        },
                    },
                )
                db_session.add(message)
                await db_session.flush()
                await notify_channel_inbound_message_enqueued(
                    db_session,
                    account_id=str(account_id),
                    bot_agent_link_id=created["agent_link_id"],
                )
                before_sql = sql_count
                await db_session.commit()
                committed_at = perf_counter()
                dispatch = await receive()
                elapsed = (perf_counter() - committed_at) * 1000
                assert dispatch["t"] == "MESSAGE_CREATE"
                assert dispatch["d"]["id"] == f"phase-{index}"
                samples.append(
                    {
                        "phase": phase,
                        "ms": round(elapsed, 3),
                        "sql": sql_count - before_sql,
                        "listening": index < 15,
                    }
                )
                await ws.send(json.dumps({"op": 1, "d": dispatch["s"]}))
                assert (await receive())["op"] == 11
                await db_session.refresh(message)
                assert message.delivered_at is not None
            await start_postgres_listener()
            unrelated = []
            for index in range(3):
                while not empty_queries.empty():
                    empty_queries.get_nowait()
                await ws.send(json.dumps({"op": 1, "d": None}))
                assert (await receive())["op"] == 11
                await asyncio.wait_for(empty_queries.get(), 5)
                # Let the heartbeat's query and any already-coalesced wakeup
                # finish before attributing SQL to the next foreign commit.
                await asyncio.sleep(0.05)
                while not empty_queries.empty():
                    empty_queries.get_nowait()
                foreign = ChannelMessage(
                    account_id=account_id,
                    bot_agent_link_id=other_link.id,
                    binding_id=other_binding.id,
                    user_id=binding.user_id,
                    direction=MESSAGE_DIRECTION_INBOUND,
                    external_chat_id=other_binding.external_chat_id,
                    provider_message_id=f"other-phase-{index}",
                    payload={"t": "MESSAGE_CREATE", "d": {"content": "other link"}},
                )
                db_session.add(foreign)
                await db_session.flush()
                await notify_channel_inbound_message_enqueued(
                    db_session, account_id=str(account_id)
                )
                before_sql = sql_count
                await db_session.commit()
                committed_at = perf_counter()
                await asyncio.wait_for(empty_queries.get(), 2)
                unrelated.append(
                    {
                        "ms": round((perf_counter() - committed_at) * 1000, 3),
                        "sql": sql_count - before_sql,
                    }
                )
                # Other Link's message must not leak through this socket.
                await ws.send(json.dumps({"op": 1, "d": None}))
                assert (await receive())["op"] == 11
            print("GATEWAY_OTHER_LINK", json.dumps(unrelated))
        times = sorted(sample["ms"] for sample in samples if sample["listening"])
        print(
            "GATEWAY_PHASES",
            json.dumps(
                {
                    "p50_ms": statistics.median(times),
                    "p95_ms": times[int(len(times) * 0.95)],
                    "samples": samples,
                }
            ),
        )
    finally:
        try:
            server.should_exit = True
            await asyncio.wait_for(server_task, 10)
        finally:
            listener.close()
            try:
                await stop_postgres_listener()
            finally:
                try:
                    await consumer_locks.close()
                finally:
                    await gateway_engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_kind", ["disconnect", "cancel", "lease_lost"])
async def test_discord_gateway_wakeup_owns_reader_and_cleanup(monkeypatch, engine, exit_kind):
    from fastapi import WebSocket

    from app.services.channel_wakeups import ChannelWakeup

    _install_discord_gateway_protocol_fakes(monkeypatch)
    consumer_locks = DiscordAdvisorySession(engine)
    monkeypatch.setattr(app.state, "discord_gateway_locks", consumer_locks, raising=False)
    source = ChannelWakeup()
    monkeypatch.setattr(discord_router, "channel_inbound_messages_enqueued", source)
    monkeypatch.setattr(settings, "discord_gateway_poll_interval_seconds", 60)
    account_key = str(_discord_gateway_protocol_agent().account.id)
    inbox_checked = asyncio.Queue()
    incoming = asyncio.Queue()
    outgoing = asyncio.Queue()
    original_dequeue = discord_router.dequeue_discord_gateway_events
    cancelled_receives = 0

    async def dequeue(*args, **kwargs):
        result = await original_dequeue(*args, **kwargs)
        inbox_checked.put_nowait(None)
        return result

    async def receive():
        nonlocal cancelled_receives
        try:
            return await incoming.get()
        except asyncio.CancelledError:
            cancelled_receives += 1
            raise

    @asynccontextmanager
    async def lost_lease(**_kwargs):
        try:
            yield True
        finally:
            raise discord_router._DiscordGatewayConsumerLeaseLost("test lease lost on exit")

    monkeypatch.setattr(discord_router, "dequeue_discord_gateway_events", dequeue)
    if exit_kind == "lease_lost":
        monkeypatch.setattr(discord_router, "_discord_gateway_consumer_lease", lost_lease)
    websocket = WebSocket(
        {
            "type": "websocket",
            "path": "/v1/channels/discord/gateway",
            "app": app,
            "headers": [],
            "query_string": b"",
        },
        receive,
        outgoing.put,
    )
    incoming.put_nowait({"type": "websocket.connect"})
    task = asyncio.create_task(discord_router.discord_agent_gateway(websocket))

    def frame(payload):
        incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    async def dispatch():
        message = await asyncio.wait_for(outgoing.get(), 2)
        return json.loads(message["text"])

    try:
        assert (await outgoing.get())["type"] == "websocket.accept"
        assert (await dispatch())["op"] == 10
        frame({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
        ready = await dispatch()
        assert ready["t"] == "READY"
        assert (await dispatch())["t"] == "GUILD_CREATE"
        assert (await dispatch())["t"] == "CHANNEL_CREATE"
        await asyncio.wait_for(inbox_checked.get(), 2)
        # A notification alone must leave the outstanding ASGI receive intact.
        source.signal(account_key)
        await asyncio.wait_for(inbox_checked.get(), 2)
        assert cancelled_receives == 0
        monkeypatch.setattr(settings, "discord_gateway_poll_interval_seconds", 0.01)
        source.signal(account_key)
        await asyncio.wait_for(inbox_checked.get(), 2)
        await asyncio.wait_for(inbox_checked.get(), 2)
        assert cancelled_receives == 0
        monkeypatch.setattr(settings, "discord_gateway_poll_interval_seconds", 60)
        # Make both inputs runnable in the same tick; neither may be discarded.
        source.signal(account_key)
        frame({"op": 1, "d": None})
        assert (await dispatch()) == {"op": 11, "d": None}
        assert cancelled_receives == 0
        source.signal(account_key)
        if exit_kind == "disconnect":
            incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})
            await asyncio.wait_for(task, 2)
        else:
            task.cancel()
            expected = (
                discord_router._DiscordGatewayConsumerLeaseLost
                if exit_kind == "lease_lost"
                else asyncio.CancelledError
            )
            with pytest.raises(expected):
                await asyncio.wait_for(task, 2)
        assert not source._waiters and not source._scoped_waiters
        entry = discord_router._DISCORD_GATEWAY_SESSIONS._entries[ready["d"]["session_id"]]
        assert entry.connection_count == 0
        assert not [
            child
            for child in asyncio.all_tasks()
            if child.get_name() in {"discord-gateway-receive", "discord-gateway-wakeup"}
        ]
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await consumer_locks.close()
