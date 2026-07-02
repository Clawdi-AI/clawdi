from __future__ import annotations

import re
from uuid import UUID

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ARCHIVED,
    PAIR_CODE_STATUS_REVOKED,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelPairCode,
)
from app.models.user import User
from app.services.channels import hash_token

pytestmark = pytest.mark.usefixtures("channel_agent")


@pytest.mark.asyncio
async def test_imessage_agent_token_is_one_time_hashed_and_resolves(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "imessage",
            "name": "imessage-creds",
            "provider_token": "bb-password",
            "config": {"server_url": "https://bluebubbles.example"},
        },
    )
    assert created_response.status_code == 201
    created = created_response.json()
    agent_token = created["agent_token"]

    assert re.fullmatch(r"im_[A-Za-z0-9_-]+", agent_token)
    assert len(agent_token) >= 40
    assert created["webhook_secret"]

    listed = await client.get("/v1/channels")
    fetched = await client.get(f"/v1/channels/{created['id']}")
    assert listed.status_code == 200
    assert fetched.status_code == 200
    assert "agent_token" not in listed.json()[0]
    assert "webhook_secret" not in listed.json()[0]
    assert "agent_token" not in fetched.json()
    assert "webhook_secret" not in fetched.json()

    link = (
        await db_session.execute(
            select(ChannelBotAgentLink).where(
                ChannelBotAgentLink.id == UUID(created["agent_link_id"])
            )
        )
    ).scalar_one()
    assert link.agent_token_hash == hash_token(agent_token)
    assert link.agent_token_hash != agent_token

    valid_ping = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        params={"password": agent_token},
    )
    invalid_ping = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        params={"password": "im_nope"},
    )
    assert valid_ping.status_code == 200
    assert valid_ping.json()["data"]["message"] == "pong"
    assert invalid_ping.status_code == 401
    assert invalid_ping.json() == {"status": 401, "message": "invalid bot token", "data": None}


@pytest.mark.asyncio
async def test_imessage_channel_delete_invalidates_creds_and_allows_remint(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
):
    created_response = await client.post(
        "/v1/channels",
        json={
            "provider": "imessage",
            "name": "imessage-remint",
            "provider_token": "bb-password",
            "config": {"server_url": "https://bluebubbles.example"},
        },
    )
    assert created_response.status_code == 201
    created = created_response.json()
    old_token = created["agent_token"]

    pair_response = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )
    assert pair_response.status_code == 201
    pair = pair_response.json()
    webhook_response = await client.post(
        f"/v1/channels/imessage/{created['id']}/webhook",
        params={"secret": created["webhook_secret"]},
        json={
            "data": {
                "guid": "imessage-remint-pair",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": "iMessage;-;+15550009000", "displayName": "Ops"}],
            }
        },
    )
    assert webhook_response.status_code == 200
    pending_pair_response = await client.post(
        f"/v1/channels/{created['id']}/pair-codes",
        json={"ttl_seconds": 900},
    )
    assert pending_pair_response.status_code == 201
    pending_pair = pending_pair_response.json()

    duplicate = await client.post(
        "/v1/channels",
        json={
            "provider": "imessage",
            "name": "imessage-remint",
            "provider_token": "bb-password",
            "config": {"server_url": "https://bluebubbles.example"},
        },
    )
    assert duplicate.status_code == 409
    await db_session.refresh(seed_user)

    deleted = await client.delete(f"/v1/channels/{created['id']}")
    assert deleted.status_code == 204

    archived = (
        await db_session.execute(
            select(ChannelAccount).where(ChannelAccount.id == UUID(created["id"]))
        )
    ).scalar_one()
    archived_link = (
        await db_session.execute(
            select(ChannelBotAgentLink).where(
                ChannelBotAgentLink.id == UUID(created["agent_link_id"])
            )
        )
    ).scalar_one()
    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == UUID(created["id"]))
        )
    ).scalar_one()
    pair_code = (
        await db_session.execute(
            select(ChannelPairCode).where(ChannelPairCode.id == UUID(pending_pair["id"]))
        )
    ).scalar_one()
    assert archived.archived_at is not None
    assert archived.status == "disabled"
    assert archived_link.agent_token_hash is None
    assert archived_link.archived_at is not None
    assert archived_link.status == "archived"
    assert binding.status == BINDING_STATUS_ARCHIVED
    assert pair_code.status == PAIR_CODE_STATUS_REVOKED

    listed = await client.get("/v1/channels")
    fetched = await client.get(f"/v1/channels/{created['id']}")
    old_ping = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        params={"password": old_token},
    )
    assert listed.status_code == 200
    assert all(item["id"] != created["id"] for item in listed.json())
    assert fetched.status_code == 404
    assert old_ping.status_code == 401
    assert old_ping.json() == {"status": 401, "message": "invalid bot token", "data": None}

    reminted_response = await client.post(
        "/v1/channels",
        json={
            "provider": "imessage",
            "name": "imessage-remint",
            "provider_token": "bb-password",
            "config": {"server_url": "https://bluebubbles.example"},
        },
    )
    assert reminted_response.status_code == 201
    reminted = reminted_response.json()
    assert reminted["id"] != created["id"]
    assert reminted["agent_token"] != old_token

    new_ping = await client.get(
        "/v1/channels/imessage/bluebubbles/v1/ping",
        params={"password": reminted["agent_token"]},
    )
    assert new_ping.status_code == 200
