from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
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
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from starlette.websockets import WebSocketDisconnect

from app.core.auth import AuthContext, get_auth
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
    CHANNEL_PROVIDER_IMESSAGE,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_DISABLED,
    CHANNEL_VISIBILITY_PUBLIC,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    MESSAGE_DIRECTION_INBOUND,
    MESSAGE_DIRECTION_OUTBOUND,
    PAIR_CODE_STATUS_CLAIMED,
    PAIR_CODE_STATUS_PENDING,
    PAIR_CODE_STATUS_REVOKED,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelAgentReference,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDelivery,
    ChannelMessage,
    ChannelPairCode,
    ChannelSecret,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import V2RuntimeEnvironmentFence
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import public as public_router
from app.routes.channel_routers import shared as shared_router
from app.routes.channel_routers.discord import (
    _DISCORD_GATEWAY_SESSIONS,
    _discord_bound_guild_channels,
    _discord_bound_guilds,
    _discord_gateway_url,
    _discord_guild_create_payload,
    cleanup_discord_guild_commands_after_authority_revoked,
)
from app.routes.channel_routers.shared import _discord_gateway_dispatch
from app.services import channels as channel_service
from app.services.bluebubbles_socket import BlueBubblesSocketManager
from app.services.channel_debug_events import record_channel_debug_event
from app.services.channel_delivery_worker import ChannelDeliveryWorker
from app.services.channel_webhook_delivery_worker import ChannelWebhookDeliveryWorker
from app.services.channels import (
    ChannelAgentContext,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    decrypt_agent_link_token,
    discord_pair_command_from_payload,
    discord_pairing_reply_for_command,
    encrypt_optional_token,
    extract_discord_routing_key,
    generate_agent_token,
    generate_pair_code,
    hash_token,
    normalize_telegram_bot_username,
    parse_pair_command,
    record_discord_dispatch,
    send_provider_outbound_payload,
    telegram_direct_messages_topic_id_from_update,
    telegram_message_thread_id_from_update,
    wait_for_telegram_updates,
)
from app.services.discord_command_reconciliation_worker import (
    DiscordCommandReconciliationWorker,
    reconcile_discord_guild_commands,
)
from app.services.discord_gateway_worker import (
    DISCORD_DEFAULT_INTENTS,
    DiscordGatewayWorker,
    _GatewayState,
    discord_gateway_advisory_lock_key,
    discord_gateway_intents,
    discord_gateway_uri,
    discord_identify_payload,
    discord_resume_payload,
    record_discord_gateway_dispatch,
)
from app.services.discord_rate_limiter import DiscordRateLimiter
from app.services.runtime_observation import retire_runtime_environment
from app.services.telegram_rate_limiter import telegram_rate_limiter
from app.services.whatsapp_baileys import (
    load_or_create_whatsapp_auth_cert,
    mint_whatsapp_agent_credential,
)

pytestmark = [pytest.mark.usefixtures("channel_agent"), pytest.mark.committed_db]

TELEGRAM_AGENT_TOKEN_RE = re.compile(r"^[1-9][0-9]{8}:[A-Za-z0-9_-]{32,}$")
DISCORD_TEST_APPLICATION_ID = "123456789012345678"
DISCORD_TEST_PUBLIC_KEY = "11" * 32
_REAL_DISCORD_BOT_GUILD_MEMBERSHIP_CHECK = channel_service.discord_bot_guild_membership_check


def _discord_ready_config(
    application_id: str = DISCORD_TEST_APPLICATION_ID,
) -> dict[str, Any]:
    return {
        "application_id": application_id,
        "public_key": DISCORD_TEST_PUBLIC_KEY,
        "discord_interactions_configured": True,
        "discord_install_config_version": channel_service.DISCORD_INSTALL_CONFIG_VERSION,
        "discord_user_install_supported": True,
        "discord_reserved_command_version": channel_service.DISCORD_RESERVED_COMMAND_VERSION,
        "_test_discord_server_state": True,
    }


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


@asynccontextmanager
async def _client_for_api_key(
    db_session: AsyncSession,
    user,
    api_key: ApiKey,
) -> AsyncIterator[httpx.AsyncClient]:
    previous_overrides = dict(app.dependency_overrides)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _override_get_auth() -> AuthContext:
        return AuthContext(user=user, api_key=api_key)

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
    agent_type: str = "openclaw",
    hosted: bool = True,
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
        agent_type=agent_type,
        os="darwin",
        default_project_id=agent_project.id,
    )
    db_session.add(agent)
    await db_session.flush()
    agent_project.origin_environment_id = agent.id
    if hosted:
        deployment_id = f"dep-{uuid4().hex}"
        db_session.add_all(
            [
                HostedRuntimeState(
                    environment_id=agent.id,
                    deployment_id=deployment_id,
                    instance_id=f"instance-{uuid4().hex}",
                    generation=1,
                    cli_package_spec="clawdi@0.12.10-beta.57",
                    locale={"language": "en", "timezone": "UTC"},
                    system={},
                    runtimes={
                        agent_type: {
                            "enabled": True,
                            "providerMode": "unmanaged",
                            "provider_ids": [],
                            "install": {"source": "official"},
                        }
                    },
                    live_sync={
                        "enabled": True,
                        "agents": [{"agentType": agent_type, "environmentId": str(agent.id)}],
                    },
                    recovery={"cacheManifest": True, "allowOfflineBoot": True},
                    tools={},
                ),
                V2RuntimeEnvironmentFence(
                    environment_id=agent.id,
                    owner_id=user.id,
                    deployment_id=deployment_id,
                ),
            ]
        )
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
            "/v1/admin/channels",
            headers={"X-Admin-Key": admin_key},
            json=payload,
        )
    finally:
        settings.admin_api_key = original_admin_key


async def _create_public_telegram_account_for_user(
    client: httpx.AsyncClient,
    *,
    user,
    label: str,
) -> dict[str, Any]:
    response = await _create_admin_channel(
        client,
        target_clerk_id=user.clerk_id,
        provider=CHANNEL_PROVIDER_TELEGRAM,
        name=f"{label}-{uuid4().hex}",
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _seed_existing_channel_link(
    db_session: AsyncSession,
    *,
    account_id: str,
    agent,
) -> tuple[ChannelBotAgentLink, str]:
    """Seed an already-existing Link for tests of legacy provider behavior."""
    account = await db_session.get(ChannelAccount, UUID(account_id))
    assert account is not None
    raw_token = generate_agent_token(account.provider)
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=agent.user_id,
        agent_id=agent.id,
    )
    channel_service.store_agent_link_token(link, raw_token)
    db_session.add(link)
    await db_session.commit()
    await db_session.refresh(link)
    return link, raw_token


async def _seed_created_channel_link(
    db_session: AsyncSession,
    *,
    created: dict[str, Any],
    agent,
) -> ChannelBotAgentLink:
    link, raw_token = await _seed_existing_channel_link(
        db_session,
        account_id=created["id"],
        agent=agent,
    )
    created.update(
        agent_id=str(agent.id),
        agent_link_id=str(link.id),
        agent_token=raw_token,
    )
    return link


async def _create_public_channel_with_links(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    *,
    label: str,
    link_count: int = 2,
) -> tuple[ChannelAccount, list[ChannelBotAgentLink]]:
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="telegram",
        name=f"{label}-{uuid4().hex}",
    )
    assert created.status_code == 201, created.text
    account_id = UUID(created.json()["id"])
    links: list[ChannelBotAgentLink] = []
    for index in range(link_count):
        link_user, link_agent = await _create_user_with_channel_agent(
            db_session,
            label=f"{label}-{index}",
        )
        async with _client_for_user(db_session, link_user) as link_client:
            linked = await link_client.post(
                f"/v1/channels/{account_id}/agent-links",
                json={"agent_id": str(link_agent.id)},
            )
        assert linked.status_code == 201, linked.text
        link = await db_session.get(ChannelBotAgentLink, UUID(linked.json()["id"]))
        assert link is not None
        links.append(link)
    account = await db_session.get(ChannelAccount, account_id)
    assert account is not None
    return account, links


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
        self.calls.append({"method": method, "url": str(url), **kwargs})
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

    async def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        raise httpx.ConnectError("network down")


class _SequencedProviderClient(_FakeProviderClient):
    status_codes: list[int] = []

    async def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        status_code = self.status_codes.pop(0) if self.status_codes else 200
        return _FakeProviderResponse({}, status_code=status_code)


class _DiscordPreparationProviderClient(_FakeProviderClient):
    responses: list[tuple[Any, int]] = []

    @classmethod
    def reset(cls, responses: list[tuple[Any, int]]) -> None:
        cls.calls = []
        cls.responses = list(responses)

    @classmethod
    def _next_response(cls) -> _FakeProviderResponse:
        payload, status_code = cls.responses.pop(0)
        return _FakeProviderResponse(payload, status_code=status_code)

    async def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        return self._next_response()

    async def post(self, url, **kwargs):
        self.calls.append({"method": "POST", "url": url, **kwargs})
        return self._next_response()


class _StatefulDiscordCommandClient(_FakeProviderClient):
    commands_by_path: dict[str, list[dict[str, Any]]] = {}
    delete_statuses_by_id: dict[str, list[int]] = {}
    created_ids = {
        "clawdi_pair": "900000000000000001",
        "clawdi_unpair": "900000000000000002",
    }

    @classmethod
    def reset(
        cls,
        commands_by_path: dict[str, list[dict[str, Any]]],
        *,
        delete_statuses_by_id: dict[str, list[int]] | None = None,
    ) -> None:
        cls.calls = []
        cls.commands_by_path = {
            path: [dict(command) for command in commands]
            for path, commands in commands_by_path.items()
        }
        cls.delete_statuses_by_id = {
            command_id: list(statuses)
            for command_id, statuses in (delete_statuses_by_id or {}).items()
        }

    @classmethod
    def _scope_path(cls, url: str) -> str | None:
        return next(
            (path for path in cls.commands_by_path if url.endswith(path) or f"{path}/" in url),
            None,
        )

    async def request(self, method, url, **kwargs):
        url = str(url)
        self.calls.append({"method": method, "url": url, **kwargs})
        scope_path = self._scope_path(url)
        if scope_path is None:
            return _FakeProviderResponse({}, status_code=404)
        commands = self.commands_by_path[scope_path]
        if method == "GET" and url.endswith(scope_path):
            return _FakeProviderResponse([dict(command) for command in commands])
        if method == "DELETE":
            command_id = url.rsplit("/", 1)[-1]
            remaining = [command for command in commands if command.get("id") != command_id]
            configured_statuses = self.delete_statuses_by_id.get(command_id)
            if configured_statuses:
                status_code = configured_statuses.pop(0)
                if status_code == 404:
                    # Simulate another reconciler deleting the ID between this
                    # client's GET and DELETE.
                    self.commands_by_path[scope_path] = remaining
                if status_code == 429:
                    return _FakeProviderResponse(
                        {"retry_after": 0},
                        status_code=status_code,
                        headers={"Retry-After": "0"},
                    )
                return _FakeProviderResponse({}, status_code=status_code)
            if len(remaining) == len(commands):
                return _FakeProviderResponse({}, status_code=404)
            self.commands_by_path[scope_path] = remaining
            return _FakeProviderResponse({}, status_code=204)
        if method == "POST" and url.endswith(scope_path):
            payload = kwargs.get("json")
            if not isinstance(payload, dict):
                return _FakeProviderResponse({}, status_code=400)
            name = payload.get("name")
            command_type = payload.get("type", 1)
            existing = next(
                (
                    command
                    for command in commands
                    if command.get("name") == name and command.get("type", 1) == command_type
                ),
                None,
            )
            command_id = (
                existing.get("id")
                if isinstance(existing, dict)
                else self.created_ids.get(str(name), "900000000000000099")
            )
            synced = {"id": command_id, **payload}
            self.commands_by_path[scope_path] = [
                command
                for command in commands
                if not (command.get("name") == name and command.get("type", 1) == command_type)
            ] + [synced]
            return _FakeProviderResponse(synced)
        return _FakeProviderResponse({}, status_code=405)


class _FakeDiscordGatewaySocket:
    def __init__(self, frames: list[dict[str, Any]], stop: asyncio.Event):
        self._frames = list(frames)
        self._stop = stop
        self.sent: list[dict[str, Any]] = []
        self.closed: list[dict[str, Any]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def recv(self):
        if not self._frames:
            self._stop.set()
            await asyncio.sleep(0)
            return json.dumps({"op": 11, "d": None})
        frame = self._frames.pop(0)
        if not self._frames:
            self._stop.set()
        return json.dumps(frame)

    async def send(self, payload: str):
        self.sent.append(json.loads(payload))

    async def close(self, *, code: int, reason: str):
        self.closed.append({"code": code, "reason": reason})
        self._stop.set()


class _FakeDiscordGatewayConnect:
    def __init__(self, sockets: list[_FakeDiscordGatewaySocket]):
        self._sockets = list(sockets)
        self.uris: list[str] = []
        self.options: list[dict[str, Any]] = []

    def __call__(self, uri: str, **kwargs):
        self.uris.append(uri)
        self.options.append(kwargs)
        return self._sockets.pop(0)


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
    _StatefulDiscordCommandClient.calls = []


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
            "/v1/channels",
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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": f"{webhook_message_guid}-pair",
                "text": f"/clawdi_pair {pair['code']}",
                "chats": [{"guid": chat_guid, "displayName": "Ops"}],
            }
        },
    )
    await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
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
    agent_id: UUID | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "provider": "telegram",
        "name": name,
    }
    if provider_token is not None:
        payload["provider_token"] = provider_token
    if config is not None:
        payload["config"] = config
    if agent_id is not None:
        payload["agent_id"] = str(agent_id)
    created = (
        await client.post(
            "/v1/channels",
            json=payload,
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id=chat_id, chat_type=chat_type)
    return created


def _telegram_bot_path(
    channel: dict[str, Any],
    method: str,
    *,
    account_id: str | None = None,
    slash_variant: bool = True,
) -> str:
    resolved_account_id = account_id or str(channel["id"])
    routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        channel_runtime_account_key(UUID(resolved_account_id)),
    )
    separator = "/" if slash_variant else ""
    return f"/v1/channels/telegram/bot{separator}{routing_id}/{method}"


def _telegram_agent_headers(
    channel: dict[str, Any],
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    return {**(extra or {}), "Authorization": f"Bearer {channel['agent_token']}"}


def _telegram_file_path(channel: dict[str, Any], file_path: str) -> str:
    routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        channel_runtime_account_key(UUID(str(channel["id"]))),
    )
    return f"/v1/channels/telegram/file/bot/{routing_id}/{file_path}"


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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": update_id,
            "message": {
                "message_id": update_id,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {pair['code']}",
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
    application_id: str = DISCORD_TEST_APPLICATION_ID,
    agent_id: UUID | None = None,
) -> dict[str, Any]:
    create_payload: dict[str, Any] = {
        "provider": "discord",
        "name": name,
        "provider_token": provider_token,
        "config": _discord_ready_config(application_id),
    }
    if agent_id is not None:
        create_payload["agent_id"] = str(agent_id)
    created = (
        await client.post(
            "/v1/channels",
            json=create_payload,
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
            "id": "discord-pair-interaction",
            "token": "discord-pair-token",
            "application_id": application_id,
            "channel_id": channel_id,
            "guild_id": guild_id,
            "context": 0,
            "authorizing_integration_owners": {"0": guild_id},
            "member": {
                "permissions": "32",
                "user": {"id": "discord-pair-user"},
            },
            "data": {
                "name": "clawdi_pair",
                "options": [{"name": "code", "value": pair["code"]}],
            },
        },
    )
    assert paired.status_code == 200, paired.text
    assert paired.json()["data"]["content"] == (
        "Server paired. This Discord server is now connected to your agent."
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
        f"/v1/channels/discord/{created['id']}/webhook",
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
async def test_create_telegram_channel_registers_provider_webhook(
    client: httpx.AsyncClient,
    monkeypatch,
):
    previous_public_api_url = settings.public_api_url
    settings.public_api_url = "https://cloud.example.test"
    _reset_fake_provider_client({"ok": True, "result": {"username": "ClawdiWebhookBot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    try:
        response = await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "auto-webhook",
                "provider_token": "123456:telegram-secret",
            },
        )
    finally:
        settings.public_api_url = previous_public_api_url

    assert response.status_code == 201
    created = response.json()
    assert len(_FakeProviderClient.calls) == 2
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/getMe")
    call = _FakeProviderClient.calls[1]
    assert call["url"].endswith("/bot123456:telegram-secret/setWebhook")
    assert call["json"] == {
        "url": created["webhook_url"],
        "secret_token": created["webhook_secret"],
    }
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()
    assert pair["bot_username"] == "ClawdiWebhookBot"
    assert pair["deep_link"] == f"https://t.me/ClawdiWebhookBot?start={pair['code']}"


def test_generate_telegram_agent_token_matches_bot_api_contract():
    tokens = [generate_agent_token(CHANNEL_PROVIDER_TELEGRAM) for _ in range(25)]

    assert len(set(tokens)) == len(tokens)
    assert all(TELEGRAM_AGENT_TOKEN_RE.fullmatch(token) for token in tokens)


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
async def test_synthetic_telegram_identity_is_account_scoped_and_topics_fail_closed(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": f"synthetic-me-{uuid4().hex}"},
        )
    ).json()
    bot_path = _telegram_bot_path(created, "getMe")
    before = await client.post(bot_path, headers=_telegram_agent_headers(created), json={})
    rotated = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )
    rotated_channel = {**created, "agent_token": rotated.json()["agent_token"]}
    after = await client.post(
        bot_path,
        headers=_telegram_agent_headers(rotated_channel),
        json={},
    )

    assert before.status_code == 200
    assert rotated.status_code == 200
    assert after.status_code == 200
    assert before.json()["result"]["id"] == after.json()["result"]["id"]
    assert before.json()["result"]["has_topics_enabled"] is False
    assert after.json()["result"]["has_topics_enabled"] is False


