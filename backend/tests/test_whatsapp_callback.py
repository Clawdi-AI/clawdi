from __future__ import annotations

import hashlib
import json
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelMessage,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.services.channels import hash_token, store_agent_link_token, upsert_channel_secrets
from app.services.whatsapp_callback import (
    WHATSAPP_IGNORED_CALLBACK_STAGE,
    WHATSAPP_SIDECAR_INGRESS_SECRET_NAME,
)

pytestmark = pytest.mark.committed_db


async def _seed_authority(
    db: AsyncSession,
    *,
    user: User,
    agent: AgentEnvironment,
    ingress_secret: str = "ingress-secret",
    chat_jid: str = "15551112222@s.whatsapp.net",
    chat_type: str = "private",
    paired_actor: str | None = "15551112222@s.whatsapp.net",
) -> tuple[ChannelAccount, ChannelBotAgentLink, ChannelBinding]:
    account = ChannelAccount(
        user_id=user.id,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        name=f"whatsapp-{uuid4().hex[:12]}",
        webhook_secret_hash=hash_token("unused-webhook-secret"),
    )
    db.add(account)
    await db.flush()
    await upsert_channel_secrets(
        db,
        account=account,
        secrets_by_name={WHATSAPP_SIDECAR_INGRESS_SECRET_NAME: ingress_secret},
    )
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=user.id,
        agent_id=agent.id,
    )
    store_agent_link_token(link, f"wa_test_{uuid4().hex}")
    db.add(link)
    await db.flush()
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=user.id,
        external_chat_id=chat_jid,
        external_chat_type=chat_type,
        external_chat_name="Authorized chat",
        paired_external_user_id=paired_actor,
    )
    db.add(binding)
    await db.commit()
    return account, link, binding


def _event(
    account_id: UUID,
    *,
    message_id: str = "message-1",
    chat_primary: str = "15551112222@s.whatsapp.net",
    chat_alt: str | None = "777000111222@lid",
    actor_primary: str = "15551112222@s.whatsapp.net",
    actor_alt: str | None = "777000111222@lid",
    from_me: bool = False,
    content: dict[str, object] | None = None,
) -> dict[str, object]:
    event: dict[str, object] = {
        "schemaVersion": "clawdi.whatsapp.sidecar-event.v1",
        "accountId": str(account_id),
        "eventType": "message",
        "messageId": message_id,
        "chat": {
            "primary": chat_primary,
            **({"alt": chat_alt} if chat_alt is not None else {}),
        },
        "actor": {
            "primary": actor_primary,
            **({"alt": actor_alt} if actor_alt is not None else {}),
        },
        "fromMe": from_me,
        "ownership": "self" if from_me else "peer",
        "timestamp": 1_700_000_000,
        "pushName": "Participant",
        "content": content or {"type": "text", "text": "hello"},
    }
    event["providerEventId"] = _provider_event_id(event)
    return event


@pytest.mark.asyncio
async def test_callback_token_body_account_and_dedup_are_account_bound(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, _link, binding = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
        ingress_secret="account-a-secret",
    )
    other, _other_link, _other_binding = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
        ingress_secret="account-b-secret",
        chat_jid="15553334444@s.whatsapp.net",
        paired_actor="15553334444@s.whatsapp.net",
    )
    url = f"/v1/channels/whatsapp/{account.id}/sidecar/events"

    wrong_token = await client.post(
        url,
        headers={"Authorization": "Bearer account-b-secret"},
        json=_event(account.id),
    )
    wrong_body_account = await client.post(
        url,
        headers={"Authorization": "Bearer account-a-secret"},
        json=_event(other.id),
    )
    accepted = await client.post(
        url,
        headers={"Authorization": "Bearer account-a-secret"},
        json=_event(account.id),
    )
    swapped = await client.post(
        url,
        headers={"Authorization": "Bearer account-a-secret"},
        json=_event(
            account.id,
            chat_primary="777000111222@lid",
            chat_alt="15551112222@s.whatsapp.net",
            actor_primary="777000111222@lid",
            actor_alt="15551112222@s.whatsapp.net",
        ),
    )

    assert wrong_token.status_code == 401
    assert wrong_body_account.status_code == 409
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["bindingId"] == str(binding.id)
    assert swapped.status_code == 200
    assert swapped.json()["duplicate"] is True
    aliases = list(
        (
            await db_session.execute(
                select(ChannelBindingAlias).where(ChannelBindingAlias.account_id == account.id)
            )
        ).scalars()
    )
    assert [(alias.alias_external_chat_id, alias.binding_id) for alias in aliases] == [
        ("777000111222@lid", binding.id)
    ]
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                )
            )
        ).scalars()
    )
    assert len(messages) == 1
    assert messages[0].payload is not None
    assert messages[0].payload["chat"] == {
        "primary": "15551112222@s.whatsapp.net",
        "alt": "777000111222@lid",
    }
    assert messages[0].payload["actor"] == messages[0].payload["chat"]


