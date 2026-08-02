from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import (
    APIRouter,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy import select, update

from app.core.config import settings
from app.core.database import async_session_factory
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_INBOUND,
    ChannelMessage,
)
from app.routes.channel_routers.shared import (
    _extract_bearer_token,
    _optional_str,
)
from app.services.channel_debug_events import record_channel_debug_event
from app.services.channels import (
    get_active_channel_account,
    resolve_channel_agent_by_identity,
    resolve_channel_agent_by_token,
)
from app.services.whatsapp_baileys import (
    WhatsAppInboxPump,
    WhatsAppInboxPumpEvent,
    describe_whatsapp_jid_for_log,
    load_or_create_whatsapp_auth_cert,
    resolve_whatsapp_credential_by_identity,
    save_whatsapp_agent_bundle,
    save_whatsapp_group_sender_keys,
    save_whatsapp_signal_senders,
    whatsapp_agent_bundle_from_config,
    whatsapp_agent_bundle_pre_key_count,
    whatsapp_group_sender_keys_from_config,
    whatsapp_message_proto_bytes,
    whatsapp_signal_senders_from_config,
)
from app.services.whatsapp_noise import (
    WhatsAppNoiseEmulatorSession,
    WhatsAppNoiseRuntimeEvent,
    WhatsAppNoiseTenant,
)
from app.services.whatsapp_provider_bridge import (
    WhatsAppProviderBridge,
)

router = APIRouter(prefix="/channels/whatsapp", tags=["channels"])


@router.websocket("/baileys")
async def whatsapp_baileys_managed_websocket(websocket: WebSocket) -> None:
    token = _extract_bearer_token(websocket.headers.get("authorization"))
    if token is None:
        await websocket.close(code=1008)
        return
    async with async_session_factory() as db:
        try:
            agent = await resolve_channel_agent_by_token(
                db,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                token=token,
            )
        except HTTPException:
            await websocket.close(code=1008)
            return
        account_id = agent.account.id
        bot_agent_link_id = agent.link.id
        agent_token_hash = agent.link.agent_token_hash
        if agent_token_hash is None:
            await websocket.close(code=1008)
            return
    await _run_whatsapp_baileys_websocket(
        websocket,
        account_id=account_id,
        bot_agent_link_id=bot_agent_link_id,
        agent_token_hash=agent_token_hash,
    )