@pytest.mark.asyncio
async def test_channel_control_plane_actions_write_redacted_audit_events(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
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
    assert outbound_item["delivery_last_error"] == "provider timed out"
    inbound_item = next(item for item in items if item["text"] == "activity inbound")
    assert inbound_item["direction"] == MESSAGE_DIRECTION_INBOUND
    assert inbound_item["provider_message_id"] == "provider-message-1"
    debug_item = next(item for item in items if item["kind"] == "debug_event")
    assert debug_item["stage"] == "delivery"
    assert debug_item["outcome"] == "failure"
    assert debug_item["status_code"] == 503
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
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    db_session.add(
        ChannelMessage(
            account_id=account.id,
            bot_agent_link_id=UUID(created["agent_link_id"]),
            user_id=account.user_id,
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
    db_session.add(binding)
    await db_session.flush()
    db_session.add(
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
        )
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
    assert health["pending_deliveries"] == 1
    assert health["failed_deliveries"] == 1
    assert health["last_error"] in {"rate limited", "provider rejected request"}
    assert health["last_error_stage"] in {"delivery", None}
    assert health["last_message_at"] is not None
    assert health["last_event_at"] is not None


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
    other_user, _other_agent = await _create_user_with_channel_agent(
        db_session,
        label="health-other",
    )
    other_binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=UUID(created["agent_link_id"]),
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
            bot_agent_link_id=UUID(created["agent_link_id"]),
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
async def test_env_bound_list_channels_returns_runtime_agent_token(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"runtime-list-{uuid4().hex}",
            "provider_token": "123456:telegram-secret",
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()

    api_key = ApiKey(user_id=seed_user.id, environment_id=channel_agent.id, label="hosted")
    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        listed = await runtime_client.get("/v1/channels")

    assert listed.status_code == 200, listed.text
    payload = listed.json()
    assert len(payload) == 1
    assert payload[0]["id"] == created["id"]
    assert payload[0]["runtime_links"] == [
        {
            "id": created["agent_link_id"],
            "account_id": created["id"],
            "agent_id": str(channel_agent.id),
            "status": "active",
            "created_at": payload[0]["runtime_links"][0]["created_at"],
            "agent_token": created["agent_token"],
        }
    ]
    assert "telegram-secret" not in listed.text
    assert "webhook_secret" not in listed.text


@pytest.mark.asyncio
async def test_account_level_managed_key_lists_runtime_channels_with_environment_query(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": f"runtime-managed-list-{uuid4().hex}",
            "provider_token": "123456:telegram-secret",
        },
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()

    api_key = ApiKey(
        user_id=seed_user.id,
        environment_id=None,
        managed=True,
        label="hosted",
    )
    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        listed = await runtime_client.get(f"/v1/channels?environment_id={channel_agent.id}")

    assert listed.status_code == 200, listed.text
    payload = listed.json()
    assert len(payload) == 1
    assert payload[0]["id"] == created["id"]
    assert payload[0]["runtime_links"][0]["agent_id"] == str(channel_agent.id)
    assert payload[0]["runtime_links"][0]["agent_token"] == created["agent_token"]
    assert "telegram-secret" not in listed.text
    assert "webhook_secret" not in listed.text


@pytest.mark.asyncio
async def test_env_bound_list_channels_filters_non_v2_runtime_providers(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    telegram = await client.post(
        "/v1/channels",
        json={
            "provider": CHANNEL_PROVIDER_TELEGRAM,
            "name": f"runtime-allowlisted-{uuid4().hex}",
            "provider_token": "123456:telegram-secret",
        },
    )
    assert telegram.status_code == 201, telegram.text
    imessage = await client.post(
        "/v1/channels",
        json={
            "provider": CHANNEL_PROVIDER_IMESSAGE,
            "name": f"runtime-imessage-{uuid4().hex}",
            "provider_token": "bluebubbles-password",
            "config": {"server_url": "https://bluebubbles.example"},
        },
    )
    assert imessage.status_code == 201, imessage.text

    api_key = ApiKey(user_id=seed_user.id, environment_id=channel_agent.id, label="hosted")
    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        listed = await runtime_client.get("/v1/channels")

    assert listed.status_code == 200, listed.text
    providers = {item["provider"] for item in listed.json()}
    assert providers == {CHANNEL_PROVIDER_TELEGRAM}
    assert imessage.json()["id"] not in listed.text
    assert "bluebubbles-password" not in listed.text


@pytest.mark.asyncio
async def test_env_bound_channel_etag_is_stable(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    duplicate_name = f"Runtime Duplicate {uuid4().hex}"
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "telegram",
            "name": duplicate_name,
            "provider_token": "123456:telegram-secret-0",
        },
    )
    assert created_response.status_code == 201, created_response.text
    api_key = ApiKey(user_id=seed_user.id, environment_id=channel_agent.id, label="hosted")
    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        first = await runtime_client.get("/v1/channels")
        assert first.status_code == 200, first.text
        etag = first.headers["etag"]
        second = await runtime_client.get("/v1/channels", headers={"If-None-Match": etag})

    assert second.status_code == 304, second.text
    assert [item["id"] for item in first.json()] == [created_response.json()["id"]]


@pytest.mark.asyncio
async def test_env_bound_channel_etag_changes_when_agent_token_rotates(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"runtime-etag-{uuid4().hex}",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    api_key = ApiKey(user_id=seed_user.id, environment_id=channel_agent.id, label="hosted")
    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        first = await runtime_client.get("/v1/channels")
    assert first.status_code == 200, first.text
    etag = first.headers["etag"]

    rotated = await client.post(
        f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}/token"
    )
    assert rotated.status_code == 200, rotated.text
    rotated_token = rotated.json()["agent_token"]

    async with _client_for_api_key(db_session, seed_user, api_key) as runtime_client:
        changed = await runtime_client.get("/v1/channels", headers={"If-None-Match": etag})

    assert changed.status_code == 200, changed.text
    assert changed.headers["etag"] != etag
    assert changed.json()[0]["runtime_links"][0]["agent_token"] == rotated_token


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
    await db_session.flush()

    pool = await client.get("/v1/channels/bot-pool")
    assert pool.status_code == 200
    telegram = pool.json()["providers"]["telegram"]
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
        api_key = ApiKey(user_id=user.id, environment_id=agent.id, label="multi-account")
        async with _client_for_api_key(db_session, user, api_key) as runtime_client:
            runtime_channels = await runtime_client.get("/v1/channels")
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
    assert runtime_channels.status_code == 200, runtime_channels.text
    assert [item["id"] for item in runtime_channels.json()] == [first_account.json()["id"]]


@pytest.mark.asyncio
async def test_second_managed_telegram_account_is_rejected_before_provider_io(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="telegram-provider-admission",
        agent_type="openclaw",
    )
    _reset_fake_provider_client({"ok": True, "result": {"username": "AdmissionTestBot"}})
    monkeypatch.setattr(settings, "public_api_url", "https://cloud.example.test")
    async with _client_for_user(db_session, user) as user_client:
        monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
        first = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": "telegram-provider-admission-first",
                "provider_token": "123456:first-token",
                "agent_id": str(agent.id),
            },
        )
        assert first.status_code == 201, first.text
        assert [call["url"].rsplit("/", 1)[-1] for call in _FakeProviderClient.calls] == [
            "getMe",
            "setWebhook",
        ]
        _clear_fake_provider_calls()
        second = await user_client.post(
            "/v1/channels",
            json={
                "provider": CHANNEL_PROVIDER_TELEGRAM,
                "name": "telegram-provider-admission-second",
                "provider_token": "123456:second-token",
                "agent_id": str(agent.id),
            },
        )

    assert second.status_code == 409, second.text
    assert second.json()["detail"] == (
        "This Agent already has a Telegram bot. Unlink it before connecting another."
    )
    assert _FakeProviderClient.calls == []


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

    from app.routes.channel_routers import telegram as telegram_router

    agent_deliveries: list[dict[str, Any]] = []

    async def _record_agent_delivery(_account, _link, payload):
        agent_deliveries.append(payload)
        return True

    monkeypatch.setattr(
        telegram_router,
        "_deliver_telegram_agent_webhook",
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
    api_key = ApiKey(user_id=user.id, environment_id=agent.id, label="duplicate-runtime")
    async with _client_for_api_key(db_session, user, api_key) as runtime_client:
        runtime_channels = await runtime_client.get("/v1/channels")
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
    assert runtime_channels.status_code == 409
    assert runtime_channels.json()["detail"] == remediation
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
    async with _client_for_api_key(db_session, user, api_key) as runtime_client:
        recovered_runtime_channels = await runtime_client.get("/v1/channels")

    assert unlinked.status_code == 204
    assert [item["id"] for item in remaining_links.json()] == [str(first_link.id)]
    assert rotated.status_code == 200, rotated.text
    assert recovered_runtime_channels.status_code == 200
    assert [item["id"] for item in recovered_runtime_channels.json()] == [first.json()["id"]]


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

        async def create_link_after_retirement_lock():
            async with session_factory() as link_session:
                account = await link_session.get(ChannelAccount, UUID(created.json()["id"]))
                assert account is not None
                return await channel_service.get_or_create_bot_agent_link(
                    link_session,
                    account=account,
                    agent_id=agent.id,
                    user_id=user.id,
                )

        pending_link = asyncio.create_task(create_link_after_retirement_lock())
        await asyncio.sleep(0.05)
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

    api_key = ApiKey(user_id=user.id, environment_id=agent.id, label="historical-local-runtime")
    async with _client_for_api_key(db_session, user, api_key) as runtime_client:
        runtime_channels = await runtime_client.get("/v1/channels")
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
    assert runtime_channels.status_code == 200
    assert runtime_channels.json() == []
    assert historical_agent_token not in runtime_channels.text
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
    ).scalar_one()
    assert inbound_message.binding_id is None
    assert inbound_message.bot_agent_link_id is None
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
async def test_hosted_runtime_agent_rejects_whatsapp_links_and_tenant_credentials(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    agent_type: str,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name=f"{agent_type}-whatsapp-{uuid4().hex}",
        config={"phone_number_id": f"phone-{agent_type}-wa"},
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label=f"{agent_type}-whatsapp",
        agent_type=agent_type,
    )

    async with _client_for_user(db_session, user) as user_client:
        link = await user_client.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent.id)},
        )
        tenant_credential = await user_client.post(
            f"/v1/channels/whatsapp/{account_id}/tenant-creds",
            json={"agent_id": str(agent.id)},
        )

    expected_detail = channel_service.WHATSAPP_COMING_SOON_DETAIL
    assert link.status_code == 409
    assert link.json()["detail"] == expected_detail
    assert tenant_credential.status_code == 409
    assert tenant_credential.json()["detail"] == expected_detail
    links = (
        (
            await db_session.execute(
                select(ChannelBotAgentLink).where(
                    ChannelBotAgentLink.account_id == UUID(account_id),
                    ChannelBotAgentLink.agent_id == agent.id,
                    ChannelBotAgentLink.archived_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    assert links == []

    legacy_link = ChannelBotAgentLink(
        account_id=UUID(account_id),
        user_id=user.id,
        agent_id=agent.id,
    )
    db_session.add(legacy_link)
    await db_session.commit()
    await db_session.refresh(legacy_link)

    async with _client_for_user(db_session, user) as user_client:
        tenant_credential_by_link = await user_client.post(
            f"/v1/channels/whatsapp/{account_id}/tenant-creds",
            json={"agent_link_id": str(legacy_link.id)},
        )

    assert tenant_credential_by_link.status_code == 409
    assert tenant_credential_by_link.json()["detail"] == expected_detail
    credentials = (
        (
            await db_session.execute(
                select(ChannelAgentCredential).where(
                    ChannelAgentCredential.bot_agent_link_id == legacy_link.id,
                    ChannelAgentCredential.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    assert credentials == []


@pytest.mark.asyncio
async def test_historical_local_whatsapp_link_cannot_mint_tenant_credentials(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name=f"historical-local-whatsapp-{uuid4().hex}",
        config={"phone_number_id": "phone-historical-local"},
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    user, agent = await _create_user_with_channel_agent(
        db_session,
        label="historical-local-whatsapp",
        agent_type="openclaw",
        hosted=False,
    )
    link, _token = await _seed_existing_channel_link(
        db_session,
        account_id=account_id,
        agent=agent,
    )

    async with _client_for_user(db_session, user) as user_client:
        by_link = await user_client.post(
            f"/v1/channels/whatsapp/{account_id}/tenant-creds",
            json={"agent_link_id": str(link.id)},
        )
        implicit = await user_client.post(
            f"/v1/channels/whatsapp/{account_id}/tenant-creds",
            json={},
        )
        listed_links = await user_client.get(f"/v1/channels/{account_id}/agent-links")
        listed_credentials = await user_client.get(
            f"/v1/channels/whatsapp/{account_id}/tenant-creds"
        )
        unlink = await user_client.delete(f"/v1/channels/{account_id}/agent-links/{link.id}")

    expected_detail = channel_service.STRICT_V2_AGENT_LINK_DETAIL
    assert by_link.status_code == 409
    assert by_link.json()["detail"] == expected_detail
    assert implicit.status_code == 409
    assert implicit.json()["detail"] == expected_detail
    assert listed_links.status_code == 200
    assert [item["id"] for item in listed_links.json()] == [str(link.id)]
    assert listed_credentials.status_code == 200
    assert listed_credentials.json() == []
    assert unlink.status_code == 204
    credentials = list(
        (
            await db_session.execute(
                select(ChannelAgentCredential).where(
                    ChannelAgentCredential.bot_agent_link_id == link.id,
                    ChannelAgentCredential.revoked_at.is_(None),
                )
            )
        ).scalars()
    )
    assert credentials == []


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
        api_key = ApiKey(user_id=user_a.id, environment_id=agent_a.id, label="hosted")
        async with _client_for_api_key(db_session, user_a, api_key) as runtime_client:
            desired_before = await runtime_client.get("/v1/channels")

        deleted = await client_a.delete(f"/v1/channels/{account_id}/agent-links/{first_link_id}")
        second_delete = await client_a.delete(
            f"/v1/channels/{account_id}/agent-links/{first_link_id}"
        )
        missing_delete = await client_a.delete(f"/v1/channels/{account_id}/agent-links/{uuid4()}")

        links_after = await client_a.get(f"/v1/channels/{account_id}/agent-links")
        pool_after_delete = await client_a.get("/v1/channels/bot-pool")
        async with _client_for_api_key(db_session, user_a, api_key) as runtime_client:
            desired_after = await runtime_client.get("/v1/channels")
        audit_response = await client_a.get(
            "/v1/audit/events",
            params={"channel_account_id": account_id, "limit": 20},
        )
    async with _client_for_user(db_session, user_b) as client_b:
        second_link = await client_b.post(
            f"/v1/channels/{account_id}/agent-links",
            json={"agent_id": str(agent_b.id)},
        )

    assert desired_before.status_code == 200, desired_before.text
    assert [item["id"] for item in desired_before.json()] == [account_id]
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
    assert desired_after.status_code == 200, desired_after.text
    assert desired_after.json() == []
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
    assert target_pending_delivery.last_error == "channel agent link archived"
    assert target_in_progress_delivery.status == DELIVERY_STATUS_FAILED
    assert target_in_progress_delivery.locked_at is None
    assert target_in_progress_delivery.locked_by is None
    assert target_in_progress_delivery.last_error == "channel agent link archived"
    assert sibling_delivery.status == DELIVERY_STATUS_PENDING
    assert sibling_delivery.last_error is None


@pytest.mark.asyncio
async def test_list_channel_agent_links_by_agent_returns_linked_channel_summaries(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
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

    listed = await client.get(
        "/v1/channels/agent-links",
        params={"agent_id": str(channel_agent.id)},
    )

    assert listed.status_code == 200, listed.text
    body = listed.json()
    by_account_id = {item["account_id"]: item for item in body}
    assert set(by_account_id) == {private["id"], public_body["id"]}
    private_item = by_account_id[private["id"]]
    public_item = by_account_id[public_body["id"]]
    assert private_item["id"] == private["agent_link_id"]
    assert private_item["agent_id"] == str(channel_agent.id)
    assert private_item["status"] == "active"
    assert private_item["agent_token"] is None
    assert private_item["account"]["id"] == private["id"]
    assert private_item["account"]["name"] == private["name"]
    assert private_item["account"]["visibility"] == "private"
    assert public_item["id"] == public_link.json()["id"]
    assert public_item["account"]["id"] == public_body["id"]
    assert public_item["account"]["visibility"] == "public"
    assert other_private["id"] not in by_account_id
    assert other_user_listing.status_code == 404


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
    assert _FakeProviderClient.calls == []
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
    assert account.user_id != link_user.id

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

    reference.user_id = account.user_id
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

    user_a, agent_a = await _create_user_with_channel_agent(
        db_session,
        label="public-wa-a",
        agent_type="claude_code",
        hosted=False,
    )
    user_b, _agent_b = await _create_user_with_channel_agent(
        db_session,
        label="public-wa-b",
        agent_type="claude_code",
        hosted=False,
    )
    link_a, _token = await _seed_existing_channel_link(
        db_session,
        account_id=account_id,
        agent=agent_a,
    )
    account = await db_session.get(ChannelAccount, UUID(account_id))
    assert account is not None
    # Seed historical persisted state directly so this test stays focused on
    # read isolation; the public create API is intentionally fail-closed.
    stored = await mint_whatsapp_agent_credential(
        db_session,
        account=account,
        bot_agent_link_id=link_a.id,
        user_id=user_a.id,
        phone_user="15551234567",
    )
    await db_session.commit()
    await db_session.refresh(stored.credential)

    async with _client_for_user(db_session, user_a) as client_a:
        auth_cert = await client_a.get(f"/v1/channels/whatsapp/{account_id}/auth-cert")
        listed_a = await client_a.get(f"/v1/channels/whatsapp/{account_id}/tenant-creds")

    assert auth_cert.status_code == 200
    assert auth_cert.json()["ISSUER"] == "clawdi"
    assert len(listed_a.json()) == 1
    assert listed_a.json()[0]["credential_id"] == str(stored.credential.id)
    assert listed_a.json()[0]["agent_id"] == str(agent_a.id)

    async with _client_for_user(db_session, user_b) as client_b:
        listed_b = await client_b.get(f"/v1/channels/whatsapp/{account_id}/tenant-creds")
        auth_cert_b = await client_b.get(f"/v1/channels/whatsapp/{account_id}/auth-cert")

    assert listed_b.status_code == 200
    assert listed_b.json() == []
    assert auth_cert_b.status_code == 200
    assert auth_cert_b.json()["PUBLIC_KEY"] == auth_cert.json()["PUBLIC_KEY"]


@pytest.mark.asyncio
async def test_env_bound_list_channels_hides_historical_local_whatsapp_credentials(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
):
    created = await _create_admin_channel(
        client,
        target_clerk_id=seed_user.clerk_id,
        provider="whatsapp",
        name=f"runtime-whatsapp-{uuid4().hex}",
        provider_token="wa-provider-token",
        config={"phone_number_id": "phone-runtime"},
    )
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
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
    # Seed historical persisted state directly to verify the env-bound read
    # projection without reopening tenant-credential admission.
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

    api_key = ApiKey(user_id=user.id, environment_id=agent.id, label="hosted-wa-runtime")
    async with _client_for_api_key(db_session, user, api_key) as runtime_client:
        listed = await runtime_client.get("/v1/channels")

    assert listed.status_code == 200, listed.text
    assert "wa-provider-token" not in listed.text
    assert str(first.credential.id) not in listed.text
    assert listed.json() == []

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

    async with _client_for_api_key(db_session, user, api_key) as runtime_client:
        listed_after_unlink = await runtime_client.get("/v1/channels")

    assert listed_after_unlink.status_code == 200, listed_after_unlink.text
    assert listed_after_unlink.json() == []


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

    user_a, agent_a = await _create_user_with_channel_agent(db_session, label="pair-owner-a")
    user_b, agent_b = await _create_user_with_channel_agent(db_session, label="pair-owner-b")

    async with _client_for_user(db_session, user_a) as client_a:
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
    ).scalar_one()
    assert bob_unpair_reply.binding_id is None
    assert bob_unpair_reply.bot_agent_link_id is None

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
async def test_telegram_bot_api_get_updates_reads_paired_inbox(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-agent"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "getUpdates", slash_variant=False),
        headers=_telegram_agent_headers(created),
        params={"offset": 3},
    )
    delete_webhook = await client.post(
        _telegram_bot_path(created, "deleteWebhook", slash_variant=False),
        headers=_telegram_agent_headers(created),
    )

    assert updates.status_code == 200
    assert updates.json()["ok"] is True
    assert updates.json()["result"][0]["message"]["text"] == "official path"
    assert delete_webhook.status_code == 200
    assert delete_webhook.json() == {"ok": True, "result": True}


@pytest.mark.asyncio
async def test_telegram_managed_bot_api_keeps_credential_out_of_loggable_path(
    client: httpx.AsyncClient,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-managed-auth",
        chat_id="334",
    )
    routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        channel_runtime_account_key(UUID(created["id"])),
    )
    path = f"/v1/channels/telegram/bot{routing_id}/getUpdates"
    headers = {"Authorization": f"Bearer {created['agent_token']}"}

    response = await client.get(path, headers=headers)
    missing_header = await client.get(path)
    old_secret_path = f"/v1/channels/telegram/bot{created['agent_token']}/getUpdates"
    rejected_old_secret_path = await client.get(old_secret_path)
    mismatched_route = await client.get(
        f"/v1/channels/telegram/bot{routing_id}x/getUpdates",
        headers=headers,
    )

    assert created["agent_token"] not in path
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert missing_header.status_code == 401
    assert created["agent_token"] in old_secret_path
    assert rejected_old_secret_path.status_code == 401
    assert mismatched_route.status_code == 401


@pytest.mark.asyncio
async def test_telegram_repair_moves_chat_to_new_agent_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-public-bot",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    default_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    workspace_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_id": str(second_channel_agent.id), "ttl_seconds": 900},
        )
    ).json()
    assert workspace_pair["agent_link_id"] != created["agent_link_id"]
    assert workspace_pair["agent_token"]

    async def post_update(update_id: int, text: str):
        return await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
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

    default_claim = await post_update(101, f"/clawdi_pair {default_pair['code']}")
    workspace_claim = await post_update(102, f"/clawdi_pair {workspace_pair['code']}")
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        params={"offset": 103},
    )
    workspace_updates = await client.get(
        _telegram_bot_path(workspace_pair, "getUpdates", account_id=created["id"]),
        headers=_telegram_agent_headers(workspace_pair),
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": f"telegram-shared-{uuid4().hex}",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    default_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    workspace_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_id": str(second_channel_agent.id), "ttl_seconds": 900},
        )
    ).json()

    async def post_update(update_id: int, text: str):
        return await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
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

    assert (await post_update(201, f"/clawdi_pair {default_pair['code']}")).json()["paired"] is True
    assert (await post_update(202, f"/clawdi_pair {workspace_pair['code']}")).json()[
        "paired"
    ] is True
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
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 203,
            "message": {
                "message_id": 203,
                "text": "/clawdi_unpair",
                "chat": {"id": int(chat_id), "type": "private"},
            },
        },
    )
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")

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
async def test_telegram_same_provider_multiple_bots_are_account_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    first = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-bot-one",
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()
    second = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-bot-two",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    assert first["agent_id"] != second["agent_id"]
    assert first["agent_link_id"] != second["agent_link_id"]
    assert first["agent_token"] != second["agent_token"]

    async def pair_and_post(account: dict[str, Any], update_id: int, text: str) -> None:
        pair = (
            await client.post(
                f"/v1/channels/{account['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()
        paired = await client.post(
            f"/v1/channels/telegram/{account['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "text": f"/clawdi_pair {pair['code']}",
                    "chat": {"id": 888, "type": "private"},
                },
            },
        )
        inbound = await client.post(
            f"/v1/channels/telegram/{account['id']}/webhook",
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
        _telegram_bot_path(first, "getUpdates"),
        headers=_telegram_agent_headers(first),
        params={"offset": 202},
    )
    second_updates = await client.get(
        _telegram_bot_path(second, "getUpdates"),
        headers=_telegram_agent_headers(second),
        params={"offset": 302},
    )
    first_token_cannot_read_second_bot = await client.get(
        _telegram_bot_path(first, "getUpdates"),
        headers=_telegram_agent_headers(first),
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
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
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-webhook-agent"},
        )
    ).json()

    set_webhook = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/webhook", "secret_token": "agent-secret"},
    )
    get_updates = await client.get(
        _telegram_bot_path(created, "getUpdates"), headers=_telegram_agent_headers(created)
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
        _telegram_bot_path(workspace_pair, "setWebhook", account_id=created["id"]),
        headers=_telegram_agent_headers(workspace_pair),
        json={"url": "https://agent.example/workspace-hook"},
    )
    default_get_updates = await client.get(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
    )
    workspace_get_updates = await client.get(
        _telegram_bot_path(workspace_pair, "getUpdates", account_id=created["id"]),
        headers=_telegram_agent_headers(workspace_pair),
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-get-me",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    response = await client.post(
        _telegram_bot_path(created, "getMe"),
        headers=_telegram_agent_headers(created),
        json={},
    )

    assert response.status_code == 200
    assert response.json()["result"]["username"] == "provider_bot"
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/getMe")


