from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.channel import (
    BINDING_STATUS_ARCHIVED,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_VISIBILITY_PUBLIC,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.runtime_observation import V2RuntimeEnvironmentFence
from app.routes import admin as admin_router
from app.routes.channel_routers import discord as discord_router
from app.routes.channel_routers import shared as shared_router
from app.services import channels as channel_service
from app.services.channels import (
    ChannelAgentContext,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    generate_agent_token,
    hash_token,
)
from app.services.runtime_generation import resolve_runtime_apply_generation
from app.services.runtime_source import expected_runtime_bundle_v2_etag
from app.services.runtime_source_revision import refresh_runtime_source_revisions
from app.services.whatsapp_native_transport import (
    WhatsAppSidecarHealth,
)
from tests.hosted_runtime_fixtures import (
    CANONICAL_CODEX_TOOLS,
    ensure_canonical_codex_tool_provider,
)

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
                    cli_package_spec="clawdi@1.2.3-test",
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
    original_clerk_issuer = settings.clerk_jwt_issuer
    settings.admin_api_key = admin_key
    settings.clerk_jwt_issuer = "https://channel-tests.clerk.example.test"
    try:
        payload: dict[str, Any] = {
            "provider": provider,
            "name": name,
            "visibility": visibility,
        }
        if visibility == "private":
            payload["target_clerk_id"] = target_clerk_id
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
        settings.clerk_jwt_issuer = original_clerk_issuer


async def _create_public_discord_account(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    *,
    name: str,
    application_id: str,
) -> dict[str, Any]:
    async def configure_test_application(account: ChannelAccount) -> dict[str, Any]:
        config = dict(account.config) if isinstance(account.config, dict) else {}
        config["discord_install_config_version"] = channel_service.DISCORD_INSTALL_CONFIG_VERSION
        config["discord_user_install_supported"] = True
        account.config = config
        return {
            "id": application_id,
            "integration_types_config": {"0": {}, "1": {}},
        }

    async def sync_test_commands(**_kwargs: Any) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(
        admin_router,
        "configure_discord_application",
        configure_test_application,
    )
    monkeypatch.setattr(admin_router, "sync_channel_commands", sync_test_commands)
    response = await _create_admin_channel(
        client,
        target_clerk_id="unused-for-public-channel",
        provider=CHANNEL_PROVIDER_DISCORD,
        name=name,
        provider_token="discord-provider-token",
        config=_discord_ready_config(application_id),
    )
    assert response.status_code == 201, response.text
    return response.json()


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


async def _seed_historical_platform_whatsapp_account(
    db_session: AsyncSession,
    *,
    name: str,
) -> ChannelAccount:
    """Seed the retired generic-create shape for historical-state projections."""

    account = channel_service.build_channel_account(
        owner_user_id=None,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name=name,
        visibility=CHANNEL_VISIBILITY_PUBLIC,
        webhook_secret_hash=hash_token(uuid4().hex),
    )
    db_session.add(account)
    await db_session.commit()
    await db_session.refresh(account)
    return account


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


async def _converge_hosted_runtime(
    db_session: AsyncSession,
    *,
    user,
    agent_id: UUID,
) -> HostedRuntimeConfigObservation:
    state = await db_session.get(HostedRuntimeState, agent_id)
    assert state is not None
    state.tools = CANONICAL_CODEX_TOOLS
    await ensure_canonical_codex_tool_provider(db_session, user)
    revisions = await refresh_runtime_source_revisions(db_session, [agent_id])
    source_revision = revisions[agent_id]
    assert source_revision is not None
    await db_session.commit()
    observation = await db_session.get(HostedRuntimeConfigObservation, agent_id)
    assert observation is not None
    observed_at = datetime.now(UTC)
    generation = resolve_runtime_apply_generation(
        generation=state.generation,
        apply_generation=state.apply_generation,
    )
    etag = expected_runtime_bundle_v2_etag(source_revision)
    observation.observed_at = observed_at
    observation.observed_config_generation = generation
    observation.observed_manifest_etag = etag
    observation.observed_source_revision = source_revision
    observation.diagnostics = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": observed_at.isoformat(),
        "runtimeMode": "hosted",
        "status": "ok",
        "activeCliVersion": state.cli_package_spec.removeprefix("clawdi@"),
        "applied": {
            "etag": etag,
            "sourceRevision": source_revision,
            "generation": generation,
            "instanceId": state.instance_id,
            "appliedProviderIds": [],
        },
        "boot": None,
        "cli": None,
    }
    await db_session.commit()
    return observation


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

    def __init_subclass__(cls) -> None:
        cls.calls = []

    def __init__(self, *, timeout, limits=None):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def aclose(self):
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


