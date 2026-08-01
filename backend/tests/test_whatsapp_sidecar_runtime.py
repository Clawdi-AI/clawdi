from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.channel import (
    PROVIDER_EVENT_SCOPE_ACCOUNT,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
    ChannelPairCode,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.routes.channel_routers.whatsapp_sidecar import _pairing_reply_message_id
from app.services.channels import (
    bot_agent_link_has_provider_cardinality_capability,
    ensure_bot_agent_link_provider_cardinality_or_409,
    hash_token,
    store_agent_link_token,
)
from app.services.whatsapp_native_transport import WhatsAppSidecarSendRequest

pytestmark = pytest.mark.committed_db


class _FakeSidecar:
    def __init__(self, *, fail: bool = False) -> None:
        self.requests: list[WhatsAppSidecarSendRequest] = []
        self.fail = fail

    async def send_text_message(self, request: WhatsAppSidecarSendRequest) -> str:
        self.requests.append(request)
        if self.fail:
            raise RuntimeError("fake sidecar unavailable")
        return request.message_id


async def _seed_account(
    db: AsyncSession,
    *,
    user: User,
    agents: tuple[AgentEnvironment, ...],
) -> tuple[ChannelAccount, list[ChannelBotAgentLink], list[str]]:
    account = ChannelAccount(
        user_id=user.id,
        provider="whatsapp",
        name=f"sidecar-{uuid4().hex[:12]}",
        webhook_secret_hash=hash_token("generic-webhook-secret"),
    )
    db.add(account)
    await db.flush()
    links: list[ChannelBotAgentLink] = []
    tokens: list[str] = []
    for index, agent in enumerate(agents):
        token = f"wa_test_link_{index}_{uuid4().hex}"
        link = ChannelBotAgentLink(
            account_id=account.id,
            user_id=user.id,
            agent_id=agent.id,
        )
        store_agent_link_token(link, token)
        db.add(link)
        links.append(link)
        tokens.append(token)
    await db.commit()
    return account, links, tokens


def _event(
    *,
    event_id: str,
    message_id: str,
    chat_jid: str,
    actor_jid: str,
    text: str,
    chat_jid_alt: str | None = None,
) -> dict[str, object]:
    return {
        "schemaVersion": "clawdi.whatsapp.sidecar-event.v1",
        "providerEventId": event_id,
        "messageId": message_id,
        "chatJid": chat_jid,
        **({"chatJidAlt": chat_jid_alt} if chat_jid_alt else {}),
        "actorJid": actor_jid,
        "fromMe": False,
        "text": text,
        "pushName": "Participant",
        "timestamp": 1_700_000_000,
    }


def _configure_sidecar(
    monkeypatch: pytest.MonkeyPatch,
    account: ChannelAccount,
    *,
    ingress_token: str | None,
) -> None:
    monkeypatch.setattr(
        settings,
        "channel_whatsapp_baileys_sidecars_json",
        json.dumps(
            {
                str(account.id): {
                    "base_url": "http://sidecar.invalid",
                    "api_token": "outbound-sidecar-token",
                    **({"ingress_token": ingress_token} if ingress_token else {}),
                }
            }
        ),
    )


@pytest.mark.asyncio
async def test_whatsapp_links_enforce_one_active_account_per_agent(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    first_account, first_links, _ = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )
    second_account, second_links, _ = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )

    assert not await bot_agent_link_has_provider_cardinality_capability(
        db_session,
        account=first_account,
        link=first_links[0],
    )
    assert not await bot_agent_link_has_provider_cardinality_capability(
        db_session,
        account=second_account,
        link=second_links[0],
    )
    with pytest.raises(
        HTTPException,
        match="This Agent has multiple active WhatsApp bots",
    ):
        await ensure_bot_agent_link_provider_cardinality_or_409(
            db_session,
            account=second_account,
            link=second_links[0],
        )


