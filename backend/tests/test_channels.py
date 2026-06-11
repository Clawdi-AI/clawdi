from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import socket
import zlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.channel import (
    CHANNEL_STATUS_DISABLED,
    DELIVERY_STATUS_FAILED,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
)
from app.routes.channel_routers.discord import (
    _DISCORD_GATEWAY_SESSIONS,
    _discord_bound_guild_channels,
    _discord_bound_guilds,
    _discord_guild_create_payload,
)
from app.services import channels as channel_service
from app.services.bluebubbles_socket import BlueBubblesSocketManager
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.channels import (
    ChannelAgentContext,
    encrypt_optional_token,
    extract_discord_routing_key,
    hash_token,
    parse_pair_command,
    record_discord_dispatch,
    send_provider_outbound_payload,
    wait_for_telegram_updates,
)
from app.services.discord_gateway_worker import (
    DISCORD_DEFAULT_INTENTS,
    discord_gateway_advisory_lock_key,
    discord_gateway_intents,
    discord_gateway_uri,
    discord_identify_payload,
    record_discord_gateway_dispatch,
)
from app.services.discord_rate_limiter import DiscordRateLimiter
from app.services.telegram_rate_limiter import telegram_rate_limiter

pytestmark = pytest.mark.usefixtures("channel_agent")


@asynccontextmanager
async def _client_for_user(
    db_session: AsyncSession,
    user,
) -> AsyncIterator[httpx.AsyncClient]:
    previous_overrides = dict(app.dependency_overrides)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=user)

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)


async def _create_user_with_channel_agent(
    db_session: AsyncSession,
    *,
    label: str,
):
    from app.models.project import PROJECT_KIND_ENVIRONMENT, PROJECT_KIND_PERSONAL, Project
    from app.models.session import AgentEnvironment
    from app.models.user import User

    suffix = uuid4().hex[:10]
    user = User(
        clerk_id=f"{label}_{suffix}",
        email=f"{label}_{suffix}@clawdi.local",
        name=f"{label.title()} User",
    )
    db_session.add(user)
    await db_session.flush()

    personal = Project(
        user_id=user.id,
        name="Personal",
        slug="personal",
        kind=PROJECT_KIND_PERSONAL,
    )
    db_session.add(personal)
    await db_session.flush()

    agent_project = Project(
        user_id=user.id,
        name=f"{label.title()} Agent",
        slug=f"{label}-agent-{suffix}",
        kind=PROJECT_KIND_ENVIRONMENT,
    )
    db_session.add(agent_project)
    await db_session.flush()

    agent = AgentEnvironment(
        user_id=user.id,
        machine_id=f"{label}-agent-{suffix}",
        machine_name=f"{label.title()} Agent",
        agent_type="claude_code",
        os="darwin",
        default_project_id=agent_project.id,
    )
    db_session.add(agent)
    await db_session.flush()
    agent_project.origin_environment_id = agent.id
    await db_session.commit()
    await db_session.refresh(user)
    await db_session.refresh(agent)
    return user, agent


async def _create_admin_channel(
    client: httpx.AsyncClient,
    *,
    target_clerk_id: str,
    provider: str,
    name: str,
    visibility: str = "public",
    provider_token: str | None = None,
    config: dict[str, Any] | None = None,
) -> httpx.Response:
    admin_key = f"admin-{uuid4().hex}"
    original_admin_key = settings.admin_api_key
    settings.admin_api_key = admin_key
    try:
        payload: dict[str, Any] = {
            "target_clerk_id": target_clerk_id,
            "provider": provider,
            "name": name,
            "visibility": visibility,
        }
        if provider_token is not None:
            payload["provider_token"] = provider_token
        if config is not None:
            payload["config"] = config
        return await client.post(
            "/api/admin/channels",
            headers={"X-Admin-Key": admin_key},
            json=payload,
        )
    finally:
        settings.admin_api_key = original_admin_key


class _FakeProviderResponse:
    def __init__(
        self,
        payload: dict[str, Any],
        *,
        status_code: int = 200,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
    ):
        self.status_code = status_code
        self._payload = payload
        self.content = content if content is not None else json.dumps(payload).encode("utf-8")
        self.text = self.content.decode("utf-8", errors="replace")
        self.headers = headers or {"content-type": "application/json"}

    def json(self):
        return self._payload


class _FakeProviderClient:
    calls: list[dict[str, Any]] = []
    response_payload: dict[str, Any] = {}
    response_status_code: int = 200
    response_content: bytes | None = None
    response_headers: dict[str, str] | None = None

    def __init__(self, *, timeout):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return _FakeProviderResponse(
            self.response_payload,
            status_code=self.response_status_code,
            content=self.response_content,
            headers=self.response_headers,
        )

    async def put(self, url, **kwargs):
        self.calls.append({"method": "PUT", "url": url, **kwargs})
        return _FakeProviderResponse(
            self.response_payload,
            status_code=self.response_status_code,
            content=self.response_content,
            headers=self.response_headers,
        )

    async def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        return _FakeProviderResponse(
            self.response_payload,
            status_code=self.response_status_code,
            content=self.response_content,
            headers=self.response_headers,
        )

    async def get(self, url, **kwargs):
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return _FakeProviderResponse(
            self.response_payload,
            status_code=self.response_status_code,
            content=self.response_content,
            headers=self.response_headers,
        )


class _FailingProviderClient(_FakeProviderClient):
    async def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        raise httpx.ConnectError("network down")


class _SequencedProviderClient(_FakeProviderClient):
    status_codes: list[int] = []

    async def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        status_code = self.status_codes.pop(0) if self.status_codes else 200
        return _FakeProviderResponse({}, status_code=status_code)


def _reset_fake_provider_client(
    payload: dict[str, Any] | None = None,
    *,
    status_code: int = 200,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> None:
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = payload or {}
    _FakeProviderClient.response_status_code = status_code
    _FakeProviderClient.response_content = content
    _FakeProviderClient.response_headers = headers


def _reset_sequenced_provider_client(status_codes: list[int]) -> None:
    _SequencedProviderClient.calls = []
    _SequencedProviderClient.status_codes = list(status_codes)


def _clear_fake_provider_calls() -> None:
    _FakeProviderClient.calls = []
    _FailingProviderClient.calls = []
    _SequencedProviderClient.calls = []


class _MemoryFileStore:
    def __init__(self):
        self.data: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes) -> None:
        self.data[key] = data

    async def get(self, key: str) -> bytes:
        return self.data[key]

    async def delete(self, key: str) -> None:
        self.data.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self.data


class _SocketProbe:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, packet: str) -> None:
        self.sent.append(packet)


async def _create_paired_imessage_channel(
    client: httpx.AsyncClient,
    *,
    name: str,
    chat_guid: str,
    webhook_message_guid: str = "imsg-test-message",
) -> dict[str, Any]:
    sequenced_status_codes = list(_SequencedProviderClient.status_codes)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": name,
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": f"{webhook_message_guid}-pair",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": chat_guid, "displayName": "Ops"}],
            }
        },
    )
    await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": webhook_message_guid,
                "text": "query me",
                "chats": [{"guid": chat_guid, "displayName": "Ops"}],
            }
        },
    )
    _SequencedProviderClient.status_codes = sequenced_status_codes
    _clear_fake_provider_calls()
    return created


async def _create_paired_telegram_channel(
    client: httpx.AsyncClient,
    *,
    name: str,
    chat_id: str = "42",
    provider_token: str | None = "123456:telegram-secret",
    config: dict[str, Any] | None = None,
    chat_type: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "provider": "telegram",
        "name": name,
    }
    if provider_token is not None:
        payload["provider_token"] = provider_token
    if config is not None:
        payload["config"] = config
    created = (
        await client.post(
            "/api/channels",
            json=payload,
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id=chat_id, chat_type=chat_type)
    return created


async def _pair_telegram_chat(
    client: httpx.AsyncClient,
    *,
    created: dict[str, Any],
    chat_id: str,
    update_id: int = 1,
    chat_type: str | None = None,
) -> None:
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": update_id,
            "message": {
                "message_id": update_id,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/bot_pair {pair['code']}",
                "chat": {
                    "id": int(chat_id) if chat_id.lstrip("-").isdigit() else chat_id,
                    **({"type": chat_type} if chat_type is not None else {}),
                },
            },
        },
    )
    _clear_fake_provider_calls()


async def _create_paired_discord_channel(
    client: httpx.AsyncClient,
    *,
    name: str,
    channel_id: str = "discord-chan-1",
    guild_id: str = "discord-guild-1",
    provider_token: str = "discord-provider-token",
    application_id: str = "discord-app-1",
) -> dict[str, Any]:
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": name,
                "provider_token": provider_token,
                "config": {"application_id": application_id},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "discord-pair-interaction",
            "token": "discord-pair-token",
            "application_id": application_id,
            "channel_id": channel_id,
            "guild_id": guild_id,
            "member": {"user": {"id": "discord-pair-user"}},
            "data": {
                "name": "bot_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    return created


async def _record_discord_interaction(
    client: httpx.AsyncClient,
    *,
    created: dict[str, Any],
    interaction_id: str,
    token: str,
    application_id: str,
    channel_id: str = "discord-chan-1",
    guild_id: str = "discord-guild-1",
) -> None:
    await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": interaction_id,
            "token": token,
            "application_id": application_id,
            "channel_id": channel_id,
            "guild_id": guild_id,
            "data": {"name": "agent_command"},
        },
    )