@pytest.mark.asyncio
async def test_telegram_set_webhook_rejects_private_targets(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-webhook-private"},
        )
    ).json()

    missing_url = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    private_url = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
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
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-webhook-private-dns"},
        )
    ).json()

    response = await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent-hook.example/hook"},
    )

    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "resolves to a private host" in response.json()["description"]


@pytest.mark.asyncio
async def test_user_channel_config_rejects_private_provider_urls(client: httpx.AsyncClient):
    response = await client.post(
        "/v1/channels",
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
        "/v1/channels",
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
async def test_telegram_bot_api_chat_capabilities_are_agent_link_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-method-capabilities",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id="111", chat_type="private")
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()
    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {second_pair['code']}",
                "chat": {"id": 222, "type": "private"},
            },
        },
    )
    assert paired.json()["paired"] is True

    for update_id, chat_id, callback_query_id, file_id in (
        (3, 111, "cb-first", "file-first"),
        (4, 222, "cb-second", "file-second"),
    ):
        inbound = await client.post(
            f"/v1/channels/telegram/{created['id']}/webhook",
            headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
            json={
                "update_id": update_id,
                "callback_query": {
                    "id": callback_query_id,
                    "data": "approve",
                    "message": {
                        "message_id": update_id,
                        "chat": {"id": chat_id, "type": "private"},
                        "document": {"file_id": file_id, "file_name": "report.pdf"},
                    },
                },
            },
        )
        assert inbound.status_code == 200

    cases = (
        {
            "name": "valid chat-scoped method",
            "method": "sendMessage",
            "json": {"chat_id": "111", "text": "allowed"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "unknown method with bound chat",
            "method": "futureGlobalMutation",
            "json": {"chat_id": "111"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "unknown method without chat",
            "method": "futureGlobalMutation",
            "json": {},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "known global mutation with smuggled chat",
            "method": "setMyProfilePhoto",
            "json": {"chat_id": "111", "photo": "attach://photo"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "known chat method without chat",
            "method": "sendMessage",
            "json": {"text": "missing target"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "chat owned by another link",
            "method": "sendMessage",
            "json": {"chat_id": "222", "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "source chat owned by another link",
            "method": "forwardMessage",
            "json": {"chat_id": "111", "from_chat_id": "222", "message_id": 1},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "reply chat owned by another link",
            "method": "sendMessage",
            "json": {
                "chat_id": "111",
                "text": "blocked reply",
                "reply_parameters": {"chat_id": "222", "message_id": 1},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "query-encoded reply chat owned by another link",
            "method": "sendMessage",
            "params": {
                "chat_id": "111",
                "text": "blocked reply",
                "reply_parameters": json.dumps({"chat_id": "222", "message_id": 1}),
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "sender chat owned by another link",
            "method": "banChatSenderChat",
            "json": {"chat_id": "111", "sender_chat_id": "222"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "callback query owned by another link",
            "method": "sendMessage",
            "json": {"chat_id": "111", "callback_query_id": "cb-second", "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "callback query owned by same link",
            "method": "sendMessage",
            "json": {"chat_id": "111", "callback_query_id": "cb-first", "text": "allowed"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "callback answer owned by another link",
            "method": "answerCallbackQuery",
            "json": {"callback_query_id": "cb-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "callback answer owned by same link",
            "method": "answerCallbackQuery",
            "json": {"callback_query_id": "cb-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "file owned by another link",
            "method": "getFile",
            "json": {"file_id": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "file owned by same link",
            "method": "getFile",
            "json": {"file_id": "file-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "inbound photo file owned by same link",
            "method": "sendPhoto",
            "json": {"chat_id": "111", "photo": "file-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "foreign top-level photo",
            "method": "sendPhoto",
            "json": {"chat_id": "111", "photo": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level document",
            "method": "sendDocument",
            "json": {"chat_id": "111", "document": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level sticker",
            "method": "sendSticker",
            "json": {"chat_id": "111", "sticker": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level animation",
            "method": "sendAnimation",
            "json": {"chat_id": "111", "animation": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level audio",
            "method": "sendAudio",
            "json": {"chat_id": "111", "audio": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level video",
            "method": "sendVideo",
            "json": {"chat_id": "111", "video": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level voice",
            "method": "sendVoice",
            "json": {"chat_id": "111", "voice": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level video note",
            "method": "sendVideoNote",
            "json": {"chat_id": "111", "video_note": "file-second"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign top-level live photo",
            "method": "sendLivePhoto",
            "json": {
                "chat_id": "111",
                "live_photo": "file-second",
                "photo": "file-first",
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign reusable video cover",
            "method": "sendVideo",
            "json": {
                "chat_id": "111",
                "video": "https://example.com/video.mp4",
                "cover": "file-second",
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "provider validates thumbnail reuse semantics",
            "method": "sendVideo",
            "json": {
                "chat_id": "111",
                "video": "https://example.com/video.mp4",
                "thumbnail": "file-first",
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "foreign media group item",
            "method": "sendMediaGroup",
            "json": {
                "chat_id": "111",
                "media": [
                    {"type": "photo", "media": "file-second"},
                    {"type": "document", "media": "https://example.com/report.pdf"},
                ],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "query-encoded foreign media group item",
            "method": "sendMediaGroup",
            "params": {
                "chat_id": "111",
                "media": json.dumps([{"type": "photo", "media": "file-second"}]),
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "duplicate query file parameter",
            "method": "sendPhoto",
            "params": [
                ("chat_id", "111"),
                ("photo", "file-second"),
                ("photo", "https://example.com/photo.jpg"),
            ],
            "status": 400,
            "forwarded": False,
        },
        {
            "name": "duplicate JSON file key",
            "method": "sendPhoto",
            "content": b"""
                {"chat_id":"111","photo":"file-second",
                "photo":"https://example.com/photo.jpg"}
            """,
            "status": 400,
            "forwarded": False,
        },
        {
            "name": "query cannot override body file authorization",
            "method": "sendPhoto",
            "query": {"photo": "file-second"},
            "json": {"chat_id": "111", "photo": "https://example.com/photo.jpg"},
            "status": 400,
            "forwarded": False,
        },
        {
            "name": "same-link media group item and URL",
            "method": "sendMediaGroup",
            "json": {
                "chat_id": "111",
                "media": [
                    {"type": "photo", "media": "file-first"},
                    {"type": "document", "media": "https://example.com/report.pdf"},
                ],
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "foreign paid media cover",
            "method": "sendPaidMedia",
            "json": {
                "chat_id": "111",
                "star_count": 1,
                "media": [
                    {
                        "type": "video",
                        "media": "https://example.com/video.mp4",
                        "cover": "file-second",
                    }
                ],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign paid media file",
            "method": "sendPaidMedia",
            "json": {
                "chat_id": "111",
                "star_count": 1,
                "media": [{"type": "photo", "media": "file-second"}],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign edited media",
            "method": "editMessageMedia",
            "json": {
                "chat_id": "111",
                "message_id": 1,
                "media": {"type": "document", "media": "file-second"},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign edited ephemeral media",
            "method": "editEphemeralMessageMedia",
            "json": {
                "chat_id": "111",
                "receiver_user_id": 7,
                "ephemeral_message_id": 8,
                "media": {"type": "photo", "media": "file-second"},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign poll description media",
            "method": "sendPoll",
            "json": {
                "chat_id": "111",
                "question": "Question?",
                "options": [{"text": "One"}, {"text": "Two"}],
                "media": {"type": "photo", "media": "file-second"},
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign poll option media",
            "method": "sendPoll",
            "json": {
                "chat_id": "111",
                "question": "Question?",
                "options": [
                    {
                        "text": "One",
                        "media": {"type": "sticker", "media": "file-second"},
                    },
                    {"text": "Two"},
                ],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign rich message media",
            "method": "sendRichMessage",
            "json": {
                "chat_id": "111",
                "rich_message": {
                    "html": '<img src="tg://photo?id=hero">',
                    "media": [
                        {
                            "id": "hero",
                            "media": {"type": "photo", "media": "file-second"},
                        }
                    ],
                },
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "foreign rich message block media",
            "method": "sendRichMessage",
            "json": {
                "chat_id": "111",
                "rich_message": {
                    "blocks": [
                        {
                            "type": "details",
                            "summary": "Media",
                            "blocks": [
                                {
                                    "type": "video",
                                    "video": {"type": "video", "media": "file-second"},
                                }
                            ],
                        }
                    ]
                },
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "HTTPS media URL",
            "method": "sendDocument",
            "json": {
                "chat_id": "111",
                "document": "https://example.com/report.pdf",
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "provider validates live photo URL semantics",
            "method": "sendLivePhoto",
            "json": {
                "chat_id": "111",
                "live_photo": "https://example.com/live.mp4",
                "photo": "file-first",
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "provider validates unknown nested media type",
            "method": "sendMediaGroup",
            "json": {
                "chat_id": "111",
                "media": [{"type": "future_media", "media": "file-first"}],
            },
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "provider validates future file field on allowed method",
            "method": "sendMessage",
            "json": {"chat_id": "111", "text": "hello", "photo": "file-first"},
            "status": 200,
            "forwarded": True,
        },
        {
            "name": "unscoped business connection",
            "method": "sendMessage",
            "json": {
                "chat_id": "111",
                "business_connection_id": "business-other",
                "text": "blocked",
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "unscoped inline message",
            "method": "editMessageText",
            "json": {"chat_id": "111", "inline_message_id": "inline-other", "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "shared Stars mutation",
            "method": "sendMessage",
            "json": {"chat_id": "111", "allow_paid_broadcast": True, "text": "blocked"},
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "shared payment invoice",
            "method": "sendInvoice",
            "json": {
                "chat_id": "111",
                "title": "Unsafe invoice",
                "description": "Payment updates have no attributable chat",
                "payload": "link-opaque",
                "currency": "XTR",
                "prices": [{"label": "Item", "amount": 1}],
            },
            "status": 403,
            "forwarded": False,
        },
        {
            "name": "shared paid media domain",
            "method": "sendPaidMedia",
            "json": {
                "chat_id": "111",
                "star_count": 1,
                "media": [{"type": "photo", "media": "https://example.com/photo.jpg"}],
            },
            "status": 403,
            "forwarded": False,
        },
    )
    for case in cases:
        telegram_rate_limiter.reset()
        _reset_fake_provider_client({"ok": True, "result": True})
        request_headers = _telegram_agent_headers(created)
        if "params" in case:
            request_kwargs = {"params": case["params"]}
        elif "content" in case:
            request_kwargs = {"content": case["content"]}
            request_headers = {**request_headers, "content-type": "application/json"}
        else:
            request_kwargs = {"json": case["json"]}
        if "query" in case:
            request_kwargs["params"] = case["query"]
        response = await client.request(
            "GET" if "params" in case else "POST",
            _telegram_bot_path(created, case["method"]),
            headers=request_headers,
            **request_kwargs,
        )
        assert response.status_code == case["status"], case["name"]
        assert bool(_FakeProviderClient.calls) is case["forwarded"], case["name"]


@pytest.mark.asyncio
async def test_telegram_bot_profile_shadow_is_account_scoped(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    account_a = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-profile-a",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account_b = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-profile-b",
                "agent_id": str(second_channel_agent.id),
            },
        )
    ).json()

    set_name = await client.post(
        _telegram_bot_path(account_a, "setMyName"),
        headers=_telegram_agent_headers(account_a),
        json={"name": "Tenant A Bot"},
    )
    get_a = await client.post(
        _telegram_bot_path(account_a, "getMyName"),
        headers=_telegram_agent_headers(account_a),
        json={},
    )
    get_b = await client.post(
        _telegram_bot_path(account_b, "getMyName"),
        headers=_telegram_agent_headers(account_b),
        json={},
    )

    assert set_name.status_code == 200
    assert set_name.json() == {"ok": True, "result": True}
    assert get_a.json() == {"ok": True, "result": {"name": "Tenant A Bot"}}
    assert get_b.json() == {"ok": True, "result": {"name": ""}}


@pytest.mark.asyncio
async def test_telegram_bot_profile_shadow_is_link_scoped_on_shared_account(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-shared-profile",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyName"),
            headers=_telegram_agent_headers(created),
            json={"name": "First link"},
        )
    ).status_code == 200
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    first_get = await client.post(
        _telegram_bot_path(created, "getMyName"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    second_get = await client.post(
        _telegram_bot_path(second, "getMyName", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={},
    )

    assert first_get.json() == {"ok": True, "result": {"name": "First link"}}
    assert second_get.json() == {"ok": True, "result": {"name": ""}}


@pytest.mark.asyncio
async def test_telegram_profile_shadow_accepts_official_clear_and_boolean_wire_values(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-profile-wire-values"},
        )
    ).json()
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyName"),
            headers=_telegram_agent_headers(created),
            json={"name": "Before clear"},
        )
    ).status_code == 200
    cleared = await client.post(
        _telegram_bot_path(created, "setMyName"),
        headers=_telegram_agent_headers(created),
        json={"name": ""},
    )
    rights = {"can_manage_chat": True, "future_administrator_right": True}
    set_channel_rights = await client.get(
        _telegram_bot_path(created, "setMyDefaultAdministratorRights"),
        headers=_telegram_agent_headers(created),
        params={"rights": json.dumps(rights), "for_channels": "yes"},
    )
    get_channel_rights = await client.get(
        _telegram_bot_path(created, "getMyDefaultAdministratorRights"),
        headers=_telegram_agent_headers(created),
        params={"for_channels": "1"},
    )
    get_group_rights = await client.get(
        _telegram_bot_path(created, "getMyDefaultAdministratorRights"),
        headers=_telegram_agent_headers(created),
    )

    assert cleared.status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "getMyName"),
            headers=_telegram_agent_headers(created),
            json={},
        )
    ).json() == {"ok": True, "result": {"name": ""}}
    assert set_channel_rights.status_code == 200
    assert get_channel_rights.json() == {"ok": True, "result": rights}
    assert get_group_rights.json() == {"ok": True, "result": {}}


@pytest.mark.asyncio
async def test_telegram_chat_menu_button_is_scoped_and_replayed_per_link(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-shared-menu-button",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id="777", chat_type="private")
    first_default = {
        "type": "web_app",
        "text": "First",
        "web_app": {"url": "https://a.test", "future_web_app_field": "preserved"},
        "future_menu_field": {"enabled": True},
    }
    first_chat = {"type": "commands"}
    invalid_menu = await client.post(
        _telegram_bot_path(created, "setChatMenuButton"),
        headers=_telegram_agent_headers(created),
        json={
            "menu_button": {
                "text": "Missing provider discriminator",
            }
        },
    )
    assert invalid_menu.status_code == 400
    assert _FakeProviderClient.calls == []
    assert (
        await client.post(
            _telegram_bot_path(created, "setChatMenuButton"),
            headers=_telegram_agent_headers(created),
            json={"menu_button": first_default},
        )
    ).status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "setChatMenuButton"),
            headers=_telegram_agent_headers(created),
            json={"chat_id": "777", "menu_button": first_chat},
        )
    ).status_code == 200
    first_get = await client.post(
        _telegram_bot_path(created, "getChatMenuButton"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "777"},
    )
    assert first_get.json() == {"ok": True, "result": first_chat}

    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    blocked_second_get = await client.post(
        _telegram_bot_path(second, "getChatMenuButton", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={"chat_id": "777"},
    )
    assert blocked_second_get.status_code == 403
    second_default = {
        "type": "web_app",
        "text": "Second",
        "web_app": {"url": "https://b.test"},
    }
    _reset_fake_provider_client({"ok": True, "result": True})
    assert (
        await client.post(
            _telegram_bot_path(second, "setChatMenuButton", account_id=created["id"]),
            headers=_telegram_agent_headers(second),
            json={"menu_button": second_default},
        )
    ).status_code == 200
    assert _FakeProviderClient.calls == []

    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()
    _reset_fake_provider_client({"ok": True, "result": True})
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {second_pair['code']}",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )
    assert repaired.status_code == 200
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [{"chat_id": "777", "menu_button": second_default}]
    blocked_first_get = await client.post(
        _telegram_bot_path(created, "getChatMenuButton"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "777"},
    )
    second_get = await client.post(
        _telegram_bot_path(second, "getChatMenuButton", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={"chat_id": "777"},
    )
    assert blocked_first_get.status_code == 403
    assert second_get.json() == {"ok": True, "result": second_default}

    _reset_fake_provider_client({"ok": True, "result": True})
    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": "/clawdi_unpair",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )
    assert unpaired.status_code == 200
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [{"chat_id": "777", "menu_button": {"type": "default"}}]


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
async def test_telegram_legacy_profile_fallback_only_applies_to_single_link(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-legacy-profile",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    account = await db_session.get(ChannelAccount, UUID(created["id"]))
    assert account is not None
    account.config = {"telegram_bot_profile": {"name:": "Legacy account name"}}
    await db_session.commit()
    single_link = await client.post(
        _telegram_bot_path(created, "getMyName"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    first_after_share = await client.post(
        _telegram_bot_path(created, "getMyName"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    second_after_share = await client.post(
        _telegram_bot_path(second, "getMyName", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={},
    )

    assert single_link.json() == {"ok": True, "result": {"name": "Legacy account name"}}
    assert first_after_share.json() == {"ok": True, "result": {"name": ""}}
    assert second_after_share.json() == {"ok": True, "result": {"name": ""}}


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
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": [{"command": "start", "description": "Start"}]},
    )
    get_commands = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    wrong_scope = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"scope": {"type": "chat", "chat_id": 99}},
    )
    query_wrong_scope = await client.get(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        params={"scope": json.dumps({"type": "chat", "chat_id": 99})},
    )
    unknown_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "future", "description": "Future"}],
            "scope": {"type": "future_global_scope", "chat_id": 42},
        },
    )
    incomplete_member_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "member", "description": "Member"}],
            "scope": {"type": "chat_member", "chat_id": 42},
        },
    )

    assert set_commands.status_code == 200
    assert get_commands.json() == {
        "ok": True,
        "result": [{"command": "start", "description": "Start"}],
    }
    assert wrong_scope.status_code == 403
    assert wrong_scope.json()["ok"] is False
    assert query_wrong_scope.status_code == 403
    assert unknown_scope.status_code == 400
    assert unknown_scope.json()["description"] == "Bad Request: invalid scope"
    assert incomplete_member_scope.status_code == 400
    assert incomplete_member_scope.json()["description"] == "Bad Request: invalid scope"


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
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": [{"command": "start", "description": "Start"}]},
    )
    default_es = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "language_code": "es",
            "commands": [{"command": "start", "description": "Inicio"}],
        },
    )
    chat_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "scope": {"type": "chat", "chat_id": "42"},
            "commands": [{"command": "deploy", "description": "Deploy"}],
        },
    )
    get_default_en = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    get_default_es = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"language_code": "es"},
    )
    get_chat_scope = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"scope": {"type": "chat", "chat_id": "42"}},
    )
    deleted_es = await client.post(
        _telegram_bot_path(created, "deleteMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"language_code": "es"},
    )
    get_deleted_es = await client.post(
        _telegram_bot_path(created, "getMyCommands"),
        headers=_telegram_agent_headers(created),
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
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
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
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
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
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={
            "commands": [{"command": "start", "description": "Start"}],
            "scope": {"type": "all_private_chats"},
        },
    )

    assert private_scope.status_code == 200
    assert {call["json"]["scope"]["chat_id"] for call in _FakeProviderClient.calls} == {"42", "99"}

    _FakeProviderClient.calls = []
    group_scope = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
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
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-command-replay-on-pair",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    commands = [{"command": "welcome", "description": "Say hi"}]
    stored = await client.post(
        _telegram_bot_path(created, "setMyCommands"),
        headers=_telegram_agent_headers(created),
        json={"commands": commands},
    )
    assert stored.status_code == 200
    _reset_fake_provider_client({"ok": True, "result": True})

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
            "update_id": 51,
            "message": {
                "message_id": 51,
                "text": f"/clawdi_pair {pair['code']}",
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
async def test_telegram_repair_and_unpair_clear_previous_link_commands(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-command-repair-isolation",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    await _pair_telegram_chat(client, created=created, chat_id="777", chat_type="private")
    first_commands = [{"command": "first", "description": "First link"}]
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={"commands": first_commands},
        )
    ).status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={"commands": first_commands, "language_code": "es"},
        )
    ).status_code == 200
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={
                "commands": first_commands,
                "scope": {"type": "chat_member", "chat_id": "777", "user_id": "4242"},
            },
        )
    ).status_code == 200
    _reset_fake_provider_client({"ok": True, "result": True})
    assert (
        await client.delete(f"/v1/channels/{created['id']}/agent-links/{created['agent_link_id']}")
    ).status_code == 204
    unlink_command_calls = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/deleteMyCommands")
    ]
    assert {json.dumps(call["json"], sort_keys=True) for call in unlink_command_calls} == {
        json.dumps({"scope": {"type": "chat", "chat_id": "777"}}, sort_keys=True),
        json.dumps(
            {"scope": {"type": "chat", "chat_id": "777"}, "language_code": "es"},
            sort_keys=True,
        ),
        json.dumps(
            {"scope": {"type": "chat_member", "chat_id": "777", "user_id": "4242"}},
            sort_keys=True,
        ),
    }
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()

    _reset_fake_provider_client({"ok": True, "result": True})
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": f"/clawdi_pair {second_pair['code']}",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )

    assert repaired.status_code == 200
    assert repaired.json()["paired"] is True
    command_calls = [
        call
        for call in _FakeProviderClient.calls
        if call["url"].endswith(("/setMyCommands", "/deleteMyCommands"))
    ]
    assert command_calls == []
    second_get = await client.post(
        _telegram_bot_path(second, "getMyCommands", account_id=created["id"]),
        headers=_telegram_agent_headers(second),
        json={},
    )
    assert second_get.json()["result"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
    ]

    second_commands = [{"command": "second", "description": "Second link"}]
    _reset_fake_provider_client({"ok": True, "result": True})
    assert (
        await client.post(
            _telegram_bot_path(second, "setMyCommands", account_id=created["id"]),
            headers=_telegram_agent_headers(second),
            json={"commands": second_commands},
        )
    ).status_code == 200
    assert [
        call["json"] for call in _FakeProviderClient.calls if call["url"].endswith("/setMyCommands")
    ] == [{"commands": second_commands, "scope": {"type": "chat", "chat_id": "777"}}]

    _reset_fake_provider_client({"ok": True, "result": True})
    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 3,
            "message": {
                "message_id": 3,
                "from": {"id": 4242, "is_bot": False, "first_name": "Pairer"},
                "text": "/clawdi_unpair",
                "chat": {"id": 777, "type": "private"},
            },
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/deleteMyCommands")
    ] == [{"scope": {"type": "chat", "chat_id": "777"}}]


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
        _telegram_bot_path(created, "editMessageText"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": 42, "message_id": 1, "text": "edited"},
    )
    copy = await client.post(
        _telegram_bot_path(created, "copyMessage"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": 42, "from_chat_id": 99, "message_id": 1},
    )
    blocked_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": 42,
            "text": "reply",
            "reply_parameters": {"chat_id": 100, "message_id": 1},
        },
    )
    no_chat = await client.post(
        _telegram_bot_path(created, "answerInlineQuery"),
        headers=_telegram_agent_headers(created),
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
    assert no_chat.json()["description"] == "Forbidden: method is not available to this bot"
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/bot123456:telegram-secret/editMessageText"
    )
    assert json.loads(_FakeProviderClient.calls[0]["content"].decode("utf-8"))["chat_id"] == 42


@pytest.mark.asyncio
async def test_telegram_ordinary_requests_preserve_raw_payload_query_and_content_type(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 7}})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-opaque-provider-payloads",
        chat_id="42",
    )
    raw_json = (
        b'{  "chat_id" : 42, "text":"json", "future_hint":"first", '
        b'"future_hint":"second", "future_payload":{"type":"first","type":"second"} }\n'
    )
    raw_form = b"chat_id=42&text=form+body&future_hint=%2f&future_hint=second&empty="
    raw_query = "chat_id=42&text=query+body&future_hint=%2f&future_hint=second&empty="

    json_response = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=raw_json,
    )
    form_response = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={
            **_telegram_agent_headers(created),
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        content=raw_form,
    )
    query_response = await client.get(
        f"{_telegram_bot_path(created, 'sendMessage')}?{raw_query}",
        headers=_telegram_agent_headers(created),
    )

    assert json_response.status_code == 200
    assert form_response.status_code == 200
    assert query_response.status_code == 200
    assert _FakeProviderClient.calls[0]["content"] == raw_json
    assert _FakeProviderClient.calls[0]["headers"]["content-type"] == "application/json"
    assert _FakeProviderClient.calls[1]["content"] == raw_form
    assert _FakeProviderClient.calls[1]["headers"]["content-type"] == (
        "application/x-www-form-urlencoded; charset=UTF-8"
    )
    assert _FakeProviderClient.calls[2]["url"].endswith(f"/sendMessage?{raw_query}")


@pytest.mark.asyncio
async def test_telegram_private_and_forum_thread_methods_preserve_message_thread_id(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-native-private-forum-topics",
        chat_id="42",
        chat_type="private",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="-10042",
        update_id=2,
        chat_type="supergroup",
    )
    _reset_fake_provider_client({"ok": True, "result": True})
    json_requests = (
        (
            "sendMessageDraft",
            b'{ "chat_id": 42, "message_thread_id": 7, "draft_id": 1, "text": "draft" }\n',
        ),
        (
            "sendChatAction",
            b'{ "chat_id": 42, "message_thread_id": 7, "action": "typing" }\n',
        ),
        (
            "sendMessage",
            b'{ "chat_id": -10042, "message_thread_id": 9, "text": "forum" }\n',
        ),
        (
            "sendChatAction",
            b'{ "chat_id": -10042, "message_thread_id": 9, "action": "typing" }\n',
        ),
    )

    for method, body in json_requests:
        response = await client.post(
            _telegram_bot_path(created, method),
            headers={**_telegram_agent_headers(created), "content-type": "application/json"},
            content=body,
        )
        assert response.status_code == 200

    private_form = b"chat_id=42&message_thread_id=8&action=typing&future_hint=preserved"
    form_response = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers={
            **_telegram_agent_headers(created),
            "content-type": "application/x-www-form-urlencoded",
        },
        content=private_form,
    )
    ordinary_private = b'{ "chat_id": 42, "action": "typing", "future_hint": true }\n'
    ordinary_response = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=ordinary_private,
    )
    assert form_response.status_code == 200
    assert ordinary_response.status_code == 200

    assert [call["content"] for call in _FakeProviderClient.calls] == [
        *[body for _method, body in json_requests],
        private_form,
        ordinary_private,
    ]
    assert [call["url"].rsplit("/", 1)[-1] for call in _FakeProviderClient.calls] == [
        *[method for method, _body in json_requests],
        "sendChatAction",
        "sendChatAction",
    ]
    assert all(
        b"direct_messages_topic_id" not in call["content"] for call in _FakeProviderClient.calls
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content", "query"),
    [
        (b'{"chat_id":42,"chat_id":99,"text":"ambiguous"}', None),
        (
            b'{"chat_id":42,"text":"ambiguous",'
            b'"reply_parameters":{"chat_id":42,"chat_id":99,"message_id":1}}',
            None,
        ),
        (None, "chat_id=42&chat_id=99&text=ambiguous"),
    ],
)
async def test_telegram_duplicate_authority_fields_are_rejected(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    content: bytes | None,
    query: str | None,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-duplicate-authority",
        chat_id="42",
    )
    if query is not None:
        response = await client.get(
            f"{_telegram_bot_path(created, 'sendMessage')}?{query}",
            headers=_telegram_agent_headers(created),
        )
    else:
        response = await client.post(
            _telegram_bot_path(created, "sendMessage"),
            headers={**_telegram_agent_headers(created), "content-type": "application/json"},
            content=content,
        )

    assert response.status_code == 400
    assert response.json()["description"].startswith("Bad Request: duplicate parameter")
    assert _FakeProviderClient.calls == []


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
        _telegram_bot_path(created, "sendPhoto"),
        headers=_telegram_agent_headers(created),
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
async def test_telegram_native_attach_multipart_is_forwarded_byte_for_byte_and_recorded(
    client: httpx.AsyncClient,
    monkeypatch,
):
    _reset_fake_provider_client(
        {
            "ok": True,
            "result": {
                "message_id": 7,
                "photo": [
                    {"file_id": "uploaded-photo-small"},
                    {"file_id": "uploaded-photo"},
                ],
            },
        }
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-native-attach",
        chat_id="42",
    )
    boundary = "telegram-native-boundary"
    content_type = f'multipart/form-data; boundary="{boundary}"'
    multipart_body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
        "42\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="photo"\r\n\r\n'
        "attach://photo_file\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="future_caption_style"\r\n\r\n'
        "future-value\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="photo_file"; filename="photo.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
        "PNGDATA\r\n"
        f"--{boundary}--\r\n"
    ).encode("ascii")

    response = await client.post(
        _telegram_bot_path(created, "sendPhoto"),
        headers={**_telegram_agent_headers(created), "content-type": content_type},
        content=multipart_body,
    )

    assert response.status_code == 200
    assert _FakeProviderClient.calls[0]["content"] == multipart_body
    assert _FakeProviderClient.calls[0]["headers"]["content-type"] == content_type

    _reset_fake_provider_client({"ok": True, "result": {"message_id": 8}})
    reuse = await client.post(
        _telegram_bot_path(created, "sendPhoto"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "photo": "uploaded-photo"},
    )

    assert reuse.status_code == 200
    assert len(_FakeProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_successful_send_survives_reference_recording_failure(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    provider_payload = {
        "ok": True,
        "result": {
            "message_id": 71,
            "chat": {"id": 42, "type": "private"},
            "document": {"file_id": "telegram-file-before-recording-failure"},
        },
    }
    provider_body = (
        b'{  "ok" : true, "result" : { "message_id" : 71, '
        b'"chat" : {"id":42,"type":"private"}, '
        b'"document":{"file_id":"telegram-file-before-recording-failure"} } }\n'
    )
    provider_headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "3",
        "x-ratelimit-remaining": "9",
        "x-request-id": "telegram-send-recording-request",
        "x-correlation-id": "telegram-send-recording-correlation",
    }
    _reset_fake_provider_client(
        provider_payload,
        content=provider_body,
        headers=provider_headers,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-send-recording-failure",
        chat_id="42",
    )
    recording_calls = 0

    async def fail_second_reference_recording(db: AsyncSession, **kwargs):
        nonlocal recording_calls
        recording_calls += 1
        if recording_calls == 2:
            await db.execute(text("SELECT * FROM telegram_missing_reference_recording_table"))
        return await channel_service.record_channel_agent_reference(db, **kwargs)

    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.record_channel_agent_reference",
        fail_second_reference_recording,
    )

    response = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "document": "https://example.test/report.pdf"},
    )

    assert response.status_code == 200
    assert response.content == provider_body
    assert response.headers["content-type"] == provider_headers["content-type"]
    assert response.headers["content-length"] == provider_headers["content-length"]
    assert response.headers["retry-after"] == provider_headers["retry-after"]
    assert response.headers["x-ratelimit-remaining"] == provider_headers["x-ratelimit-remaining"]
    assert response.headers["x-telegram-request-id"] == provider_headers["x-request-id"]
    assert response.headers["x-request-id"] != provider_headers["x-request-id"]
    assert response.headers["x-correlation-id"] == provider_headers["x-correlation-id"]
    assert recording_calls == 2
    recorded_reference = (
        await db_session.execute(
            select(ChannelAgentReference.id).where(
                ChannelAgentReference.account_id == UUID(created["id"]),
                ChannelAgentReference.ref_value == "telegram-file-before-recording-failure",
            )
        )
    ).scalar_one_or_none()
    assert recorded_reference is None
    assert (await db_session.execute(select(1))).scalar_one() == 1
    assert "telegram_reference_recording_failed" in caplog.text
    assert f"account_id={created['id']}" in caplog.text
    assert "method=sendDocument" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_status", [200, 400])
async def test_telegram_failed_outbound_response_does_not_grant_file_reference(
    client: httpx.AsyncClient,
    monkeypatch,
    provider_status: int,
):
    _reset_fake_provider_client(
        {
            "ok": False,
            "error_code": 400,
            "description": "Bad Request: upload failed",
            "result": {"document": {"file_id": "failed-upload-file"}},
        },
        status_code=provider_status,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name=f"telegram-failed-upload-ref-{provider_status}",
        chat_id="42",
    )

    failed = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        data={"chat_id": "42"},
        files={"document": ("report.pdf", b"PDFDATA", "application/pdf")},
    )
    assert failed.status_code == provider_status
    assert failed.json()["ok"] is False
    assert len(_FakeProviderClient.calls) == 1

    _reset_fake_provider_client({"ok": True, "result": {"message_id": 8}})
    reuse = await client.post(
        _telegram_bot_path(created, "sendDocument"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": "42", "document": "failed-upload-file"},
    )

    assert reuse.status_code == 403
    assert reuse.json()["description"] == "Forbidden: file_id is not bound to this bot"
    assert _FakeProviderClient.calls == []


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
            _telegram_bot_path(created, "sendMessage"),
            headers=_telegram_agent_headers(created),
            json={"chat_id": 42, "text": f"msg{index}"},
        )
        assert response.status_code == 200

    limited = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
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

    deleted = await client.post(
        _telegram_bot_path(created, "deleteWebhook"),
        headers=_telegram_agent_headers(created),
        json={"drop_pending_updates": True},
    )
    updates = await client.get(
        _telegram_bot_path(created, "getUpdates"), headers=_telegram_agent_headers(created)
    )

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
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
async def test_telegram_agent_webhook_5xx_defers_ack_to_worker(
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
        name="telegram-agent-webhook-retry-5xx",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 907,
            "message": {
                "message_id": 907,
                "text": "retry 5xx immediately",
                "chat": {"id": 42, "type": "private"},
            },
        },
    )

    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "907")
        )
    ).scalar_one()
    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert len(_SequencedProviderClient.calls) == 1

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(message)

    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_update_redelivery_retries_failed_agent_webhook(
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
        name="telegram-redelivery-retry",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    payload = {
        "update_id": 909,
        "message": {
            "message_id": 77,
            "text": "retry identical update",
            "chat": {"id": 42, "type": "private"},
        },
    }
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    first = await client.post(webhook_url, headers=headers, json=payload)
    redelivery = await client.post(webhook_url, headers=headers, json=payload)
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id == "update:909",
                )
            )
        ).scalars()
    )

    assert first.status_code == 200
    assert redelivery.status_code == 200
    assert len(messages) == 1
    assert messages[0].provider_message_id == "77"
    assert messages[0].delivered_at is None
    assert len(_SequencedProviderClient.calls) == 1

    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    result = await ChannelWebhookDeliveryWorker(sessionmaker).run_once()
    await db_session.refresh(messages[0])

    assert result is not None
    assert result.message_id == messages[0].id
    assert result.delivered is True
    assert messages[0].delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 2