@pytest.mark.asyncio
async def test_sidecar_ingress_dedupes_and_routes_group_actor_to_link_inbox(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, links, tokens = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )
    group_jid = "120363000000000001@g.us"
    actor_jid = "15551112222@s.whatsapp.net"
    binding = ChannelBinding(
        account_id=account.id,
        bot_agent_link_id=links[0].id,
        user_id=seed_user.id,
        external_chat_id=group_jid,
        external_chat_type="group",
        external_chat_name="Test Group",
        paired_external_user_id=actor_jid,
    )
    db_session.add(binding)
    await db_session.commit()
    ingress_token = "account-sidecar-ingress-token"
    _configure_sidecar(monkeypatch, account, ingress_token=ingress_token)
    payload = _event(
        event_id="message:group-in-1",
        message_id="group-in-1",
        chat_jid=group_jid,
        actor_jid=actor_jid,
        text="hello group",
    )

    generic_secret = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": "Bearer generic-webhook-secret"},
        json=payload,
    )
    accepted = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": f"Bearer {ingress_token}"},
        json=payload,
    )
    replay = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": f"Bearer {ingress_token}"},
        json=payload,
    )

    messages = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.provider_event_id == "message:group-in-1",
                )
            )
        ).scalars()
    )
    assert generic_secret.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["bindingId"] == str(binding.id)
    assert replay.json()["duplicate"] is True
    assert len(messages) == 1
    assert messages[0].provider_event_scope == PROVIDER_EVENT_SCOPE_ACCOUNT
    assert messages[0].external_chat_id == group_jid
    assert messages[0].payload == {
        "actorJid": actor_jid,
        "pushName": "Participant",
        "timestamp": 1_700_000_000,
    }
    assert ingress_token not in json.dumps(messages[0].payload)
    assert tokens[0] not in json.dumps(messages[0].payload)


@pytest.mark.asyncio
async def test_sidecar_ingress_is_disabled_without_account_ingress_token(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _links, _tokens = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )
    _configure_sidecar(monkeypatch, account, ingress_token=None)

    response = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": "Bearer generic-webhook-secret"},
        json=_event(
            event_id="message:disabled-ingress-1",
            message_id="disabled-ingress-1",
            chat_jid="15551112222@s.whatsapp.net",
            actor_jid="15551112222@s.whatsapp.net",
            text="must not persist",
        ),
    )

    persisted = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(ChannelMessage.account_id == account.id)
            )
        ).scalars()
    )
    assert response.status_code == 401
    assert persisted == []


@pytest.mark.asyncio
async def test_sidecar_ingress_rejects_unsupported_chat_servers(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _links, _tokens = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )
    ingress_token = "strict-jid-ingress-token"
    _configure_sidecar(monkeypatch, account, ingress_token=ingress_token)

    for index, chat_jid in enumerate(
        ["status@broadcast", "12345@newsletter", "15551112222@other.example"]
    ):
        response = await client.post(
            f"/v1/channels/whatsapp/{account.id}/sidecar/events",
            headers={"Authorization": f"Bearer {ingress_token}"},
            json=_event(
                event_id=f"message:invalid-jid-{index}",
                message_id=f"invalid-jid-{index}",
                chat_jid=chat_jid,
                actor_jid=chat_jid,
                text="must not persist",
            ),
        )
        assert response.status_code == 422

    persisted = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(ChannelMessage.account_id == account.id)
            )
        ).scalars()
    )
    assert persisted == []


@pytest.mark.asyncio
async def test_sidecar_ingress_rejects_cross_link_jid_alias_conflict_without_persistence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    second_channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, links, _tokens = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent, second_channel_agent),
    )
    phone_jid = "15551112222@s.whatsapp.net"
    lid_jid = "7826185388106@lid"
    db_session.add_all(
        [
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=links[0].id,
                user_id=seed_user.id,
                external_chat_id=phone_jid,
                external_chat_type="private",
            ),
            ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=links[1].id,
                user_id=seed_user.id,
                external_chat_id=lid_jid,
                external_chat_type="private",
            ),
        ]
    )
    await db_session.commit()
    ingress_token = "alias-conflict-ingress-token"
    _configure_sidecar(monkeypatch, account, ingress_token=ingress_token)

    response = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": f"Bearer {ingress_token}"},
        json=_event(
            event_id="message:alias-conflict-1",
            message_id="alias-conflict-1",
            chat_jid=phone_jid,
            chat_jid_alt=lid_jid,
            actor_jid=phone_jid,
            text="must retry",
        ),
    )

    persisted = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(ChannelMessage.account_id == account.id)
            )
        ).scalars()
    )
    assert response.status_code == 409
    assert persisted == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reply_fails", [False, True])