@pytest.mark.asyncio
async def test_create_channel_masks_provider_token(client: httpx.AsyncClient):
    response = await client.post(
        "/api/channels",
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
    assert created["agent_token"].count(":") == 1
    assert created["webhook_secret"]
    assert "telegram-secret" not in response.text

    listed = await client.get("/api/channels")
    assert listed.status_code == 200
    assert listed.json()[0]["has_provider_token"] is True
    assert "webhook_secret" not in listed.text
    assert "telegram-secret" not in listed.text
    assert "agent_token" not in listed.text


@pytest.mark.asyncio
async def test_rotate_channel_agent_link_token_replaces_one_time_token(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": f"rotate-token-{uuid4().hex}",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    old_token = created["agent_token"]

    rotated = await client.post(
        f"/api/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )

    assert rotated.status_code == 200, rotated.text
    body = rotated.json()
    assert body["id"] == created["agent_link_id"]
    assert body["agent_token"]
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


@pytest.mark.asyncio
async def test_user_created_channel_is_private_to_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": f"private-{uuid4().hex}"},
        )
    ).json()
    assert created["visibility"] == "private"

    other_user, other_agent = await _create_user_with_channel_agent(
        db_session,
        label="private-other",
    )
    async with _client_for_user(db_session, other_user) as other_client:
        listed = await other_client.get("/api/channels")
        assert listed.status_code == 200
        assert all(item["id"] != created["id"] for item in listed.json())

        fetched = await other_client.get(f"/api/channels/{created['id']}")
        linked = await other_client.post(
            f"/api/channels/{created['id']}/agent-links",
            json={"agent_id": str(other_agent.id)},
        )
        paired = await other_client.post(
            f"/api/channels/{created['id']}/pair-codes",
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
            "/api/channels",
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
            "/api/channels",
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
            "/api/channels",
            json={"provider": "whatsapp", "name": f"pool-disabled-wa-{uuid4().hex}"},
        )
    ).json()
    disabled_whatsapp_account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(disabled_whatsapp["id"]))
        )
    ).scalar_one()
    disabled_whatsapp_account.status = CHANNEL_STATUS_DISABLED
    await db_session.flush()

    pool = await client.get("/api/channels/bot-pool")
    assert pool.status_code == 200
    telegram = pool.json()["providers"]["telegram"]
    pool_by_id = {item["id"]: item for item in telegram}
    assert pool_by_id[private["id"]]["visibility"] == "private"
    assert pool_by_id[private["id"]]["access"] == "owner"
    assert pool_by_id[private["id"]]["capabilities"] == {
        "link_agent": True,
        "pair_chat": True,
        "send_message": True,
        "manage_account": True,
        "sync_commands": True,
    }
    assert pool_by_id[public_body["id"]]["visibility"] == "public"
    assert pool_by_id[public_body["id"]]["access"] == "public"
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
        other_pool = await other_client.get("/api/channels/bot-pool")
    assert other_pool.status_code == 200
    other_telegram = other_pool.json()["providers"]["telegram"]
    other_ids = {item["id"] for item in other_telegram}
    assert public_body["id"] in other_ids
    assert private["id"] not in other_ids
    assert disabled_private["id"] not in pool_by_id
    other_public = next(item for item in other_telegram if item["id"] == public_body["id"])
    assert other_public["access"] == "public"

    disabled_detail = await client.get(f"/api/channels/{disabled_private['id']}")
    disabled_links = await client.get(f"/api/channels/{disabled_private['id']}/agent-links")
    disabled_link_create = await client.post(
        f"/api/channels/{disabled_private['id']}/agent-links",
        json={},
    )
    disabled_pair = await client.post(
        f"/api/channels/{disabled_private['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )
    disabled_send = await client.post(
        f"/api/channels/{disabled_private['id']}/messages",
        json={"external_chat_id": "12345", "text": "hello"},
    )
    disabled_whatsapp_credential = await client.post(
        f"/api/channels/whatsapp/{disabled_whatsapp['id']}/tenant-creds",
        json={},
    )
    disabled_whatsapp_auth_cert = await client.get(
        f"/api/channels/whatsapp/{disabled_whatsapp['id']}/auth-cert"
    )
    assert disabled_detail.status_code == 200
    assert disabled_links.status_code == 200
    assert disabled_link_create.status_code == 404
    assert disabled_pair.status_code == 404
    assert disabled_send.status_code == 404
    assert disabled_whatsapp_credential.status_code == 404
    assert disabled_whatsapp_auth_cert.status_code == 404


@pytest.mark.asyncio
async def test_public_bot_account_is_admin_managed_even_for_seed_owner(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
    monkeypatch,
):
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
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)

    sync = await client.post(f"/api/channels/{account_id}/commands/sync", json={})
    delete = await client.delete(f"/api/channels/{account_id}")
    link = await client.post(
        f"/api/channels/{account_id}/agent-links",
        json={"agent_id": str(channel_agent.id)},
    )
    pair = await client.post(
        f"/api/channels/{account_id}/pair-codes",
        json={"agent_id": str(channel_agent.id), "ttl_seconds": 900},
    )

    assert sync.status_code == 404
    assert delete.status_code == 404
    assert link.status_code == 201
    assert link.json()["agent_id"] == str(channel_agent.id)
    assert pair.status_code == 201
    assert pair.json()["agent_id"] == str(channel_agent.id)
    assert _FakeProviderClient.calls == []
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(account_id))
        )
    ).scalar_one()
    assert account.archived_at is None
    assert account.visibility == "public"


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
        listed = await client_a.get("/api/channels")
        assert listed.status_code == 200
        assert all(item["id"] != str(account_id) for item in listed.json())

        pool = await client_a.get("/api/channels/bot-pool")
        assert pool.status_code == 200
        public_item = next(
            item
            for item in pool.json()["providers"]["telegram"]
            if item["id"] == str(account_id)
        )
        assert public_item["visibility"] == "public"
        assert public_item["access"] == "public"

        pair = await client_a.post(
            f"/api/channels/{account_id}/pair-codes",
            json={"agent_id": str(agent_a.id), "ttl_seconds": 900},
        )
        assert pair.status_code == 201
        pair_body = pair.json()

    pair_webhook = await client.post(
        f"/api/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": public_secret},
        json={
            "update_id": 7001,
            "message": {
                "message_id": 7001,
                "text": f"/bot_pair {pair_body['code']}",
                "chat": {"id": 99001, "type": "private", "first_name": "A"},
            },
        },
    )
    inbound = await client.post(
        f"/api/channels/telegram/{account_id}/webhook",
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
        fetched = await client_b.get(f"/api/channels/{account_id}")
        assert fetched.status_code == 200
        assert fetched.json()["visibility"] == "public"

        links = await client_b.get(f"/api/channels/{account_id}/agent-links")
        bindings = await client_b.get(f"/api/channels/{account_id}/bindings")
        rotate = await client_b.post(
            f"/api/channels/{account_id}/agent-links/{link.id}/token",
        )
        send_unowned = await client_b.post(
            f"/api/channels/{account_id}/messages",
            json={"external_chat_id": "99001", "text": "wrong user"},
        )
        own_link = await client_b.post(
            f"/api/channels/{account_id}/agent-links",
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
async def test_public_whatsapp_bot_runtime_credentials_are_user_scoped(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="whatsapp",
        name=f"public-whatsapp-{uuid4().hex}",
        provider_token="wa-access-token",
        config={"phone_number_id": "phone-public"},
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]

    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="public-wa-a")
    user_b, _agent_b = await _create_user_with_channel_agent(db_session, label="public-wa-b")

    async with _client_for_user(db_session, user_a) as client_a:
        auth_cert = await client_a.get(f"/api/channels/whatsapp/{account_id}/auth-cert")
        credential = await client_a.post(
            f"/api/channels/whatsapp/{account_id}/tenant-creds",
            json={"agent_id": str(agent_a.id), "phone_user": "15551234567"},
        )
        listed_a = await client_a.get(f"/api/channels/whatsapp/{account_id}/tenant-creds")

    assert auth_cert.status_code == 200
    assert auth_cert.json()["ISSUER"] == "clawdi"
    assert credential.status_code == 201, credential.text
    assert credential.json()["agent_id"] == str(agent_a.id)
    assert credential.json()["auth_cert"]["ISSUER"] == "clawdi"
    assert len(listed_a.json()) == 1

    async with _client_for_user(db_session, user_b) as client_b:
        listed_b = await client_b.get(f"/api/channels/whatsapp/{account_id}/tenant-creds")
        auth_cert_b = await client_b.get(f"/api/channels/whatsapp/{account_id}/auth-cert")

    assert listed_b.status_code == 200
    assert listed_b.json() == []
    assert auth_cert_b.status_code == 200
    assert auth_cert_b.json()["PUBLIC_KEY"] == auth_cert.json()["PUBLIC_KEY"]


@pytest.mark.asyncio
async def test_group_pairing_can_only_be_changed_by_pairing_actor(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
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

    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="pair-owner-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="pair-owner-b")

    async with _client_for_user(db_session, user_a) as client_a:
        pair_a = await client_a.post(
            f"/api/channels/{account_id}/pair-codes",
            json={"agent_id": str(agent_a.id), "ttl_seconds": 900},
        )
    assert pair_a.status_code == 201

    async with _client_for_user(db_session, user_b) as client_b:
        pair_b = await client_b.post(
            f"/api/channels/{account_id}/pair-codes",
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
        f"/api/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8101, f"/bot_pair {pair_a.json()['code']}", 1111),
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
        f"/api/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8102, "/bot_unpair", 2222),
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
                    ChannelMessage.text
                    == "Only the user who paired this chat can change its pairing.",
            )
            .order_by(ChannelMessage.created_at.desc())
            .limit(1)
        )
    ).scalar_one()
    assert bob_unpair_reply.binding_id is None
    assert bob_unpair_reply.bot_agent_link_id is None

    bob_takeover = await client.post(
        f"/api/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8103, f"/bot_pair {pair_b.json()['code']}", 2222),
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
                    ChannelMessage.text
                    == "Only the user who paired this chat can change its pairing.",
            )
            .order_by(ChannelMessage.created_at.desc())
            .limit(1)
        )
    ).scalar_one()
    assert bob_takeover_reply.binding_id is None
    assert bob_takeover_reply.bot_agent_link_id is None

    pair_code_b = (
        await db_session.execute(
            select(ChannelPairCode).where(ChannelPairCode.id == UUID(pair_b.json()["id"]))
        )
    ).scalar_one()
    assert pair_code_b.status == "pending"
    assert pair_code_b.claimed_external_chat_id is None
    assert pair_code_b.claimed_external_user_id is None

    alice_unpair = await client.post(
        f"/api/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8104, "/bot_unpair", 1111),
    )
    assert alice_unpair.status_code == 200
    assert alice_unpair.json()["unpaired"] is True
    await db_session.refresh(binding)
    assert binding.status == "archived"

    paired_b = await client.post(
        f"/api/channels/telegram/{account_id}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_secret},
        json=group_command(8105, f"/bot_pair {pair_b.json()['code']}", 2222),
    )
    assert paired_b.status_code == 200
    assert paired_b.json()["paired"] is True

    active_binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.external_chat_id == "-99002",
                ChannelBinding.status == "active",
            )
        )
    ).scalar_one()
    assert active_binding.user_id == user_b.id
    assert active_binding.paired_external_user_id == "2222"
    await db_session.refresh(pair_code_b)
    assert pair_code_b.status == "claimed"
    assert pair_code_b.claimed_external_chat_id == "-99002"
    assert pair_code_b.claimed_external_user_id == "2222"


@pytest.mark.asyncio
async def test_group_pairing_requires_external_actor(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-group-missing-actor"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 8201,
            "message": {
                "message_id": 8201,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": -99003, "type": "supergroup", "title": "Ops"},
            },
        },
    )
    assert paired.status_code == 200
    assert paired.json()["paired"] is False

    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
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
            "/api/channels",
            json={"provider": "telegram", "name": f"telegram-race-{uuid4().hex}"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    async def _raise_integrity_error(*_args, **_kwargs):
        raise IntegrityError("insert channel binding", {}, Exception("unique active binding"))

    monkeypatch.setattr(channel_service, "get_or_create_binding", _raise_integrity_error)

    paired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is False
    assert paired.json()["binding_id"] is None
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
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
async def test_telegram_bot_api_get_updates_reads_paired_inbox(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-agent"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 1,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "hello agent",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )

    updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates",
        params={"offset": 2},
    )

    assert updates.status_code == 200
    assert updates.json()["ok"] is True
    assert updates.json()["result"] == [
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "hello agent",
                "chat": {"id": 222, "type": "private"},
            },
        }
    ]


@pytest.mark.asyncio
async def test_telegram_bot_api_accepts_official_bot_path_shape(client: httpx.AsyncClient):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-official-path",
        chat_id="333",
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "text": "official path",
                "chat": {"id": 333, "type": "private"},
            },
        },
    )

    updates = await client.get(
        f"/api/channels/telegram/bot{created['agent_token']}/getUpdates",
        params={"offset": 3},
    )
    delete_webhook = await client.post(
        f"/api/channels/telegram/bot{created['agent_token']}/deleteWebhook",
    )

    assert updates.status_code == 200
    assert updates.json()["ok"] is True
    assert updates.json()["result"][0]["message"]["text"] == "official path"
    assert delete_webhook.status_code == 200
    assert delete_webhook.json() == {"ok": True, "result": True}


@pytest.mark.asyncio
async def test_telegram_repair_moves_chat_to_new_agent_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-public-bot",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    default_pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    workspace_pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"agent_id": str(second_channel_agent.id), "ttl_seconds": 900},
        )
    ).json()
    assert workspace_pair["agent_link_id"] != created["agent_link_id"]
    assert workspace_pair["agent_token"]

    async def post_update(update_id: int, text: str):
        return await client.post(
            f"/api/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": text,
                    "chat": {"id": 777, "type": "private"},
                },
            },
        )

    default_claim = await post_update(101, f"/bot_pair {default_pair['code']}")
    workspace_claim = await post_update(102, f"/bot_pair {workspace_pair['code']}")
    inbound = await post_update(103, "shared chat update")
    assert default_claim.status_code == 200
    assert default_claim.json()["paired"] is True
    assert workspace_claim.status_code == 200
    assert workspace_claim.json()["paired"] is True
    assert inbound.status_code == 200

    messages = (
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    ChannelMessage.external_chat_id == "777",
                    ChannelMessage.provider_message_id == "103",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(messages) == 1
    assert str(messages[0].bot_agent_link_id) == workspace_pair["agent_link_id"]

    default_updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates",
        params={"offset": 103},
    )
    workspace_updates = await client.get(
        f"/api/channels/telegram/bot/{workspace_pair['agent_token']}/getUpdates",
        params={"offset": 103},
    )
    assert default_updates.status_code == 200
    assert workspace_updates.status_code == 200
    assert default_updates.json()["result"] == []
    assert workspace_updates.json()["result"] == [
        {
            "update_id": 103,
            "message": {
                "message_id": 103,
                "text": "shared chat update",
                "chat": {"id": 777, "type": "private"},
            },
        }
    ]


async def _paired_telegram_shared_chat(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": f"telegram-shared-{uuid4().hex}",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    default_pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    workspace_pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"agent_id": str(second_channel_agent.id), "ttl_seconds": 900},
        )
    ).json()

    async def post_update(update_id: int, text: str):
        return await client.post(
            f"/api/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": text,
                    "chat": {"id": 888, "type": "private"},
                },
            },
        )

    assert (await post_update(201, f"/bot_pair {default_pair['code']}")).json()["paired"] is True
    assert (await post_update(202, f"/bot_pair {workspace_pair['code']}")).json()["paired"] is True
    return created, workspace_pair, "888"


@pytest.mark.asyncio
async def test_telegram_unpair_archives_current_chat_route(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    created, _workspace_pair, chat_id = await _paired_telegram_shared_chat(
        client,
        channel_agent,
        second_channel_agent,
    )

    unpaired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 203,
            "message": {
                "message_id": 203,
                "text": "/bot_unpair",
                "chat": {"id": int(chat_id), "type": "private"},
            },
        },
    )
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")

    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert bindings.json() == []


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
    bindings = (await client.get(f"/api/channels/{created['id']}/bindings")).json()

    by_chat = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": chat_id, "text": "by-chat"},
    )
    explicit = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"binding_id": bindings[0]["id"], "text": "explicit"},
    )

    assert by_chat.status_code == 201
    assert by_chat.json()["external_chat_id"] == chat_id
    assert explicit.status_code == 201
    assert explicit.json()["external_chat_id"] == chat_id


@pytest.mark.asyncio
async def test_telegram_same_provider_multiple_bots_are_account_scoped(
    client: httpx.AsyncClient,
):
    first = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-bot-one"},
        )
    ).json()
    second = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-bot-two"},
        )
    ).json()
    assert first["agent_id"] == second["agent_id"]
    assert first["agent_link_id"] != second["agent_link_id"]
    assert first["agent_token"] != second["agent_token"]

    async def pair_and_post(account: dict[str, Any], update_id: int, text: str) -> None:
        pair = (
            await client.post(
                f"/api/channels/{account['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()
        paired = await client.post(
            f"/api/channels/telegram/{account['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": f"/bot_pair {pair['code']}",
                    "chat": {"id": 888, "type": "private"},
                },
            },
        )
        inbound = await client.post(
            f"/api/channels/telegram/{account['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
            json={
                "update_id": update_id + 1,
                "message": {
                    "message_id": update_id + 1,
                    "text": text,
                    "chat": {"id": 888, "type": "private"},
                },
            },
        )
        assert paired.status_code == 200
        assert paired.json()["paired"] is True
        assert inbound.status_code == 200

    await pair_and_post(first, 201, "first bot update")
    await pair_and_post(second, 301, "second bot update")

    first_updates = await client.get(
        f"/api/channels/telegram/bot/{first['agent_token']}/getUpdates",
        params={"offset": 202},
    )
    second_updates = await client.get(
        f"/api/channels/telegram/bot/{second['agent_token']}/getUpdates",
        params={"offset": 302},
    )
    first_token_cannot_read_second_bot = await client.get(
        f"/api/channels/telegram/bot/{first['agent_token']}/getUpdates",
        params={"offset": 302},
    )
    assert first_updates.status_code == 200
    assert second_updates.status_code == 200
    assert first_token_cannot_read_second_bot.status_code == 200
    assert first_updates.json()["result"][0]["message"]["text"] == "first bot update"
    assert second_updates.json()["result"][0]["message"]["text"] == "second bot update"
    assert first_token_cannot_read_second_bot.json()["result"] == []


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_empty_allowed_updates_delivers_all(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-allowed-updates-empty",
        chat_id="222",
        provider_token=None,
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "empty allowlist still arrives",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )

    updates = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates",
        json={"offset": 2, "allowed_updates": []},
    )

    assert updates.status_code == 200
    assert updates.json()["result"][0]["message"]["text"] == "empty allowlist still arrives"


@pytest.mark.asyncio
async def test_telegram_webhook_synthesizes_bot_command_entities(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-entities",
        chat_id="222",
        provider_token=None,
    )
    inbound = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "text": "/start hello",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates",
        params={"offset": 3},
    )

    assert inbound.status_code == 200
    assert updates.status_code == 200
    assert updates.json()["result"][0]["message"]["entities"] == [
        {"type": "bot_command", "offset": 0, "length": 6}
    ]


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_allowed_updates_drains_filtered_rows(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-allowed-updates-filter",
        chat_id="222",
        provider_token=None,
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "filtered out",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "callback_query": {
                "id": "cb-allowed",
                "message": {"chat": {"id": 222, "type": "private"}},
                "data": "button",
            },
        },
    )

    updates = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates",
        json={"offset": 2, "allowed_updates": ["callback_query"]},
    )
    filtered_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == UUID(created["id"]),
                ChannelMessage.text == "filtered out",
            )
        )
    ).scalar_one()

    assert updates.status_code == 200
    assert updates.json()["result"] == [
        {
            "update_id": 3,
            "callback_query": {
                "id": "cb-allowed",
                "message": {"chat": {"id": 222, "type": "private"}},
                "data": "button",
            },
        }
    ]
    assert filtered_message.delivered_at is not None