@pytest.mark.asyncio
async def test_callback_fails_closed_for_alias_actor_and_binding_authority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, link, _binding = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    conflict = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        external_chat_id="777000111222@lid",
        external_chat_type="private",
        paired_external_user_id="15551112222@s.whatsapp.net",
    )
    group = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        external_chat_id="120363000000000001@g.us",
        external_chat_type="group",
        paired_external_user_id="15559990000@s.whatsapp.net",
    )
    no_actor = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=seed_user.id,
        external_chat_id="15556667777@s.whatsapp.net",
        external_chat_type="private",
        paired_external_user_id=None,
    )
    db_session.add_all([conflict, group, no_actor])
    await db_session.commit()
    url = f"/v1/channels/whatsapp/{account.id}/sidecar/events"
    headers = {"Authorization": "Bearer ingress-secret"}

    alias_conflict = await client.post(url, headers=headers, json=_event(account.id))
    wrong_actor = await client.post(
        url,
        headers=headers,
        json=_event(
            account.id,
            message_id="wrong-group-message",
            chat_primary=group.external_chat_id,
            chat_alt=None,
            actor_primary="15558880000@s.whatsapp.net",
            actor_alt="888000111222@lid",
        ),
    )
    accepted_group = await client.post(
        url,
        headers=headers,
        json=_event(
            account.id,
            message_id="accepted-group-message",
            chat_primary=group.external_chat_id,
            chat_alt=None,
            actor_primary="15559990000@s.whatsapp.net",
            actor_alt="999000111222@lid",
        ),
    )
    missing_actor_authority = await client.post(
        url,
        headers=headers,
        json=_event(
            account.id,
            message_id="missing-actor-authority",
            chat_primary=no_actor.external_chat_id,
            chat_alt=None,
            actor_primary=no_actor.external_chat_id,
            actor_alt=None,
        ),
    )

    assert alias_conflict.status_code == 409
    assert wrong_actor.status_code == 403
    assert accepted_group.status_code == 200
    assert missing_actor_authority.status_code == 403
    assert (
        await db_session.execute(
            select(ChannelBindingAlias).where(ChannelBindingAlias.account_id == account.id)
        )
    ).scalars().all() == []


@pytest.mark.asyncio
async def test_unpaired_non_command_is_deduped_without_poisoning_callback_fifo_or_agent_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, _link, binding = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    url = f"/v1/channels/whatsapp/{account.id}/sidecar/events"
    headers = {"Authorization": "Bearer ingress-secret"}
    unpaired = _event(
        account.id,
        message_id="spam-message",
        chat_primary="15550000000@s.whatsapp.net",
        chat_alt=None,
        actor_primary="15550000000@s.whatsapp.net",
        actor_alt=None,
    )

    ignored = await client.post(url, headers=headers, json=unpaired)
    duplicate = await client.post(url, headers=headers, json=unpaired)
    following = await client.post(
        url,
        headers=headers,
        json=_event(account.id, message_id="following-authorized-message"),
    )

    assert ignored.status_code == 200, ignored.text
    assert ignored.json()["ignoredUnpaired"] is True
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True
    assert following.status_code == 200
    assert following.json()["bindingId"] == str(binding.id)
    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(ChannelMessage.account_id == account.id)
            )
        ).scalars()
    )
    assert [message.provider_message_id for message in messages] == ["following-authorized-message"]
    receipts = list(
        (
            await db_session.execute(
                select(ChannelDebugEvent).where(
                    ChannelDebugEvent.account_id == account.id,
                    ChannelDebugEvent.stage == WHATSAPP_IGNORED_CALLBACK_STAGE,
                )
            )
        ).scalars()
    )
    assert len(receipts) == 1
    assert receipts[0].request_id == unpaired["providerEventId"]
    assert receipts[0].details == {"reason": "unpaired"}


@pytest.mark.asyncio
async def test_from_me_is_accepted_and_deduped_without_agent_loop(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    account, _link, _binding = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    url = f"/v1/channels/whatsapp/{account.id}/sidecar/events"
    headers = {"Authorization": "Bearer ingress-secret"}
    event = _event(account.id, message_id="self-message", from_me=True)

    accepted = await client.post(url, headers=headers, json=event)
    duplicate = await client.post(url, headers=headers, json=event)

    assert accepted.status_code == 200
    assert accepted.json()["ignoredFromMe"] is True
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True
    assert (
        await db_session.execute(
            select(ChannelMessage).where(ChannelMessage.account_id == account.id)
        )
    ).scalars().all() == []


def _provider_event_id(payload: dict[str, object]) -> str:
    chat = payload["chat"]
    actor = payload["actor"]
    assert isinstance(chat, dict)
    assert isinstance(actor, dict)
    identity = {
        "accountId": payload["accountId"],
        "chatAliases": sorted(value for value in chat.values() if isinstance(value, str)),
        "actorAliases": sorted(value for value in actor.values() if isinstance(value, str)),
        "messageId": payload["messageId"],
    }
    encoded = json.dumps(identity, separators=(",", ":"), ensure_ascii=False)
    return f"message:{hashlib.sha256(encoded.encode()).hexdigest()}"