@pytest.mark.asyncio
async def test_telegram_agent_webhook_inactive_link_records_debug_health(
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
        name="telegram-agent-webhook-inactive-link",
        chat_id="4301",
        provider_token=None,
    )
    await client.post(
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    link.status = "archived"
    link.archived_at = datetime.now(UTC)
    await db_session.commit()

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 908,
            "message": {
                "message_id": 908,
                "text": "link is inactive",
                "chat": {"id": 4301, "type": "private"},
            },
        },
    )
    message = (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.provider_message_id == "908")
        )
    ).scalar_one()
    health_response = await client.get("/v1/channels/health")
    activity_response = await client.get(
        f"/v1/channels/{created['id']}/activity",
        params={"external_chat_id": "4301", "limit": 20},
    )

    assert inbound.status_code == 200
    assert message.delivered_at is None
    assert _SequencedProviderClient.calls == []
    assert health_response.status_code == 200, health_response.text
    health = next(
        item for item in health_response.json()["items"] if item["account_id"] == created["id"]
    )
    assert health["health_status"] == "error"
    assert "pending_inbox" in health["reasons"]
    assert "recent_error" in health["reasons"]
    assert health["pending_inbox"] >= 1
    assert health["last_error"] == "bot agent link inactive"
    assert health["last_error_stage"] == "agent_webhook"
    assert health["last_error_outcome"] == "failure"
    assert activity_response.status_code == 200, activity_response.text
    debug_item = next(
        item for item in activity_response.json()["items"] if item["kind"] == "debug_event"
    )
    assert debug_item["stage"] == "agent_webhook"
    assert debug_item["outcome"] == "failure"
    assert debug_item["error"] == "bot agent link inactive"
    assert debug_item["details"]["reason"] == "link_archived"
    assert debug_item["details"]["bot_agent_link_id"] == created["agent_link_id"]
    assert debug_item["details"]["bot_agent_link_status"] == "archived"


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
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent-hook.example/agent-hook"},
    )

    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
    _reset_sequenced_provider_client([503, 503, 503, 200])
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
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook", "secret_token": "agent-secret"},
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
    worker = ChannelWebhookDeliveryWorker(sessionmaker)
    first_result = await worker.run_once()
    second_result = await worker.run_once()
    result = await worker.run_once()
    await db_session.refresh(message)

    assert first_result is not None
    assert first_result.message_id == message.id
    assert first_result.delivered is False
    assert second_result is not None
    assert second_result.message_id == message.id
    assert second_result.delivered is False
    assert result is not None
    assert result.message_id == message.id
    assert result.delivered is True
    assert message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 4


