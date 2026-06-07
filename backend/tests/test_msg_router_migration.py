from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import ChannelAccount, ChannelBinding, ChannelBotAgentLink
from app.models.session import AgentEnvironment
from app.models.user import User
from app.services.msg_router_migration import (
    MIGRATION_CONFIG_SOURCE_ID,
    import_msg_router_migration_dump,
    resolve_discord_dm_channel_id,
    translate_mux_binding,
    validate_migration_dump,
)


def test_msg_router_migration_translates_mux_route_keys():
    assert translate_mux_binding(
        {
            "channel": "telegram",
            "scope": "chat",
            "routeKey": "telegram:default:chat:-100999:topic:42",
        }
    ).translated.chat_id == "-100999"

    whatsapp = translate_mux_binding(
        {
            "channel": "whatsapp",
            "scope": "chat",
            "routeKey": "whatsapp:default:chat:555111@g.us",
        }
    )
    assert whatsapp.ok is True
    assert whatsapp.translated is not None
    assert whatsapp.translated.chat_id == "555111@g.us"

    discord_guild = translate_mux_binding(
        {
            "channel": "discord",
            "scope": "guild",
            "routeKey": "discord:default:guild:9001:channel:777001:thread:777101",
        }
    )
    assert discord_guild.ok is True
    assert discord_guild.translated is not None
    assert discord_guild.translated.chat_id == "9001"
    assert discord_guild.translated.chat_type == "guild_text"
    assert discord_guild.translated.scope_id == "9001"

    discord_dm = translate_mux_binding(
        {
            "channel": "discord",
            "scope": "dm",
            "routeKey": "discord:default:dm:user:4242",
        }
    )
    assert discord_dm.ok == "pending"
    assert discord_dm.pending is not None
    assert discord_dm.pending.kind == "discord_dm_lookup"
    assert discord_dm.pending.user_id == "4242"

    imessage = translate_mux_binding(
        {
            "channel": "imessage",
            "scope": "chat",
            "routeKey": "imessage:direct:any;-;dhzhtun@qq.com",
        }
    )
    assert imessage.ok is True
    assert imessage.translated is not None
    assert imessage.translated.chat_id == "imessage:direct:any;-;dhzhtun@qq.com"
    assert imessage.translated.scope_id == "any;-;dhzhtun@qq.com"

    malformed = translate_mux_binding(
        {"channel": "telegram", "scope": "chat", "routeKey": "not-a-telegram-key"}
    )
    assert malformed.ok is False
    assert malformed.failure is not None
    assert malformed.failure.reason == "unparseable_route_key"

    unknown = translate_mux_binding(
        {"channel": "signal", "scope": "chat", "routeKey": "signal:default:chat:abc"}
    )
    assert unknown.ok is False
    assert unknown.failure is not None
    assert unknown.failure.reason == "unknown_channel"


def test_msg_router_migration_validates_dump_shape():
    valid = {
        "schemaVersion": 1,
        "dumpedAtMs": 1000,
        "tenant": {"id": "t", "name": "T"},
        "bindings": [],
    }

    assert validate_migration_dump(valid) is None
    assert validate_migration_dump(None) == "body must be an object"
    assert (
        validate_migration_dump({**valid, "schemaVersion": 2})
        == "unsupported schemaVersion (expected 1)"
    )
    assert validate_migration_dump({**valid, "tenant": {"id": "", "name": "T"}}) == (
        "tenant.id required"
    )
    assert validate_migration_dump({**valid, "bindings": "x"}) == "bindings must be an array"


@pytest.mark.asyncio
async def test_msg_router_migration_resolves_discord_dm_channel_id():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"id": "dm-channel-9001"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        channel_id = await resolve_discord_dm_channel_id(
            discord_base_url="https://discord.example",
            bot_token="real-bot-token",
            user_id="4242",
            client=client,
        )

    assert channel_id == "dm-channel-9001"
    assert str(requests[0].url) == "https://discord.example/api/v10/users/@me/channels"
    assert requests[0].headers["authorization"] == "Bot real-bot-token"
    assert requests[0].read() == b'{"recipient_id":"4242"}'


