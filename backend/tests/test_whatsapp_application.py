from __future__ import annotations

import asyncio
import hashlib
import json
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.config import settings
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    DELIVERY_STATUS_SUCCEEDED,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelMessage,
    ChannelSecret,
)
from app.models.session import AgentEnvironment
from app.models.user import User
from app.routes.channel_routers.public import _runtime_account_response
from app.routes.channel_routers.whatsapp_application import whatsapp_application_operation
from app.schemas.whatsapp_application import WhatsAppApplicationOperation
from app.services.channels import (
    HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS,
    archive_channel_account,
    bot_agent_link_has_provider_cardinality_capability,
    deliver_channel_delivery,
    enqueue_channel_outbound_message,
    hash_token,
    store_agent_link_token,
    upsert_channel_secrets,
)
from app.services.whatsapp_callback import WHATSAPP_SIDECAR_INGRESS_SECRET_NAME
from app.services.whatsapp_sidecar_client import (
    WhatsAppOperationStatus,
    WhatsAppSidecarCapabilities,
    WhatsAppSidecarConfig,
    WhatsAppSidecarHealth,
    WhatsAppSidecarMedia,
    WhatsAppSidecarOperationResult,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarRejectedError,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_sidecar_registry import ConfiguredWhatsAppSidecarRegistry

pytestmark = pytest.mark.committed_db
MEDIA_ID = f"media_{'a' * 43}"


class _FakeSidecar:
    def __init__(
        self,
        config: WhatsAppSidecarConfig | None = None,
        *,
        fail_operations: int = 0,
        reject_operations: bool = False,
        rejection_code: str = "operation_denied",
        fail_logout: bool = False,
        fail_pairing_status: bool = False,
        registered: bool = True,
        operation_status: WhatsAppOperationStatus = "completed",
        operation_error: str | None = None,
        supported_operations: frozenset[str] | None = None,
    ) -> None:
        self.config = config
        self.connected = True
        self.fail_operations = fail_operations
        self.reject_operations = reject_operations
        self.rejection_code = rejection_code
        self.fail_logout = fail_logout
        self.fail_pairing_status = fail_pairing_status
        self.registered = registered
        self.operation_status = operation_status
        self.operation_error = operation_error
        self.supported_operations = supported_operations or frozenset(
            {"send", "edit", "delete", "reaction", "presence", "read"}
        )
        self.operations: list[dict[str, object]] = []
        self.actions: list[str] = []
        self.media_requests: list[str] = []
        self.closed = False
        self._block_next_operation = False
        self.operation_started = asyncio.Event()
        self.operation_release = asyncio.Event()

    def block_next_operation(self) -> None:
        self._block_next_operation = True
        self.operation_started = asyncio.Event()
        self.operation_release = asyncio.Event()

    async def health(self):
        return WhatsAppSidecarHealth(
            status="connected" if self.registered else "stopped",
            connected=self.registered,
            registered=self.registered,
            uptime_seconds=1,
            callback_enabled=True,
            pending_callback_events=0,
            version_recovery_required=False,
        )

    async def capabilities(self):
        return WhatsAppSidecarCapabilities(
            operations=self.supported_operations,
            pairing=frozenset({"qr", "code", "cancel", "logout", "recover"}),
            media_download=True,
            callback_delivery=True,
            jid_kinds=frozenset({"pn", "lid", "group"}),
            raw_provider_access=False,
        )

    async def execute_operation(self, payload, *, expected_operation_id):
        self.operations.append(dict(payload))
        assert payload["schemaVersion"] == "clawdi.whatsapp.operation.v1"
        assert payload["operationId"] == expected_operation_id
        if self.fail_operations > 0:
            self.fail_operations -= 1
            raise WhatsAppSidecarUnavailableError("sensitive-sidecar-address")
        if self.reject_operations:
            raise WhatsAppSidecarRejectedError(self.rejection_code)
        if self._block_next_operation:
            self._block_next_operation = False
            self.operation_started.set()
            await self.operation_release.wait()
        message_id = (
            payload.get("messageId")
            if payload.get("type") == "send" and self.operation_status == "completed"
            else None
        )
        return WhatsAppSidecarOperationResult(
            operation_id=expected_operation_id,
            status=self.operation_status,
            message_id=message_id if isinstance(message_id, str) else None,
            error_code=self.operation_error,
        )

    async def fetch_media(self, media_id: str, *, max_bytes: int | None = None):
        assert media_id == MEDIA_ID
        if max_bytes is not None:
            assert max_bytes > 0
        self.media_requests.append(media_id)
        return WhatsAppSidecarMedia(
            content=b"fake-media",
            content_type="image/jpeg",
            file_name="photo.jpg",
        )

    async def pairing_status(self):
        self.actions.append("status")
        if self.fail_pairing_status:
            raise WhatsAppSidecarUnavailableError("provider-secret")
        return WhatsAppSidecarPairingStatus(
            status="connected" if self.registered else "stopped",
            registered=self.registered,
        )

    async def pairing_qr(self):
        self.actions.append("qr")
        return WhatsAppSidecarPairingStatus(
            status="pairing_qr",
            registered=False,
            method="qr",
            qr="QR-SECRET",
        )

    async def pairing_code(self, *, phone_number: str):
        assert phone_number == "15550001111"
        self.actions.append("code")
        return WhatsAppSidecarPairingStatus(
            status="pairing_code",
            registered=False,
            method="code",
            code="CODE-SECRET",
        )

    async def pairing_cancel(self):
        self.actions.append("cancel")
        self.registered = False
        return WhatsAppSidecarPairingStatus(status="stopped", registered=False)

    async def pairing_logout(self):
        self.actions.append("logout")
        if self.fail_logout:
            raise WhatsAppSidecarUnavailableError("provider-secret")
        self.registered = False
        return WhatsAppSidecarPairingStatus(status="stopped", registered=False)

    async def recover(
        self,
        *,
        accept_version_change: bool,
        reset_logged_out: bool = False,
    ):
        self.actions.append(f"recover:{int(accept_version_change)}:{int(reset_logged_out)}")

    async def close(self):
        self.closed = True


async def _seed_authority(
    db: AsyncSession,
    *,
    user: User,
    agent: AgentEnvironment,
    chat_jid: str = "15551112222@s.whatsapp.net",
    chat_type: str = "private",
    paired_actor: str | None = "15551112222@s.whatsapp.net",
    account: ChannelAccount | None = None,
    token: str | None = None,
) -> tuple[ChannelAccount, ChannelBotAgentLink, ChannelBinding, str]:
    if account is None:
        account = ChannelAccount(
            user_id=user.id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            name=f"whatsapp-{uuid4().hex[:12]}",
            webhook_secret_hash=hash_token("unused-webhook-secret"),
            config={"sidecar_linking_enabled": True},
        )
        db.add(account)
        await db.flush()
        await upsert_channel_secrets(
            db,
            account=account,
            secrets_by_name={WHATSAPP_SIDECAR_INGRESS_SECRET_NAME: "ingress-secret"},
        )
    raw_token = token or f"wa_test_{uuid4().hex}"
    link = ChannelBotAgentLink(
        account_id=account.id,
        user_id=user.id,
        agent_id=agent.id,
    )
    store_agent_link_token(link, raw_token)
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
    return account, link, binding, raw_token


def _event(
    account_id: UUID,
    *,
    message_id: str,
    chat_primary: str = "15551112222@s.whatsapp.net",
    chat_alt: str | None = "777000111222@lid",
    actor_primary: str = "15551112222@s.whatsapp.net",
    actor_alt: str | None = "777000111222@lid",
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
        "fromMe": False,
        "ownership": "peer",
        "timestamp": 1_700_000_000,
        "pushName": "Participant",
        "content": content or {"type": "text", "text": "hello"},
    }
    event["providerEventId"] = _provider_event_id(event)
    return event


def _install_fake_sidecar(monkeypatch: pytest.MonkeyPatch, fake: _FakeSidecar) -> None:
    monkeypatch.setattr(
        "app.routes.channel_routers.whatsapp_application.get_configured_whatsapp_sidecar_client",
        lambda _account_id: fake,
    )
    monkeypatch.setattr(
        "app.services.whatsapp_application.get_configured_whatsapp_sidecar_client",
        lambda _account_id: fake,
    )


@pytest.mark.asyncio
async def test_application_inbox_redelivery_single_ack_and_link_isolation(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    second_channel_agent: AgentEnvironment,
):
    account, _link_a, binding_a, token_a = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    _account, _link_b, binding_b, token_b = await _seed_authority(
        db_session,
        user=seed_user,
        agent=second_channel_agent,
        account=account,
        chat_jid="120363000000000002@g.us",
        chat_type="group",
        paired_actor="15553334444@s.whatsapp.net",
    )
    callback_url = f"/v1/channels/whatsapp/{account.id}/sidecar/events"
    assert (
        await client.post(
            callback_url,
            headers={"Authorization": "Bearer ingress-secret"},
            json=_event(account.id, message_id="message-link-a"),
        )
    ).status_code == 200
    assert (
        await client.post(
            callback_url,
            headers={"Authorization": "Bearer ingress-secret"},
            json=_event(
                account.id,
                message_id="message-link-b",
                chat_primary=binding_b.external_chat_id,
                chat_alt=None,
                actor_primary="15553334444@s.whatsapp.net",
                actor_alt="999000111222@lid",
            ),
        )
    ).status_code == 200

    inbox_url = f"/v1/channels/whatsapp/application/{account.id}/inbox"
    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}
    first = await client.get(
        inbox_url,
        params={"wait_seconds": 0, "limit": 50},
        headers=headers_a,
    )
    restarted = await client.get(inbox_url, headers=headers_a)
    restarted_with_cursor = await client.get(
        inbox_url,
        params={"cursor": first.json()["cursor"]},
        headers=headers_a,
    )
    explicitly_advanced = await client.get(
        inbox_url,
        params={"cursor": str(int(first.json()["cursor"]) + 1)},
        headers=headers_a,
    )
    other = await client.get(inbox_url, headers=headers_b)

    assert first.status_code == 200, first.text
    assert restarted.json() == first.json()
    assert restarted_with_cursor.json() == first.json()
    assert explicitly_advanced.json()["events"] == []
    assert len(first.json()["events"]) == 1
    event = first.json()["events"][0]
    assert set(event) == {"id", "binding", "chat", "sender", "message"}
    assert event["binding"] == {"id": str(binding_a.id)}
    assert event["chat"] == {
        "id": str(binding_a.id),
        "type": "direct",
        "name": "Participant",
    }
    assert "@" not in event["sender"]["id"]
    assert event["message"] == {
        "id": "message-link-a",
        "text": "hello",
        "timestamp": 1_700_000_000,
        "replyTo": None,
        "reaction": None,
        "media": [],
    }
    assert first.json()["cursor"].isdecimal()
    assert other.json()["events"][0]["binding"] == {"id": str(binding_b.id)}

    denied_ack = await client.post(
        f"{inbox_url}/{event['id']}/ack",
        headers=headers_b,
        json={},
    )
    acked = await client.post(
        f"{inbox_url}/{event['id']}/ack",
        headers=headers_a,
        json={},
    )
    duplicate_ack = await client.post(
        f"{inbox_url}/{event['id']}/ack",
        headers=headers_a,
        json={},
    )
    assert denied_ack.status_code == 404
    assert acked.json() == {"id": event["id"], "acknowledged": True, "duplicate": False}
    assert duplicate_ack.json()["duplicate"] is True
    assert (await client.get(inbox_url, headers=headers_a)).json()["events"] == []