class _AmbiguousDiscordCreateMessageClient(_FakeProviderClient):
    attempts = 0

    async def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        self.__class__.attempts += 1
        if self.attempts == 1:
            raise httpx.ReadTimeout(
                "response was lost after provider acceptance",
                request=httpx.Request("POST", str(url)),
            )
        return _FakeProviderResponse({"id": "123456789012345679"})


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
    clients = [_FakeProviderClient]
    while clients:
        client = clients.pop()
        client.calls = []
        clients.extend(client.__subclasses__())


class _MemoryFileStore:
    def __init__(self):
        self.data: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        del content_type
        self.data[key] = data

    async def get(self, key: str) -> bytes:
        return self.data[key]

    async def delete(self, key: str) -> None:
        self.data.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self.data


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
) -> httpx.Response:
    return await client.post(
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


class _WhatsAppPairLinkSidecar:
    def __init__(self, health: WhatsAppSidecarHealth | Exception) -> None:
        self._health = health
        self.health_calls = 0

    async def health(self) -> WhatsAppSidecarHealth:
        self.health_calls += 1
        if isinstance(self._health, Exception):
            raise self._health
        return self._health


class _WhatsAppPairLinkRegistry:
    def __init__(
        self,
        *,
        account_id: UUID,
        client: _WhatsAppPairLinkSidecar,
        revision: str = "trusted-managed-revision",
        bound: bool = True,
    ) -> None:
        self._account_id = account_id
        self._client = client
        self._revision = revision
        self._bound = bound

    def managed_is_bound(self, account_id: UUID) -> bool:
        return self._bound and account_id == self._account_id

    def session_revision(self, session_id: UUID) -> str | None:
        return self._revision if session_id == self._account_id else None

    def session_client(self, session_id: UUID) -> _WhatsAppPairLinkSidecar | None:
        return self._client if session_id == self._account_id else None


async def _create_whatsapp_pair_target(
    client: httpx.AsyncClient,
    *,
    agent_id: UUID,
) -> tuple[dict[str, Any], dict[str, Any]]:
    created_response = await client.post(
        "/v1/channels",
        json={"provider": "whatsapp", "name": f"whatsapp-pair-link-{uuid4().hex}"},
    )
    assert created_response.status_code == 201, created_response.text
    created = created_response.json()
    link_response = await client.post(
        f"/v1/channels/{created['id']}/agent-links",
        json={"agent_id": str(agent_id)},
    )
    assert link_response.status_code == 201, link_response.text
    return created, link_response.json()


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
    guilds: dict[str, str] | None = None,
    channels: dict[str, str | None] | None = None,
    provider_channels: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    _reset_discord_gateway_sessions(monkeypatch)
    event_queue = events if events is not None else []
    for event in event_queue:
        if event.id is None:
            event.id = uuid4()
    guild_authority = guilds if guilds is not None else {"guild-protocol-1": "Protocol Guild"}
    channel_authority = (
        channels if channels is not None else {"chan-protocol-1": "guild-protocol-1"}
    )
    provider_payloads = (
        provider_channels
        if provider_channels is not None
        else {
            "chan-protocol-1": {
                "id": "chan-protocol-1",
                "guild_id": "guild-protocol-1",
                "type": 0,
                "name": "general",
            }
        }
    )
    provider_paths: list[str] = []

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

    async def fake_authority(
        db,
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID,
        priority_channel_id: str | None = None,
    ) -> tuple[dict[str, str], dict[str, str | None]]:
        return dict(guild_authority), dict(channel_authority)

    async def fake_provider_request(*, account, method: str, path: str, **kwargs):
        provider_paths.append(path)
        payload = provider_payloads[path.rpartition("/")[2]]
        return shared_router.DiscordProviderResult(
            content=json.dumps(payload).encode(),
            status_code=200,
            media_type="application/json",
        )

    async def fake_dequeue_events(
        db,
        *,
        account: ChannelAccount,
        bot_agent_link_id: UUID | None = None,
        after_sequence: int,
        limit: int,
    ):
        return [event for event in event_queue if event.inbox_sequence > after_sequence][:limit]

    async def fake_send_message(
        *,
        account_id: UUID,
        bot_agent_link_id: UUID,
        message: ChannelMessage,
        send,
    ) -> tuple[str, int | None]:
        if send is None:
            event_queue.remove(message)
            return "dropped", None
        dispatched_sequence = await send()
        return "sent", dispatched_sequence

    async def fake_ack_messages(
        db,
        *,
        account_id: UUID,
        bot_agent_link_id: UUID,
        message_ids: list[UUID],
    ) -> int:
        before = len(event_queue)
        event_queue[:] = [event for event in event_queue if event.id not in message_ids]
        return before - len(event_queue)

    @asynccontextmanager
    async def fake_consumer_lease(**_kwargs):
        yield True

    monkeypatch.setattr(
        "app.routes.channel_routers.discord.resolve_channel_agent_by_token",
        fake_resolve_agent,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.resolve_channel_agent_by_identity",
        fake_resolve_identity,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord._discord_gateway_authority",
        fake_authority,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.request_discord_provider",
        fake_provider_request,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.dequeue_discord_gateway_events",
        fake_dequeue_events,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord._send_discord_gateway_message",
        fake_send_message,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord._discord_gateway_consumer_lease",
        fake_consumer_lease,
    )
    monkeypatch.setattr(
        "app.routes.channel_routers.discord.ack_discord_gateway_messages",
        fake_ack_messages,
    )
    return provider_paths


def _reset_discord_gateway_sessions(
    monkeypatch: pytest.MonkeyPatch,
) -> discord_router._DiscordGatewaySessionStore:
    store = discord_router._DiscordGatewaySessionStore(
        max_sessions=discord_router._DISCORD_GATEWAY_MAX_SESSIONS,
        ttl_seconds=discord_router._DISCORD_GATEWAY_SESSION_TTL_SECONDS,
    )
    monkeypatch.setattr(discord_router, "_DISCORD_GATEWAY_SESSIONS", store)
    return store


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
    monkeypatch.setattr(
        "app.main.engine",
        gateway_engine,
    )


async def _archive_discord_binding_with_identity_lock(
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    account_id: UUID,
    binding_id: UUID,
    external_chat_id: str,
    backend_pids: asyncio.Queue[int],
) -> None:
    async with sessionmaker() as db:
        backend_pid = await db.scalar(select(func.pg_backend_pid()))
        assert isinstance(backend_pid, int)
        backend_pids.put_nowait(backend_pid)
        await channel_service.lock_channel_binding_identity(
            db,
            account_id=account_id,
            external_chat_id=external_chat_id,
        )
        binding = await db.get(ChannelBinding, binding_id)
        assert binding is not None
        binding.status = BINDING_STATUS_ARCHIVED
        await db.commit()


def _discord_provider_result(
    status_code: int,
    payload: Any,
    *,
    headers: dict[str, str] | None = None,
) -> shared_router.DiscordProviderResult:
    return shared_router.DiscordProviderResult(
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


async def _make_discord_projection_due(
    db_session: AsyncSession,
    *,
    link_id: UUID,
) -> None:
    await db_session.rollback()
    link = await db_session.get(ChannelBotAgentLink, link_id)
    assert link is not None
    await db_session.refresh(link, with_for_update=True)
    config = dict(link.config) if isinstance(link.config, dict) else {}
    config["discord_command_projection_settle_at"] = (
        datetime.now(UTC) - timedelta(seconds=1)
    ).isoformat()
    link.config = config
    await db_session.commit()