@pytest.mark.asyncio
async def test_telegram_get_updates_wait_helper_sees_new_committed_update(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-long-poll",
        chat_id="222",
        provider_token=None,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async with sessionmaker() as wait_session:
        account = (
            await wait_session.execute(
                select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
            )
        ).scalar_one()
        pending = asyncio.create_task(
            wait_for_telegram_updates(
                wait_session,
                account=account,
                offset=2,
                limit=100,
                timeout_seconds=1,
                poll_interval_seconds=0.005,
            )
        )
        await asyncio.sleep(0.01)
        async with sessionmaker() as insert_session:
            binding = (
                await insert_session.execute(
                    select(ChannelBinding).where(
                        ChannelBinding.account_id == UUID(created["id"]),
                        ChannelBinding.external_chat_id == "222",
                    )
                )
            ).scalar_one()
            insert_session.add(
                ChannelMessage(
                    account_id=binding.account_id,
                    bot_agent_link_id=binding.bot_agent_link_id,
                    binding_id=binding.id,
                    user_id=binding.user_id,
                    direction=MESSAGE_DIRECTION_INBOUND,
                    external_chat_id="222",
                    provider_message_id="2",
                    text="arrived during long poll",
                    payload={
                        "update_id": 2,
                        "message": {
                            "message_id": 2,
                            "text": "arrived during long poll",
                            "chat": {"id": 222, "type": "private"},
                        },
                    },
                )
            )
            await insert_session.commit()

        updates = await pending

    assert updates == [
        {
            "update_id": 2,
            "message": {
                "message_id": 2,
                "text": "arrived during long poll",
                "chat": {"id": 222, "type": "private"},
            },
        }
    ]


@pytest.mark.asyncio
async def test_telegram_bot_api_get_updates_long_poll_times_out_empty(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-long-poll-empty",
        chat_id="333",
        provider_token=None,
    )

    updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates",
        params={"offset": 2, "timeout": 1},
    )

    assert updates.status_code == 200
    assert updates.json() == {"ok": True, "result": []}


@pytest.mark.asyncio
async def test_telegram_bot_api_set_webhook_conflicts_with_get_updates(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-webhook-agent"},
        )
    ).json()

    set_webhook = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/webhook", "secret_token": "agent-secret"},
    )
    get_updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates"
    )

    assert set_webhook.status_code == 200
    assert set_webhook.json() == {"ok": True, "result": True}
    assert get_updates.status_code == 409
    assert get_updates.json()["ok"] is False
    assert get_updates.json()["error_code"] == 409


@pytest.mark.asyncio
async def test_telegram_agent_webhook_is_scoped_to_agent_link(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch,
):
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created, workspace_pair, chat_id = await _paired_telegram_shared_chat(
        client,
        channel_agent,
        second_channel_agent,
    )
    set_workspace_webhook = await client.post(
        f"/api/channels/telegram/bot/{workspace_pair['agent_token']}/setWebhook",
        json={"url": "https://agent.example/workspace-hook"},
    )
    default_get_updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates"
    )
    workspace_get_updates = await client.get(
        f"/api/channels/telegram/bot/{workspace_pair['agent_token']}/getUpdates"
    )
    inbound = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 204,
            "message": {
                "message_id": 204,
                "text": "link scoped delivery",
                "chat": {"id": int(chat_id), "type": "private"},
            },
        },
    )
    default_updates = await client.get(
        f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates"
    )

    assert set_workspace_webhook.status_code == 200
    assert default_get_updates.status_code == 200
    assert workspace_get_updates.status_code == 409
    assert inbound.status_code == 200
    assert len(_SequencedProviderClient.calls) == 1
    assert _SequencedProviderClient.calls[0]["url"] == "https://agent.example/workspace-hook"
    assert default_updates.json()["result"] == []


@pytest.mark.asyncio
async def test_telegram_get_me_proxies_provider_bot_identity(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client(
        {
            "ok": True,
            "result": {
                "id": 123456,
                "is_bot": True,
                "first_name": "Provider Bot",
                "username": "provider_bot",
            },
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-get-me",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    response = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMe",
        json={},
    )

    assert response.status_code == 200
    assert response.json()["result"]["username"] == "provider_bot"
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/getMe")


@pytest.mark.asyncio
async def test_telegram_set_webhook_rejects_private_targets(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-webhook-private"},
        )
    ).json()

    missing_url = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={},
    )
    private_url = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://127.0.0.1/hook"},
    )

    assert missing_url.status_code == 400
    assert missing_url.json()["description"] == "Bad Request: url is required"
    assert private_url.status_code == 400
    assert private_url.json()["ok"] is False
    assert "private host" in private_url.json()["description"]


@pytest.mark.asyncio
async def test_telegram_set_webhook_rejects_private_dns_targets(
    client: httpx.AsyncClient,
    monkeypatch,
):
    def fake_getaddrinfo(host, port):
        assert host == "agent-hook.example"
        assert port is None
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("10.0.0.5", 0),
            )
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-webhook-private-dns"},
        )
    ).json()

    response = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent-hook.example/hook"},
    )

    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "resolves to a private host" in response.json()["description"]


@pytest.mark.asyncio
async def test_user_channel_config_rejects_private_provider_urls(client: httpx.AsyncClient):
    response = await client.post(
        "/api/channels",
        json={
            "provider": "imessage",
            "name": "imessage-private-server-url",
            "provider_token": "bb-password",
            "config": {"server_url": "https://127.0.0.1:1234"},
        },
    )

    assert response.status_code == 400
    assert "private host" in response.json()["detail"]


@pytest.mark.asyncio
async def test_user_channel_config_rejects_malformed_provider_urls(client: httpx.AsyncClient):
    response = await client.post(
        "/api/channels",
        json={
            "provider": "imessage",
            "name": "imessage-malformed-server-url",
            "provider_token": "bb-password",
            "config": {"server_url": "https://[::1"},
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "imessage server_url must use https"


@pytest.mark.asyncio
async def test_user_channel_config_rejects_insecure_discord_gateway_url(
    client: httpx.AsyncClient,
):
    response = await client.post(
        "/api/channels",
        json={
            "provider": "discord",
            "name": "discord-insecure-gateway-url",
            "provider_token": "discord-token",
            "config": {"gateway_url": "ws://gateway.discord.gg"},
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "discord gateway_url must use wss"


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
    assert "private host" in str(exc.value.detail)
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_command_sync_rejects_private_provider_base_url(monkeypatch):
    _reset_fake_provider_client()
    monkeypatch.setattr(
        "app.services.channels.httpx.AsyncClient",
        _FakeProviderClient,
    )
    monkeypatch.setattr(settings, "channel_telegram_api_base_url", "https://127.0.0.1")
    ciphertext, nonce = encrypt_optional_token("telegram-token")
    account = ChannelAccount(
        provider="telegram",
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
    )

    with pytest.raises(HTTPException) as exc:
        await channel_service.sync_telegram_commands(account=account, commands=[])

    assert exc.value.status_code == 400
    assert "private host" in str(exc.value.detail)
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_bot_profile_shadow_is_account_scoped(client: httpx.AsyncClient):
    account_a = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-profile-a"},
        )
    ).json()
    account_b = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-profile-b"},
        )
    ).json()

    set_name = await client.post(
        f"/api/channels/telegram/bot/{account_a['agent_token']}/setMyName",
        json={"name": "Tenant A Bot"},
    )
    get_a = await client.post(
        f"/api/channels/telegram/bot/{account_a['agent_token']}/getMyName",
        json={},
    )
    get_b = await client.post(
        f"/api/channels/telegram/bot/{account_b['agent_token']}/getMyName",
        json={},
    )

    assert set_name.status_code == 200
    assert set_name.json() == {"ok": True, "result": True}
    assert get_a.json() == {"ok": True, "result": {"name": "Tenant A Bot"}}
    assert get_b.json() == {"ok": True, "result": {"name": ""}}


@pytest.mark.asyncio
async def test_telegram_bot_commands_are_shadowed_and_scope_checked(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-shadow",
        chat_id="42",
        provider_token=None,
    )

    set_commands = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={"commands": [{"command": "start", "description": "Start"}]},
    )
    get_commands = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMyCommands",
        json={},
    )
    wrong_scope = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMyCommands",
        json={"scope": {"type": "chat", "chat_id": 99}},
    )

    assert set_commands.status_code == 200
    assert get_commands.json() == {
        "ok": True,
        "result": [{"command": "start", "description": "Start"}],
    }
    assert wrong_scope.status_code == 403
    assert wrong_scope.json()["ok"] is False


@pytest.mark.asyncio
async def test_telegram_bot_commands_preserve_scope_language_and_delete(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-scope-language",
        chat_id="42",
        provider_token=None,
    )

    default_en = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={"commands": [{"command": "start", "description": "Start"}]},
    )
    default_es = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={
            "language_code": "es",
            "commands": [{"command": "start", "description": "Inicio"}],
        },
    )
    chat_scope = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={
            "scope": {"type": "chat", "chat_id": "42"},
            "commands": [{"command": "deploy", "description": "Deploy"}],
        },
    )
    get_default_en = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMyCommands",
        json={},
    )
    get_default_es = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMyCommands",
        json={"language_code": "es"},
    )
    get_chat_scope = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMyCommands",
        json={"scope": {"type": "chat", "chat_id": "42"}},
    )
    deleted_es = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/deleteMyCommands",
        json={"language_code": "es"},
    )
    get_deleted_es = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMyCommands",
        json={"language_code": "es"},
    )

    assert default_en.status_code == 200
    assert default_es.status_code == 200
    assert chat_scope.status_code == 200
    assert get_default_en.json()["result"] == [{"command": "start", "description": "Start"}]
    assert get_default_es.json()["result"] == [{"command": "start", "description": "Inicio"}]
    assert get_chat_scope.json()["result"] == [{"command": "deploy", "description": "Deploy"}]
    assert deleted_es.status_code == 200
    assert get_deleted_es.json()["result"] == [
        {"command": "bot_pair", "description": "Pair this chat with Clawdi."},
        {"command": "bot_unpair", "description": "Disconnect this chat from Clawdi."},
    ]


@pytest.mark.asyncio
async def test_telegram_set_my_commands_fans_out_to_bound_chats(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-command-fanout",
        chat_id="42",
        chat_type="private",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="-100",
        update_id=2,
        chat_type="group",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="-200",
        update_id=3,
        chat_type="supergroup",
    )
    await _pair_telegram_chat(client, created=created, chat_id="99", update_id=4)

    response = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={"commands": [{"command": "start", "description": "Start"}]},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "result": True}
    assert {
        (call["json"]["scope"]["chat_id"], call["json"]["scope"]["type"])
        for call in _FakeProviderClient.calls
    } == {
        ("42", "chat"),
        ("-100", "chat_administrators"),
        ("-200", "chat_administrators"),
        ("99", "chat"),
    }
    assert all(
        call["url"].endswith("/bot123456:telegram-secret/setMyCommands")
        for call in _FakeProviderClient.calls
    )

    _FakeProviderClient.calls = []
    private_scope = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={
            "commands": [{"command": "start", "description": "Start"}],
            "scope": {"type": "all_private_chats"},
        },
    )

    assert private_scope.status_code == 200
    assert {call["json"]["scope"]["chat_id"] for call in _FakeProviderClient.calls} == {"42", "99"}

    _FakeProviderClient.calls = []
    group_scope = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={
            "commands": [{"command": "group", "description": "Group"}],
            "scope": {"type": "all_group_chats"},
        },
    )

    assert group_scope.status_code == 200
    assert {
        (call["json"]["scope"]["chat_id"], call["json"]["scope"]["type"])
        for call in _FakeProviderClient.calls
    } == {("-100", "chat"), ("-200", "chat")}

    _FakeProviderClient.calls = []
    admin_scope = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={
            "commands": [{"command": "admin", "description": "Admin"}],
            "scope": {"type": "all_chat_administrators"},
        },
    )

    assert admin_scope.status_code == 200
    assert {
        (call["json"]["scope"]["chat_id"], call["json"]["scope"]["type"])
        for call in _FakeProviderClient.calls
    } == {("-100", "chat_administrators"), ("-200", "chat_administrators")}


@pytest.mark.asyncio
async def test_telegram_pairing_replays_stored_broad_scope_commands(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-command-replay-on-pair",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    commands = [{"command": "welcome", "description": "Say hi"}]
    stored = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setMyCommands",
        json={"commands": commands},
    )
    assert stored.status_code == 200
    _reset_fake_provider_client({"ok": True, "result": True})

    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 51,
            "message": {
                "message_id": 51,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 777, "type": "private"},
                "from": {"id": 777, "is_bot": False},
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is True
    command_calls = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/setMyCommands")
    ]
    assert len(command_calls) == 1
    assert command_calls[0]["json"] == {
        "commands": commands,
        "scope": {"type": "chat", "chat_id": "777"},
    }


@pytest.mark.asyncio
async def test_telegram_generic_bot_api_proxies_only_bound_chats(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-generic-proxy",
        chat_id="42",
    )
    await _pair_telegram_chat(client, created=created, chat_id="99", update_id=2)

    edit = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/editMessageText",
        json={"chat_id": 42, "message_id": 1, "text": "edited"},
    )
    copy = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/copyMessage",
        json={"chat_id": 42, "from_chat_id": 99, "message_id": 1},
    )
    blocked_reply = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/sendMessage",
        json={
            "chat_id": 42,
            "text": "reply",
            "reply_parameters": {"chat_id": 100, "message_id": 1},
        },
    )
    no_chat = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/answerInlineQuery",
        json={"inline_query_id": "inline-1", "results": []},
    )

    assert edit.status_code == 200
    assert edit.json()["ok"] is True
    assert copy.status_code == 200
    assert blocked_reply.status_code == 403
    assert (
        blocked_reply.json()["description"] == "Forbidden: referenced chat is not bound to this bot"
    )
    assert no_chat.status_code == 403
    assert no_chat.json()["description"] == "Forbidden: method requires a bound chat_id"
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/bot123456:telegram-secret/editMessageText"
    )
    assert json.loads(_FakeProviderClient.calls[0]["content"].decode("utf-8"))["chat_id"] == 42


@pytest.mark.asyncio
async def test_telegram_multipart_reply_parameters_are_scope_checked(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-multipart-scope",
        chat_id="42",
    )

    response = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/sendPhoto",
        data={
            "chat_id": "42",
            "caption": "photo",
            "reply_parameters": json.dumps({"chat_id": 99, "message_id": 7}),
        },
        files={"photo": ("photo.png", b"PNGDATA", "image/png")},
    )

    assert response.status_code == 403
    assert response.json()["description"] == "Forbidden: referenced chat is not bound to this bot"


@pytest.mark.asyncio
async def test_telegram_multipart_attach_refs_are_rewritten_before_proxy(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-attach-rewrite",
        chat_id="42",
    )

    response = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/sendPhoto",
        data={"chat_id": "42", "photo": "attach://photo_file"},
        files={"photo_file": ("photo.png", b"PNGDATA", "image/png")},
    )

    forwarded = _FakeProviderClient.calls[0]["content"].decode("latin-1")
    assert response.status_code == 200
    assert 'name="photo"; filename="photo.png"' in forwarded
    assert "attach://photo_file" not in forwarded
    assert 'name="photo_file"; filename="photo.png"' not in forwarded