async def test_sidecar_pairing_binds_group_jid_to_participant_actor(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
    reply_fails: bool,
):
    account, links, _tokens = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )
    raw_code = "PAIRSIDECARRUNTIME123"
    db_session.add(
        ChannelPairCode(
            account_id=account.id,
            bot_agent_link_id=links[0].id,
            user_id=seed_user.id,
            code_hash=hash_token(raw_code),
            expires_at=datetime.now(UTC) + timedelta(minutes=15),
        )
    )
    await db_session.commit()
    ingress_token = "pairing-sidecar-token"
    _configure_sidecar(monkeypatch, account, ingress_token=ingress_token)
    group_jid = "120363000000000099@g.us"
    actor_jid = "15551119999@s.whatsapp.net"
    fake_sidecar = _FakeSidecar(fail=reply_fails)
    monkeypatch.setattr(
        "app.routes.channel_routers.whatsapp_sidecar.get_configured_whatsapp_sidecar_client",
        lambda account_id: fake_sidecar if account_id == account.id else None,
    )

    response = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": f"Bearer {ingress_token}"},
        json=_event(
            event_id="message:pair-group-1",
            message_id="pair-group-1",
            chat_jid=group_jid,
            actor_jid=actor_jid,
            text=f"/bot_pair {raw_code}",
        ),
    )

    binding = (
        await db_session.execute(
            select(ChannelBinding).where(ChannelBinding.account_id == account.id)
        )
    ).scalar_one()
    assert response.status_code == 200, response.text
    assert response.json()["paired"] is True
    assert binding.external_chat_id == group_jid
    assert binding.paired_external_user_id == actor_jid
    assert binding.external_chat_name is None
    assert fake_sidecar.requests == [
        WhatsAppSidecarSendRequest(
            jid=group_jid,
            text="Paired! This chat is now connected to your agent.",
            message_id=_pairing_reply_message_id(account.id, "pair-group-1"),
            reply_to_message_id="pair-group-1",
            reply_to_participant_jid=actor_jid,
        )
    ]


@pytest.mark.asyncio
async def test_sidecar_group_unpair_reply_uses_current_event_participant(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, links, _tokens = await _seed_account(
        db_session,
        user=seed_user,
        agents=(channel_agent,),
    )
    group_jid = "120363000000000077@g.us"
    current_actor_jid = "15551117777@s.whatsapp.net"
    db_session.add(
        ChannelBinding(
            account_id=account.id,
            bot_agent_link_id=links[0].id,
            user_id=seed_user.id,
            external_chat_id=group_jid,
            external_chat_type="group",
            paired_external_user_id=current_actor_jid,
        )
    )
    await db_session.commit()
    ingress_token = "unpair-sidecar-token"
    _configure_sidecar(monkeypatch, account, ingress_token=ingress_token)
    fake_sidecar = _FakeSidecar()
    monkeypatch.setattr(
        "app.routes.channel_routers.whatsapp_sidecar.get_configured_whatsapp_sidecar_client",
        lambda account_id: fake_sidecar if account_id == account.id else None,
    )

    response = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": f"Bearer {ingress_token}"},
        json=_event(
            event_id="message:unpair-group-1",
            message_id="unpair-group-1",
            chat_jid=group_jid,
            actor_jid=current_actor_jid,
            text="/bot_unpair",
        ),
    )

    assert response.status_code == 200, response.text
    assert response.json()["unpaired"] is True
    assert fake_sidecar.requests == [
        WhatsAppSidecarSendRequest(
            jid=group_jid,
            text="Unpaired. This chat is no longer connected to an agent.",
            message_id=_pairing_reply_message_id(account.id, "unpair-group-1"),
            reply_to_message_id="unpair-group-1",
            reply_to_participant_jid=current_actor_jid,
        )
    ]