@pytest.mark.asyncio
async def test_application_operations_use_flat_contract_hash_and_binding_authority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    fake = _FakeSidecar()
    _install_fake_sidecar(monkeypatch, fake)
    capabilities = await client.get(
        f"/v1/channels/whatsapp/application/{account.id}/capabilities",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert capabilities.status_code == 200
    assert capabilities.json() == {
        "operations": [
            "send_text",
            "send_media",
            "reaction",
            "typing",
            "edit_message",
            "delete_message",
            "mark_read",
        ],
        "typingStates": ["composing", "recording", "paused"],
        "maxInboxLimit": 100,
        "maxLongPollSeconds": 30,
        "maxMediaBytes": 8 * 1024 * 1024,
    }
    callback_url = f"/v1/channels/whatsapp/{account.id}/sidecar/events"
    headers = {"Authorization": f"Bearer {token}"}
    ingress_headers = {"Authorization": "Bearer ingress-secret"}
    assert (
        await client.post(
            callback_url,
            headers=ingress_headers,
            json=_event(account.id, message_id="inbound-1"),
        )
    ).status_code == 200
    assert (
        await client.post(
            callback_url,
            headers=ingress_headers,
            json=_event(
                account.id,
                message_id="media-1",
                content={
                    "type": "media",
                    "mediaId": MEDIA_ID,
                    "mediaType": "audio",
                    "mimeType": "audio/ogg",
                    "fileName": "voice.ogg",
                },
            ),
        )
    ).status_code == 200
    media_message = (
        await db_session.execute(
            select(ChannelMessage).where(
                ChannelMessage.account_id == account.id,
                ChannelMessage.provider_message_id == "media-1",
            )
        )
    ).scalar_one()
    media_payload = dict(media_message.payload)
    media_content = dict(media_payload["content"])
    media_content["ptt"] = True
    media_payload["content"] = media_content
    media_message.payload = media_payload
    await db_session.commit()
    target = {
        "bindingId": str(binding.id),
        "chatId": str(binding.id),
        "chatType": "direct",
    }
    operation_url = f"/v1/channels/whatsapp/application/{account.id}/operations"
    send = {
        "operationId": "send-op-1",
        "type": "send_text",
        "target": target,
        "text": "reply",
        "replyTo": "inbound-1",
    }

    sent = await client.post(operation_url, headers=headers, json=send)
    replay = await client.post(operation_url, headers=headers, json=send)
    conflict = await client.post(
        operation_url,
        headers=headers,
        json={**send, "text": "different body"},
    )
    wrong_chat = await client.post(
        operation_url,
        headers=headers,
        json={
            **send,
            "operationId": "send-op-wrong-chat",
            "target": {**target, "chatId": str(uuid4())},
        },
    )
    typing = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "typing-op-1",
            "type": "typing",
            "target": target,
            "state": "recording",
        },
    )
    denied_global_presence = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "typing-global",
            "type": "typing",
            "target": target,
            "state": "available",
        },
    )
    denied_edit = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "edit-inbound",
            "type": "edit_message",
            "target": target,
            "messageId": "inbound-1",
            "text": "not owned",
        },
    )

    assert sent.status_code == 200, sent.text
    assert sent.json()["messageId"] is not None
    assert replay.status_code == 200
    assert replay.json()["duplicate"] is True
    assert conflict.status_code == 409
    assert wrong_chat.status_code == 409
    assert typing.status_code == 200
    assert typing.json()["messageId"] is None
    assert denied_global_presence.status_code == 422
    assert denied_edit.status_code == 404
    assert len(fake.operations) == 2
    sent_payload = fake.operations[0]
    assert sent_payload["schemaVersion"] == "clawdi.whatsapp.operation.v1"
    assert sent_payload["chatJid"] == binding.external_chat_id
    assert sent_payload["type"] == "send"
    assert sent_payload["content"] == {"type": "text", "text": "reply"}
    assert sent_payload["replyTo"] == {"messageId": "inbound-1", "fromMe": False}
    assert "accountId" not in sent_payload
    assert "operation" not in sent_payload
    assert fake.operations[1]["type"] == "presence"
    assert fake.operations[1]["presence"] == "recording"

    sent_message_id = sent.json()["messageId"]
    edit = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "edit-owned",
            "type": "edit_message",
            "target": target,
            "messageId": sent_message_id,
            "text": "edited",
        },
    )
    delete = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "delete-owned",
            "type": "delete_message",
            "target": target,
            "messageId": sent_message_id,
        },
    )
    denied_read_outbound = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "read-outbound",
            "type": "mark_read",
            "target": target,
            "messageId": sent_message_id,
        },
    )
    assert edit.status_code == 200, edit.text
    assert delete.status_code == 200, delete.text
    assert denied_read_outbound.status_code == 404
    assert fake.operations[2]["type"] == "edit"
    assert fake.operations[2]["target"] == {
        "messageId": sent_message_id,
        "fromMe": True,
    }
    assert fake.operations[3]["type"] == "delete"
    assert fake.operations[3]["target"] == {
        "messageId": sent_message_id,
        "fromMe": True,
    }

    inbox = await client.get(
        f"/v1/channels/whatsapp/application/{account.id}/inbox",
        headers=headers,
    )
    media_event = next(item for item in inbox.json()["events"] if item["message"]["media"])
    media_url = media_event["message"]["media"][0]["url"]
    assert media_event["message"]["media"][0]["ptt"] is True
    forwarded = await client.post(
        operation_url,
        headers=headers,
        json={
            "operationId": "send-media-1",
            "type": "send_media",
            "target": target,
            "text": "caption",
            "media": {"relayUrl": media_url},
        },
    )
    assert forwarded.status_code == 200, forwarded.text
    media_payload = fake.operations[-1]
    assert media_payload["type"] == "send"
    assert media_payload["content"] == {
        "type": "media",
        "mediaType": "audio",
        "dataBase64": "ZmFrZS1tZWRpYQ==",
        "mimeType": "audio/ogg",
        "fileName": "voice.ogg",
        "caption": "caption",
        "ptt": True,
    }