async def _run_whatsapp_baileys_websocket(
    websocket: WebSocket,
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    agent_token_hash: str,
) -> None:
    async with async_session_factory() as db:
        try:
            account = await get_active_channel_account(db, account_id=account_id)
        except HTTPException:
            await websocket.close(code=1008)
            return
        if account.provider != CHANNEL_PROVIDER_WHATSAPP:
            await websocket.close(code=1008)
            return
        auth_cert = await load_or_create_whatsapp_auth_cert(db, account=account)
        await db.commit()
        account_user_id = account.user_id

    session_revoked = asyncio.Event()
    session_revocation_lock = asyncio.Lock()

    async def revoke_session() -> None:
        async with session_revocation_lock:
            if session_revoked.is_set():
                return
            session_revoked.set()
            with contextlib.suppress(Exception):
                await websocket.close(code=1008)

    async def require_session_authority() -> None:
        async with async_session_factory() as db:
            try:
                agent = await resolve_channel_agent_by_identity(
                    db,
                    provider=CHANNEL_PROVIDER_WHATSAPP,
                    account_id=account_id,
                    link_id=bot_agent_link_id,
                    agent_token_hash=agent_token_hash,
                )
            except HTTPException:
                await revoke_session()
                raise _WhatsAppSessionAuthorityRevoked from None
            if agent.account.id != account_id or agent.link.id != bot_agent_link_id:
                await revoke_session()
                raise _WhatsAppSessionAuthorityRevoked

    async def resolve_client(identity_public_key: bytes) -> WhatsAppNoiseTenant | None:
        async with async_session_factory() as db:
            credential = await resolve_whatsapp_credential_by_identity(
                db,
                identity_public_key=identity_public_key,
            )
            if (
                credential is None
                or credential.account_id != account_id
                or credential.bot_agent_link_id != bot_agent_link_id
            ):
                return None
            bundle = whatsapp_agent_bundle_from_config(credential.config)
            signal_senders = whatsapp_signal_senders_from_config(credential.config)
            group_sender_keys = whatsapp_group_sender_keys_from_config(credential.config)
            return WhatsAppNoiseTenant(
                tenant_id=str(credential.bot_agent_link_id),
                lid=credential.synthetic_jid,
                pre_key_count=len(bundle.pre_keys)
                if bundle is not None
                else whatsapp_agent_bundle_pre_key_count(credential.config),
                credential_id=str(credential.id),
                bot_agent_link_id=str(credential.bot_agent_link_id),
                bundle=bundle,
                signal_senders=signal_senders,
                group_sender_keys=group_sender_keys,
            )

    async def record_runtime_event(event: WhatsAppNoiseRuntimeEvent) -> None:
        await require_session_authority()
        details = {"runtime": "baileys_websocket", **_whatsapp_runtime_debug_details(event.details)}
        if event.external_chat_id is not None:
            details["jidDescription"] = describe_whatsapp_jid_for_log(event.external_chat_id)
        async with async_session_factory() as db:
            if (
                event.stage == "agent_bundle"
                and event.outcome in {"captured", "updated"}
                and session.bundle is not None
                and session.tenant is not None
                and session.tenant.credential_id is not None
            ):
                try:
                    await save_whatsapp_agent_bundle(
                        db,
                        credential_id=UUID(session.tenant.credential_id),
                        account_id=account_id,
                        bundle=session.bundle,
                    )
                except Exception as exc:  # noqa: BLE001 - debug event recording should survive.
                    details["bundlePersistError"] = exc.__class__.__name__
            if (
                event.stage in {"inbound_message", "outbound_message"}
                and event.outcome in {"pushed", "decoded"}
                and session.tenant is not None
                and session.tenant.credential_id is not None
            ):
                snapshots = session.signal_sender_snapshots()
                if snapshots:
                    try:
                        await save_whatsapp_signal_senders(
                            db,
                            credential_id=UUID(session.tenant.credential_id),
                            account_id=account_id,
                            senders=snapshots,
                        )
                    except Exception as exc:  # noqa: BLE001 - debug event recording should survive.
                        details["signalStatePersistError"] = exc.__class__.__name__
                group_sender_keys = session.group_sender_key_snapshots()
                if group_sender_keys:
                    try:
                        await save_whatsapp_group_sender_keys(
                            db,
                            credential_id=UUID(session.tenant.credential_id),
                            account_id=account_id,
                            group_sender_keys=group_sender_keys,
                        )
                    except Exception as exc:  # noqa: BLE001 - debug event recording should survive.
                        details["groupSignalStatePersistError"] = exc.__class__.__name__
            await record_channel_debug_event(
                db,
                account=account,
                user_id=account_user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction="agent",
                stage=event.stage,
                outcome=event.outcome,
                external_chat_id=event.external_chat_id,
                details=details,
            )
            await db.commit()

    provider_bridge = WhatsAppProviderBridge(
        async_session_factory,
        account_id=account_id,
    )

    async def relay_outbound_message(message) -> None:
        await require_session_authority()
        await provider_bridge.store_outbound_message(
            message,
            bot_agent_link_id=bot_agent_link_id,
        )

    async def relay_outbound_node(node: Any, lookup_inbound_sender: Any) -> None:
        await require_session_authority()
        await provider_bridge.relay_raw_node(
            node,
            lookup_inbound_sender,
            bot_agent_link_id=bot_agent_link_id,
        )

    async def forward_iq(node: Any, tenant_id: str | None) -> Any:
        await require_session_authority()
        return await provider_bridge.forward_iq(
            node,
            tenant_id,
            bot_agent_link_id=bot_agent_link_id,
        )

    session = WhatsAppNoiseEmulatorSession(
        auth_cert=auth_cert,
        lid="0:0@lid",
        resolve_client=resolve_client,
        on_event=record_runtime_event,
        on_outbound_message=relay_outbound_message,
        on_outbound_relay=relay_outbound_node,
        forward_iq=forward_iq,
    )
    send_lock = asyncio.Lock()
    inbox_pump_task: asyncio.Task[None] | None = None

    async def maybe_start_inbox_pump() -> None:
        nonlocal inbox_pump_task
        tenant = session.tenant
        if tenant is None or tenant.tenant_id is None or session.bundle is None:
            return
        if inbox_pump_task is not None and not inbox_pump_task.done():
            return
        inbox_pump_task = asyncio.create_task(
            _run_whatsapp_websocket_inbox_pump(
                account_id=account_id,
                bot_agent_link_id=bot_agent_link_id,
                tenant_id=tenant.tenant_id,
                session=session,
                websocket=websocket,
                send_lock=send_lock,
                require_session_authority=require_session_authority,
            )
        )

    await websocket.accept()
    try:
        while True:
            chunk = await _receive_websocket_bytes_or_revocation(websocket, session_revoked)
            if chunk is None:
                return
            try:
                await require_session_authority()
            except _WhatsAppSessionAuthorityRevoked:
                return
            async with send_lock:
                frames = await session.handle_inbound(chunk)
                for frame in frames:
                    await require_session_authority()
                    await websocket.send_bytes(frame)
            await maybe_start_inbox_pump()
            if session.rejected:
                await websocket.close(code=1008)
                return
    except WebSocketDisconnect:
        return
    except _WhatsAppSessionAuthorityRevoked:
        return
    except Exception as exc:  # noqa: BLE001 - close malformed agent sockets without leaking internals.
        with contextlib.suppress(Exception):
            await record_runtime_event(
                WhatsAppNoiseRuntimeEvent(
                    stage="websocket",
                    outcome="error",
                    details={"errorType": exc.__class__.__name__},
                    tenant_id=session.tenant.tenant_id if session.tenant else None,
                    external_chat_id=session.tenant.lid if session.tenant else None,
                )
            )
        with contextlib.suppress(Exception):
            await websocket.close(code=1011)
        return
    finally:
        if inbox_pump_task is not None:
            inbox_pump_task.cancel()
            with contextlib.suppress(
                asyncio.CancelledError,
                _WhatsAppSessionAuthorityRevoked,
            ):
                await inbox_pump_task