@pytest.mark.asyncio
async def test_telegram_send_methods_are_rate_limited(
    client: httpx.AsyncClient,
    monkeypatch,
):
    telegram_rate_limiter.reset()
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-rate-limit",
        chat_id="42",
    )

    for index in range(5):
        response = await client.post(
            f"/api/channels/telegram/bot/{created['agent_token']}/sendMessage",
            json={"chat_id": 42, "text": f"msg{index}"},
        )
        assert response.status_code == 200

    limited = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/sendMessage",
        json={"chat_id": 42, "text": "overflow"},
    )

    assert limited.status_code == 429
    assert limited.json()["ok"] is False
    assert limited.json()["parameters"]["retry_after"] >= 1


@pytest.mark.asyncio
async def test_telegram_delete_webhook_drop_pending_updates(client: httpx.AsyncClient):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-drop-pending",
        chat_id="42",
        provider_token=None,
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
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
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/webhook"},
    )

    deleted = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/deleteWebhook",
        json={"drop_pending_updates": True},
    )
    updates = await client.get(f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates")

    assert deleted.status_code == 200
    assert updates.status_code == 200
    assert updates.json() == {"ok": True, "result": []}


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
        f"/api/channels/telegram/bot/{created['agent_token']}/getMe",
        content=b"{",
        headers={"content-type": "application/json"},
    )
    non_object = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getMe",
        json=[],
    )

    assert malformed.status_code == 400
    assert malformed.json()["detail"] == "invalid json"
    assert non_object.status_code == 400
    assert non_object.json()["detail"] == "json object required"


@pytest.mark.asyncio
async def test_channel_request_parsing_accepts_form_encoded_wire_values(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-form-parse",
        chat_id="42",
        provider_token=None,
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
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
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/webhook"},
    )

    deleted = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/deleteWebhook",
        data={"drop_pending_updates": "true"},
    )
    updates = await client.get(f"/api/channels/telegram/bot/{created['agent_token']}/getUpdates")

    assert deleted.status_code == 200
    assert updates.json() == {"ok": True, "result": []}


@pytest.mark.asyncio
async def test_telegram_agent_webhook_success_acks_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-ack",
        provider_token=None,
    )
    set_webhook = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )

    inbound = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 901,
            "message": {
                "message_id": 901,
                "text": "deliver to agent",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "901")
        )
    ).scalar_one()
    assert set_webhook.status_code == 200
    assert inbound.status_code == 200
    assert message.delivered_at is not None
    assert _SequencedProviderClient.calls[0]["headers"] == {
        "X-Telegram-Bot-Api-Secret-Token": "agent-secret"
    }
    assert _SequencedProviderClient.calls[0]["json"]["message"]["text"] == "deliver to agent"


@pytest.mark.asyncio
async def test_telegram_agent_webhook_4xx_does_not_ack_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([403, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-4xx",
        provider_token=None,
    )
    set_webhook = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )

    inbound = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 904,
            "message": {
                "message_id": 904,
                "text": "do not ack 4xx",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "904")
        )
    ).scalar_one()
    assert set_webhook.status_code == 200
    assert inbound.status_code == 200
    assert message.delivered_at is None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_agent_webhook_revalidates_dns_at_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    resolutions = [
        ("8.8.8.8", 0),
        ("10.0.0.5", 0),
    ]

    def fake_getaddrinfo(host, port):
        assert host == "agent-hook.example"
        assert port is None
        address = resolutions.pop(0)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", address)]

    _reset_fake_provider_client()
    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-dns-revalidate",
        provider_token=None,
    )
    set_webhook = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent-hook.example/agent-hook"},
    )

    inbound = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 905,
            "message": {
                "message_id": 905,
                "text": "dns rebind",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "905")
        )
    ).scalar_one()
    assert set_webhook.status_code == 200
    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_telegram_webhook_worker_retries_failed_agent_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-retry",
        provider_token=None,
    )
    await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 902,
            "message": {
                "message_id": 902,
                "text": "retry to agent",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "902")
        )
    ).scalar_one()
    assert message.delivered_at is None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_webhook_worker_skips_non_webhook_queue_head(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    polling_channel = await _create_paired_telegram_channel(
        client,
        name="telegram-worker-polling-queue-head",
        provider_token=None,
        chat_id="4201",
    )
    webhook_channel = await _create_paired_telegram_channel(
        client,
        name="telegram-worker-webhook-behind-queue-head",
        provider_token=None,
        chat_id="4202",
    )
    await client.post(
        f"/api/channels/telegram/bot/{webhook_channel['agent_token']}/setWebhook",
        json={"url": "https://agent.example/agent-hook"},
    )

    polling_binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(polling_channel["id"]),
            )
        )
    ).scalar_one()
    for index in range(101):
        db_session.add(
            ChannelMessage(
                account_id=polling_binding.account_id,
                bot_agent_link_id=polling_binding.bot_agent_link_id,
                binding_id=polling_binding.id,
                user_id=polling_binding.user_id,
                direction=MESSAGE_DIRECTION_INBOUND,
                external_chat_id=polling_binding.external_chat_id,
                provider_message_id=f"polling-{index}",
                text="polling mode pending",
                payload={},
            )
        )
    await db_session.flush()

    inbound = await client.post(
        f"/api/channels/telegram/{webhook_channel['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": webhook_channel["webhook_secret"]},
        json={
            "update_id": 906,
            "message": {
                "message_id": 906,
                "text": "behind polling queue",
                "chat": {"id": 4202, "type": "private"},
            },
        },
    )
    webhook_message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "906")
        )
    ).scalar_one()
    assert inbound.status_code == 200
    assert webhook_message.delivered_at is None

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(webhook_message)

    assert result is not None
    assert result.message_id == webhook_message.id
    assert result.delivered is True
    assert webhook_message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_webhook_worker_drops_expired_agent_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-agent-webhook-ttl",
        provider_token=None,
    )
    await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/setWebhook",
        json={"url": "https://agent.example/agent-hook"},
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 903,
            "message": {
                "message_id": 903,
                "text": "expire agent delivery",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "903")
        )
    ).scalar_one()
    message.created_at = datetime.now(UTC) - timedelta(days=2)
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker, ttl_seconds=60).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.expired is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_callback_query_answer_requires_recorded_reference(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"callback_query_id": "cb-1"}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-callback-ref",
        chat_id="42",
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "callback_query": {
                "id": "cb-1",
                "data": "approve",
                "message": {
                    "message_id": 2,
                    "chat": {"id": 42, "type": "private"},
                },
            },
        },
    )

    owned = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/answerCallbackQuery",
        json={"callback_query_id": "cb-1", "text": "ok"},
    )
    unowned = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/answerCallbackQuery",
        json={"callback_query_id": "cb-other", "text": "ok"},
    )

    assert owned.status_code == 200
    assert owned.json()["ok"] is True
    assert unowned.status_code == 403
    assert unowned.json()["description"] == "Forbidden: callback_query_id is not bound to this bot"


@pytest.mark.asyncio
async def test_telegram_get_file_records_path_and_download_is_scoped(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"file_path": "photos/file_1.jpg"}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-file-ref",
        chat_id="42",
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": 42, "type": "private"},
                "document": {"file_id": "file_1", "file_name": "report.pdf"},
            },
        },
    )

    get_file = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getFile",
        json={"file_id": "file_1"},
    )
    unowned_file = await client.post(
        f"/api/channels/telegram/bot/{created['agent_token']}/getFile",
        json={"file_id": "file_other"},
    )
    _reset_fake_provider_client(
        {"ok": True},
        content=b"telegram-file",
        headers={"content-type": "text/plain"},
    )
    download = await client.get(
        f"/api/channels/telegram/file/bot/{created['agent_token']}/photos/file_1.jpg"
    )
    unowned_download = await client.get(
        f"/api/channels/telegram/file/bot/{created['agent_token']}/photos/other.jpg"
    )

    assert get_file.status_code == 200
    assert get_file.json()["result"]["file_path"] == "photos/file_1.jpg"
    assert unowned_file.status_code == 403
    assert unowned_file.json()["description"] == "Forbidden: file_id is not bound to this bot"
    assert download.status_code == 200
    assert download.text == "telegram-file"
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/file/bot123456:telegram-secret/photos/file_1.jpg"
    )
    assert unowned_download.status_code == 403
    assert unowned_download.json()["description"] == "Forbidden: file_path is not bound to this bot"


@pytest.mark.asyncio
async def test_discord_rest_gateway_bot_uses_agent_token(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-agent",
                "config": {"application_id": "app-agent"},
            },
        )
    ).json()

    response = await client.get(
        "/api/channels/discord/v10/gateway/bot",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == 200
    assert response.json()["url"].endswith("/api/channels/discord/gateway")
    assert response.json()["shards"] == 1


@pytest.mark.asyncio
async def test_discord_rest_accepts_preserve_path_mitm_alias(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-agent-preserve-path",
                "config": {"application_id": "app-agent"},
            },
        )
    ).json()

    response = await client.get(
        "/api/channels/discord/api/v10/gateway/bot",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert response.status_code == 200
    assert response.json()["url"].endswith("/api/channels/discord/gateway")


@pytest.mark.asyncio
async def test_discord_rest_application_commands_are_tenant_shadowed(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-command-shadow",
                "config": {"application_id": "app-shadow"},
            },
        )
    ).json()
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    updated = await client.put(
        "/api/channels/discord/v10/applications/app-shadow/commands",
        headers=headers,
        json=[{"name": "deploy", "description": "Deploy a service"}],
    )
    listed = await client.get(
        "/api/channels/discord/v10/applications/app-shadow/commands", headers=headers
    )
    reserved = await client.post(
        "/api/channels/discord/v10/applications/app-shadow/commands",
        headers=headers,
        json={"name": "bot_pair", "description": "bad"},
    )

    assert updated.status_code == 200
    assert updated.json()[0]["name"] == "deploy"
    assert listed.json()[0]["description"] == "Deploy a service"
    assert reserved.status_code == 400


@pytest.mark.asyncio
async def test_discord_application_command_lifecycle_is_tenant_shadowed(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-command-lifecycle",
                "config": {"application_id": "app-lifecycle"},
            },
        )
    ).json()
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    created_command = await client.post(
        "/api/channels/discord/v10/applications/app-lifecycle/commands",
        headers=headers,
        json={"name": "deploy", "description": "Deploy"},
    )
    command_id = created_command.json()["id"]
    edited = await client.patch(
        f"/api/channels/discord/v10/applications/app-lifecycle/commands/{command_id}",
        headers=headers,
        json={"description": "Deploy service"},
    )
    listed = await client.get(
        "/api/channels/discord/v10/applications/app-lifecycle/commands",
        headers=headers,
    )
    deleted = await client.delete(
        f"/api/channels/discord/v10/applications/app-lifecycle/commands/{command_id}",
        headers=headers,
    )
    missing = await client.patch(
        "/api/channels/discord/v10/applications/app-lifecycle/commands/missing",
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
        "/api/channels/discord/v10/applications/app-lifecycle/guilds/guild-1/commands",
        headers=headers,
        json={"name": "guilddeploy", "description": "Guild deploy"},
    )
    guild_id = guild_created.json()["id"]
    guild_edited = await client.patch(
        f"/api/channels/discord/v10/applications/app-lifecycle/guilds/guild-1/commands/{guild_id}",
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
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-command-scope",
                "config": {"application_id": "app-scope"},
            },
        )
    ).json()
    headers = {"Authorization": f"Bot {created['agent_token']}"}

    wrong_app = await client.put(
        "/api/channels/discord/v10/applications/wrong-app/commands",
        headers=headers,
        json=[{"name": "deploy", "description": "Deploy"}],
    )
    unbound_guild = await client.put(
        "/api/channels/discord/v10/applications/app-scope/guilds/guild-404/commands",
        headers=headers,
        json=[{"name": "deploy", "description": "Deploy"}],
    )
    dm_create = await client.post(
        "/api/channels/discord/v10/users/@me/channels",
        headers=headers,
        json={"recipient_id": "user-1"},
    )
    unknown = await client.post(
        "/api/channels/discord/v10/unknown/path",
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
async def test_discord_global_commands_fan_out_only_to_uncontested_guilds(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_fake_provider_client([])
    monkeypatch.setattr(
        "app.routes.channel_routers.shared.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-command-fanout",
                "provider_token": "discord-provider-token",
                "config": {"application_id": "app-fanout"},
            },
        )
    ).json()
    other = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-command-contender",
                "config": {"application_id": "app-contender"},
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

    response = await client.put(
        "/api/channels/discord/v10/applications/app-fanout/commands",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "deploy", "description": "Deploy"}],
    )

    assert response.status_code == 200
    assert response.json()[0]["application_id"] == "app-fanout"
    assert response.json()[0]["name"] == "deploy"
    assert len(_FakeProviderClient.calls) == 1
    call = _FakeProviderClient.calls[0]
    assert call["method"] == "PUT"
    assert call["url"].endswith("/applications/app-fanout/guilds/guild-owned/commands")
    assert call["headers"]["Authorization"] == "Bot discord-provider-token"
    assert call["json"][0]["application_id"] == "app-fanout"


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
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-command-replay-on-pair",
                "provider_token": "discord-provider-token",
                "config": {"application_id": "app-replay"},
            },
        )
    ).json()
    commands = [{"name": "deploy", "description": "Deploy"}]
    stored = await client.put(
        "/api/channels/discord/v10/applications/app-replay/commands",
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=commands,
    )
    assert stored.status_code == 200
    _reset_fake_provider_client({"id": "provider-ok"})

    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-pair-replay",
                "channel_id": "chan-replay",
                "guild_id": "guild-replay",
                "content": f"/bot_pair {pair['code']}",
                "author": {"id": "discord-replay-user"},
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is True
    command_calls = [
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "PUT"
        and call["url"].endswith("/applications/app-replay/guilds/guild-replay/commands")
    ]
    assert len(command_calls) == 1
    assert command_calls[0]["json"][0]["name"] == "deploy"


@pytest.mark.asyncio
async def test_discord_interaction_callback_and_followup_require_recorded_token(
    client: httpx.AsyncClient,
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
        application_id="discord-app-123",
    )
    await _record_discord_interaction(
        client,
        created=created,
        interaction_id="interaction-1",
        token="interaction-token-1",
        application_id="discord-app-123",
    )
    other = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-interaction-other",
                "provider_token": "discord-provider-token-2",
                "config": {"application_id": "discord-app-123"},
            },
        )
    ).json()

    headers = {"Authorization": f"Bot {created['agent_token']}"}
    callback = await client.post(
        "/api/channels/discord/v10/interactions/interaction-1/interaction-token-1/callback",
        headers=headers,
        json={"type": 4, "data": {"content": "pong"}},
    )
    wrong_id = await client.post(
        "/api/channels/discord/v10/interactions/wrong/interaction-token-1/callback",
        headers=headers,
        json={"type": 4, "data": {"content": "pong"}},
    )
    wrong_tenant = await client.post(
        "/api/channels/discord/v10/interactions/interaction-1/interaction-token-1/callback",
        headers={"Authorization": f"Bot {other['agent_token']}"},
        json={"type": 4},
    )
    followup = await client.post(
        "/api/channels/discord/v10/webhooks/discord-app-123/interaction-token-1",
        headers=headers,
        json={"content": "followup"},
    )
    edit_original = await client.patch(
        "/api/channels/discord/v10/webhooks/discord-app-123/interaction-token-1/messages/@original",
        headers=headers,
        json={"content": "edited"},
    )
    wrong_app = await client.post(
        "/api/channels/discord/v10/webhooks/wrong-app/interaction-token-1",
        headers=headers,
        json={"content": "nope"},
    )
    unknown_token = await client.post(
        "/api/channels/discord/v10/webhooks/discord-app-123/unknown-token",
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
        "/webhooks/discord-app-123/interaction-token-1"
    )
    assert _FakeProviderClient.calls[2]["method"] == "PATCH"