@pytest.mark.asyncio
async def test_group_reaction_uses_persisted_actor_without_exposing_actor_jid(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
        chat_jid="120363000000000003@g.us",
        chat_type="group",
        paired_actor="15553334444@s.whatsapp.net",
    )
    fake = _FakeSidecar()
    _install_fake_sidecar(monkeypatch, fake)
    assert (
        await client.post(
            f"/v1/channels/whatsapp/{account.id}/sidecar/events",
            headers={"Authorization": "Bearer ingress-secret"},
            json=_event(
                account.id,
                message_id="group-inbound",
                chat_primary=binding.external_chat_id,
                chat_alt=None,
                actor_primary="15553334444@s.whatsapp.net",
                actor_alt="999000111222@lid",
            ),
        )
    ).status_code == 200
    assert (
        await client.post(
            f"/v1/channels/whatsapp/{account.id}/sidecar/events",
            headers={"Authorization": "Bearer ingress-secret"},
            json=_event(
                account.id,
                message_id="group-inbound-2",
                chat_primary=binding.external_chat_id,
                chat_alt=None,
                actor_primary="15553334444@s.whatsapp.net",
                actor_alt="999000111222@lid",
            ),
        )
    ).status_code == 200
    response = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "operationId": "group-reaction-1",
            "type": "reaction",
            "target": {
                "bindingId": str(binding.id),
                "chatId": str(binding.id),
                "chatType": "group",
            },
            "messageId": "group-inbound",
            "emoji": "👍",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["messageId"] is None
    assert fake.operations[0]["target"] == {
        "messageId": "group-inbound",
        "fromMe": False,
        "participantJid": "15553334444@s.whatsapp.net",
        "participantJidAlt": "999000111222@lid",
    }
    mark_read = {
        "operationId": "group-read-1",
        "type": "mark_read",
        "target": {
            "bindingId": str(binding.id),
            "chatId": str(binding.id),
            "chatType": "group",
        },
        "messageId": "group-inbound",
    }
    no_read_fake = _FakeSidecar(
        supported_operations=frozenset({"send", "edit", "delete", "reaction", "presence"})
    )
    _install_fake_sidecar(monkeypatch, no_read_fake)
    unsupported_read = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json={**mark_read, "operationId": "group-read-unsupported"},
    )
    assert unsupported_read.status_code == 409
    assert no_read_fake.operations == []
    _install_fake_sidecar(monkeypatch, fake)
    read_response = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json=mark_read,
    )
    read_replay = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json=mark_read,
    )
    read_conflict = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json={**mark_read, "messageId": "group-inbound-2"},
    )
    assert read_response.status_code == 200, read_response.text
    assert read_response.json()["messageId"] is None
    assert read_replay.status_code == 200
    assert read_replay.json()["duplicate"] is True
    assert read_conflict.status_code == 409
    assert fake.operations[1] == {
        "schemaVersion": "clawdi.whatsapp.operation.v1",
        "operationId": fake.operations[1]["operationId"],
        "chatJid": binding.external_chat_id,
        "type": "read",
        "messages": [
            {
                "messageId": "group-inbound",
                "fromMe": False,
                "participantJid": "15553334444@s.whatsapp.net",
                "participantJidAlt": "999000111222@lid",
            }
        ],
    }
    assert len(fake.operations) == 2