class _WhatsAppSessionAuthorityRevoked(RuntimeError):
    pass


async def _receive_websocket_bytes_or_revocation(
    websocket: WebSocket,
    session_revoked: asyncio.Event,
) -> bytes | None:
    receive_task = asyncio.create_task(websocket.receive_bytes())
    revocation_task = asyncio.create_task(session_revoked.wait())
    try:
        done, _pending = await asyncio.wait(
            {receive_task, revocation_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if revocation_task in done:
            return None
        return receive_task.result()
    finally:
        for task in (receive_task, revocation_task):
            if task.done():
                continue
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def _whatsapp_runtime_debug_details(details: dict[str, Any]) -> dict[str, Any]:
    aliases = {
        "preKeyCount": "preCount",
        "signedPreKeyId": "signedPreId",
    }
    return {aliases.get(key, key): value for key, value in details.items()}


async def _run_whatsapp_websocket_inbox_pump(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    tenant_id: str,
    session: WhatsAppNoiseEmulatorSession,
    websocket: WebSocket,
    send_lock: asyncio.Lock,
    require_session_authority: Callable[[], Awaitable[None]],
) -> None:
    async def wait_for_events(
        _tenant_id: str,
        after_sequence: int,
        limit: int,
    ) -> list[WhatsAppInboxPumpEvent]:
        await require_session_authority()
        events = await _wait_whatsapp_websocket_inbox(
            account_id=account_id,
            bot_agent_link_id=bot_agent_link_id,
            after_sequence=after_sequence,
            limit=limit,
        )
        await require_session_authority()
        return events

    async def ack(_tenant_id: str, through_sequence: int) -> None:
        await require_session_authority()
        await _ack_whatsapp_websocket_inbox(
            account_id=account_id,
            bot_agent_link_id=bot_agent_link_id,
            through_sequence=through_sequence,
        )

    async def deliver(prepared):
        async with send_lock:
            await require_session_authority()
            frame, result = await session.push_inbound_message(
                from_jid=prepared.from_jid,
                message_id=prepared.message_id,
                message_proto=whatsapp_message_proto_bytes(prepared.payload, prepared.text),
                participant_jid=prepared.participant_jid,
                push_name=prepared.push_name,
                timestamp=prepared.timestamp,
                sender_lid_jid=prepared.sender_lid_jid,
                sender_pn_jid=prepared.sender_pn_jid,
                participant_lid_jid=prepared.participant_lid_jid,
                participant_pn_jid=prepared.participant_pn_jid,
            )
            await require_session_authority()
            await websocket.send_bytes(frame)
        return result

    pump = WhatsAppInboxPump(
        tenant_id=tenant_id,
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        debug_events=_WhatsAppWebsocketInboxDebugEvents(
            account_id,
            require_session_authority=require_session_authority,
        ),
    )
    await pump.run(stop_when_idle=False)


class _WhatsAppWebsocketInboxDebugEvents:
    def __init__(
        self,
        account_id: UUID,
        *,
        require_session_authority: Callable[[], Awaitable[None]],
    ) -> None:
        self._account_id = account_id
        self._require_session_authority = require_session_authority

    async def record(self, payload: dict[str, Any]) -> None:
        await self._require_session_authority()
        async with async_session_factory() as db:
            account = await get_active_channel_account(db, account_id=self._account_id)
            await record_channel_debug_event(
                db,
                account=account,
                user_id=account.user_id,
                provider=CHANNEL_PROVIDER_WHATSAPP,
                direction=_optional_str(payload.get("direction")) or "agent",
                stage=_optional_str(payload.get("stage")) or "inbox_delivery",
                outcome=_optional_str(payload.get("outcome")) or "unknown",
                external_chat_id=_optional_str(payload.get("chatId")),
                details=payload.get("details") if isinstance(payload.get("details"), dict) else {},
            )
            await db.commit()


async def _wait_whatsapp_websocket_inbox(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    after_sequence: int,
    limit: int = 100,
) -> list[WhatsAppInboxPumpEvent]:
    timeout = max(0.0, min(settings.channel_long_poll_max_seconds, 30.0))
    poll_interval = max(0.001, settings.channel_long_poll_interval_seconds)
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        async with async_session_factory() as db:
            result = await db.execute(
                select(ChannelMessage)
                .where(
                    ChannelMessage.account_id == account_id,
                    ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                    ChannelMessage.binding_id.is_not(None),
                    ChannelMessage.delivered_at.is_(None),
                    ChannelMessage.inbox_sequence > after_sequence,
                    ChannelMessage.bot_agent_link_id == bot_agent_link_id,
                )
                .order_by(ChannelMessage.inbox_sequence, ChannelMessage.created_at)
                .limit(max(0, limit))
            )
            messages = list(result.scalars().all())
        if messages or timeout == 0 or asyncio.get_running_loop().time() >= deadline:
            return [
                WhatsAppInboxPumpEvent(
                    sequence=message.inbox_sequence,
                    external_chat_id=message.external_chat_id,
                    payload=message.payload if isinstance(message.payload, dict) else {},
                    provider_message_id=message.provider_message_id,
                    text=message.text,
                )
                for message in messages
            ]
        await asyncio.sleep(
            min(
                poll_interval,
                max(0.0, deadline - asyncio.get_running_loop().time()),
            )
        )


async def _ack_whatsapp_websocket_inbox(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID,
    through_sequence: int,
) -> None:
    async with async_session_factory() as db:
        await db.execute(
            update(ChannelMessage)
            .where(
                ChannelMessage.account_id == account_id,
                ChannelMessage.direction == MESSAGE_DIRECTION_INBOUND,
                ChannelMessage.binding_id.is_not(None),
                ChannelMessage.delivered_at.is_(None),
                ChannelMessage.inbox_sequence <= through_sequence,
                ChannelMessage.bot_agent_link_id == bot_agent_link_id,
            )
            .values(delivered_at=datetime.now(UTC))
        )
        await db.commit()