@pytest.mark.asyncio
async def test_telegram_webhook_worker_skips_non_webhook_queue_head(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    channel_agent,
    second_channel_agent,
):
    _reset_sequenced_provider_client([503, 503, 503, 200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    polling_channel = await _create_paired_telegram_channel(
        client,
        name="telegram-worker-polling-queue-head",
        provider_token=None,
        chat_id="4201",
        agent_id=channel_agent.id,
    )
    webhook_channel = await _create_paired_telegram_channel(
        client,
        name="telegram-worker-webhook-behind-queue-head",
        provider_token=None,
        chat_id="4202",
        agent_id=second_channel_agent.id,
    )
    await client.post(
        _telegram_bot_path(webhook_channel, "setWebhook"),
        headers=_telegram_agent_headers(webhook_channel),
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
        f"/v1/channels/telegram/{webhook_channel['id']}/webhook",
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
    worker = ChannelWebhookDeliveryWorker(sessionmaker)
    first_result = await worker.run_once()
    second_result = await worker.run_once()
    result = await worker.run_once()
    await db_session.refresh(webhook_message)

    assert first_result is not None
    assert first_result.message_id == webhook_message.id
    assert first_result.delivered is False
    assert second_result is not None
    assert second_result.message_id == webhook_message.id
    assert second_result.delivered is False
    assert result is not None
    assert result.message_id == webhook_message.id
    assert result.delivered is True
    assert webhook_message.delivered_at is not None
    assert len(_SequencedProviderClient.calls) == 4


@pytest.mark.asyncio
async def test_telegram_webhook_worker_drops_expired_agent_delivery(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    _reset_sequenced_provider_client([503, 503, 503])
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
        _telegram_bot_path(created, "setWebhook"),
        headers=_telegram_agent_headers(created),
        json={"url": "https://agent.example/agent-hook"},
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        _telegram_bot_path(created, "answerCallbackQuery"),
        headers=_telegram_agent_headers(created),
        json={"callback_query_id": "cb-1", "text": "ok"},
    )
    unowned = await client.post(
        _telegram_bot_path(created, "answerCallbackQuery"),
        headers=_telegram_agent_headers(created),
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
    routing_id = channel_runtime_placeholder_token(
        CHANNEL_PROVIDER_TELEGRAM,
        channel_runtime_account_key(UUID(created["id"])),
    )
    managed_headers = {"Authorization": f"Bearer {created['agent_token']}"}
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        f"/v1/channels/telegram/bot/{routing_id}/getFile",
        headers=managed_headers,
        json={"file_id": "file_1"},
    )
    unowned_file = await client.post(
        f"/v1/channels/telegram/bot/{routing_id}/getFile",
        headers=managed_headers,
        json={"file_id": "file_other"},
    )
    _reset_fake_provider_client(
        {"ok": True},
        content=b"telegram-file",
        headers={"content-type": "text/plain"},
    )
    download_path = f"/v1/channels/telegram/file/bot/{routing_id}/photos/file_1.jpg"
    unowned_download_path = f"/v1/channels/telegram/file/bot/{routing_id}/photos/other.jpg"
    download = await client.get(download_path, headers=managed_headers)
    unowned_download = await client.get(unowned_download_path, headers=managed_headers)
    rejected_old_secret_path = await client.get(
        f"/v1/channels/telegram/file/bot/{created['agent_token']}/photos/file_1.jpg"
    )

    assert get_file.status_code == 200
    assert get_file.json()["result"]["file_path"] == "photos/file_1.jpg"
    assert unowned_file.status_code == 403
    assert unowned_file.json()["description"] == "Forbidden: file_id is not bound to this bot"
    assert download.status_code == 200
    assert download.text == "telegram-file"
    assert created["agent_token"] not in download_path
    assert created["agent_token"] not in unowned_download_path
    assert rejected_old_secret_path.status_code == 401
    assert _FakeProviderClient.calls[0]["url"].endswith(
        "/file/bot123456:telegram-secret/photos/file_1.jpg"
    )
    assert unowned_download.status_code == 403
    assert unowned_download.json()["description"] == "Forbidden: file_path is not bound to this bot"


@pytest.mark.asyncio
async def test_telegram_get_file_success_survives_path_recording_failure(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-get-file-recording-failure",
        chat_id="42",
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 2,
                "chat": {"id": 42, "type": "private"},
                "document": {"file_id": "telegram-owned-file"},
            },
        },
    )
    assert inbound.status_code == 200
    provider_payload = {
        "ok": True,
        "result": {
            "file_id": "telegram-owned-file",
            "file_path": "documents/provider-success.dat",
        },
    }
    provider_body = (
        b'{ "ok" : true, "result" : {"file_id":"telegram-owned-file", '
        b'"file_path":"documents/provider-success.dat"} }\n'
    )
    provider_headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "5",
        "ratelimit-reset": "8",
        "x-request-id": "telegram-get-file-recording-request",
        "x-correlation-id": "telegram-get-file-recording-correlation",
    }
    _reset_fake_provider_client(
        provider_payload,
        content=provider_body,
        headers=provider_headers,
    )

    async def fail_file_path_recording(db: AsyncSession, **_kwargs):
        await db.execute(text("SELECT * FROM telegram_missing_file_path_recording_table"))

    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.record_channel_agent_reference",
        fail_file_path_recording,
    )

    response = await client.post(
        _telegram_bot_path(created, "getFile"),
        headers=_telegram_agent_headers(created),
        json={"file_id": "telegram-owned-file"},
    )

    assert response.status_code == 200
    assert response.content == provider_body
    assert response.headers["content-type"] == provider_headers["content-type"]
    assert response.headers["content-length"] == provider_headers["content-length"]
    assert response.headers["retry-after"] == provider_headers["retry-after"]
    assert response.headers["ratelimit-reset"] == provider_headers["ratelimit-reset"]
    assert response.headers["x-telegram-request-id"] == provider_headers["x-request-id"]
    assert response.headers["x-request-id"] != provider_headers["x-request-id"]
    assert response.headers["x-correlation-id"] == provider_headers["x-correlation-id"]
    recorded_path = (
        await db_session.execute(
            select(ChannelAgentReference.id).where(
                ChannelAgentReference.account_id == UUID(created["id"]),
                ChannelAgentReference.ref_value == "documents/provider-success.dat",
            )
        )
    ).scalar_one_or_none()
    assert recorded_path is None
    assert (await db_session.execute(select(1))).scalar_one() == 1
    assert "telegram_reference_recording_failed" in caplog.text
    assert f"account_id={created['id']}" in caplog.text
    assert "method=getFile" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "payload"),
    [
        ("getFile", {"file_id": "file-owned"}),
        ("answerCallbackQuery", {"callback_query_id": "callback-owned", "text": "done"}),
    ],
)
async def test_telegram_reference_methods_preserve_provider_failure_response(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, str],
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name=f"telegram-transparent-{method.lower()}",
        chat_id="42",
    )
    inbound = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "callback_query": {
                "id": "callback-owned",
                "data": "approve",
                "message": {
                    "message_id": 2,
                    "chat": {"id": 42, "type": "private"},
                    "document": {"file_id": "file-owned"},
                },
            },
        },
    )
    assert inbound.status_code == 200
    provider_body = b"telegram provider overloaded\n"
    provider_headers = {
        "content-type": "text/plain; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "11",
        "x-ratelimit-reset-after": "11.5",
        "x-request-id": "telegram-request-1",
        "x-correlation-id": "telegram-correlation-1",
    }
    _reset_fake_provider_client(
        {"ok": False, "future_error": {"retry_after": 11}},
        status_code=429,
        content=provider_body,
        headers=provider_headers,
    )

    response = await client.post(
        _telegram_bot_path(created, method),
        headers=_telegram_agent_headers(created),
        json=payload,
    )

    assert response.status_code == 429
    assert response.content == provider_body
    for key, value in provider_headers.items():
        if key == "x-request-id":
            assert response.headers["x-telegram-request-id"] == value
            assert response.headers["x-request-id"] != value
        else:
            assert response.headers[key] == value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "payload"),
    [
        (
            "setMyCommands",
            {
                "commands": [
                    {
                        "command": "future",
                        "description": "Future command",
                        "future_command_field": "preserved",
                    }
                ],
                "future_top_level_option": {"enabled": True},
            },
        ),
        (
            "setChatMenuButton",
            {
                "chat_id": "42",
                "menu_button": {
                    "type": "future_button",
                    "future_menu_field": {"enabled": True},
                },
                "future_top_level_option": "preserved",
            },
        ),
    ],
)
async def test_telegram_materialized_shadow_methods_preserve_provider_error_and_unknown_fields(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, Any],
):
    _reset_fake_provider_client({"ok": True, "result": True})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = await _create_paired_telegram_channel(
        client,
        name=f"telegram-transparent-shadow-{method.lower()}",
        chat_id="42",
    )
    provider_body = b'{  "ok" : false, "future_error":"provider-owned"  }\n'
    provider_headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": str(len(provider_body)),
        "retry-after": "7",
        "x-request-id": "telegram-shadow-request",
    }
    _reset_fake_provider_client(
        {"ok": False, "future_error": "provider-owned"},
        content=provider_body,
        headers=provider_headers,
    )

    response = await client.post(
        _telegram_bot_path(created, method),
        headers=_telegram_agent_headers(created),
        json=payload,
    )

    assert response.status_code == 200
    assert response.content == provider_body
    for key, value in provider_headers.items():
        if key == "x-request-id":
            assert response.headers["x-telegram-request-id"] == value
            assert response.headers["x-request-id"] != value
        else:
            assert response.headers[key] == value
    assert _FakeProviderClient.calls
    provider_payload = _FakeProviderClient.calls[0]["json"]
    assert provider_payload["future_top_level_option"] == payload["future_top_level_option"]
    if method == "setMyCommands":
        assert provider_payload["commands"][0]["future_command_field"] == "preserved"
    else:
        assert provider_payload["menu_button"]["future_menu_field"] == {"enabled": True}


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
                    "d": {"token": placeholder, "session_id": session_id, "seq": guild["s"]},
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
    _DISCORD_GATEWAY_SESSIONS.clear()
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
    binding_a = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link_a.id,
        user_id=account.user_id,
        external_chat_id="shared-gateway-channel-a",
        external_chat_type="guild_text",
        external_chat_name="shared-gateway-guild-a",
    )
    binding_b = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link_b.id,
        user_id=account.user_id,
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
                user_id=account.user_id,
                binding_id=binding_a.id,
                alias_kind="discord_channel",
                alias_external_chat_id="shared-gateway-channel-a",
            ),
            ChannelBindingAlias(
                account_id=account.id,
                bot_agent_link_id=link_b.id,
                user_id=account.user_id,
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

    def identify(bearer: str) -> tuple[dict[str, Any], dict[str, Any]]:
        with TestClient(app) as sync_client:
            with sync_client.websocket_connect(
                "/v1/channels/discord/gateway?v=10&encoding=json",
                headers={"Authorization": f"Bearer {bearer}"},
            ) as websocket:
                assert websocket.receive_json()["op"] == 10
                websocket.send_json({"op": 2, "d": {"token": placeholder, "intents": 0}})
                return websocket.receive_json(), websocket.receive_json()

    ready_a, guild_a = identify(created["agent_token"])
    ready_b, guild_b = identify(second["agent_token"])

    assert ready_a["d"]["resume_gateway_url"] == settings.channel_discord_gateway_url
    assert ready_b["d"]["resume_gateway_url"] == settings.channel_discord_gateway_url
    assert ready_a["d"]["guilds"] == [{"id": "shared-gateway-guild-a", "unavailable": False}]
    assert ready_b["d"]["guilds"] == [{"id": "shared-gateway-guild-b", "unavailable": False}]
    assert [channel["id"] for channel in guild_a["d"]["channels"]] == ["shared-gateway-channel-a"]
    assert [channel["id"] for channel in guild_b["d"]["channels"]] == ["shared-gateway-channel-b"]
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
                        "seq": guild_a["s"],
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
    account.visibility = CHANNEL_VISIBILITY_PUBLIC
    db_session.add_all(
        [
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=UUID(created["agent_link_id"]),
                user_id=account.user_id,
                external_chat_id="shared-link-channel-a",
                external_chat_type="guild_text",
                external_chat_name="shared-link-guild-a",
            ),
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=UUID(link_b["id"]),
                user_id=account.user_id,
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
    await _record_discord_interaction(
        client,
        created=created,
        interaction_id="interaction-1",
        token="interaction-token-1",
        application_id=DISCORD_TEST_APPLICATION_ID,
    )
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
    blocked = await client.post(
        "/v1/channels/discord/v10/guilds/discord-guild-2/channels",
        headers=headers,
        json={"name": "ops", "type": 0},
    )

    assert allowed.status_code == 200
    assert channel_send.status_code == 200
    assert channel_send.json()["id"] == "guild-channel"
    assert blocked.status_code == 403
    assert blocked.json() == {"code": 50001, "message": "Missing Access"}
    assert _FakeProviderClient.calls[0]["url"].endswith("/guilds/discord-guild-1/channels")
    assert _FakeProviderClient.calls[0]["headers"]["Authorization"] == (
        "Bot discord-provider-token"
    )
    assert _FakeProviderClient.calls[1]["url"].endswith("/channels/discord-chan-1/messages")


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
    ("provider_payload", "provider_status", "provider_content"),
    [
        ({"id": "unknown-channel", "guild_id": "wrong-guild"}, 200, None),
        ({"id": "unknown-channel", "type": 1}, 200, None),
        ({"id": "different-channel", "guild_id": "bound-guild"}, 200, None),
        ({}, 200, b"not-json"),
        ({"message": "upstream error"}, 500, None),
    ],
)
async def test_discord_unobserved_channel_lookup_failures_do_not_authorize(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    provider_payload: dict[str, Any],
    provider_status: int,
    provider_content: bytes | None,
):
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

    assert response.status_code == 403
    assert response.json() == {"code": 50001, "message": "Missing Access"}
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


@pytest.mark.asyncio
async def test_whatsapp_graph_agent_send_uses_agent_token_and_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    channel_agent,
):
    _FakeProviderClient.calls = []
    _FakeProviderClient.response_payload = {"messages": [{"id": "wamid.agent.pair-reply"}]}
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-agent",
                "provider_token": "wa-provider-token",
                "config": {"phone_number_id": "phone-agent"},
            },
        )
    ).json()
    await _seed_created_channel_link(db_session, created=created, agent=channel_agent)
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
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
                                        "text": {"body": f"/clawdi_pair {pair['code']}"},
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
        "/v1/channels/whatsapp/graph/v20.0/phone-agent/messages",
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
            "/v1/channels",
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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-pair",
                "text": f"/clawdi_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15550001111"}],
            }
        },
    )
    _reset_fake_provider_client({"data": {"guid": "imsg-agent-sent"}})

    sent = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/text",
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
            "/v1/channels",
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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-any-pair",
                "text": f"/clawdi_pair {pair['code']}",
                "chats": [{"guid": "any;-;+15550001112"}],
            }
        },
    )
    _reset_fake_provider_client({"data": {"guid": "imsg-any-service-sent"}})

    sent = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/text",
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
            "/v1/channels",
            json={
                "provider": "imessage",
                "name": "imessage-auth-shapes",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()
    token = created["agent_token"]

    missing = await client.get("/v1/channels/imessage/bluebubbles/v1/ping")
    password = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        params={"password": token},
    )
    x_api_key = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        headers={"X-API-Key": token},
    )
    x_password = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        headers={"X-Password": token},
    )
    bearer = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
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
    path = "/v1/channels/imessage/bluebubbles/socket.io/?EIO=4&transport=websocket"

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
            "/v1/channels",
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
        "/v1/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )
    listed = await client.get("/v1/channels/imessage/bluebubbles/v1/webhook", params=params)
    deleted = await client.delete(
        f"/v1/channels/imessage/bluebubbles/v1/webhook/{created['id']}", params=params
    )
    relisted = await client.get("/v1/channels/imessage/bluebubbles/v1/webhook", params=params)

    assert registered.status_code == 200
    assert registered.json()["data"]["url"] == "https://agent.example/bluebubbles"
    assert listed.json()["data"][0]["events"]
    assert deleted.status_code == 200
    assert relisted.json()["data"] == []


@pytest.mark.asyncio
async def test_bluebubbles_server_info_advertises_private_api(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
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
        "/v1/channels/imessage/bluebubbles/v1/server/info",
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
            "/v1/channels",
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
        "/v1/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "http://example.com/webhook"},
    )
    loopback = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://127.0.0.1/webhook"},
    )
    safe = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/webhook",
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
            "/v1/channels",
            json={
                "provider": "imessage",
                "name": "imessage-webhook-private-dns",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()

    response = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/webhook",
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
        f"/v1/channels/imessage/{created['id']}/webhook",
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
        "/v1/channels/imessage/bluebubbles/v1/webhook",
        params={"password": created["agent_token"]},
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )

    inbound = await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
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
        "/v1/channels/imessage/bluebubbles/v1/webhook",
        params={"password": created["agent_token"]},
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )

    inbound = await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
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
        "/v1/channels/imessage/bluebubbles/v1/webhook",
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
        f"/v1/channels/imessage/{created['id']}/webhook",
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
        "/v1/channels/imessage/bluebubbles/v1/webhook",
        params=params,
        json={"url": "https://agent.example/bluebubbles", "events": ["new-message"]},
    )

    inbound = await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
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
        "/v1/channels/imessage/bluebubbles/v1/message/imsg-sanitize-message",
        params=params,
    )
    history = await client.get(
        f"/v1/channels/imessage/bluebubbles/v1/chat/{chat_guid}/messages",
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
            "/v1/channels",
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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imsg-query-pair",
                "text": f"/clawdi_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15550003333", "displayName": "Ops"}],
            }
        },
    )
    await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
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
        "/v1/channels/imessage/bluebubbles/v1/chat/query", params=params, json={}
    )
    messages = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/query",
        params=params,
        json={"chatGuid": "iMessage;-;+15550003333"},
    )
    single = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/message/imsg-query-message", params=params
    )
    blocked = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/chat/iMessage;-;+19999999999", params=params
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
        f"/v1/channels/imessage/bluebubbles/v1/chat/{chat_guid}/messages", params=params
    )
    history_b = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/messages",
        params={**params, "chatGuid": chat_guid},
    )
    count = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/message/count",
        params={**params, "chatGuid": chat_guid},
    )
    edited = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/imsg-compat-message/edit",
        params=params,
        json={"editedMessage": "edited"},
    )
    reacted = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/react",
        params=params,
        json={
            "chatGuid": chat_guid,
            "selectedMessageGuid": "imsg-compat-message",
            "reaction": "love",
        },
    )
    updated_count = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/message/count/updated",
        params={**params, "chatGuid": chat_guid},
    )
    unsent = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/imsg-compat-message/unsend",
        params=params,
        json={},
    )
    scheduled = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/schedule",
        params=params,
        json={"chatGuid": chat_guid, "message": "later", "scheduledFor": 1_900_000_000_000},
    )
    schedule_id = scheduled.json()["data"]["id"]
    listed = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/message/schedule", params=params
    )
    updated_schedule = await client.put(
        f"/v1/channels/imessage/bluebubbles/v1/message/schedule/{schedule_id}",
        params=params,
        json={"message": "later edited"},
    )
    deleted_schedule = await client.delete(
        f"/v1/channels/imessage/bluebubbles/v1/message/schedule/{schedule_id}", params=params
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
        "/v1/channels/imessage/bluebubbles/v1/attachment/upload",
        params=params,
        files={"attachment": ("note.txt", b"hello attachment", "text/plain")},
    )
    upload_path = uploaded.json()["data"]["path"]
    multipart = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/multipart",
        params=params,
        json={
            "chatGuid": chat_guid,
            "parts": [{"text": "caption"}, {"attachment": upload_path}],
        },
    )
    attachment_guid = multipart.json()["data"]["attachments"][0]["guid"]
    downloaded = await client.get(
        f"/v1/channels/imessage/bluebubbles/v1/attachment/{attachment_guid}/download",
        params=params,
    )
    direct = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/attachment",
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
            "/v1/channels",
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
        "/v1/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={"addresses": [None], "message": "hi"},
    )
    no_message = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={
            "addresses": ["+15550007777"],
            "tempGuid": "temp-create",
            "groupChatName": "Project",
        },
    )
    with_message = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/chat/new",
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
        "/v1/channels/imessage/bluebubbles/v1/messages",
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
        "/v1/channels/imessage/bluebubbles/v1/chat/new",
        params=params,
        json={"participants": ["+15550007777"], "displayName": "New chat"},
    )
    search = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/message/search",
        params=params,
        json={"chatGuid": chat_guid, "query": "query"},
    )
    poll = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/poll/create",
        params=params,
        json={"chatGuid": chat_guid, "title": "Pick one", "options": ["A", "B"]},
    )
    facetime = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/facetime/session", params=params
    )
    handles = await client.post(
        "/v1/channels/imessage/bluebubbles/v1/handle/query", params=params, json={}
    )
    stats = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/server/statistics/totals", params=params
    )
    contact = await client.get("/v1/channels/imessage/bluebubbles/v1/contact", params=params)
    share = await client.get(
        f"/v1/channels/imessage/bluebubbles/v1/chat/{chat_guid}/share/contact/status",
        params=params,
    )
    missing_share = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/chat/iMessage;-;+19999999999/share/contact/status",
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
async def test_telegram_webhook_pair_code_creates_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-main"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "message_thread_id": 321,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
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
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json()[0]["external_chat_id"] == "987654321"
    assert bindings.json()[0]["external_chat_type"] == "private"
    assert bindings.json()[0]["external_chat_name"] == "paco"


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
async def test_telegram_pairing_threads_share_one_chat_binding(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-chat-level-binding"},
        )
    ).json()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    for update_id, thread_id in ((11, 321), (12, 654)):
        pair = (
            await client.post(
                f"/v1/channels/{created['id']}/pair-codes",
                json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
            )
        ).json()
        response = await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": update_id,
                "message": {
                    "message_id": update_id,
                    "message_thread_id": thread_id,
                    "text": f"/clawdi_pair {pair['code']}",
                    "chat": {"id": 987654321, "type": "private"},
                    "from": {"id": 987654321, "is_bot": False},
                },
            },
        )
        assert response.status_code == 200
        assert response.json()["paired"] is True

    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert [binding["external_chat_id"] for binding in bindings.json()] == ["987654321"]