@pytest.mark.asyncio
async def test_concurrent_operation_id_reuse_is_serialized_before_sidecar_dispatch(
    engine: AsyncEngine,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    fake = _FakeSidecar()
    _install_fake_sidecar(monkeypatch, fake)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    adapter = TypeAdapter(WhatsAppApplicationOperation)
    target = {
        "bindingId": str(binding.id),
        "chatId": str(binding.id),
        "chatType": "direct",
    }

    async def execute(body: dict[str, object]):
        operation = adapter.validate_python(body)
        async with session_factory() as session:
            return await whatsapp_application_operation(
                account.id,
                operation,
                authorization=f"Bearer {token}",
                db=session,
            )

    fake.block_next_operation()
    first_body = {
        "operationId": "concurrent-different",
        "type": "send_text",
        "target": target,
        "text": "first",
    }
    first_task = asyncio.create_task(execute(first_body))
    await asyncio.wait_for(fake.operation_started.wait(), timeout=2)
    conflicting_task = asyncio.create_task(execute({**first_body, "text": "different"}))
    await asyncio.sleep(0.05)
    assert not conflicting_task.done()
    assert len(fake.operations) == 1
    fake.operation_release.set()
    first = await first_task
    with pytest.raises(HTTPException) as conflicting:
        await conflicting_task
    assert first.status == "completed"
    assert conflicting.value.status_code == 409
    assert len(fake.operations) == 1

    fake.block_next_operation()
    same_body = {
        "operationId": "concurrent-same",
        "type": "send_text",
        "target": target,
        "text": "same",
    }
    same_first_task = asyncio.create_task(execute(same_body))
    await asyncio.wait_for(fake.operation_started.wait(), timeout=2)
    same_replay_task = asyncio.create_task(execute(same_body))
    await asyncio.sleep(0.05)
    assert not same_replay_task.done()
    assert len(fake.operations) == 2
    fake.operation_release.set()
    same_first, same_replay = await asyncio.gather(same_first_task, same_replay_task)
    assert same_first.status == "completed"
    assert same_replay.status == "completed"
    assert same_replay.duplicate is True
    assert len(fake.operations) == 2


@pytest.mark.asyncio
async def test_failed_and_ambiguous_operations_are_durable_non_successes(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    callback = await client.post(
        f"/v1/channels/whatsapp/{account.id}/sidecar/events",
        headers={"Authorization": "Bearer ingress-secret"},
        json=_event(account.id, message_id="readable-inbound"),
    )
    assert callback.status_code == 200
    url = f"/v1/channels/whatsapp/application/{account.id}/operations"
    headers = {"Authorization": f"Bearer {token}"}
    target = {
        "bindingId": str(binding.id),
        "chatId": str(binding.id),
        "chatType": "direct",
    }

    failed_fake = _FakeSidecar(operation_status="failed", operation_error="send_failed")
    _install_fake_sidecar(monkeypatch, failed_fake)
    failed_body = {
        "operationId": "failed-send",
        "type": "send_text",
        "target": target,
        "text": "not sent",
    }
    failed = await client.post(url, headers=headers, json=failed_body)
    failed_replay = await client.post(url, headers=headers, json=failed_body)
    assert failed.status_code == 422
    assert failed_replay.status_code == 422
    assert failed.json()["detail"]["status"] == "failed"
    assert len(failed_fake.operations) == 1

    typing_fake = _FakeSidecar(
        operation_status="ambiguous",
        operation_error="provider_outcome_unknown",
    )
    _install_fake_sidecar(monkeypatch, typing_fake)
    typing_body = {
        "operationId": "ambiguous-typing",
        "type": "typing",
        "target": target,
        "active": True,
    }
    typing = await client.post(url, headers=headers, json=typing_body)
    typing_replay = await client.post(url, headers=headers, json=typing_body)
    assert typing.status_code == 409
    assert typing_replay.status_code == 409
    assert typing.json()["detail"]["status"] == "ambiguous"
    assert len(typing_fake.operations) == 1
    assert "messageId" not in typing.json()["detail"]

    read_fake = _FakeSidecar(
        operation_status="ambiguous",
        operation_error="provider_outcome_unknown",
    )
    _install_fake_sidecar(monkeypatch, read_fake)
    read_body = {
        "operationId": "ambiguous-read",
        "type": "mark_read",
        "target": target,
        "messageId": "readable-inbound",
    }
    read = await client.post(url, headers=headers, json=read_body)
    read_replay = await client.post(url, headers=headers, json=read_body)
    assert read.status_code == 409
    assert read_replay.status_code == 409
    assert read_fake.operations[0]["type"] == "read"
    assert "messageId" not in read_fake.operations[0]
    assert len(read_fake.operations) == 1

    conflict_fake = _FakeSidecar(
        reject_operations=True,
        rejection_code="operation_id_conflict",
    )
    _install_fake_sidecar(monkeypatch, conflict_fake)
    sidecar_conflict = await client.post(
        url,
        headers=headers,
        json={
            "operationId": "sidecar-conflict",
            "type": "typing",
            "target": target,
            "active": False,
        },
    )
    assert sidecar_conflict.status_code == 409

    durable_operations = list(
        (
            await db_session.execute(
                select(ChannelMessage).where(
                    ChannelMessage.account_id == account.id,
                    ChannelMessage.direction == "outbound",
                )
            )
        ).scalars()
    )
    recorded_ids = {
        message.payload["whatsappOperation"]["operationId"]
        for message in durable_operations
        if isinstance(message.payload, dict)
        and isinstance(message.payload.get("whatsappOperation"), dict)
    }
    assert {"failed-send", "ambiguous-typing", "ambiguous-read"} <= recorded_ids


@pytest.mark.asyncio
async def test_application_media_is_link_scoped_and_never_redirects(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    second_channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, _binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    _account, _other_link, other_binding, other_token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=second_channel_agent,
        account=account,
        chat_jid="15552223333@s.whatsapp.net",
        paired_actor="15552223333@s.whatsapp.net",
    )
    fake = _FakeSidecar()
    _install_fake_sidecar(monkeypatch, fake)
    assert (
        await client.post(
            f"/v1/channels/whatsapp/{account.id}/sidecar/events",
            headers={"Authorization": "Bearer ingress-secret"},
            json=_event(
                account.id,
                message_id="other-media",
                chat_primary=other_binding.external_chat_id,
                chat_alt=None,
                actor_primary=other_binding.external_chat_id,
                actor_alt=None,
                content={
                    "type": "media",
                    "mediaId": MEDIA_ID,
                    "mediaType": "image",
                    "mimeType": "image/jpeg",
                },
            ),
        )
    ).status_code == 200
    media_url = f"/v1/channels/whatsapp/application/{account.id}/media/{MEDIA_ID}"
    denied = await client.get(media_url, headers={"Authorization": f"Bearer {token}"})
    accepted = await client.get(media_url, headers={"Authorization": f"Bearer {other_token}"})

    assert denied.status_code == 404
    assert accepted.status_code == 200
    assert accepted.content == b"fake-media"
    assert accepted.headers["cache-control"] == "no-store"
    assert accepted.headers["x-content-type-options"] == "nosniff"
    assert "location" not in accepted.headers


@pytest.mark.asyncio
async def test_whatsapp_delivery_retries_with_stable_flat_operation_ids(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    message, delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id=binding.external_chat_id,
        text="delivery text",
        bot_agent_link_id=binding.bot_agent_link_id,
    )
    delivery.status = DELIVERY_STATUS_IN_PROGRESS
    delivery.attempts = 1
    fake = _FakeSidecar(fail_operations=1)
    _install_fake_sidecar(monkeypatch, fake)

    await deliver_channel_delivery(db_session, delivery=delivery)
    assert delivery.status == DELIVERY_STATUS_PENDING
    assert delivery.last_error == "WhatsApp sidecar is unavailable"
    delivery.status = DELIVERY_STATUS_IN_PROGRESS
    delivery.attempts += 1
    await deliver_channel_delivery(db_session, delivery=delivery)

    assert delivery.status == DELIVERY_STATUS_SUCCEEDED
    assert len(fake.operations) == 2
    assert fake.operations[0] == fake.operations[1]
    operation = fake.operations[0]
    assert operation["schemaVersion"] == "clawdi.whatsapp.operation.v1"
    assert operation["chatJid"] == binding.external_chat_id
    assert operation["type"] == "send"
    assert operation["content"] == {"type": "text", "text": "delivery text"}
    assert "accountId" not in operation
    assert "operation" not in operation
    assert message.provider_message_id == operation["messageId"]
    assert delivery.provider_response is not None
    assert "secret" not in json.dumps(delivery.provider_response).lower()

    edited = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "operationId": "edit-delivery",
            "type": "edit_message",
            "target": {
                "bindingId": str(binding.id),
                "chatId": str(binding.id),
                "chatType": "direct",
            },
            "messageId": message.provider_message_id,
            "text": "edited delivery",
        },
    )
    assert edited.status_code == 200, edited.text
    assert fake.operations[2]["type"] == "edit"
    assert fake.operations[2]["target"] == {
        "messageId": message.provider_message_id,
        "fromMe": True,
    }

    ambiguous_message, ambiguous_delivery = await enqueue_channel_outbound_message(
        db_session,
        account=account,
        external_chat_id=binding.external_chat_id,
        text="ambiguous delivery",
        bot_agent_link_id=binding.bot_agent_link_id,
    )
    ambiguous_delivery.status = DELIVERY_STATUS_IN_PROGRESS
    ambiguous_delivery.attempts = 1
    ambiguous_fake = _FakeSidecar(
        operation_status="ambiguous",
        operation_error="provider_outcome_unknown",
    )
    _install_fake_sidecar(monkeypatch, ambiguous_fake)
    await deliver_channel_delivery(db_session, delivery=ambiguous_delivery)
    assert ambiguous_delivery.status == DELIVERY_STATUS_FAILED
    assert ambiguous_message.provider_message_id is None