@pytest.mark.asyncio
async def test_discord_bot_profile_shadow_is_account_scoped(client: httpx.AsyncClient):
    account_a = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-profile-a",
                "config": {"application_id": "discord-app-profile-a"},
            },
        )
    ).json()
    account_b = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-profile-b",
                "config": {"application_id": "discord-app-profile-b"},
            },
        )
    ).json()
    headers_a = {"Authorization": f"Bot {account_a['agent_token']}"}
    headers_b = {"Authorization": f"Bot {account_b['agent_token']}"}

    default_a = await client.get("/api/channels/discord/v10/users/@me", headers=headers_a)
    patched_a = await client.patch(
        "/api/channels/discord/v10/users/@me",
        headers=headers_a,
        json={"username": "Tenant A Bot", "avatar": "data:image/png;base64,abc"},
    )
    get_a = await client.get("/api/channels/discord/v10/users/@me", headers=headers_a)
    get_b = await client.get("/api/channels/discord/v10/users/@me", headers=headers_b)
    app_a = await client.get("/api/channels/discord/v10/applications/@me", headers=headers_a)

    await client.patch(
        "/api/channels/discord/v10/users/@me",
        headers=headers_b,
        json={"username": "Tenant B Bot"},
    )
    app_b = await client.get("/api/channels/discord/v10/oauth2/applications/@me", headers=headers_b)

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
        "/api/channels/discord/v10/guilds/discord-guild-1/channels",
        headers=headers,
        json={"name": "ops", "type": 0},
    )
    channel_send = await client.post(
        "/api/channels/discord/v10/channels/discord-chan-1/messages",
        headers=headers,
        json={"content": "hello guild channel"},
    )
    blocked = await client.post(
        "/api/channels/discord/v10/guilds/discord-guild-2/channels",
        headers=headers,
        json={"name": "ops", "type": 0},
    )

    assert allowed.status_code == 200
    assert channel_send.status_code == 200
    assert channel_send.json()["channel_id"] == "discord-chan-1"
    assert blocked.status_code == 403
    assert blocked.json() == {"code": 50001, "message": "Missing Access"}
    assert _FakeProviderClient.calls[0]["url"].endswith("/guilds/discord-guild-1/channels")
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == (
        "Bot discord-provider-token"
    )
    assert _FakeProviderClient.calls[1]["url"].endswith("/channels/discord-chan-1/messages")


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
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-channel-alias-rest",
                "provider_token": "discord-provider-token",
                "config": {"application_id": "discord-app-alias"},
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
        "/api/channels/discord/v10/channels/chan-alias-rest/permissions/role-1",
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
async def test_whatsapp_graph_agent_send_uses_agent_token_and_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"messages": [{"id": "wamid.agent.pair-reply"}]}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-agent",
                "provider_token": "wa-provider-token",
                "config": {"phone_number_id": "phone-agent"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": "wamid.agent.pair",
                                        "from": "15550002222",
                                        "text": {"body": f"/bot_pair {pair['code']}"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        },
    )
    _reset_fake_provider_client({"messages": [{"id": "wamid.agent.sent"}]})

    sent = await client.post(
        "/api/channels/whatsapp/graph/v20.0/phone-agent/messages",
        headers={"Authorization": f"Bearer {created['agent_token']}"},
        json={
            "messaging_product": "whatsapp",
            "to": "15550002222",
            "type": "text",
            "text": {"body": "hello wa agent"},
        },
    )

    assert sent.status_code == 200
    assert sent.json()["messages"][0]["id"] == "wamid.agent.sent"
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "wamid.agent.sent")
        )
    ).scalar_one()
    assert message.text == "hello wa agent"


@pytest.mark.asyncio
async def test_bluebubbles_agent_send_uses_agent_token_and_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"data": {"guid": "imsg-pair-reply"}}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-agent",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-pair",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15550001111"}],
            }
        },
    )
    _reset_fake_provider_client({"data": {"guid": "imsg-agent-sent"}})

    sent = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/text",
        params={"password": created["agent_token"]},
        json={"chatGuid": "iMessage;-;+15550001111", "message": "hello imessage"},
    )

    assert sent.status_code == 200
    assert sent.json()["data"]["guid"] == "imsg-agent-sent"
    assert _FakeProviderClient.calls[0]["json"]["chatGuid"] == "iMessage;-;+15550001111"
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "imsg-agent-sent")
        )
    ).scalar_one()
    assert message.text == "hello imessage"


@pytest.mark.asyncio
async def test_bluebubbles_agent_send_resolves_any_service_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"data": {"guid": "imsg-any-pair-reply"}}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-any-service",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-any-pair",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": "any;-;+15550001112"}],
            }
        },
    )
    _reset_fake_provider_client({"data": {"guid": "imsg-any-service-sent"}})

    sent = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/text",
        params={"password": created["agent_token"]},
        json={"chatGuid": "SMS;-;+15550001112", "message": "hello sms"},
    )

    assert sent.status_code == 200
    assert _FakeProviderClient.calls[0]["json"]["chatGuid"] == "SMS;-;+15550001112"
    message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.provider_message_id == "imsg-any-service-sent"
            )
        )
    ).scalar_one()
    assert message.external_chat_id == "any;-;+15550001112"


@pytest.mark.asyncio
async def test_bluebubbles_auth_accepts_password_api_key_x_password_and_bearer(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-auth-shapes",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    token = created["agent_token"]

    missing = await client.get("/api/channels/imessage/bluebubbles/v1/ping")
    password = await client.get(
        "/api/channels/imessage/bluebubbles/v1/ping",
        params={"password": token},
    )
    x_api_key = await client.get(
        "/api/channels/imessage/bluebubbles/v1/ping",
        headers={"X-API-Key": token},
    )
    x_password = await client.get(
        "/api/channels/imessage/bluebubbles/v1/ping",
        headers={"X-Password": token},
    )
    bearer = await client.get(
        "/api/channels/imessage/bluebubbles/v1/ping",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert missing.status_code == 401
    assert missing.json() == {"status": 401, "message": "missing agent token", "data": None}
    for response in (password, x_api_key, x_password, bearer):
        assert response.status_code == 200
        assert response.json()["data"]["message"] == "pong"


@pytest.mark.asyncio
async def test_bluebubbles_socketio_auth_packets_match_advanced_imessagekit(
    monkeypatch,
):
    async def fake_resolve_agent(db, *, provider: str, token: str) -> ChannelAgentContext:
        if provider == "imessage" and token == "fixed-imessage-token":
            account = ChannelAccount(
                id=UUID("00000000-0000-0000-0000-0000000000cc"),
                user_id=UUID("00000000-0000-0000-0000-0000000000dd"),
                provider="imessage",
                name="imessage-socket-auth",
                webhook_secret_hash="unused",
            )
            link = ChannelBotAgentLink(
                id=UUID("00000000-0000-0000-0000-0000000000cf"),
                account_id=account.id,
                user_id=account.user_id,
                agent_id=UUID("00000000-0000-0000-0000-0000000000ee"),
                agent_token_hash="unused",
            )
            return ChannelAgentContext(account=account, link=link)
        raise HTTPException(status_code=401, detail="invalid agent token")

    monkeypatch.setattr(
        "app.routes.channel_routers.imessage_realtime.resolve_channel_agent_by_token",
        fake_resolve_agent,
    )
    path = "/api/channels/imessage/bluebubbles/socket.io/?EIO=4&transport=websocket"

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(path) as websocket:
            assert websocket.receive_text().startswith("0{")
            websocket.send_text("40" + json.dumps({"apiKey": "fixed-imessage-token"}))
            assert websocket.receive_text().startswith("40{")
            assert websocket.receive_text() == '42["auth-ok"]'

        with sync_client.websocket_connect(path) as websocket:
            assert websocket.receive_text().startswith("0{")
            websocket.send_text("40" + json.dumps({"apiKey": "wrong"}))
            assert (
                websocket.receive_text()
                == '42["auth-error",{"message":"Unauthorized","reason":"invalid apiKey"}]'
            )
            with pytest.raises(WebSocketDisconnect):
                websocket.receive_text()

        with sync_client.websocket_connect(path) as websocket:
            assert websocket.receive_text().startswith("0{")
            websocket.send_text("40" + json.dumps({}))
            assert (
                websocket.receive_text()
                == '42["auth-error",{"message":"Unauthorized","reason":"missing apiKey"}]'
            )
            with pytest.raises(WebSocketDisconnect):
                websocket.receive_text()


@pytest.mark.asyncio
async def test_bluebubbles_socket_manager_emits_only_to_account():
    manager = BlueBubblesSocketManager()
    account_a = UUID("00000000-0000-0000-0000-0000000000aa")
    account_b = UUID("00000000-0000-0000-0000-0000000000bb")
    socket_a = _SocketProbe()
    socket_b = _SocketProbe()

    await manager.connect(socket_a, account_a)  # type: ignore[arg-type]
    await manager.connect(socket_b, account_b)  # type: ignore[arg-type]
    delivered = await manager.emit(
        account_a,
        "new-message",
        {"guid": "msg-1", "text": "hello"},
    )

    assert delivered == 1
    assert json.loads(socket_a.sent[-1][2:]) == [
        "new-message",
        {"guid": "msg-1", "text": "hello"},
    ]
    assert all("new-message" not in packet for packet in socket_b.sent)


@pytest.mark.asyncio
async def test_bluebubbles_webhook_self_registration_and_delete(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-webhook-agent",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    params = {"password": created["agent_token"]}

    registered = await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )
    listed = await client.get("/api/channels/imessage/bluebubbles/v1/webhook", params=params)
    deleted = await client.delete(
        f"/api/channels/imessage/bluebubbles/v1/webhook/{created['id']}", params=params
    )
    relisted = await client.get("/api/channels/imessage/bluebubbles/v1/webhook", params=params)

    assert registered.status_code == 200
    assert registered.json()["data"]["url"] == "https://agent.example/bluebubbles"
    assert listed.json()["data"][0]["events"]
    assert deleted.status_code == 200
    assert relisted.json()["data"] == []


@pytest.mark.asyncio
async def test_bluebubbles_server_info_advertises_private_api(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-server-info",
                "provider_token": "bb-password",
                "config": {
                    "server_url": "https://bluebubbles.example",
                    "detected_imessage": "+15550001111",
                },
            },
        )
    ).json()

    info = await client.get(
        "/api/channels/imessage/bluebubbles/v1/server/info",
        params={"password": created["agent_token"]},
    )

    assert info.status_code == 200
    assert info.json()["data"]["private_api"] is True
    assert info.json()["data"]["os_version"].startswith("15.")
    assert info.json()["data"]["detected_imessage"] == "+15550001111"


@pytest.mark.asyncio
async def test_bluebubbles_webhook_registration_rejects_unsafe_urls(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-webhook-ssrf",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    params = {"password": created["agent_token"]}

    plain_http = await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "http://example.com/webhook"},
    )
    loopback = await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://127.0.0.1/webhook"},
    )
    safe = await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://example.com/webhook"},
    )

    assert plain_http.status_code == 400
    assert plain_http.json() == {
        "status": 400,
        "message": "webhook url must use https",
        "data": None,
    }
    assert loopback.status_code == 400
    assert loopback.json() == {
        "status": 400,
        "message": "webhook url targets a private host",
        "data": None,
    }
    assert safe.status_code == 200


@pytest.mark.asyncio
async def test_bluebubbles_webhook_registration_rejects_private_dns_targets(
    client: httpx.AsyncClient,
    monkeypatch,
):
    def fake_getaddrinfo(host, port):
        assert port is None
        if host == "bluebubbles.example":
            return [
                (
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    6,
                    "",
                    ("8.8.8.8", 0),
                )
            ]
        assert host == "agent-hook.example"
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("169.254.169.254", 0),
            )
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-webhook-private-dns",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()

    response = await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params={"password": created["agent_token"]},
        json={"url": "https://agent-hook.example/bluebubbles"},
    )

    assert response.status_code == 400
    assert response.json() == {
        "status": 400,
        "message": "webhook url resolves to a private host",
        "data": None,
    }


@pytest.mark.asyncio
async def test_bluebubbles_webhook_delivery_no_config_does_not_call_agent(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-webhook-no-config",
        chat_guid="iMessage;-;+15550003333",
        webhook_message_guid="imsg-no-config-initial",
    )

    inbound = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-no-config-message",
                "text": "no webhook configured",
                "chats": [{"guid": "iMessage;-;+15550003333"}],
            }
        },
    )

    assert inbound.status_code == 200
    assert _SequencedProviderClient.calls == []


@pytest.mark.asyncio
async def test_bluebubbles_webhook_delivery_retries_5xx(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-webhook-retry",
        chat_guid="iMessage;-;+15550004444",
        webhook_message_guid="imsg-retry-initial",
    )
    await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params={"password": created["agent_token"]},
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )

    inbound = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-retry-message",
                "text": "retry delivery",
                "chats": [{"guid": "iMessage;-;+15550004444"}],
            }
        },
    )

    assert inbound.status_code == 200
    assert len(_SequencedProviderClient.calls) == 3


@pytest.mark.asyncio
async def test_bluebubbles_webhook_delivery_does_not_retry_4xx(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_sequenced_provider_client([403, 200, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-webhook-4xx",
        chat_guid="iMessage;-;+15550005555",
        webhook_message_guid="imsg-4xx-initial",
    )
    await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params={"password": created["agent_token"]},
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )

    inbound = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-4xx-message",
                "text": "no retry",
                "chats": [{"guid": "iMessage;-;+15550005555"}],
            }
        },
    )

    assert inbound.status_code == 200
    assert len(_SequencedProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_bluebubbles_webhook_delivery_sends_password_query_and_header(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_fake_provider_client()
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _FakeProviderClient,
    )
    chat_guid = "iMessage;-;+15550005556"
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-webhook-auth-delivery",
        chat_guid=chat_guid,
        webhook_message_guid="imsg-auth-delivery-initial",
    )
    await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params={"password": created["agent_token"]},
        json={
            "url": "https://agent.example/bluebubbles?existing=1&password=old",
            "events": ["new-message"],
        },
    )
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    webhook_config = account.config["bluebubbles_webhook"]

    inbound = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-auth-delivery-message",
                "text": "auth delivery",
                "chats": [{"guid": chat_guid}],
            }
        },
    )

    assert inbound.status_code == 200
    assert "password_encrypted" in webhook_config
    assert created["agent_token"] not in json.dumps(webhook_config)
    call = _FakeProviderClient.calls[0]
    parsed = urlparse(call["url"])
    query = parse_qs(parsed.query)
    assert query["existing"] == ["1"]
    assert query["password"] == [created["agent_token"]]
    assert call["headers"] == {"x-password": created["agent_token"]}