@pytest.mark.asyncio
async def test_telegram_pair_code_returns_server_owned_deep_link_metadata(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-deep-link",
                "config": {"bot_username": "@Clawdi_Test_Bot"},
            },
        )
    ).json()
    response = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
    )

    assert response.status_code == 201
    pair = response.json()
    assert pair["pairing_command"] == f"/clawdi_pair {pair['code']}"
    assert pair["bot_username"] == "Clawdi_Test_Bot"
    assert pair["deep_link"] == f"https://t.me/Clawdi_Test_Bot?start={pair['code']}"
    assert pair["qr_payload"] == pair["deep_link"]
    assert created["agent_token"] not in pair["deep_link"]
    assert "telegram-secret" not in response.text


@pytest.mark.asyncio
async def test_telegram_pair_code_omits_link_metadata_for_invalid_username(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-no-username",
                "config": {"bot_username": "ValidUser"},
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()

    assert pair["bot_username"] is None
    assert pair["deep_link"] is None
    assert pair["qr_payload"] is None
    assert pair["pairing_command"] == f"/clawdi_pair {pair['code']}"


@pytest.mark.asyncio
async def test_telegram_inbound_dedupes_update_redelivery_but_keeps_edits(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-update-identity",
        chat_id="4242",
        provider_token=None,
    )
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    original = {
        "update_id": 7001,
        "message": {
            "message_id": 88,
            "text": "before edit",
            "chat": {"id": 4242, "type": "private"},
        },
    }
    edited = {
        "update_id": 7002,
        "edited_message": {
            "message_id": 88,
            "text": "after edit",
            "chat": {"id": 4242, "type": "private"},
        },
    }
    conflicting_chat_replay = {
        "update_id": 7001,
        "message": {
            "message_id": 99,
            "text": "must not become a second physical update",
            "chat": {"id": 4343, "type": "private"},
        },
    }

    assert (await client.post(webhook_url, headers=headers, json=original)).status_code == 200
    assert (await client.post(webhook_url, headers=headers, json=original)).status_code == 200
    assert (
        await client.post(webhook_url, headers=headers, json=conflicting_chat_replay)
    ).status_code == 200
    assert (await client.post(webhook_url, headers=headers, json=edited)).status_code == 200
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id.in_(["update:7001", "update:7002"]),
                )
            )
        ).scalars()
    )
    assert sorted(
        (message.provider_event_id, message.provider_message_id, message.text)
        for message in messages
    ) == [
        ("update:7001", "88", "before edit"),
        ("update:7002", "88", "after edit"),
    ]
    activity = await client.get(f"/v1/channels/{created['id']}/activity")
    edited_items = [
        item
        for item in activity.json()["items"]
        if item.get("text") in {"before edit", "after edit"}
    ]
    assert [item["provider_message_id"] for item in edited_items] == ["88", "88"]


@pytest.mark.asyncio
async def test_telegram_concurrent_redelivery_has_one_agent_side_effect(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    real_httpx_async_client = httpx.AsyncClient
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-concurrent-redelivery",
        chat_id="4242",
        provider_token=None,
    )
    assert (
        await client.post(
            _telegram_bot_path(created, "setWebhook"),
            headers=_telegram_agent_headers(created),
            json={"url": "https://agent.example/concurrent-redelivery"},
        )
    ).status_code == 200
    _reset_sequenced_provider_client([200])
    monkeypatch.setattr(
        "app.services.channel_webhooks.httpx.AsyncClient",
        _SequencedProviderClient,
    )
    update = {
        "update_id": 7_501,
        "message": {
            "message_id": 101,
            "text": "deliver exactly once",
            "chat": {"id": 4242, "type": "private"},
        },
    }
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
            first, second = await asyncio.gather(
                concurrent.post(
                    f"/v1/channels/telegram/{created['id']}/webhook",
                    headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
                    json=update,
                ),
                concurrent.post(
                    f"/v1/channels/telegram/{created['id']}/webhook",
                    headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
                    json=update,
                ),
            )
    finally:
        app.dependency_overrides[get_session] = previous_session_override

    assert first.status_code == 200
    assert second.status_code == 200
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id == "update:7501",
                )
            )
        ).scalars()
    )
    assert len(messages) == 1
    assert len(_SequencedProviderClient.calls) == 1


@pytest.mark.asyncio
async def test_telegram_webhook_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 100}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-reply",
                "provider_token": "123456:telegram-secret",
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
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 42,
                "message_thread_id": 321,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 987654321, "type": "private", "username": "paco"},
                "from": {"id": 987654321, "is_bot": False, "username": "paco"},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/sendMessage")
    assert _FakeProviderClient.calls[0]["json"] == {
        "chat_id": "987654321",
        "message_thread_id": 321,
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-failure-replies",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    missing = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 43,
                "message_thread_id": 322,
                "is_topic_message": True,
                "text": "/clawdi_pair",
                "chat": {
                    "id": 987654322,
                    "type": "supergroup",
                    "is_forum": True,
                },
                "from": {"id": 987654322, "is_bot": False},
            },
        },
    )
    invalid = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 44,
                "message_thread_id": 999,
                "is_topic_message": False,
                "text": "/clawdi_pair BCDFGHJKLM",
                "chat": {"id": 987654322, "type": "private"},
                "from": {"id": 987654322, "is_bot": False},
            },
        },
    )

    assert missing.status_code == 200
    assert invalid.status_code == 200
    assert [call["json"] for call in _FakeProviderClient.calls] == [
        {
            "chat_id": "987654322",
            "message_thread_id": 322,
            "text": "Usage: /clawdi_pair <code>",
        },
        {
            "chat_id": "987654322",
            "text": "Pairing failed: invalid.",
        },
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpair-reply",
                "provider_token": "123456:telegram-secret",
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
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 45,
                "message_thread_id": 323,
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 987654323, "type": "private"},
                "from": {"id": 987654323, "is_bot": False},
            },
        },
    )
    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 2,
            "message": {
                "message_id": 46,
                "message_thread_id": 324,
                "is_topic_message": True,
                "text": "/clawdi_unpair",
                "chat": {"id": 987654323, "type": "private"},
                "from": {"id": 987654323, "is_bot": False},
            },
        },
    )

    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [
        call["json"] for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ] == [
        {
            "chat_id": "987654323",
            "message_thread_id": 323,
            "text": "Paired! This chat is now connected to your agent.",
        },
        {
            "chat_id": "987654323",
            "message_thread_id": 324,
            "text": "Unpaired. This chat is no longer connected to an agent.",
        },
    ]
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [
        {"chat_id": "987654323", "menu_button": {"type": "default"}},
        {"chat_id": "987654323", "menu_button": {"type": "default"}},
    ]


@pytest.mark.asyncio
async def test_telegram_channel_direct_message_pairing_replies_stay_in_originating_topic(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 104}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient", _FakeProviderClient
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-direct-message-topic-replies",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    chat = {
        "id": -100987654326,
        "type": "supergroup",
        "is_direct_messages": True,
    }

    paired = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 1,
            "message": {
                "message_id": 48,
                "direct_messages_topic": {"topic_id": 4242},
                "is_topic_message": True,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": chat,
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    same_actor = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 2,
            "message": {
                "message_id": 49,
                "direct_messages_topic": {"topic_id": 4242},
                "is_topic_message": True,
                "text": "same actor reaches its isolated topic",
                "chat": chat,
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )
    updates = await client.post(
        _telegram_bot_path(created, "getUpdates"),
        headers=_telegram_agent_headers(created),
        json={},
    )
    compatibility_body = (
        b'{ "chat_id": -100987654326, "message_thread_id": 4242, '
        b'"text": "reply through virtual topic transport", '
        b'"future_hint":"first", "future_hint":"second" }\n'
    )
    agent_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=compatibility_body,
    )
    edit_own_message = await client.post(
        _telegram_bot_path(created, "editMessageText"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_id": 104,
            "text": "edit an owned streamed message",
        },
    )
    edit_other_topic_message = await client.post(
        _telegram_bot_path(created, "editMessageText"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_id": 105,
            "text": "must not edit another topic",
        },
    )
    query_reply = await client.get(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        params={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "text": "query topic transport",
        },
    )
    form_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        data={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "text": "form topic transport",
        },
    )
    multipart_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        data={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "text": "multipart topic transport",
        },
        files={"attachment": ("unused.txt", b"unused")},
    )
    telegram_rate_limiter.reset()
    native_direct_body = (
        b'{ "chat_id": -100987654326, "direct_messages_topic_id": 4242, '
        b'"text": "native direct topic" }\n'
    )
    native_direct_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=native_direct_body,
    )
    draft_body = (
        b'{ "chat_id": -100987654326, "message_thread_id": 4242, '
        b'"draft_id": 1, "text": "native draft" }\n'
    )
    draft = await client.post(
        _telegram_bot_path(created, "sendMessageDraft"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=draft_body,
    )
    typing_body = b'{ "chat_id": -100987654326, "message_thread_id": 4242, "action": "typing" }\n'
    typing = await client.post(
        _telegram_bot_path(created, "sendChatAction"),
        headers={**_telegram_agent_headers(created), "content-type": "application/json"},
        content=typing_body,
    )
    missing_direct_topic = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={"chat_id": -100987654326, "text": "ambiguous channel DM"},
    )
    duplicate_topic = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_thread_id": 4242,
            "direct_messages_topic_id": 4242,
            "text": "ambiguous topic transport",
        },
    )
    other_topic_reply = await client.post(
        _telegram_bot_path(created, "sendMessage"),
        headers=_telegram_agent_headers(created),
        json={
            "chat_id": -100987654326,
            "message_thread_id": 9999,
            "text": "must not cross direct-message actors",
        },
    )
    other_actor = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 3,
            "message": {
                "message_id": 50,
                "direct_messages_topic": {"topic_id": 9999},
                "is_topic_message": True,
                "text": "must not cross direct-message actors",
                "chat": chat,
                "from": {"id": 9999, "is_bot": False},
            },
        },
    )
    unpaired = await client.post(
        webhook_url,
        headers=headers,
        json={
            "update_id": 4,
            "message": {
                "message_id": 51,
                "direct_messages_topic": {"topic_id": 4242},
                "is_topic_message": True,
                "text": "/clawdi_unpair",
                "chat": chat,
                "from": {"id": 4242, "is_bot": False},
            },
        },
    )

    assert paired.status_code == 200
    assert paired.json()["paired"] is True
    assert same_actor.status_code == 200
    assert updates.status_code == 200
    assert updates.json()["result"][0]["message"]["message_thread_id"] == 4242
    assert updates.json()["result"][0]["message"]["direct_messages_topic"] == {"topic_id": 4242}
    assert agent_reply.status_code == 200
    assert edit_own_message.status_code == 200
    assert edit_other_topic_message.status_code == 403
    assert query_reply.status_code == 200
    assert form_reply.status_code == 200
    assert multipart_reply.status_code == 200
    assert native_direct_reply.status_code == 200
    assert draft.status_code == 200
    assert typing.status_code == 200
    assert missing_direct_topic.status_code == 400
    assert missing_direct_topic.json()["description"] == (
        "Bad Request: direct message topic is required"
    )
    assert duplicate_topic.status_code == 400
    assert other_topic_reply.status_code == 403
    assert other_actor.status_code == 200
    assert other_actor.json()["binding_id"] is None
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/sendMessage") and "json" in call
    ] == [
        {
            "chat_id": "-100987654326",
            "direct_messages_topic_id": 4242,
            "text": "Paired! This chat is now connected to your agent.",
        },
        {
            "chat_id": "-100987654326",
            "direct_messages_topic_id": 4242,
            "text": "Unpaired. This chat is no longer connected to an agent.",
        },
    ]
    proxied_reply = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST" and call["url"].endswith("/sendMessage")
    )
    assert proxied_reply["content"] == compatibility_body.replace(
        b'"message_thread_id"',
        b'"direct_messages_topic_id"',
    )
    query_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "GET" and "/sendMessage?" in call["url"]
    )
    assert b"direct_messages_topic_id=4242" in httpx.URL(query_call["url"]).query
    assert b"message_thread_id" not in httpx.URL(query_call["url"]).query
    form_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST"
        and call["url"].endswith("/sendMessage")
        and b"form+topic+transport" in call.get("content", b"")
    )
    assert b"direct_messages_topic_id=4242" in form_call["content"]
    assert b"message_thread_id" not in form_call["content"]
    multipart_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST"
        and call["url"].endswith("/sendMessage")
        and b"multipart topic transport" in call.get("content", b"")
    )
    assert b'name="direct_messages_topic_id"' in multipart_call["content"]
    assert b'name="message_thread_id"' not in multipart_call["content"]
    native_direct_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST"
        and call["url"].endswith("/sendMessage")
        and b"native direct topic" in call.get("content", b"")
    )
    assert native_direct_call["content"] == native_direct_body
    draft_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST" and call["url"].endswith("/sendMessageDraft")
    )
    typing_call = next(
        call
        for call in _FakeProviderClient.calls
        if call.get("method") == "POST" and call["url"].endswith("/sendChatAction")
    )
    assert draft_call["content"] == draft_body
    assert typing_call["content"] == typing_body


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_redelivery_does_not_duplicate_reply(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 103}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-unpair-redelivery",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="987654325",
        chat_type="private",
    )
    payload = {
        "update_id": 7003,
        "message": {
            "message_id": 47,
            "text": "/clawdi_unpair",
            "chat": {"id": 987654325, "type": "private"},
            "from": {"id": 4242, "is_bot": False},
        },
    }
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}

    first = await client.post(webhook_url, headers=headers, json=payload)
    redelivery = await client.post(webhook_url, headers=headers, json=payload)

    assert first.status_code == 200
    assert first.json()["unpaired"] is True
    assert redelivery.status_code == 200
    assert redelivery.json()["unpaired"] is False
    replies = [call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")]
    assert [call["json"]["text"] for call in replies] == [
        "Unpaired. This chat is no longer connected to an agent."
    ]


@pytest.mark.asyncio
async def test_telegram_update_dedupe_is_account_scoped_across_repair(
    client: httpx.AsyncClient,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 104}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-account-dedupe-repair",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    second_link = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    chat = {"id": 987654326, "type": "private"}
    actor = {"id": 987654326, "is_bot": False}

    first_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": created["agent_link_id"], "ttl_seconds": 900},
        )
    ).json()
    first_payload = {
        "update_id": 7201,
        "message": {
            "message_id": 201,
            "text": f"/clawdi_pair {first_pair['code']}",
            "chat": chat,
            "from": actor,
        },
    }
    assert (await client.post(webhook_url, headers=headers, json=first_payload)).json()[
        "paired"
    ] is True
    assert (
        await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": 7202,
                "message": {
                    "message_id": 202,
                    "text": "/clawdi_unpair",
                    "chat": chat,
                    "from": actor,
                },
            },
        )
    ).json()["unpaired"] is True

    second_pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second_link["id"], "ttl_seconds": 900},
        )
    ).json()
    assert (
        await client.post(
            webhook_url,
            headers=headers,
            json={
                "update_id": 7203,
                "message": {
                    "message_id": 203,
                    "text": f"/clawdi_pair {second_pair['code']}",
                    "chat": chat,
                    "from": actor,
                },
            },
        )
    ).json()["paired"] is True

    redelivery = await client.post(webhook_url, headers=headers, json=first_payload)
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    replies = [call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")]

    assert redelivery.status_code == 200
    assert redelivery.json()["paired"] is False
    assert bindings.json()[0]["agent_link_id"] == second_link["id"]
    assert [call["json"]["text"] for call in replies] == [
        "Paired! This chat is now connected to your agent.",
        "Unpaired. This chat is no longer connected to an agent.",
        "Paired! This chat is now connected to your agent.",
    ]


@pytest.mark.asyncio
async def test_delete_binding_unpairs_exactly_one_chat_and_cleans_telegram_projection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    runtime_signals: list[tuple[UUID, UUID]] = []

    async def record_runtime_signal(_db, user_id: UUID, environment_id: UUID) -> bool:
        runtime_signals.append((user_id, environment_id))
        return True

    monkeypatch.setattr(
        "app.routes.channel_routers.public.queue_environment_runtime_manifest_changed",
        record_runtime_signal,
    )
    _reset_fake_provider_client({"ok": True, "result": {"username": "clawdi_test_bot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FakeProviderClient,
    )
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-ui-unpair-isolation",
                "provider_token": "123456:telegram-secret",
                "agent_id": str(channel_agent.id),
            },
        )
    ).json()
    runtime_signals.clear()
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="111",
        update_id=101,
        chat_type="private",
    )
    await _pair_telegram_chat(
        client,
        created=created,
        chat_id="222",
        update_id=102,
        chat_type="private",
    )
    commands = [{"command": "status", "description": "Show status"}]
    assert (
        await client.post(
            _telegram_bot_path(created, "setMyCommands"),
            headers=_telegram_agent_headers(created),
            json={"commands": commands},
        )
    ).status_code == 200
    bindings_before = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    target = next(item for item in bindings_before if item["external_chat_id"] == "111")
    sibling = next(item for item in bindings_before if item["external_chat_id"] == "222")
    _clear_fake_provider_calls()

    deleted = await client.delete(f"/v1/channels/{created['id']}/bindings/{target['id']}")
    repeated = await client.delete(f"/v1/channels/{created['id']}/bindings/{target['id']}")

    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "binding_id": target["id"],
        "unpaired": True,
        "notification_status": "sent",
        "provider_cleanup_status": "succeeded",
        "warning": None,
    }
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["unpaired"] is False
    assert runtime_signals == []
    binding_rows = {
        str(binding.id): binding
        for binding in (
            await db_session.execute(
                select(ChannelBinding).where(
                    ChannelBinding.id.in_([UUID(target["id"]), UUID(sibling["id"])])
                )
            )
        ).scalars()
    }
    assert binding_rows[target["id"]].status == BINDING_STATUS_ARCHIVED
    assert binding_rows[sibling["id"]].status == BINDING_STATUS_ACTIVE
    link = await db_session.get(ChannelBotAgentLink, UUID(created["agent_link_id"]))
    assert link is not None
    assert link.status != BOT_AGENT_LINK_STATUS_ARCHIVED
    assert link.archived_at is None
    remaining = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert [item["id"] for item in remaining] == [sibling["id"]]
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/deleteMyCommands")
    ] == [{"scope": {"type": "chat", "chat_id": "111"}}]
    assert [
        call["json"]
        for call in _FakeProviderClient.calls
        if call["url"].endswith("/setChatMenuButton")
    ] == [{"chat_id": "111", "menu_button": {"type": "default"}}]
    assert [
        call["json"] for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ] == [
        {
            "chat_id": "111",
            "text": "Unpaired. This chat is no longer connected to an agent.",
        }
    ]