@pytest.mark.asyncio
async def test_archive_requires_confirmed_logout_before_scrubbing_authority(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    missing_account, missing_link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    with pytest.raises(HTTPException) as missing_raised:
        await archive_channel_account(db_session, account=missing_account)
    assert missing_raised.value.status_code == 503
    assert missing_account.status == CHANNEL_STATUS_ACTIVE
    assert missing_account.archived_at is None
    assert missing_link.agent_token_hash is not None
    assert (
        await db_session.execute(
            select(ChannelSecret).where(ChannelSecret.account_id == missing_account.id)
        )
    ).scalar_one_or_none() is not None

    account, link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    fake: _FakeSidecar | None = None

    def factory(config: WhatsAppSidecarConfig):
        nonlocal fake
        fake = _FakeSidecar(config)
        return fake

    registry = ConfiguredWhatsAppSidecarRegistry(
        _registry_config(account.id),
        client_factory=factory,
    )
    await registry.start()
    assert fake is not None
    runtime = await _runtime_account_response(db_session, account, link)
    assert runtime.runtime_credentials == []
    await archive_channel_account(db_session, account=account)
    await db_session.commit()
    assert fake.actions == ["status", "logout"]
    assert account.archived_at is not None
    await registry.stop()

    failed_account, failed_link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    failed_fake: _FakeSidecar | None = None

    def failed_factory(config: WhatsAppSidecarConfig):
        nonlocal failed_fake
        failed_fake = _FakeSidecar(config, fail_logout=True)
        return failed_fake

    failed_registry = ConfiguredWhatsAppSidecarRegistry(
        _registry_config(failed_account.id),
        client_factory=failed_factory,
    )
    await failed_registry.start()
    with pytest.raises(HTTPException) as raised:
        await archive_channel_account(db_session, account=failed_account)
    assert raised.value.status_code == 503
    assert failed_account.status == CHANNEL_STATUS_ACTIVE
    assert failed_account.archived_at is None
    assert failed_link.agent_token_hash is not None
    assert (
        await db_session.execute(
            select(ChannelSecret).where(ChannelSecret.account_id == failed_account.id)
        )
    ).scalar_one_or_none() is not None
    assert failed_fake is not None
    assert failed_fake.actions == ["status", "logout"]
    await failed_registry.stop()

    status_account, status_link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    status_fake: _FakeSidecar | None = None

    def status_factory(config: WhatsAppSidecarConfig):
        nonlocal status_fake
        status_fake = _FakeSidecar(config, fail_pairing_status=True)
        return status_fake

    status_registry = ConfiguredWhatsAppSidecarRegistry(
        _registry_config(status_account.id),
        client_factory=status_factory,
    )
    await status_registry.start()
    with pytest.raises(HTTPException) as status_raised:
        await archive_channel_account(db_session, account=status_account)
    assert status_raised.value.status_code == 503
    assert status_account.status == CHANNEL_STATUS_ACTIVE
    assert status_account.archived_at is None
    assert status_link.agent_token_hash is not None
    assert status_fake is not None
    assert status_fake.actions == ["status"]
    assert not {"start", "stop"}.intersection(status_fake.actions)
    await status_registry.stop()

    safe_account, _safe_link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    safe_fake: _FakeSidecar | None = None

    def safe_factory(config: WhatsAppSidecarConfig):
        nonlocal safe_fake
        safe_fake = _FakeSidecar(config, registered=False)
        return safe_fake

    safe_registry = ConfiguredWhatsAppSidecarRegistry(
        _registry_config(safe_account.id),
        client_factory=safe_factory,
    )
    await safe_registry.start()
    await archive_channel_account(db_session, account=safe_account)
    assert safe_fake is not None
    assert safe_fake.actions == ["status"]
    assert safe_account.archived_at is not None
    await safe_registry.stop()


@pytest.mark.asyncio
async def test_lifecycle_gate_has_no_start_facade_and_sidecar_errors_are_redacted(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    fake = _FakeSidecar(reject_operations=True)
    _install_fake_sidecar(monkeypatch, fake)
    monkeypatch.setattr(settings, "channel_whatsapp_linking_enabled", False)
    rejected = await client.post(
        f"/v1/channels/whatsapp/application/{account.id}/operations",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "operationId": "typing-op-rejected",
            "type": "typing",
            "target": {
                "bindingId": str(binding.id),
                "chatId": str(binding.id),
                "chatType": "direct",
            },
            "active": True,
        },
    )
    gated = await client.post(f"/v1/channels/whatsapp/{account.id}/sidecar/pairing/qr")
    no_start = await client.post(f"/v1/channels/whatsapp/{account.id}/sidecar/start")

    assert rejected.status_code == 422
    assert rejected.json()["detail"].endswith("operation_denied")
    assert "internal-api-token" not in rejected.text
    assert gated.status_code == 409
    assert no_start.status_code == 404
    assert fake.actions == []


@pytest.mark.asyncio
async def test_pairing_secrets_are_no_store_and_recovery_reset_is_explicit(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
    monkeypatch: pytest.MonkeyPatch,
):
    account, _link, _binding, token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    fake = _FakeSidecar()
    _install_fake_sidecar(monkeypatch, fake)
    monkeypatch.setattr(settings, "channel_whatsapp_linking_enabled", True)
    base = f"/v1/channels/whatsapp/{account.id}/sidecar"

    pairing_status = await client.get(f"{base}/pairing/status")
    qr = await client.post(f"{base}/pairing/qr")
    code = await client.post(
        f"{base}/pairing/code",
        json={"phoneNumber": "15550001111"},
    )
    cancelled = await client.post(f"{base}/pairing/cancel")
    logged_out = await client.post(f"{base}/pairing/logout")
    default_recovery = await client.post(
        f"{base}/recover",
        json={"acceptVersionChange": True},
    )
    logged_out_recovery = await client.post(
        f"{base}/recover",
        json={"acceptVersionChange": False, "resetLoggedOut": True},
    )
    capabilities = await client.get(
        f"/v1/channels/whatsapp/application/{account.id}/capabilities",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert pairing_status.status_code == 200
    assert qr.status_code == 200
    assert code.status_code == 200
    assert qr.json()["qr"] == "QR-SECRET"
    assert code.json()["code"] == "CODE-SECRET"
    for response in (pairing_status, qr, code, cancelled, logged_out):
        assert response.headers["cache-control"] == "no-store"
    assert default_recovery.status_code == 200
    assert logged_out_recovery.status_code == 200
    assert fake.actions == [
        "status",
        "qr",
        "code",
        "cancel",
        "logout",
        "recover:1:0",
        "recover:0:1",
    ]
    assert capabilities.status_code == 200
    assert "qr" not in capabilities.text.lower()
    assert "code" not in capabilities.text.lower()


@pytest.mark.asyncio
async def test_whatsapp_provider_cardinality_is_single_account(
    db_session: AsyncSession,
    seed_user: User,
    channel_agent: AgentEnvironment,
):
    first, first_link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    second, second_link, _binding, _token = await _seed_authority(
        db_session,
        user=seed_user,
        agent=channel_agent,
    )
    assert CHANNEL_PROVIDER_WHATSAPP in HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS
    assert not await bot_agent_link_has_provider_cardinality_capability(
        db_session,
        account=first,
        link=first_link,
    )
    assert not await bot_agent_link_has_provider_cardinality_capability(
        db_session,
        account=second,
        link=second_link,
    )


def _registry_config(account_id: UUID) -> str:
    return json.dumps(
        {
            str(account_id): {
                "account_id": str(account_id),
                "base_url": "http://sidecar.local",
                "api_token": "deployment-secret",
            }
        }
    )


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