@pytest.mark.asyncio
async def test_bluebubbles_client_payload_strips_photon_reply_pointers(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client()
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _FakeProviderClient,
    )
    chat_guid = "iMessage;-;+15550006601"
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-sanitize-agent",
        chat_guid=chat_guid,
        webhook_message_guid="imsg-sanitize-initial",
    )
    params = {"password": created["agent_token"]}
    await client.post(
        "/api/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )

    inbound = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "type": "new-message",
            "data": {
                "guid": "imsg-sanitize-message",
                "text": "not a reply",
                "replyToGuid": "previous-message",
                "replyGuid": "previous-message",
                "threadOriginatorGuid": "true-thread-origin",
                "associatedMessageGuid": "tapback-target",
                "chats": [{"guid": chat_guid, "displayName": "Ops"}],
            },
        },
    )
    single = await client.get(
        "/api/channels/imessage/bluebubbles/v1/message/imsg-sanitize-message",
        params=params,
    )
    history = await client.get(
        f"/api/channels/imessage/bluebubbles/v1/chat/{chat_guid}/messages",
        params=params,
    )

    assert inbound.status_code == 200
    assert single.status_code == 200
    assert history.status_code == 200
    delivered = _FakeProviderClient.calls[0]["json"]["data"]
    history_message = next(
        item for item in history.json()["data"] if item["guid"] == "imsg-sanitize-message"
    )
    for payload in (delivered, single.json()["data"], history_message):
        assert "replyToGuid" not in payload
        assert "replyGuid" not in payload
        assert payload["threadOriginatorGuid"] == "true-thread-origin"
        assert payload["associatedMessageGuid"] == "tapback-target"


@pytest.mark.asyncio
async def test_bluebubbles_query_routes_are_binding_scoped(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-query-agent",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-query-pair",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15550003333", "displayName": "Ops"}],
            }
        },
    )
    await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-query-message",
                "text": "query me",
                "chats": [{"guid": "iMessage;-;+15550003333", "displayName": "Ops"}],
            }
        },
    )

    params = {"password": created["agent_token"]}
    chats = await client.post(
        "/api/channels/imessage/bluebubbles/v1/chat/query", params=params, json={}
    )
    messages = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/query",
        params=params,
        json={"chatGuid": "iMessage;-;+15550003333"},
    )
    single = await client.get(
        "/api/channels/imessage/bluebubbles/v1/message/imsg-query-message", params=params
    )
    blocked = await client.get(
        "/api/channels/imessage/bluebubbles/v1/chat/iMessage;-;+19999999999", params=params
    )

    assert chats.status_code == 200
    assert chats.json()["data"][0]["guid"] == "iMessage;-;+15550003333"
    assert messages.json()["data"][0]["text"] == "query me"
    assert single.json()["data"]["guid"] == "imsg-query-message"
    assert blocked.status_code == 403
    assert blocked.json() == {"status": 403, "message": "chat is not paired", "data": None}


@pytest.mark.asyncio
async def test_bluebubbles_history_count_message_ops_and_schedule(client: httpx.AsyncClient):
    chat_guid = "iMessage;-;+15550004444"
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-compat-agent",
        chat_guid=chat_guid,
        webhook_message_guid="imsg-compat-message",
    )
    params = {"password": created["agent_token"]}

    history_a = await client.get(
        f"/api/channels/imessage/bluebubbles/v1/chat/{chat_guid}/messages", params=params
    )
    history_b = await client.get(
        "/api/channels/imessage/bluebubbles/v1/messages",
        params={**params, "chatGuid": chat_guid},
    )
    count = await client.get(
        "/api/channels/imessage/bluebubbles/v1/message/count",
        params={**params, "chatGuid": chat_guid},
    )
    edited = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/imsg-compat-message/edit",
        params=params,
        json={"editedMessage": "edited"},
    )
    reacted = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/react",
        params=params,
        json={
            "chatGuid": chat_guid,
            "selectedMessageGuid": "imsg-compat-message",
            "reaction": "love",
        },
    )
    updated_count = await client.get(
        "/api/channels/imessage/bluebubbles/v1/message/count/updated",
        params={**params, "chatGuid": chat_guid},
    )
    unsent = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/imsg-compat-message/unsend",
        params=params,
        json={},
    )
    scheduled = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/schedule",
        params=params,
        json={"chatGuid": chat_guid, "message": "later", "scheduledFor": 1_900_000_000_000},
    )
    schedule_id = scheduled.json()["data"]["id"]
    listed = await client.get(
        "/api/channels/imessage/bluebubbles/v1/message/schedule", params=params
    )
    updated_schedule = await client.put(
        f"/api/channels/imessage/bluebubbles/v1/message/schedule/{schedule_id}",
        params=params,
        json={"message": "later edited"},
    )
    deleted_schedule = await client.delete(
        f"/api/channels/imessage/bluebubbles/v1/message/schedule/{schedule_id}", params=params
    )

    assert history_a.status_code == 200
    assert history_b.status_code == 200
    assert history_a.json()["data"][0]["guid"] == "imsg-compat-message"
    assert history_b.json()["data"][0]["guid"] == "imsg-compat-message"
    assert count.status_code == 200
    assert count.json()["data"]["total"] >= 1
    assert edited.status_code == 200
    assert edited.json()["data"]["text"] == "edited"
    assert reacted.status_code == 200
    assert reacted.json()["data"]["reactions"][0]["reaction"] == "love"
    assert updated_count.status_code == 200
    assert updated_count.json()["data"]["total"] >= 1
    assert unsent.status_code == 200
    assert unsent.json()["data"]["isUnsent"] is True
    assert scheduled.status_code == 200
    assert listed.json()["data"][0]["id"] == schedule_id
    assert updated_schedule.json()["data"]["message"] == "later edited"
    assert deleted_schedule.json()["data"]["id"] == schedule_id


@pytest.mark.asyncio
async def test_bluebubbles_attachment_upload_multipart_and_download(
    client: httpx.AsyncClient,
    monkeypatch,
):
    memory_store = _MemoryFileStore()
    monkeypatch.setattr("app.routes.channel_routers.imessage_attachments.file_store", memory_store)
    chat_guid = "iMessage;-;+15550005555"
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-attachment-agent",
        chat_guid=chat_guid,
        webhook_message_guid="imsg-attachment-message",
    )
    params = {"password": created["agent_token"]}

    uploaded = await client.post(
        "/api/channels/imessage/bluebubbles/v1/attachment/upload",
        params=params,
        files={"attachment": ("note.txt", b"hello attachment", "text/plain")},
    )
    upload_path = uploaded.json()["data"]["path"]
    multipart = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/multipart",
        params=params,
        json={
            "chatGuid": chat_guid,
            "parts": [{"text": "caption"}, {"attachment": upload_path}],
        },
    )
    attachment_guid = multipart.json()["data"]["attachments"][0]["guid"]
    downloaded = await client.get(
        f"/api/channels/imessage/bluebubbles/v1/attachment/{attachment_guid}/download",
        params=params,
    )
    direct = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/attachment",
        params=params,
        data={"chatGuid": chat_guid, "name": "direct.txt", "message": "direct"},
        files={"attachment": ("direct.txt", b"direct bytes", "text/plain")},
    )

    assert uploaded.status_code == 200
    assert upload_path.startswith("clawdi-upload://")
    assert multipart.status_code == 200
    assert multipart.json()["data"]["text"] == "caption"
    assert multipart.json()["data"]["attachments"][0]["transferName"] == "note.txt"
    assert downloaded.status_code == 200
    assert downloaded.content == b"hello attachment"
    assert downloaded.headers["content-type"].startswith("text/plain")
    assert direct.status_code == 200
    assert direct.json()["data"]["chatGuid"] == chat_guid


@pytest.mark.asyncio
async def test_bluebubbles_chat_new_accepts_addresses_and_initial_message(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-chat-new-addresses",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    params = {"password": created["agent_token"]}

    empty_address = await client.post(
        "/api/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={"addresses": [None], "message": "hi"},
    )
    no_message = await client.post(
        "/api/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={
            "addresses": ["+15550007777"],
            "tempGuid": "temp-create",
            "groupChatName": "Project",
        },
    )
    with_message = await client.post(
        "/api/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={
            "addresses": ["+15550008888"],
            "message": "hello",
            "tempGuid": "temp-create-message",
            "method": "apple-script",
        },
    )

    assert empty_address.status_code == 400
    assert empty_address.json() == {"status": 400, "message": "address is required", "data": None}
    assert no_message.status_code == 200
    assert no_message.json()["data"]["chatGuid"] == "iMessage;-;+15550007777"
    assert no_message.json()["data"]["guid"] == "iMessage;-;+15550007777"
    assert no_message.json()["data"]["displayName"] == "Project"
    assert with_message.status_code == 200
    message_data = with_message.json()["data"]
    assert message_data["chatGuid"] == "iMessage;-;+15550008888"
    assert message_data["messageGuid"] == message_data["guid"]
    assert message_data["messageId"] == message_data["guid"]
    assert message_data["message"]["text"] == "hello"
    assert message_data["chat"]["guid"] == "iMessage;-;+15550008888"

    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.external_chat_id == "iMessage;-;+15550008888",
            )
        )
    ).scalar_one()
    message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.binding_id == binding.id,
                ChannelMessage.provider_message_id == message_data["guid"],
            )
        )
    ).scalar_one()
    history = await client.get(
        "/api/channels/imessage/bluebubbles/v1/messages",
        params={**params, "chatGuid": "iMessage;-;+15550008888"},
    )

    assert message.direction == MESSAGE_DIRECTION_OUTBOUND
    assert message.text == "hello"
    assert history.status_code == 200
    assert history.json()["data"][0]["guid"] == message_data["guid"]


@pytest.mark.asyncio
async def test_bluebubbles_extended_compat_routes_are_account_scoped(client: httpx.AsyncClient):
    chat_guid = "iMessage;-;+15550006666"
    created = await _create_paired_imessage_channel(
        client,
        name="imessage-extended-agent",
        chat_guid=chat_guid,
        webhook_message_guid="imsg-extended-message",
    )
    params = {"password": created["agent_token"]}

    chat_new = await client.post(
        "/api/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={"participants": ["+15550007777"], "displayName": "New chat"},
    )
    search = await client.post(
        "/api/channels/imessage/bluebubbles/v1/message/search",
        params=params,
        json={"chatGuid": chat_guid, "query": "query"},
    )
    poll = await client.post(
        "/api/channels/imessage/bluebubbles/v1/poll/create",
        params=params,
        json={"chatGuid": chat_guid, "title": "Pick one", "options": ["A", "B"]},
    )
    facetime = await client.post(
        "/api/channels/imessage/bluebubbles/v1/facetime/session", params=params
    )
    handles = await client.post(
        "/api/channels/imessage/bluebubbles/v1/handle/query", params=params, json={}
    )
    stats = await client.get(
        "/api/channels/imessage/bluebubbles/v1/server/statistics/totals", params=params
    )
    contact = await client.get("/api/channels/imessage/bluebubbles/v1/contact", params=params)
    share = await client.get(
        f"/api/channels/imessage/bluebubbles/v1/chat/{chat_guid}/share/contact/status",
        params=params,
    )
    missing_share = await client.get(
        "/api/channels/imessage/bluebubbles/v1/chat/iMessage;-;+19999999999/share/contact/status",
        params=params,
    )

    assert chat_new.status_code == 200
    assert chat_new.json()["data"]["displayName"] == "New chat"
    assert search.status_code == 200
    assert search.json()["data"][0]["guid"] == "imsg-extended-message"
    assert poll.status_code == 200
    assert poll.json()["data"]["text"] == "Pick one"
    assert facetime.status_code == 200
    assert handles.status_code == 200
    assert stats.status_code == 200
    assert stats.json()["data"]["chats"] >= 1
    assert contact.status_code == 200
    assert contact.json()["data"] == []
    assert share.status_code == 200
    assert missing_share.status_code == 403


def test_discord_rate_limiter_blocks_exhausted_route_bucket():
    limiter = DiscordRateLimiter(global_per_second=10)
    headers = {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "60",
        "x-ratelimit-limit": "5",
        "x-ratelimit-bucket": "bucket-1",
    }

    limiter.observe("POST", "/channels/123456789012345678/messages", headers, 200)
    decision = limiter.check("POST", "/channels/123456789012345678/messages")
    other = limiter.check("POST", "/channels/987654321098765432/messages")

    assert decision.allowed is False
    assert decision.retry_after_seconds is not None
    assert other.allowed is True


@pytest.mark.asyncio
async def test_create_discord_channel_returns_provider_webhook(client: httpx.AsyncClient):
    response = await client.post(
        "/api/channels",
        json={
            "provider": "discord",
            "name": "discord-main",
            "provider_token": "discord-token",
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["provider"] == "discord"
    assert "/api/channels/discord/" in created["webhook_url"]
    assert created["has_provider_token"] is True
    assert "discord-token" not in response.text


@pytest.mark.asyncio
async def test_legacy_msg_router_root_routes_are_absent(client: httpx.AsyncClient):
    checks = [
        ("POST", "/bot123456:token/getMe"),
        ("GET", "/api/v10/gateway/bot"),
        ("GET", "/api/v1/server/info"),
        ("GET", "/channels/telegram"),
        ("GET", "/socket.io/"),
        ("GET", "/media/file.jpg"),
        ("POST", "/api/channels/migrations/msg-router/import-tenant"),
    ]

    for method, path in checks:
        response = await client.request(method, path)
        assert response.status_code == 404, path


@pytest.mark.asyncio
async def test_telegram_webhook_pair_code_creates_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-main"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "text": f"/bot_pair {pair['code']}",
                "chat": {
                    "id": 987654321,
                    "type": "private",
                    "username": "paco",
                },
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert webhook.json()["binding_id"]

    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json()[0]["external_chat_id"] == "987654321"
    assert bindings.json()[0]["external_chat_type"] == "private"
    assert bindings.json()[0]["external_chat_name"] == "paco"


@pytest.mark.asyncio
async def test_telegram_webhook_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 100}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-reply",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 987654321, "type": "private", "username": "paco"},
                "from": {"id": 987654321, "is_bot": False, "username": "paco"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/bot123456:telegram-secret/sendMessage"
    )
    assert _FakeProviderClient.calls[0]["json"] == {
        "chat_id": "987654321",
        "text": "Paired! This chat is now connected to your agent.",
    }


@pytest.mark.asyncio
async def test_telegram_webhook_pair_command_sends_failure_replies(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 101}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-failure-replies",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    missing = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 43,
                "text": "/bot_pair",
                "chat": {"id": 987654322, "type": "private"},
                "from": {"id": 987654322, "is_bot": False},
            },
        },
    )
    invalid = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 44,
                "text": "/bot_pair PAIRDOESNOTEXIST",
                "chat": {"id": 987654322, "type": "private"},
                "from": {"id": 987654322, "is_bot": False},
            },
        },
    )

    assert missing.status_code == 200
    assert invalid.status_code == 200
    assert [call["json"]["text"] for call in _FakeProviderClient.calls] == [
        "Usage: /bot_pair <code>",
        "Pairing failed: invalid.",
    ]


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 102}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpair-reply",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 45,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 987654323, "type": "private"},
                "from": {"id": 987654323, "is_bot": False},
            },
        },
    )
    unpaired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 46,
                "text": "/bot_unpair",
                "chat": {"id": 987654323, "type": "private"},
                "from": {"id": 987654323, "is_bot": False},
            },
        },
    )

    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [call["json"]["text"] for call in _FakeProviderClient.calls] == [
        "Paired! This chat is now connected to your agent.",
        "Unpaired. This chat is no longer connected to an agent.",
    ]


