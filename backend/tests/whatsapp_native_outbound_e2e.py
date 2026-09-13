"""Required PostgreSQL stage of scripts/test-managed-whatsapp-native-e2e.sh.

The stock consumers supply fresh Noise-decoded envelopes, not hand-built proto.
This file is selected explicitly by that CI entrypoint after both consumers pass.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.channel import MESSAGE_DIRECTION_OUTBOUND, ChannelDelivery, ChannelMessage
from app.services.whatsapp_baileys import remember_whatsapp_binding_aliases
from app.services.whatsapp_provider_bridge import (
    WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
    WhatsAppProviderBridge,
    _outbound_from_provider_payload,
)
from tests.test_whatsapp_provider_bridge import _seed_whatsapp_link_and_binding

pytestmark = [pytest.mark.asyncio, pytest.mark.committed_db]


@pytest.mark.parametrize("runtime", ["openclaw", "hermes"])
async def test_native_consumer_envelopes_reach_idempotent_outbox(
    runtime,
    request,
    client,
    db_session,
    channel_agent,
):
    capture_arg = request.config.getoption("--whatsapp-native-captures")
    assert capture_arg, "Run scripts/test-managed-whatsapp-native-e2e.sh"
    capture_dir = Path(capture_arg).resolve()
    assert capture_dir.is_relative_to(Path(__file__).resolve().parents[2])
    capture_file = capture_dir / f"{runtime}.json"
    assert capture_file.stat().st_size <= 2 * 1024 * 1024
    captured = json.loads(capture_file.read_text())
    assert captured["runtime"] == runtime
    envelopes = captured["outboundMessages"]
    assert 4 <= len(envelopes) <= 32
    assert any(envelope["additionalNodes"] for envelope in envelopes)
    if runtime == "hermes":
        assert any(envelope["attrs"].get("edit") == "1" for envelope in envelopes)
    account, link, binding = await _seed_whatsapp_link_and_binding(
        client,
        db_session,
        channel_agent,
        name=f"native-{runtime}-outbox",
        external_chat_id=captured["chatJid"],
    )
    await remember_whatsapp_binding_aliases(
        db_session,
        binding=binding,
        remote_jid=captured["chatJid"],
        alt_jid=captured["chatLid"],
    )
    await db_session.commit()
    sessions = async_sessionmaker(db_session.bind, expire_on_commit=False)
    accepted_ids = set()
    for envelope in envelopes:
        message = _outbound_from_provider_payload(
            external_chat_id=envelope["toJid"],
            text=envelope["conversation"] or "",
            provider_payload={
                "schemaVersion": WHATSAPP_PROVIDER_PAYLOAD_SCHEMA,
                **{
                    key: envelope[key]
                    for key in (
                        "messageId",
                        "messageProtoBase64",
                        "encType",
                        "attrs",
                        "additionalNodes",
                    )
                },
            },
        )
        bridge = WhatsAppProviderBridge(sessions, account_id=account.id)
        accepted = await bridge.store_outbound_message(message, bot_agent_link_id=link.id)
        accepted_ids.add(accepted.channel_message_id)
        replayed = await WhatsAppProviderBridge(
            sessions, account_id=account.id
        ).store_outbound_message(
            replace(
                message,
                enc_type="pkmsg",
                attrs={
                    **message.attrs,
                    "from": "900000000000001:2@lid",
                    "recipient": captured["chatJid"],
                    "participant": "184207372460253:2@lid",
                },
            ),
            bot_agent_link_id=link.id,
        )
        assert replayed.delivery_id == accepted.delivery_id
        assert replayed.channel_message_id == accepted.channel_message_id
        for changed in (
            replace(message, attrs={**message.attrs, "edit": "8"}),
            replace(
                message,
                additional_nodes=()
                if message.additional_nodes
                else ({"tag": "meta", "attrs": {"polltype": "creation"}},),
            ),
        ):
            with pytest.raises(HTTPException) as conflict:
                await bridge.store_outbound_message(changed, bot_agent_link_id=link.id)
            assert conflict.value.status_code == 409
    expected_messages = len({envelope["messageId"] for envelope in envelopes})
    assert len(accepted_ids) == expected_messages
    assert (
        await db_session.scalar(
            select(func.count(ChannelMessage.id)).where(
                ChannelMessage.account_id == account.id,
                ChannelMessage.direction == MESSAGE_DIRECTION_OUTBOUND,
            )
        )
        == expected_messages
    )
    assert (
        await db_session.scalar(
            select(func.count(ChannelDelivery.id)).where(ChannelDelivery.account_id == account.id)
        )
        == expected_messages
    )