@pytest.mark.asyncio
async def test_msg_router_migration_import_route_creates_accounts_bindings_and_is_idempotent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    channel_agent: AgentEnvironment,
):
    dump = {
        "schemaVersion": 1,
        "dumpedAtMs": 1000,
        "agent_id": str(channel_agent.id),
        "tenant": {"id": "mux-tenant-mixed", "name": "Mixed Tenant"},
        "bindings": [
            {
                "channel": "telegram",
                "scope": "chat",
                "routeKey": "telegram:default:chat:-1001",
            },
            {
                "channel": "imessage",
                "scope": "chat",
                "routeKey": "imessage:direct:iMessage;-;+15551112222",
            },
        ],
    }

    first = await client.post("/api/channels/migrations/msg-router/import-tenant", json=dump)
    second = await client.post("/api/channels/migrations/msg-router/import-tenant", json=dump)

    assert first.status_code == 200
    assert second.status_code == 200
    first_body = first.json()
    second_body = second.json()
    assert first_body["bindingsImported"] == {"telegram": 1, "imessage": 1}
    assert first_body["bindingsSkipped"] == []
    assert first_body["channelTokens"]["telegram"].count(":") == 1
    assert first_body["channelTokens"]["imessage"].startswith("im_")
    assert second_body["channelAccounts"] == first_body["channelAccounts"]
    assert second_body["channelTokens"] == first_body["channelTokens"]
    assert second_body["webhookSecrets"] == first_body["webhookSecrets"]

    accounts = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.archived_at.is_(None))
        )
    ).scalars().all()
    migrated_accounts = [
        account
        for account in accounts
        if isinstance(account.config, dict)
        and account.config.get(MIGRATION_CONFIG_SOURCE_ID) == "mux-tenant-mixed"
    ]
    assert {account.provider for account in migrated_accounts} == {"telegram", "imessage"}

    bindings = (
        await db_session.execute(
            select(ChannelBinding).where(
                ChannelBinding.account_id.in_([a.id for a in migrated_accounts])
            )
        )
    ).scalars().all()
    assert {binding.external_chat_id for binding in bindings} == {
        "-1001",
        "imessage:direct:iMessage;-;+15551112222",
    }


@pytest.mark.asyncio
async def test_msg_router_migration_import_resolves_discord_dm_bindings(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"id": "dm-channel-9001"})

    dump = {
        "schemaVersion": 1,
        "dumpedAtMs": 1000,
        "tenant": {"id": "mux-discord-dm", "name": "Discord DM"},
        "bindings": [
            {
                "channel": "discord",
                "scope": "dm",
                "routeKey": "discord:default:dm:user:4242",
            }
        ],
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as discord_client:
        result = await import_msg_router_migration_dump(
            db_session,
            user_id=seed_user.id,
            agent_id=channel_agent.id,
            dump=dump,
            provider_tokens={"discord": "discord-provider-token"},
            discord_base_url="https://discord.example",
            discord_client=discord_client,
        )

    assert result.bindings_imported == {"discord": 1}
    assert result.bindings_skipped == []
    assert requests[0].headers["authorization"] == "Bot discord-provider-token"
    assert requests[0].read() == b'{"recipient_id":"4242"}'

    account = (
        await db_session.execute(
            select(ChannelAccount).where(
                ChannelAccount.provider == "discord",
                ChannelAccount.config[MIGRATION_CONFIG_SOURCE_ID].astext == "mux-discord-dm",
            )
        )
    ).scalar_one()
    link = (
        await db_session.execute(
            select(ChannelBotAgentLink).where(
                ChannelBotAgentLink.account_id == account.id,
                ChannelBotAgentLink.agent_id == channel_agent.id,
            )
        )
    ).scalar_one()
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account.id)
        )
    ).scalar_one()
    assert binding.bot_agent_link_id == link.id
    assert binding.external_chat_id == "dm-channel-9001"
    assert binding.external_chat_type == "dm"