@pytest.mark.asyncio
async def test_telegram_webhook_pair_reply_failure_does_not_roll_back_binding(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-reply-fails",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 47,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 987654324, "type": "private"},
                "from": {"id": 987654324, "is_bot": False},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json()[0]["external_chat_id"] == "987654324"
    assert len(_FailingProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_webhook_start_deep_link_pair_code_creates_binding(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-start-pair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "text": f"/start {pair['code']}",
                "chat": {"id": 987654322, "type": "private"},
            },
        },
    )
    legacy_start = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 43,
                "text": "/start OLD_PAIR_CODE",
                "chat": {"id": 987654323, "type": "private"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert legacy_start.status_code == 200
    assert legacy_start.json()["paired"] is False
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert [binding["external_chat_id"] for binding in bindings.json()] == ["987654322"]


@pytest.mark.asyncio
async def test_telegram_webhook_rejects_invalid_secret(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-secret-check"},
        )
    ).json()

    response = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": "wrong"},
        json={
            "message": {
                "message_id": 1,
                "text": "hello",
                "chat": {"id": 123, "type": "private"},
            }
        },
    )

    assert response.status_code == 401


def test_parse_pair_command_matches_strict_bot_shapes():
    assert parse_pair_command("/bot_pair ABCDEF1234") is not None
    assert parse_pair_command("/bot_pair ABCDEF1234").code == "ABCDEF1234"
    assert parse_pair_command("/bot_pair@shared_bot ABC123").code == "ABC123"
    assert parse_pair_command("/bot_pair ABC123 thanks").code == ""
    assert parse_pair_command("/bot_pair ABC123\n•").code == ""
    assert parse_pair_command("/bot_pair").code == ""
    assert parse_pair_command("/start PAIRABCDEF1234").code == "PAIRABCDEF1234"
    assert parse_pair_command("/start@shared_bot PAIRABCDEF1234").code == "PAIRABCDEF1234"
    assert parse_pair_command("/start PAIRABCDEF1234 thanks") is None
    assert parse_pair_command("/start OLD_PAIR_CODE") is None
    assert parse_pair_command("/start") is None
    assert parse_pair_command("/bot_unpair").kind == "unpair"
    assert parse_pair_command("/bot_unpair@shared_bot").kind == "unpair"
    assert parse_pair_command("/bot_unpair now").kind == "unknown"
    assert parse_pair_command("hello world") is None
    unknown = parse_pair_command("/bot_foo bar")
    assert unknown is not None
    assert unknown.kind == "unknown"
    assert unknown.command == "/bot_foo"


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
    assert discord_gateway_intents(ChannelAccount(config=None)) == DISCORD_DEFAULT_INTENTS
    assert discord_gateway_intents(ChannelAccount(config={"gateway_intents": "513"})) == 513
    lock_key = discord_gateway_advisory_lock_key(UUID("00000000-0000-0000-0000-000000000001"))
    assert 0 <= lock_key <= 0x7FFF_FFFF_FFFF_FFFF


@pytest.mark.asyncio
async def test_discord_gateway_ready_guilds_come_from_active_bindings(
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

    guilds = await _discord_bound_guilds(db_session, account=account)
    guild_channels = await _discord_bound_guild_channels(db_session, account=account)

    assert guilds == ["ready-guild-1"]
    assert guild_channels == {"ready-guild-1": ["ready-channel-1"]}
    assert _discord_guild_create_payload(
        guild_id="ready-guild-1",
        channel_ids=guild_channels["ready-guild-1"],
        sequence=2,
    ) == {
        "op": 0,
        "t": "GUILD_CREATE",
        "s": 2,
        "d": {
            "id": "ready-guild-1",
            "name": "ready-guild-1",
            "unavailable": False,
            "channels": [
                {
                    "id": "ready-channel-1",
                    "guild_id": "ready-guild-1",
                    "name": "ready-channel-1",
                    "type": 0,
                    "position": 0,
                    "permission_overwrites": [],
                    "parent_id": None,
                }
            ],
            "threads": [],
            "members": [],
        },
    }


def _install_discord_gateway_protocol_fakes(
    monkeypatch,
    *,
    events: list[ChannelMessage] | None = None,
) -> None:
    _DISCORD_GATEWAY_SESSIONS.clear()

    async def fake_resolve_agent(db, *, provider: str, token: str) -> ChannelAgentContext:
        if provider == "discord" and token == "valid-discord-token":
            account = ChannelAccount(
                id=UUID("00000000-0000-0000-0000-0000000000dc"),
                user_id=UUID("00000000-0000-0000-0000-0000000000dd"),
                provider="discord",
                name="discord-gateway-protocol",
                webhook_secret_hash="unused",
                config={"application_id": "discord-app-1"},
            )
            link = ChannelBotAgentLink(
                id=UUID("00000000-0000-0000-0000-0000000000df"),
                account_id=account.id,
                user_id=account.user_id,
                agent_id=UUID("00000000-0000-0000-0000-0000000000de"),
                agent_token_hash="unused",
            )
            return ChannelAgentContext(account=account, link=link)
        raise HTTPException(status_code=401, detail="invalid bot token")

    async def fake_bound_guilds(
        db,
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID | None = None,
    ) -> list[str]:
        return ["guild-protocol-1"]

    async def fake_bound_guild_channels(
        db,
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID | None = None,
    ) -> dict[str, list[str]]:
        return {"guild-protocol-1": ["chan-protocol-1"]}

    async def fake_dequeue_events(
        db,
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID | None = None,
        after_sequence: int,
        limit: int,
    ):
        return [event for event in events or [] if event.inbox_sequence > after_sequence][:limit]

    monkeypatch.setattr(
        "app.routes.channel_routers.discord.resolve_channel_agent_by_token",
        fake_resolve_agent,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord._discord_bound_guilds",
        fake_bound_guilds,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord._discord_bound_guild_channels",
        fake_bound_guild_channels,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.dequeue_discord_gateway_events",
        fake_dequeue_events,
    )


def test_discord_gateway_rejects_unsupported_encoding_and_compress():
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/api/channels/discord/gateway?encoding=etf"
        ) as websocket:
            with pytest.raises(WebSocketDisconnect) as exc:
                websocket.receive_json()
            assert exc.value.code == 4012

        with sync_client.websocket_connect(
            "/api/channels/discord/gateway?encoding=json&compress=zstd-stream"
        ) as websocket:
            with pytest.raises(WebSocketDisconnect) as exc:
                websocket.receive_json()
            assert exc.value.code == 4012


def test_discord_gateway_zlib_stream_compresses_outbound_frames(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)
    inflater = zlib.decompressobj()

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/api/channels/discord/gateway?encoding=json&compress=zlib-stream"
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
        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"

        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
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
            assert websocket.receive_json()["t"] == "RESUMED"

        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
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

        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
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
                    "d": {"channel_id": "chan-protocol-1", "content": "missed dispatch"},
                },
            )
        ],
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["d"]["content"] == "missed dispatch"

        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
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
            replayed = websocket.receive_json()
            resumed = websocket.receive_json()

    assert replayed["t"] == "MESSAGE_CREATE"
    assert replayed["d"]["content"] == "missed dispatch"
    assert resumed["t"] == "RESUMED"


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
                    "d": {"channel_id": "chan-protocol-1", "content": "event one"},
                },
            ),
            ChannelMessage(
                inbox_sequence=12,
                external_chat_id="chan-protocol-1",
                provider_message_id="msg-replay-2",
                text="event two",
                payload={
                    "t": "MESSAGE_CREATE",
                    "d": {"channel_id": "chan-protocol-1", "content": "event two"},
                },
            ),
        ],
    )

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["d"]["content"] == "event one"
            assert websocket.receive_json()["d"]["content"] == "event two"

        with sync_client.websocket_connect("/api/channels/discord/gateway") as websocket:
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


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_archives_and_allows_repair(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-unpair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert paired.status_code == 200
    assert paired.json()["paired"] is True

    unpaired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 2,
                "text": "/bot_unpair@shared_bot",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True

    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []

    pair_again = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    repaired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 3,
                "text": f"/bot_pair {pair_again['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert repaired.status_code == 200
    assert repaired.json()["paired"] is True
    repaired_bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert len(repaired_bindings.json()) == 1


@pytest.mark.asyncio
async def test_telegram_pairing_same_agent_is_idempotent_and_consumes_code(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": "telegram-already-bound"},
        )
    ).json()
    first = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    second = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/bot_pair {first['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    repaired_same_agent = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 2,
                "text": f"/bot_pair {second['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 3,
                "text": "/bot_unpair",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    repaired = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 4,
                "text": f"/bot_pair {second['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )

    assert paired.json()["paired"] is True
    assert repaired_same_agent.json()["paired"] is True
    assert repaired.json()["paired"] is False


@pytest.mark.asyncio
async def test_discord_webhook_pair_code_creates_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "discord", "name": "discord-pair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-1",
                "channel_id": "chan-1",
                "guild_id": "guild-1",
                "content": f"/bot_pair {pair['code']}",
                "author": {"id": "discord-msg-pair-user"},
                "channel": {"id": "chan-1", "name": "ops"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.json()[0]["external_chat_id"] == "guild-1"
    assert bindings.json()[0]["external_chat_type"] == "guild_text"
    assert bindings.json()[0]["external_chat_name"] == "guild-1"


@pytest.mark.asyncio
async def test_discord_message_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"id": "discord-pair-reply"})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-message-pair-reply",
                "provider_token": "discord-provider-token",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-1",
                "channel_id": "chan-1",
                "guild_id": "guild-1",
                "content": f"/bot_pair {pair['code']}",
                "author": {"id": "discord-msg-pair-user"},
                "channel": {"id": "chan-1", "name": "ops"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    reply_call = next(
        call
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/channels/chan-1/messages")
    )
    assert reply_call["headers"]["Authorization"] == (
        "Bot discord-provider-token"
    )
    assert reply_call["json"] == {
        "content": "Paired! This chat is now connected to your agent.",
        "allowed_mentions": {"parse": []},
    }


@pytest.mark.asyncio
async def test_discord_interaction_unpair_archives_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "discord", "name": "discord-unpair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-pair",
            "token": "token-pair",
            "channel_id": "chan-discord-unpair",
            "guild_id": "guild-discord-unpair",
            "channel": {"id": "chan-discord-unpair", "name": "ops", "type": 0},
            "member": {"user": {"id": "discord-user-unpair"}},
            "data": {
                "name": "bot_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )

    unpaired = await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "type": 2,
            "id": "interaction-unpair",
            "token": "token-unpair",
            "channel_id": "chan-discord-unpair",
            "guild_id": "guild-discord-unpair",
            "channel": {"id": "chan-discord-unpair", "name": "ops", "type": 0},
            "member": {"user": {"id": "discord-user-unpair"}},
            "data": {"name": "bot_unpair"},
        },
    )

    assert unpaired.status_code == 200
    assert (
        unpaired.json()["data"]["content"]
        == "Unpaired. This chat is no longer connected to an agent."
    )
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []


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
async def test_discord_dispatch_records_bound_message(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "discord", "name": "discord-dispatch"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/api/channels/discord/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-pair",
                "channel_id": "chan-dispatch",
                "guild_id": "guild-dispatch",
                "content": f"/bot_pair {pair['code']}",
                "author": {"id": "discord-dispatch-pair-user"},
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


@pytest.mark.asyncio
async def test_discord_gateway_dispatch_pair_code_creates_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "discord", "name": "discord-gateway-pair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    recorded = await record_discord_gateway_dispatch(
        sessionmaker,
        UUID(created["id"]),
        {
            "op": 0,
            "t": "MESSAGE_CREATE",
            "s": 42,
            "d": {
                "id": "msg-gateway-pair",
                "channel_id": "chan-gateway-pair",
                "guild_id": "guild-gateway",
                "content": f"/bot_pair {pair['code']}",
                "author": {"id": "discord-gateway-pair-user"},
            },
        },
    )

    assert recorded is True
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == UUID(created["id"]),
                ChannelBinding.external_chat_id == "guild-gateway",
            )
        )
    ).scalar_one()
    assert binding.status == "active"
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "msg-gateway-pair")
        )
    ).scalar_one()
    assert message.binding_id == binding.id
    alias = (
        await db_session.execute(
            select(ChannelBindingAlias).where(
                ChannelBindingAlias.account_id == UUID(created["id"]),
                ChannelBindingAlias.alias_external_chat_id == "chan-gateway-pair",
                ChannelBindingAlias.alias_kind == "discord_channel",
            )
        )
    ).scalar_one()
    assert alias.binding_id == binding.id