@pytest.mark.asyncio
async def test_delete_binding_keeps_unpair_durable_when_telegram_notification_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _reset_fake_provider_client({"ok": True, "result": {"username": "clawdi_test_bot"}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = await _create_paired_telegram_channel(
        client,
        name="telegram-ui-unpair-notify-failure",
        chat_id="333",
        chat_type="private",
    )
    binding = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()[0]
    _FailingProviderClient.calls = []
    monkeypatch.setattr(
        "app.routes.channel_routers.telegram.httpx.AsyncClient",
        _FailingProviderClient,
    )

    deleted = await client.delete(f"/v1/channels/{created['id']}/bindings/{binding['id']}")

    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["unpaired"] is True
    assert deleted.json()["notification_status"] == "failed"
    assert deleted.json()["provider_cleanup_status"] == "failed"
    assert "unpaired" in deleted.json()["warning"].lower()
    archived = await db_session.get(ChannelBinding, UUID(binding["id"]))
    assert archived is not None
    assert archived.status == BINDING_STATUS_ARCHIVED
    audit = await client.get(
        "/v1/audit/events",
        params={"channel_account_id": created["id"], "limit": 20},
    )
    cleanup_event = next(
        item
        for item in audit.json()["items"]
        if item["action"] == "channel.binding.telegram_cleanup"
    )
    assert cleanup_event["details"] == {
        "notification_status": "failed",
        "provider_cleanup_status": "failed",
    }


@pytest.mark.asyncio
async def test_telegram_webhook_pair_reply_failure_does_not_roll_back_binding(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _FailingProviderClient.calls = []
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FailingProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-pair-reply-fails",
                "provider_token": "123456:telegram-secret",
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
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": 1,
            "message": {
                "message_id": 47,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 987654324, "type": "private"},
                "from": {"id": 987654324, "is_bot": False},
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json()[0]["external_chat_id"] == "987654324"
    assert [call["url"].rsplit("/", 1)[-1] for call in _FailingProviderClient.calls] == [
        "sendMessage",
        "setChatMenuButton",
    ]


@pytest.mark.asyncio
async def test_telegram_webhook_start_deep_link_pair_code_creates_binding(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-start-pair"},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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
        f"/v1/channels/telegram/{created['id']}/webhook",
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
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert [binding["external_chat_id"] for binding in bindings.json()] == ["987654322"]


@pytest.mark.asyncio
async def test_telegram_start_claims_explicit_agent_link_and_redelivery_is_idempotent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
    second_channel_agent,
    monkeypatch: pytest.MonkeyPatch,
):
    real_httpx_async_client = httpx.AsyncClient
    _reset_fake_provider_client({"ok": True, "result": {"message_id": 100}})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-explicit-start-pair",
                "agent_id": str(channel_agent.id),
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
    _clear_fake_provider_calls()
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/agent-links",
            json={"agent_id": str(second_channel_agent.id)},
        )
    ).json()
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"agent_link_id": second["id"], "ttl_seconds": 900},
        )
    ).json()
    payload = {
        "update_id": 7101,
        "message": {
            "message_id": 91,
            "text": f"/start@Clawdi_Test_Bot {pair['code']}",
            "chat": {"id": 987654399, "type": "private"},
            "from": {"id": 987654399, "is_bot": False},
        },
    }
    webhook_url = f"/v1/channels/telegram/{created['id']}/webhook"
    headers = {"x-telegram-bot-api-secret-token": created["webhook_secret"]}
    from app.routes.channel_routers import telegram as telegram_router

    original_find = telegram_router.find_existing_inbound_provider_event
    precheck_count = 0
    both_prechecks_started = asyncio.Event()

    async def synchronized_find(*args, **kwargs):
        nonlocal precheck_count
        precheck_count += 1
        if precheck_count <= 2:
            if precheck_count == 2:
                both_prechecks_started.set()
            await both_prechecks_started.wait()
        return await original_find(*args, **kwargs)

    monkeypatch.setattr(
        telegram_router,
        "find_existing_inbound_provider_event",
        synchronized_find,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def independent_session():
        async with sessionmaker() as session:
            yield session

    previous_session_override = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = independent_session
    try:
        transport = httpx.ASGITransport(app=app)
        async with real_httpx_async_client(
            transport=transport, base_url="http://test"
        ) as concurrent:
            first, redelivery = await asyncio.gather(
                concurrent.post(webhook_url, headers=headers, json=payload),
                concurrent.post(webhook_url, headers=headers, json=payload),
            )
    finally:
        app.dependency_overrides[get_session] = previous_session_override
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    events = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == UUID(created["id"]),
                    ChannelMessage.provider_event_id == "update:7101",
                )
            )
        ).scalars()
    )

    assert first.status_code == 200
    assert redelivery.status_code == 200
    assert sorted([first.json()["paired"], redelivery.json()["paired"]]) == [False, True]
    assert len(bindings.json()) == 1
    assert len(events) == 1
    assert bindings.json()[0]["agent_link_id"] == second["id"]
    pairing_replies = [
        call for call in _FakeProviderClient.calls if call["url"].endswith("/sendMessage")
    ]
    assert len(pairing_replies) == 1
    assert "paired" in pairing_replies[0]["json"]["text"].lower()