@pytest.mark.asyncio
async def test_imessage_webhook_pair_code_creates_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-main",
                "provider_token": "bluebubbles-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "type": "new-message",
            "data": {
                "guid": "imsg-1",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15551234567", "displayName": "Ops"}],
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.json()[0]["external_chat_id"] == "iMessage;-;+15551234567"
    assert bindings.json()[0]["external_chat_type"] == "dm"


@pytest.mark.asyncio
async def test_imessage_webhook_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"data": {"guid": "imsg-pair-reply"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-pair-reply",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "type": "new-message",
            "data": {
                "guid": "imsg-1",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15551234567", "displayName": "Ops"}],
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert _FakeProviderClient.calls[0]["url"] == (
        "https://bluebubbles.example/api/v1/message/text"
    )
    assert _FakeProviderClient.calls[0]["params"] == {"password": "bb-password"}
    assert _FakeProviderClient.calls[0]["json"] == {
        "chatGuid": "iMessage;-;+15551234567",
        "message": "Paired! This chat is now connected to your agent.",
        "text": "Paired! This chat is now connected to your agent.",
        "method": "private-api",
    }


@pytest.mark.asyncio
async def test_whatsapp_webhook_pair_code_creates_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-main",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-1"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    verify = await client.get(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": created["webhook_secret"],
            "hub.challenge": "challenge-1",
        },
    )
    assert verify.status_code == 200
    assert verify.text == "challenge-1"

    webhook = await client.post(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "contacts": [{"profile": {"name": "Ops Phone"}}],
                                "messages": [
                                    {
                                        "id": "wamid.1",
                                        "from": "15551234567",
                                        "text": {"body": f"/bot_pair {pair['code']}"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.json()[0]["external_chat_id"] == "15551234567"
    assert bindings.json()[0]["external_chat_name"] == "Ops Phone"


@pytest.mark.asyncio
async def test_whatsapp_webhook_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"messages": [{"id": "wamid.pair-reply"}]})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-pair-reply",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-1"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": "wamid.1",
                                        "from": "15551234567",
                                        "text": {"body": f"/bot_pair {pair['code']}"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert _FakeProviderClient.calls[0]["url"].endswith("/phone-1/messages")
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == "Bearer wa-access-token"
    assert _FakeProviderClient.calls[0]["json"]["to"] == "15551234567"
    assert (
        _FakeProviderClient.calls[0]["json"]["text"]["body"]
        == "Paired! This chat is now connected to your agent."
    )


@pytest.mark.asyncio
async def test_same_external_chat_id_is_isolated_across_channel_providers(
    client: httpx.AsyncClient,
):
    shared_chat_id = "shared-chat-id"
    channel_specs = [
        (
            "telegram",
            {
                "provider": "telegram",
                "name": "telegram-shared-chat",
                "provider_token": "telegram-provider-token",
            },
        ),
        (
            "discord",
            {
                "provider": "discord",
                "name": "discord-shared-chat",
                "provider_token": "discord-provider-token",
                "config": {"application_id": "discord-shared-app"},
            },
        ),
        (
            "imessage",
            {
                "provider": "imessage",
                "name": "imessage-shared-chat",
                "provider_token": "bluebubbles-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        ),
        (
            "whatsapp",
            {
                "provider": "whatsapp",
                "name": "whatsapp-shared-chat",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-shared"},
            },
        ),
    ]
    created_by_provider = {
        provider: (await client.post("/api/channels", json=body)).json()
        for provider, body in channel_specs
    }
    pair_codes = {
        provider: (
            await client.post(
                f"/api/channels/{created['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()["code"]
        for provider, created in created_by_provider.items()
    }

    telegram = created_by_provider["telegram"]
    await client.post(
        f"/api/channels/telegram/{telegram['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": telegram["webhook_secret"]},
        json={
            "update_id": 401,
            "message": {
                "message_id": 401,
                "text": f"/bot_pair {pair_codes['telegram']}",
                "chat": {"id": shared_chat_id, "type": "private"},
            },
        },
    )
    discord = created_by_provider["discord"]
    await client.post(
        f"/api/channels/discord/{discord['id']}/webhook",
        headers={"x-clawdi-channel-secret": discord["webhook_secret"]},
        json={
            "id": "discord-shared-msg",
            "channel_id": shared_chat_id,
            "content": f"/bot_pair {pair_codes['discord']}",
        },
    )
    imessage = created_by_provider["imessage"]
    await client.post(
        f"/api/channels/imessage/{imessage['id']}/webhook",
        params={"secret": imessage["webhook_secret"]},
        json={
            "data": {
                "guid": "imessage-shared-msg",
                "text": f"/bot_pair {pair_codes['imessage']}",
                "handle": {"address": "shared-imessage-sender"},
                "chats": [{"guid": shared_chat_id, "displayName": "Shared Chat"}],
            }
        },
    )
    whatsapp = created_by_provider["whatsapp"]
    await client.post(
        f"/api/channels/whatsapp/{whatsapp['id']}/webhook",
        headers={"x-clawdi-channel-secret": whatsapp["webhook_secret"]},
        json={
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": "wamid.shared",
                                        "from": shared_chat_id,
                                        "text": {"body": f"/bot_pair {pair_codes['whatsapp']}"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        },
    )

    bindings_by_provider = {}
    for provider, created in created_by_provider.items():
        bindings = await client.get(f"/api/channels/{created['id']}/bindings")
        assert bindings.status_code == 200
        bindings_by_provider[provider] = bindings.json()

    assert set(bindings_by_provider) == {"telegram", "discord", "imessage", "whatsapp"}
    assert {bindings[0]["external_chat_id"] for bindings in bindings_by_provider.values()} == {
        shared_chat_id
    }
    assert len({bindings[0]["account_id"] for bindings in bindings_by_provider.values()}) == len(
        bindings_by_provider
    )


@pytest.mark.asyncio
async def test_whatsapp_webhook_accepts_meta_hmac_signature(client: httpx.AsyncClient):
    app_secret = "wa-app-secret"
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-hmac",
                "secrets": {"app_secret": app_secret},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    body = json.dumps(
        {
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": "wamid.hmac",
                                        "from": "15551239999",
                                        "text": {"body": f"/bot_pair {pair['code']}"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ]
        },
        separators=(",", ":"),
    ).encode("utf-8")
    signature = hmac.new(app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()

    webhook = await client.post(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        headers={
            "x-hub-signature-256": f"sha256={signature}",
            "content-type": "application/json",
        },
        content=body,
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.json()[0]["external_chat_id"] == "15551239999"


@pytest.mark.asyncio
async def test_whatsapp_webhook_rejects_bad_meta_hmac_signature(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-hmac-bad",
                "secrets": {"app_secret": "wa-app-secret"},
            },
        )
    ).json()

    response = await client.post(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        headers={
            "x-hub-signature-256": "sha256=bad",
            "content-type": "application/json",
        },
        content=b'{"message":{"key":{"remoteJid":"15550000000@s.whatsapp.net"}}}',
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_whatsapp_webhook_skips_from_me_messages(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "whatsapp", "name": "wa-from-me"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    response = await client.post(
        f"/api/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {
                    "id": "FROM-ME-PAIR",
                    "remoteJid": "15551112222@s.whatsapp.net",
                    "fromMe": True,
                },
                "message": {"conversation": f"/bot_pair {pair['code']}"},
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["paired"] is False
    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert bindings.json() == []
    messages = (
        (
            await db_session.execute(
                select(ChannelMessage).where(ChannelMessage.account_id == UUID(created["id"]))
            )
        )
        .scalars()
        .all()
    )
    assert messages == []


@pytest.mark.asyncio
async def test_whatsapp_webhook_pairs_from_common_baileys_wrappers(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "whatsapp", "name": "wa-wrapper-pair"},
        )
    ).json()
    wrappers = [
        (
            "ephemeral",
            lambda body: {
                "ephemeralMessage": {
                    "message": {"extendedTextMessage": {"text": body}},
                }
            },
        ),
        (
            "viewonce",
            lambda body: {"viewOnceMessageV2": {"message": {"conversation": body}}},
        ),
        (
            "devicesent",
            lambda body: {"deviceSentMessage": {"message": {"conversation": body}}},
        ),
        (
            "edited",
            lambda body: {
                "protocolMessage": {
                    "editedMessage": {"extendedTextMessage": {"text": body}},
                }
            },
        ),
    ]

    for label, wrapped_message in wrappers:
        pair = (
            await client.post(
                f"/api/channels/{created['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()
        jid = f"{label}@s.whatsapp.net"
        response = await client.post(
            f"/api/channels/whatsapp/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json={
                "message": {
                    "key": {"id": f"PAIR-{label}", "remoteJid": jid, "fromMe": False},
                    "message": wrapped_message(f"/bot_pair {pair['code']}"),
                }
            },
        )
        assert response.status_code == 200
        assert response.json()["paired"] is True

    bindings = await client.get(f"/api/channels/{created['id']}/bindings")
    assert {binding["external_chat_id"] for binding in bindings.json()} == {
        "ephemeral@s.whatsapp.net",
        "viewonce@s.whatsapp.net",
        "devicesent@s.whatsapp.net",
        "edited@s.whatsapp.net",
    }


@pytest.mark.asyncio
async def test_send_channel_message_uses_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-send",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    webhook = (
        await client.post(
            f"/api/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "message": {
                    "message_id": 42,
                    "text": f"/bot_pair {pair['code']}",
                    "chat": {"id": 111, "type": "private"},
                }
            },
        )
    ).json()

    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
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
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-delete-outbox",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": "111", "text": "delete before delivery"},
    )

    deleted = await client.delete(f"/api/channels/{created['id']}")

    assert deleted.status_code == 204
    delivery = (
        await db_session.execute(
            select(ChannelDelivery).where(ChannelDelivery.id == UUID(sent.json()["delivery_id"]))
        )
    ).scalar_one()
    assert delivery.status == DELIVERY_STATUS_FAILED
    assert delivery.locked_at is None
    assert delivery.locked_by is None
    assert delivery.last_error == "channel account archived"


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
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-retry",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
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
    assert delivery.last_error == "telegram api unreachable"


@pytest.mark.asyncio
async def test_telegram_command_sync_uses_set_my_commands(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"ok": True, "result": True}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "telegram",
                "name": "telegram-commands",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    response = await client.post(f"/api/channels/{created['id']}/commands/sync", json={})

    assert response.status_code == 200
    assert response.json()["provider"] == "telegram"
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/setMyCommands")
    assert _FakeProviderClient.calls[0]["json"]["commands"] == [
        {"command": "bot_pair", "description": "Pair this chat with Clawdi."},
        {"command": "bot_unpair", "description": "Disconnect this chat from Clawdi."},
    ]


@pytest.mark.asyncio
async def test_discord_command_sync_upserts_application_commands(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"id": "command-1"}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-commands",
                "provider_token": "discord-token",
                "config": {"application_id": "app-123"},
            },
        )
    ).json()

    response = await client.post(
        f"/api/channels/{created['id']}/commands/sync",
        json={"guild_id": "guild-123"},
    )

    assert response.status_code == 200
    assert response.json()["provider"] == "discord"
    assert len(_FakeProviderClient.calls) == 2
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/applications/app-123/guilds/guild-123/commands"
    )
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == "Bot discord-token"
    assert _FakeProviderClient.calls[0]["json"]["name"] == "bot_pair"
    assert _FakeProviderClient.calls[0]["json"]["options"][0]["name"] == "code"
    assert _FakeProviderClient.calls[1]["json"]["name"] == "bot_unpair"


@pytest.mark.asyncio
async def test_discord_send_uses_provider_rest_api(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"id": "discord-msg-1"}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "discord",
                "name": "discord-send",
                "provider_token": "discord-token",
            },
        )
    ).json()

    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
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


@pytest.mark.asyncio
async def test_whatsapp_send_uses_cloud_api(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"messages": [{"id": "wamid.sent"}]}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()

    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": "15551234567", "text": "hello"},
    )

    assert sent.status_code == 201
    assert sent.json()["delivery_status"] == "pending"

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == UUID(sent.json()["delivery_id"])

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.id == UUID(sent.json()["id"]))
        )
    ).scalar_one()
    assert message.provider_message_id == "wamid.sent"
    assert _FakeProviderClient.calls[0]["url"].endswith("/phone-123/messages")
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == "Bearer wa-access-token"
    assert _FakeProviderClient.calls[0]["json"]["text"]["body"] == "hello"


@pytest.mark.asyncio
async def test_whatsapp_delivery_worker_uses_structured_provider_payload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"messages": [{"id": "wamid.structured"}]}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-structured-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()

    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": "15551234567:3@s.whatsapp.net", "text": "fallback"},
    )
    assert sent.status_code == 201
    message = await db_session.get(ChannelMessage, UUID(sent.json()["id"]))
    assert message is not None
    message.payload = {
        "delivery": "pending",
        "providerPayload": {
            "type": "text",
            "text": {"body": "reply with quote"},
            "context": {"message_id": "wamid.original"},
        },
    }
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == UUID(sent.json()["delivery_id"])

    await db_session.rollback()
    message = (
        await db_session.execute(
            select(ChannelMessage)
            .where(ChannelMessage.id == UUID(sent.json()["id"]))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert message.provider_message_id == "wamid.structured"
    assert message.payload["delivery"] == "succeeded"
    assert message.payload["providerPayload"]["text"]["body"] == "reply with quote"
    assert message.payload["providerResponse"] == {"messages": [{"id": "wamid.structured"}]}
    assert _FakeProviderClient.calls[0]["json"] == {
        "messaging_product": "whatsapp",
        "to": "15551234567",
        "type": "text",
        "text": {"body": "reply with quote"},
        "context": {"message_id": "wamid.original"},
    }


@pytest.mark.asyncio
async def test_channel_delivery_worker_fails_invalid_whatsapp_provider_payload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-invalid-structured-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()
    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": "15551234567", "text": "fallback"},
    )
    assert sent.status_code == 201
    message = await db_session.get(ChannelMessage, UUID(sent.json()["id"]))
    assert message is not None
    message.payload = {
        "delivery": "pending",
        "providerPayload": {"type": "image", "image": {"id": "media-id", "link": "https://x"}},
    }
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == UUID(sent.json()["delivery_id"])

    await db_session.rollback()
    delivery = (
        await db_session.execute(
            select(ChannelDelivery)
            .where(ChannelDelivery.id == UUID(sent.json()["delivery_id"]))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert delivery.status == "failed"
    assert delivery.attempts == 1
    assert delivery.last_error == "whatsapp image payload requires exactly one of id or link"
    assert _FakeProviderClient.calls == []


@pytest.mark.asyncio
async def test_whatsapp_delivery_worker_uses_structured_audio_provider_payload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"messages": [{"id": "wamid.audio"}]}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-audio-structured-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()
    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": "15551234567", "text": "fallback"},
    )
    assert sent.status_code == 201
    message = await db_session.get(ChannelMessage, UUID(sent.json()["id"]))
    assert message is not None
    message.payload = {
        "delivery": "pending",
        "providerPayload": {
            "type": "audio",
            "audio": {"link": "https://cdn.example.test/voice.ogg"},
        },
    }
    await db_session.commit()

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == UUID(sent.json()["delivery_id"])

    assert _FakeProviderClient.calls[0]["json"] == {
        "messaging_product": "whatsapp",
        "to": "15551234567",
        "type": "audio",
        "audio": {"link": "https://cdn.example.test/voice.ogg"},
    }


@pytest.mark.asyncio
async def test_imessage_send_uses_bluebubbles_api(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"data": {"guid": "imsg-sent-1"}}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/api/channels",
            json={
                "provider": "imessage",
                "name": "imessage-send",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()

    sent = await client.post(
        f"/api/channels/{created['id']}/messages",
        json={"external_chat_id": "iMessage;-;+15551234567", "text": "hello"},
    )

    assert sent.status_code == 201
    assert sent.json()["delivery_status"] == "pending"

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    delivered_id = await ChannelDeliveryWorker(sessionmaker).run_once()
    assert delivered_id == UUID(sent.json()["delivery_id"])

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.id == UUID(sent.json()["id"]))
        )
    ).scalar_one()
    assert message.provider_message_id == "imsg-sent-1"
    assert _FakeProviderClient.calls[0]["url"] == (
        "https://bluebubbles.example/api/v1/message/text"
    )
    assert _FakeProviderClient.calls[0]["params"] == {"password": "bb-password"}
    assert _FakeProviderClient.calls[0]["json"]["chatGuid"] == "iMessage;-;+15551234567"