@pytest.mark.asyncio
async def test_telegram_webhook_rejects_invalid_secret(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-secret-check"},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
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


def test_parse_pair_command_matches_strict_canonical_shapes():
    assert parse_pair_command("/clawdi_pair ABCDEF1234").code == "ABCDEF1234"
    assert parse_pair_command("/clawdi_pair@shared_bot ABC123").code == "ABC123"
    assert parse_pair_command("/clawdi_pair ABC123 thanks").code == ""
    assert parse_pair_command("/clawdi_pair ABC123\n•").code == ""
    assert parse_pair_command("/clawdi_pair").code == ""
    assert parse_pair_command("/clawdi_unpair").kind == "unpair"
    assert parse_pair_command("/clawdi_unpair@shared_bot").kind == "unpair"
    assert parse_pair_command("/clawdi_unpair now").kind == "unknown"
    assert parse_pair_command("/start BCDFGHJKLM").code == "BCDFGHJKLM"
    assert parse_pair_command("/start@shared_bot BCDFGHJKLM").code == "BCDFGHJKLM"
    # Pending codes issued before the shorter-code rollout remain claimable
    # through Telegram deep links until their stored expiry.
    assert parse_pair_command("/start PAIRABCDEF1234").code == "PAIRABCDEF1234"
    assert parse_pair_command("/start PAIRABCDEF1234 thanks") is None
    assert parse_pair_command("/start OLD_PAIR_CODE") is None
    assert parse_pair_command("/start") is None
    assert parse_pair_command("hello world") is None

    unknown = parse_pair_command("/clawdi_foo bar")
    assert unknown is not None
    assert unknown.kind == "unknown"
    assert unknown.command == "/clawdi_foo"


@pytest.mark.parametrize(
    "text",
    [
        "/bot_pair BCDFGHJKLM",
        "/bot_pair@shared_bot BCDFGHJKLM",
        "/bot_unpair",
        "/bot_unpair@shared_bot",
    ],
)
def test_parse_pair_command_rejects_legacy_aliases(text: str):
    assert parse_pair_command(text) is None


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


@pytest.mark.parametrize(
    ("name", "expected_kind"),
    [
        ("clawdi_pair", "pair"),
        ("clawdi_unpair", "unpair"),
    ],
)
def test_discord_interaction_parser_accepts_current_reserved_commands(
    name: str,
    expected_kind: str,
):
    command = discord_pair_command_from_payload(
        {
            "type": 2,
            "data": {
                "name": name,
                "options": [{"name": "code", "value": "BCDFGHJKLM"}],
            },
        }
    )

    assert command is not None
    assert command.kind == expected_kind
    assert command.code == ("BCDFGHJKLM" if expected_kind == "pair" else None)


@pytest.mark.parametrize("name", ["bot_pair", "bot_unpair", "pair", "unpair"])
def test_discord_interaction_parser_rejects_legacy_and_generic_commands(name: str):
    assert (
        discord_pair_command_from_payload(
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
    assert discord_pair_command_from_payload({"d": {"content": content}}) is None


def test_discord_message_parser_requires_slash_for_current_commands():
    current = discord_pair_command_from_payload({"d": {"content": "/clawdi_pair BCDFGHJKLM"}})

    assert current is not None
    assert current.kind == "pair"
    assert current.code == "BCDFGHJKLM"
    assert discord_pair_command_from_payload({"d": {"content": "clawdi_pair BCDFGHJKLM"}}) is None
    assert discord_pair_command_from_payload({"d": {"content": "clawdi_unpair"}}) is None


def test_discord_unknown_command_reply_uses_only_current_reserved_commands():
    reply = discord_pairing_reply_for_command(
        channel_service.ChannelPairCommand(kind="unknown", command="/clawdi_unpair"),
        channel_service.InboundBindingResult(binding=None, command_handled=True),
        guild_id="guild-1",
    )

    assert reply == ("Unknown command: /clawdi_unpair. Use /clawdi_pair <code> or /clawdi_unpair.")
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
    assert response.json()["data"]["content"] == "Message received."
    pair_code = await db_session.get(ChannelPairCode, UUID(pair["id"]))
    assert pair_code is not None
    assert pair_code.status == PAIR_CODE_STATUS_PENDING
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []


def test_telegram_reply_thread_requires_a_true_private_or_forum_topic():
    def update(*, chat_type: str, is_topic: bool, is_forum: bool = False):
        return {
            "message": {
                "message_thread_id": 77,
                "is_topic_message": is_topic,
                "chat": {"id": -1001, "type": chat_type, "is_forum": is_forum},
            }
        }

    assert telegram_message_thread_id_from_update(update(chat_type="private", is_topic=True)) == 77
    assert (
        telegram_message_thread_id_from_update(
            update(chat_type="supergroup", is_topic=True, is_forum=True)
        )
        == 77
    )
    assert (
        telegram_message_thread_id_from_update(update(chat_type="private", is_topic=False)) is None
    )
    assert (
        telegram_message_thread_id_from_update(
            update(chat_type="supergroup", is_topic=False, is_forum=True)
        )
        is None
    )
    assert (
        telegram_message_thread_id_from_update(
            update(chat_type="group", is_topic=True, is_forum=False)
        )
        is None
    )


def test_telegram_direct_message_reply_topic_requires_a_true_direct_messages_chat():
    def update(*, chat_type: str, is_direct_messages: bool, topic_id: object):
        return {
            "message": {
                "direct_messages_topic": {"topic_id": topic_id},
                "chat": {
                    "id": -1001,
                    "type": chat_type,
                    "is_direct_messages": is_direct_messages,
                },
            }
        }

    assert (
        telegram_direct_messages_topic_id_from_update(
            update(
                chat_type="supergroup",
                is_direct_messages=True,
                topic_id=4_294_967_297,
            )
        )
        == 4_294_967_297
    )
    assert (
        telegram_direct_messages_topic_id_from_update(
            update(chat_type="supergroup", is_direct_messages=False, topic_id=77)
        )
        is None
    )
    assert (
        telegram_direct_messages_topic_id_from_update(
            update(chat_type="private", is_direct_messages=True, topic_id=77)
        )
        is None
    )
    assert (
        telegram_direct_messages_topic_id_from_update(
            update(chat_type="supergroup", is_direct_messages=True, topic_id=True)
        )
        is None
    )


def test_normalize_telegram_bot_username_requires_bot_suffix():
    assert normalize_telegram_bot_username(" @Clawdi_Test_Bot ") == "Clawdi_Test_Bot"
    assert normalize_telegram_bot_username("ClawdiPublicBot") == "ClawdiPublicBot"
    assert normalize_telegram_bot_username("ValidUser") is None
    assert normalize_telegram_bot_username("bad!") is None
    assert normalize_telegram_bot_username("bot") is None


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


def _discord_gateway_protocol_agent() -> ChannelAgentContext:
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


def _install_discord_gateway_protocol_fakes(
    monkeypatch,
    *,
    events: list[ChannelMessage] | None = None,
) -> None:
    _DISCORD_GATEWAY_SESSIONS.clear()

    async def fake_resolve_agent(db, *, provider: str, token: str) -> ChannelAgentContext:
        if provider == "discord" and token == "valid-discord-token":
            return _discord_gateway_protocol_agent()
        raise HTTPException(status_code=401, detail="invalid bot token")

    async def fake_resolve_identity(
        db,
        *,
        provider: str,
        account_id: UUID,
        link_id: UUID,
        agent_token_hash: str,
    ) -> ChannelAgentContext:
        agent = _discord_gateway_protocol_agent()
        if (
            provider == "discord"
            and account_id == agent.account.id
            and link_id == agent.link.id
            and agent_token_hash == agent.link.agent_token_hash
        ):
            return agent
        raise HTTPException(status_code=401, detail="invalid bot identity")

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

    async def fake_ack_sequence(
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID | None,
        through_sequence: int,
    ) -> None:
        return None

    monkeypatch.setattr(
        "app.routes.channel_routers.discord.resolve_channel_agent_by_token",
        fake_resolve_agent,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.resolve_channel_agent_by_identity",
        fake_resolve_identity,
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
    monkeypatch.setattr(
        "app.routes.channel_routers.discord._ack_discord_gateway_sequence",
        fake_ack_sequence,
    )


def _install_discord_gateway_test_session_factory(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep TestClient's worker loop off pytest's session-bound asyncpg pool."""
    gateway_engine = create_async_engine(
        settings.database_url,
        poolclass=NullPool,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.async_session_factory",
        async_sessionmaker(gateway_engine, expire_on_commit=False),
    )


def test_discord_gateway_rejects_unsupported_encoding_and_compress():
    with TestClient(app) as sync_client:
        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?encoding=etf"
        ) as websocket:
            with pytest.raises(WebSocketDisconnect) as exc:
                websocket.receive_json()
            assert exc.value.code == 4012

        with sync_client.websocket_connect(
            "/v1/channels/discord/gateway?encoding=json&compress=zstd-stream"
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


def test_discord_gateway_resume_validates_session_id_and_token(monkeypatch):
    _install_discord_gateway_protocol_fakes(monkeypatch)

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"

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
            assert websocket.receive_json()["t"] == "RESUMED"

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
                    "d": {"channel_id": "chan-protocol-1", "content": "missed dispatch"},
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
            assert websocket.receive_json()["d"]["content"] == "missed dispatch"

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
            replayed = websocket.receive_json()
            resumed = websocket.receive_json()

    assert replayed["t"] == "MESSAGE_CREATE"
    assert replayed["d"]["content"] == "missed dispatch"
    assert resumed["t"] == "RESUMED"


@pytest.mark.asyncio
async def test_discord_gateway_stateless_resume_replays_unacked_db_events(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _install_discord_gateway_test_session_factory(monkeypatch)
    _DISCORD_GATEWAY_SESSIONS.clear()
    created = await _create_paired_discord_channel(
        client,
        name="discord-stateless-resume",
        channel_id="stateless-resume-channel",
        guild_id="stateless-resume-guild",
    )
    account = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account.id,
                ChannelBinding.external_chat_id == "stateless-resume-guild",
            )
        )
    ).scalar_one()
    message = ChannelMessage(
        account_id=account.id,
        bot_agent_link_id=binding.bot_agent_link_id,
        binding_id=binding.id,
        user_id=binding.user_id,
        direction=MESSAGE_DIRECTION_INBOUND,
        external_chat_id="stateless-resume-channel",
        provider_message_id="msg-stateless-resume",
        text="from db after worker hop",
        payload={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-stateless-resume",
                "channel_id": "stateless-resume-channel",
                "guild_id": "stateless-resume-guild",
                "content": "from db after worker hop",
            },
        },
    )
    db_session.add(message)
    await db_session.flush()
    await db_session.refresh(message)
    await db_session.commit()

    with TestClient(app) as sync_client:
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json(
                {
                    "op": 6,
                    "d": {
                        "token": created["agent_token"],
                        "session_id": "lost-worker-session",
                        "seq": 0,
                    },
                }
            )
            resumed = websocket.receive_json()
            dispatch = websocket.receive_json()
            websocket.send_json({"op": 1, "d": dispatch["s"]})
            heartbeat_ack = websocket.receive_json()

    assert resumed["t"] == "RESUMED"
    assert dispatch["t"] == "MESSAGE_CREATE"
    assert isinstance(dispatch["s"], int)
    assert dispatch["d"]["content"] == "from db after worker hop"
    assert heartbeat_ack == {"op": 11, "d": None}
    await db_session.refresh(message)
    assert message.delivered_at is not None


@pytest.mark.asyncio
async def test_discord_gateway_early_heartbeat_does_not_ack_undispatched_low_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    _install_discord_gateway_test_session_factory(monkeypatch)
    _DISCORD_GATEWAY_SESSIONS.clear()
    created = await _create_paired_discord_channel(
        client,
        name="discord-gateway-heartbeat-low-inbox",
        channel_id="ack-race-channel-1",
        guild_id="ack-race-guild-1",
    )
    account_id = UUID(created["id"])
    link_id = UUID(created["agent_link_id"])
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id == account_id,
                ChannelBinding.bot_agent_link_id == link_id,
                ChannelBinding.external_chat_id == "ack-race-guild-1",
            )
        )
    ).scalar_one()
    for guild_id in ("ack-race-guild-2", "ack-race-guild-3"):
        db_session.add(
            ChannelBinding(
                account_id=account_id,
                bot_agent_link_id=link_id,
                user_id=binding.user_id,
                external_chat_id=guild_id,
                external_chat_type="guild",
                external_chat_name=guild_id,
            )
        )
    await db_session.commit()

    previous_poll_interval = settings.discord_gateway_poll_interval_seconds
    settings.discord_gateway_poll_interval_seconds = 1.0
    try:
        with TestClient(app) as sync_client:
            with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
                assert websocket.receive_json()["op"] == 10
                websocket.send_json({"op": 2, "d": {"token": created["agent_token"], "intents": 0}})
                ready = websocket.receive_json()
                guild_creates = [websocket.receive_json() for _ in range(3)]
                highest_guild_sequence = max(frame["s"] for frame in guild_creates)

                assert ready["t"] == "READY"
                assert {frame["t"] for frame in guild_creates} == {"GUILD_CREATE"}
                assert highest_guild_sequence > 2

                await asyncio.sleep(0.05)
                message = ChannelMessage(
                    account_id=account_id,
                    bot_agent_link_id=link_id,
                    binding_id=binding.id,
                    user_id=binding.user_id,
                    direction=MESSAGE_DIRECTION_INBOUND,
                    inbox_sequence=2,
                    external_chat_id="ack-race-guild-1",
                    provider_message_id="ack-race-message",
                    text="low inbox after guild create",
                    payload={
                        "t": "MESSAGE_CREATE",
                        "d": {
                            "id": "ack-race-message",
                            "channel_id": "ack-race-channel-1",
                            "guild_id": "ack-race-guild-1",
                            "content": "low inbox after guild create",
                        },
                    },
                )
                db_session.add(message)
                await db_session.flush()
                await db_session.refresh(message)
                assert message.inbox_sequence < highest_guild_sequence
                await db_session.commit()

                websocket.send_json({"op": 1, "d": highest_guild_sequence})
                first_frame = websocket.receive_json()
                if first_frame == {"op": 11, "d": None}:
                    dispatch = websocket.receive_json()
                else:
                    # The gateway poll may observe the newly committed inbox row
                    # before it processes the heartbeat. Frame ordering is not
                    # the invariant under test: the stale heartbeat still must
                    # not acknowledge this later dispatch sequence.
                    dispatch = first_frame
                    assert websocket.receive_json() == {"op": 11, "d": None}
                await db_session.refresh(message)
                assert message.delivered_at is None

                assert dispatch["t"] == "MESSAGE_CREATE"
                assert dispatch["s"] > highest_guild_sequence
                assert dispatch["d"]["content"] == "low inbox after guild create"

                websocket.send_json({"op": 1, "d": dispatch["s"]})
                assert websocket.receive_json() == {"op": 11, "d": None}

        await db_session.refresh(message)
        assert message.delivered_at is not None
    finally:
        settings.discord_gateway_poll_interval_seconds = previous_poll_interval
        _DISCORD_GATEWAY_SESSIONS.clear()


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
        with sync_client.websocket_connect("/v1/channels/discord/gateway") as websocket:
            assert websocket.receive_json()["op"] == 10
            websocket.send_json({"op": 2, "d": {"token": "valid-discord-token", "intents": 0}})
            ready = websocket.receive_json()
            session_id = ready["d"]["session_id"]
            assert websocket.receive_json()["t"] == "GUILD_CREATE"
            assert websocket.receive_json()["d"]["content"] == "event one"
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


@pytest.mark.asyncio
async def test_telegram_webhook_unpair_archives_and_allows_repair(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-unpair"},
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
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {pair['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert paired.status_code == 200
    assert paired.json()["paired"] is True

    unpaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 2,
                "text": "/clawdi_unpair@shared_bot",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert unpaired.status_code == 200
    assert unpaired.json()["unpaired"] is True

    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.status_code == 200
    assert bindings.json() == []

    pair_again = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 3,
                "text": f"/clawdi_pair {pair_again['code']}",
                "chat": {"id": 123456, "type": "private"},
            }
        },
    )
    assert repaired.status_code == 200
    assert repaired.json()["paired"] is True
    repaired_bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert len(repaired_bindings.json()) == 1


@pytest.mark.asyncio
async def test_telegram_pairing_same_agent_is_idempotent_and_consumes_code(
    client: httpx.AsyncClient,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "telegram", "name": "telegram-already-bound"},
        )
    ).json()
    first = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()
    second = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    paired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 1,
                "text": f"/clawdi_pair {first['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    repaired_same_agent = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 2,
                "text": f"/clawdi_pair {second['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 3,
                "text": "/clawdi_unpair",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )
    repaired = await client.post(
        f"/v1/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "message": {
                "message_id": 4,
                "text": f"/clawdi_pair {second['code']}",
                "chat": {"id": 111, "type": "private"},
            }
        },
    )

    assert paired.json()["paired"] is True
    assert repaired_same_agent.json()["paired"] is True
    assert repaired.json()["paired"] is False


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
        commands: list[dict[str, Any]],
        guild_ids: set[str] | None = None,
        automatic: bool = False,
        force: bool = False,
    ) -> None:
        fan_out_calls.append(
            {
                "account_id": account.id,
                "bot_agent_link_id": bot_agent_link_id,
                "application_id": application_id,
                "commands": commands,
                "guild_ids": guild_ids,
                "automatic": automatic,
                "force": force,
            }
        )

    monkeypatch.setattr(
        "app.routes.channel_routers.discord._fan_out_discord_global_commands",
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
            "commands": [shadowed_command],
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
    assert "pending_inbox" in health["reasons"]
    assert "recent_error" in health["reasons"]
    assert health["last_error"] == "bot agent link inactive"
    assert health["last_error_stage"] == "agent_webhook"
    assert health["last_error_outcome"] == "failure"
    assert activity_response.status_code == 200, activity_response.text
    debug_item = next(
        item for item in activity_response.json()["items"] if item["kind"] == "debug_event"
    )
    assert debug_item["stage"] == "agent_webhook"
    assert debug_item["outcome"] == "failure"
    assert debug_item["error"] == "bot agent link inactive"
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
):
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
    assert stale_alias.bot_agent_link_id == link_a_id

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
        message.provider_message_id: _discord_gateway_dispatch(message) for message in messages
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
    assert not await record_discord_dispatch(
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
    assert _discord_gateway_dispatch(message)["d"] == dm_frame["d"]

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


@pytest.mark.asyncio
async def test_discord_gateway_dispatch_pair_code_creates_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
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
            select(ChannelMessage).where(
                ChannelMessage.provider_message_id == "interaction-gateway-pair"
            )
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
            "/v1/channels",
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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "type": "new-message",
            "data": {
                "guid": "imsg-1",
                "text": f"/clawdi_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15551234567", "displayName": "Ops"}],
            },
        },
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
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
            "/v1/channels",
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
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "type": "new-message",
            "data": {
                "guid": "imsg-1",
                "text": f"/clawdi_pair {pair['code']}",
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
async def test_whatsapp_webhook_pair_code_creates_binding(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-main",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-1"},
            },
        )
    ).json()
    await _seed_created_channel_link(db_session, created=created, agent=channel_agent)
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    verify = await client.get(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": created["webhook_secret"],
            "hub.challenge": "challenge-1",
        },
    )
    assert verify.status_code == 200
    assert verify.text == "challenge-1"

    webhook = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
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
                                        "text": {"body": f"/clawdi_pair {pair['code']}"},
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
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.json()[0]["external_chat_id"] == "15551234567"
    assert bindings.json()[0]["external_chat_name"] == "Ops Phone"


@pytest.mark.asyncio
async def test_whatsapp_webhook_pair_code_sends_user_reply(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    channel_agent,
):
    _reset_fake_provider_client({"messages": [{"id": "wamid.pair-reply"}]})
    monkeypatch.setattr("app.services.channels.httpx.AsyncClient", _FakeProviderClient)
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-pair-reply",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-1"},
            },
        )
    ).json()
    await _seed_created_channel_link(db_session, created=created, agent=channel_agent)
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    webhook = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
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
                                        "text": {"body": f"/clawdi_pair {pair['code']}"},
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
    db_session: AsyncSession,
    channel_agent,
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
                "config": _discord_ready_config(),
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
        provider: (await client.post("/v1/channels", json=body)).json()
        for provider, body in channel_specs
    }
    await _seed_created_channel_link(
        db_session,
        created=created_by_provider["whatsapp"],
        agent=channel_agent,
    )
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
    imessage = created_by_provider["imessage"]
    await client.post(
        f"/v1/channels/imessage/{imessage['id']}/webhook",
        params={"secret": imessage["webhook_secret"]},
        json={
            "data": {
                "guid": "imessage-shared-msg",
                "text": f"/clawdi_pair {pair_codes['imessage']}",
                "handle": {"address": "shared-imessage-sender"},
                "chats": [{"guid": shared_chat_id, "displayName": "Shared Chat"}],
            }
        },
    )
    whatsapp = created_by_provider["whatsapp"]
    await client.post(
        f"/v1/channels/whatsapp/{whatsapp['id']}/webhook",
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
                                        "text": {"body": f"/clawdi_pair {pair_codes['whatsapp']}"},
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
        bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
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
async def test_whatsapp_webhook_accepts_meta_hmac_signature(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    app_secret = "wa-app-secret"
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-hmac",
                "secrets": {"app_secret": app_secret},
            },
        )
    ).json()
    await _seed_created_channel_link(db_session, created=created, agent=channel_agent)
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
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
                                        "text": {"body": f"/clawdi_pair {pair['code']}"},
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
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={
            "x-hub-signature-256": f"sha256={signature}",
            "content-type": "application/json",
        },
        content=body,
    )

    assert webhook.status_code == 200
    assert webhook.json()["paired"] is True
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
    assert bindings.json()[0]["external_chat_id"] == "15551239999"


@pytest.mark.asyncio
async def test_whatsapp_webhook_rejects_bad_meta_hmac_signature(client: httpx.AsyncClient):
    created = (
        await client.post(
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-hmac-bad",
                "secrets": {"app_secret": "wa-app-secret"},
            },
        )
    ).json()

    response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
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
    channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-from-me"},
        )
    ).json()
    await _seed_created_channel_link(db_session, created=created, agent=channel_agent)
    pair = (
        await client.post(
            f"/v1/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    response = await client.post(
        f"/v1/channels/whatsapp/{created['id']}/webhook",
        headers={"x-clawdi-channel-secret": created["webhook_secret"]},
        json={
            "message": {
                "key": {
                    "id": "FROM-ME-PAIR",
                    "remoteJid": "15551112222@s.whatsapp.net",
                    "fromMe": True,
                },
                "message": {"conversation": f"/clawdi_pair {pair['code']}"},
            }
        },
    )

    assert response.status_code == 200
    assert response.json()["paired"] is False
    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
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
async def test_whatsapp_webhook_pairs_from_common_baileys_wrappers(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent,
):
    created = (
        await client.post(
            "/v1/channels",
            json={"provider": "whatsapp", "name": "wa-wrapper-pair"},
        )
    ).json()
    await _seed_created_channel_link(db_session, created=created, agent=channel_agent)
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
                f"/v1/channels/{created['id']}/pair-codes",
                json={"ttl_seconds": 900},
            )
        ).json()
        jid = f"{label}@s.whatsapp.net"
        response = await client.post(
            f"/v1/channels/whatsapp/{created['id']}/webhook",
            headers={"x-clawdi-channel-secret": created["webhook_secret"]},
            json={
                "message": {
                    "key": {"id": f"PAIR-{label}", "remoteJid": jid, "fromMe": False},
                    "message": wrapped_message(f"/clawdi_pair {pair['code']}"),
                }
            },
        )
        assert response.status_code == 200
        assert response.json()["paired"] is True

    bindings = await client.get(f"/v1/channels/{created['id']}/bindings")
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-send",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()
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
    assert delivery.last_error == "channel account archived"
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
    assert delivery.last_error == "telegram api unreachable"


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
    assert delivery.last_error == "channel agent link archived"


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
    assert delivery.last_error == "channel agent link has no managed runtime authority"


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
    assert delivery.last_error == "channel binding archived"


@pytest.mark.asyncio
async def test_channel_delivery_link_lock_contention_does_not_exhaust_attempts(
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
    assert contended_delivery.last_error == channel_service.DELIVERY_LINK_LOCK_CONTENTION_ERROR
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
            "/v1/channels",
            json={
                "provider": "telegram",
                "name": "telegram-commands",
                "provider_token": "123456:telegram-secret",
            },
        )
    ).json()

    response = await client.post(f"/v1/channels/{created['id']}/commands/sync", json={})

    assert response.status_code == 200
    assert response.json()["provider"] == "telegram"
    assert _FakeProviderClient.calls[0]["url"].endswith("/bot123456:telegram-secret/setMyCommands")
    assert _FakeProviderClient.calls[0]["json"]["commands"] == [
        {"command": "clawdi_pair", "description": "Pair this chat with Clawdi."},
        {"command": "clawdi_unpair", "description": "Disconnect this chat from Clawdi."},
    ]


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
    ]
    pair_command, unpair_command = [call["json"] for call in post_calls]
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
    install_url = pair.json()["discord_install_url"]
    assert install_url == (
        "https://discord.com/oauth2/authorize"
        f"?client_id={DISCORD_TEST_APPLICATION_ID}"
        "&integration_type=0"
        "&permissions=274878024768"
        "&scope=bot%20applications.commands"
    )
    bot_permissions = int(parse_qs(urlparse(install_url).query)["permissions"][0])
    assert bot_permissions == sum(1 << bit for bit in (6, 10, 11, 14, 15, 16, 38))
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
    assert account.config["discord_install_config_version"] == 1
    assert account.config["discord_user_install_supported"] is True
    assert (
        account.config["discord_reserved_command_version"]
        == channel_service.DISCORD_RESERVED_COMMAND_VERSION
    )


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
        "DELETE",
        "DELETE",
        "GET",
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
    }
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[guild_path]
    } == {
        "guild_runtime",
        "clawdi_pair",
        "clawdi_unpair",
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
    assert len(_StatefulDiscordCommandClient.calls) == 10


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
        "DELETE",
        "DELETE",
    ]
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[global_path]
    } == {
        "runtime_status",
        "clawdi_pair",
        "clawdi_unpair",
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
    assert [call["method"] for call in _StatefulDiscordCommandClient.calls[4:]] == [
        "GET",
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
                ({"id": DISCORD_TEST_APPLICATION_ID}, 200),
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
    pair_command, unpair_command = [call["json"] for call in post_calls]
    assert pair_command["name"] == "clawdi_pair"
    assert pair_command["default_member_permissions"] == "32"
    assert pair_command["options"][0]["name"] == "code"
    assert "integration_types" not in pair_command
    assert "contexts" not in pair_command
    assert unpair_command["name"] == "clawdi_unpair"
    assert unpair_command["default_member_permissions"] == "32"
    assert "integration_types" not in unpair_command
    assert "contexts" not in unpair_command
    assert {
        command["name"] for command in _StatefulDiscordCommandClient.commands_by_path[guild_path]
    } == {
        "guild_runtime",
        "clawdi_pair",
        "clawdi_unpair",
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
    ["bot_pair", "bot_unpair", "bot_status", "clawdi_pair", "clawdi_unpair"],
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
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
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
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-structured-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
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
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-invalid-structured-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
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
            "/v1/channels",
            json={
                "provider": "whatsapp",
                "name": "wa-audio-structured-send",
                "provider_token": "wa-access-token",
                "config": {"phone_number_id": "phone-123"},
            },
        )
    ).json()
    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
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
            "/v1/channels",
            json={
                "provider": "imessage",
                "name": "imessage-send",
                "provider_token": "bb-password",
                "config": {"server_url": "https://bluebubbles.example"},
            },
        )
    ).json()

    sent = await client.post(
        f"/v1/channels/{created['id']}/messages",
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
    command = channel_service.ChannelPairCommand(kind="pair", code="BCDFGHJKLM")

    assert (
        channel_service.discord_pair_install_denied_reason(
            payload,
            command=command,
            guild_id=guild_id,
            external_user_id=external_user_id,
            trusted_interaction=True,
        )
        == expected
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
    assert await _discord_bound_guilds(db_session, account=account) == [guild_id]
    assert shared_router._discord_binding_guild_id(binding) == guild_id


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
        decision = limiter.check("GET", "/guilds/membership-real-guild")
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

    async def provider_success(**_kwargs: Any) -> shared_router._DiscordProviderResult:
        return shared_router._DiscordProviderResult(
            content=b"[]",
            status_code=200,
            media_type="application/json",
        )

    monkeypatch.setattr(shared_router, "_request_discord_provider", provider_success)

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

    async def provider_success(**_kwargs: Any) -> shared_router._DiscordProviderResult:
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "_request_discord_provider", provider_success)
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

    async def independent_request_session() -> AsyncIterator[AsyncSession]:
        async with sessionmaker() as request_db:
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
        replacement_pair_task = asyncio.create_task(post_interaction(replacement_pair))
        await asyncio.sleep(0.05)
        replay_task = asyncio.create_task(post_interaction(original_unpair))
        await asyncio.sleep(0.05)
        release_unpair_commit.set()

        first_unpair, repaired, replay = await asyncio.gather(
            first_unpair_task,
            replacement_pair_task,
            replay_task,
        )
    finally:
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
async def test_discord_gateway_replayed_unpair_cannot_archive_replacement_binding(
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
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    original_unpair = {
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
    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            original_unpair,
        )
        is True
    )
    assert (await client.get(f"/v1/channels/{created['id']}/bindings")).json() == []

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
            "id": "gateway-replacement-pair-interaction",
            "token": "gateway-replacement-pair-token",
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

    assert (
        await record_discord_gateway_dispatch(
            sessionmaker,
            UUID(created["id"]),
            original_unpair,
        )
        is True
    )
    bindings = (await client.get(f"/v1/channels/{created['id']}/bindings")).json()
    assert len(bindings) == 1
    assert bindings[0]["external_chat_id"] == guild_id


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
    assert len(post_calls) == 2
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
    assert not await shared_router._discord_guild_owned_by_link(
        db_session,
        account=first_account,
        bot_agent_link_id=first_link.id,
        guild_id=guild_id,
    )
    assert (
        await shared_router._discord_uncontested_guilds_for_link(
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


def test_discord_minimal_bot_permissions_are_exact_text_baseline() -> None:
    permissions = channel_service.DISCORD_MINIMAL_BOT_PERMISSIONS

    assert permissions == sum(1 << bit for bit in (6, 10, 11, 14, 15, 16, 38))
    excluded_bits = (3, 4, 5, 13, 17, 20, 21, 28, 29, 30, 31, 33, 34, 35, 36, 40, 43, 44, 49)
    for excluded_bit in excluded_bits:
        assert permissions & (1 << excluded_bit) == 0


def _discord_provider_result(
    status_code: int,
    payload: Any,
    *,
    headers: dict[str, str] | None = None,
) -> shared_router._DiscordProviderResult:
    return shared_router._DiscordProviderResult(
        content=json.dumps(payload).encode("utf-8"),
        status_code=status_code,
        media_type="application/json",
        headers=headers,
    )


async def _make_discord_retry_due(
    db_session: AsyncSession,
    *,
    link_id: UUID,
    guild_id: str,
) -> None:
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    await db_session.refresh(link, with_for_update=True)
    config = dict(link.config) if isinstance(link.config, dict) else {}
    retries = dict(config.get("discord_command_retries", {}))
    retry = dict(retries[guild_id])
    retry["next_retry_at"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    retries[guild_id] = retry
    config["discord_command_retries"] = retries
    link.config = config
    await db_session.commit()


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

    async def sequenced_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "_request_discord_provider", sequenced_provider)
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
async def test_discord_delete_tombstone_recovers_after_provider_failure(
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

    async def sequenced_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "_request_discord_provider", sequenced_provider)
    command_url = f"/v1/channels/discord/v10/applications/{DISCORD_TEST_APPLICATION_ID}/commands"
    stored = await client.put(
        command_url,
        headers={"Authorization": f"Bot {created['agent_token']}"},
        json=[{"name": "ephemeral", "description": "Ephemeral command"}],
    )
    command_id = stored.json()[0]["id"]

    failed_delete = await client.delete(
        f"{command_url}/{command_id}",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )
    retry_delete = await client.delete(
        f"{command_url}/{command_id}",
        headers={"Authorization": f"Bot {created['agent_token']}"},
    )

    assert failed_delete.status_code == 502
    assert retry_delete.status_code == 404
    assert len(provider_calls) == 2
    link_id = UUID(created["agent_link_id"])
    await _make_discord_retry_due(
        db_session,
        link_id=link_id,
        guild_id=guild_id,
    )
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 1
    assert len(provider_calls) == 3
    assert provider_calls[2]["body"] == b"[]"
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    await db_session.refresh(link)
    empty_fingerprint = shared_router._discord_guild_command_fingerprint(
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

    async def sequenced_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "_request_discord_provider", sequenced_provider)
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
    assert shared_router._discord_retry_after_seconds(body_only) == pytest.approx(23.5)


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

    async def forbidden_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(403, {"message": "Missing Access"})

    monkeypatch.setattr(shared_router, "_request_discord_provider", forbidden_provider)
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

    async def sequenced_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "_request_discord_provider", sequenced_provider)
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

    async def partial_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        nonlocal guild_b_attempts
        provider_calls.append(kwargs)
        path = kwargs["path"]
        if guild_b in path:
            guild_b_attempts += 1
            if guild_b_attempts == 1:
                return _discord_provider_result(502, {"message": "temporary guild failure"})
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "_request_discord_provider", partial_provider)
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

    async def blocked_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        commands = json.loads(kwargs["body"])
        provider_versions.append(commands[0]["name"])
        if commands[0]["name"] == "version_one":
            first_started.set()
            await release_first.wait()
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "_request_discord_provider", blocked_provider)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)

    async def materialize_current() -> int:
        async with sessionmaker() as session:
            account = await session.get(ChannelAccount, account_id)
            assert account is not None
            return await shared_router._fan_out_discord_global_commands(
                session,
                account=account,
                bot_agent_link_id=link_id,
                application_id=DISCORD_TEST_APPLICATION_ID,
                commands=[],
                force=True,
            )

    async def store_v2_and_materialize() -> int:
        async with sessionmaker() as session:
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
    await asyncio.sleep(0.05)
    assert provider_versions == ["version_one"]
    release_first.set()

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
        shared_router._discord_guild_command_fingerprint(
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

    first = shared_router._discord_guild_command_fingerprint(
        commands,
        application_id=DISCORD_TEST_APPLICATION_ID,
    )
    second = shared_router._discord_guild_command_fingerprint(
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

    async def sequenced_provider(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return responses.pop(0)

    monkeypatch.setattr(shared_router, "_request_discord_provider", sequenced_provider)
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
        shared_router._discord_guild_command_fingerprint(
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

    async def provider_success(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "_request_discord_provider", provider_success)
    sessionmaker = async_sessionmaker(db_session.bind, expire_on_commit=False)
    worker = DiscordCommandReconciliationWorker(sessionmaker, poll_interval_seconds=0.01)

    assert await worker.run_once() == 0
    assert len(provider_calls) == 1
    assert provider_calls[0]["body"] == b"[]"
    assert await worker.run_once() == 0
    assert len(provider_calls) == 1


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
    assert await _discord_bound_guilds(db_session, account=account) == [guild_id]
    assert shared_router._discord_binding_guild_id(binding) == guild_id
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

    async def provider_must_not_run(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "_request_discord_provider", provider_must_not_run)
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

    async def provider_success(**kwargs: Any) -> shared_router._DiscordProviderResult:
        provider_calls.append(kwargs)
        return _discord_provider_result(200, [])

    monkeypatch.setattr(shared_router, "_request_discord_provider", provider_success)
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
async def test_archived_agent_cannot_route_channels_and_reactivation_restores_authority(
    db_session, seed_user, channel_agent
):
    from fastapi import HTTPException

    from app.services.agent_lifecycle import (
        archive_agent_and_project,
        reactivate_agent_and_project,
    )
    from app.services.channels import get_strict_v2_hosted_channel_agent_or_409

    await archive_agent_and_project(db_session, agent=channel_agent)
    await db_session.commit()
    with pytest.raises(HTTPException) as exc_info:
        await get_strict_v2_hosted_channel_agent_or_409(
            db_session,
            agent_id=channel_agent.id,
            user_id=seed_user.id,
        )
    assert exc_info.value.status_code == 409

    await reactivate_agent_and_project(db_session, agent=channel_agent)
    await db_session.commit()
    restored = await get_strict_v2_hosted_channel_agent_or_409(
        db_session,
        agent_id=channel_agent.id,
        user_id=seed_user.id,
    )
    assert restored.id == channel_agent.id
