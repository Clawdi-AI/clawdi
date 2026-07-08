from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    require_user_auth,
)
from app.core.config import settings
from app.core.database import async_session_factory, get_session
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAgentCredential,
    ChannelBotAgentLink,
    ChannelMessage,
)
from app.routes.channel_routers.shared import (
    _extract_bearer_token,
    _json_object_from_bytes,
    _optional_str,
    _request_params,
    _require_bound_chat,
    _required_str_param,
    _whatsapp_graph_text,
)
from app.schemas.channel import (
    TelegramWebhookResponse,
    WhatsAppTenantCredentialCreate,
    WhatsAppTenantCredentialMetadata,
    WhatsAppTenantCredentialResponse,
)
from app.services.agent_bindings import get_owned_agent_or_404
from app.services.channel_debug_events import record_channel_debug_event
from app.services.channels import (
    ensure_hermes_agent_provider_link_available,
    get_active_channel_account,
    get_channel_secret,
    get_or_create_bot_agent_link,
    get_owned_bot_agent_link,
    get_usable_channel_account,
    list_owned_active_bot_agent_links,
    parse_pair_command,
    record_inbound_messages_for_bindings,
    resolve_channel_agent_by_token,
    resolve_inbound_binding,
    send_channel_outbound_message,
    send_pairing_command_reply,
    verify_hub_signature,
    verify_webhook_secret,
    whatsapp_chat_from_payload,
    whatsapp_external_user_id_from_payload,
    whatsapp_from_me_from_payload,
    whatsapp_jids_from_payload,
    whatsapp_message_id_from_payload,
    whatsapp_text_from_payload,
)
from app.services.whatsapp_baileys import (
    WhatsAppInboxPump,
    WhatsAppInboxPumpEvent,
    choose_whatsapp_route_jid,
    describe_whatsapp_jid_for_log,
    encode_buffer_json,
    load_or_create_whatsapp_auth_cert,
    mint_whatsapp_agent_credential,
    remember_whatsapp_binding_aliases,
    resolve_whatsapp_binding_by_jids,
    resolve_whatsapp_credential_by_identity,
    revoke_whatsapp_agent_credential,
    rewrite_whatsapp_media_to_upstream_url,
    save_whatsapp_agent_bundle,
    save_whatsapp_group_sender_keys,
    save_whatsapp_signal_senders,
    serialize_whatsapp_auth_cert,
    whatsapp_agent_bundle_from_config,
    whatsapp_agent_bundle_pre_key_count,
    whatsapp_agent_websocket_url,
    whatsapp_group_sender_keys_from_config,
    whatsapp_media_proxy_base_url,
    whatsapp_message_proto_bytes,
    whatsapp_signal_senders_from_config,
)
from app.services.whatsapp_noise import (
    WhatsAppNoiseEmulatorSession,
    WhatsAppNoiseRuntimeEvent,
    WhatsAppNoiseTenant,
)
from app.services.whatsapp_shared_runtime import (
    WhatsAppClawdiOutboxSharedBotRuntime,
    get_whatsapp_shared_bot_transport,
)

router = APIRouter(prefix="/channels/whatsapp", tags=["channels"])


@router.post(
    "/{account_id}/tenant-creds",
    status_code=status.HTTP_201_CREATED,
)
async def create_whatsapp_tenant_credential(
    account_id: UUID,
    body: WhatsAppTenantCredentialCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppTenantCredentialResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    self_identity = (
        body.self_identity.model_dump(exclude_none=True) if body.self_identity is not None else None
    )
    auth_cert = await load_or_create_whatsapp_auth_cert(db, account=account)
    link = await _resolve_whatsapp_tenant_link(db, auth=auth, account=account, body=body)
    await ensure_hermes_agent_provider_link_available(
        db,
        account=account,
        agent_id=link.agent_id,
        user_id=link.user_id,
        existing_same_account_link=True,
    )
    stored = await mint_whatsapp_agent_credential(
        db,
        account=account,
        bot_agent_link_id=link.id,
        user_id=link.user_id,
        phone_user=body.phone_user,
        device=body.device,
        name=body.name,
        self_identity=self_identity,
    )
    await db.commit()
    await db.refresh(stored.credential)
    return WhatsAppTenantCredentialResponse(
        credential_id=stored.credential.id,
        agent_link_id=link.id,
        agent_id=link.agent_id,
        jid=stored.minted.jid,
        identity_pub_key_hex=stored.minted.identity_pub_key.hex(),
        creds=encode_buffer_json(stored.minted.creds),
        auth_cert=serialize_whatsapp_auth_cert(auth_cert),
        websocket_url=whatsapp_agent_websocket_url(account.id),
        media_proxy_base_url=whatsapp_media_proxy_base_url(),
    )


@router.get("/{account_id}/tenant-creds")
async def list_whatsapp_tenant_credentials(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[WhatsAppTenantCredentialMetadata]:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    result = await db.execute(
        select(ChannelAgentCredential, ChannelBotAgentLink)
        .join(
            ChannelBotAgentLink,
            ChannelBotAgentLink.id == ChannelAgentCredential.bot_agent_link_id,
        )
        .where(
            ChannelAgentCredential.account_id == account.id,
            ChannelAgentCredential.user_id == auth.user_id,
            ChannelBotAgentLink.user_id == auth.user_id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
        .order_by(ChannelAgentCredential.created_at.desc())
    )
    return [
        WhatsAppTenantCredentialMetadata(
            credential_id=credential.id,
            agent_link_id=credential.bot_agent_link_id,
            agent_id=link.agent_id,
            jid=credential.synthetic_jid,
            identity_pub_key_hex=credential.identity_public_key.hex(),
            created_at=credential.created_at,
        )
        for credential, link in result.all()
    ]


async def _resolve_whatsapp_tenant_link(
    db: AsyncSession,
    *,
    auth: AuthContext,
    account,
    body: WhatsAppTenantCredentialCreate,
) -> ChannelBotAgentLink:
    if body.agent_link_id is not None:
        return await get_owned_bot_agent_link(
            db,
            account=account,
            link_id=body.agent_link_id,
            user_id=auth.user_id,
        )
    if body.agent_id is not None:
        await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=body.agent_id)
        link, _agent_token = await get_or_create_bot_agent_link(
            db,
            account=account,
            agent_id=body.agent_id,
            user_id=auth.user_id,
        )
        return link
    links = await list_owned_active_bot_agent_links(db, account=account, user_id=auth.user_id)
    if len(links) == 1:
        return links[0]
    detail = "agent_id or agent_link_id is required"
    if len(links) > 1:
        detail = "agent_id or agent_link_id is required for channels with multiple agents"
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


@router.delete(
    "/{account_id}/tenant-creds/{credential_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_whatsapp_tenant_credential(
    account_id: UUID,
    credential_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    revoked = await revoke_whatsapp_agent_credential(
        db,
        account=account,
        credential_id=credential_id,
        user_id=auth.user_id,
    )
    if not revoked:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="credential not found")
    await db.commit()


@router.get("/{account_id}/auth-cert")
async def get_whatsapp_auth_cert(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    auth_cert = await load_or_create_whatsapp_auth_cert(db, account=account)
    await db.commit()
    return serialize_whatsapp_auth_cert(auth_cert)


@router.websocket("/{account_id}/baileys")
async def whatsapp_baileys_agent_websocket(
    websocket: WebSocket,
    account_id: UUID,
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

    async def resolve_client(identity_public_key: bytes) -> WhatsAppNoiseTenant | None:
        async with async_session_factory() as db:
            credential = await resolve_whatsapp_credential_by_identity(
                db,
                identity_public_key=identity_public_key,
            )
            if credential is None or credential.account_id != account_id:
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

    shared_runtime = WhatsAppClawdiOutboxSharedBotRuntime(
        async_session_factory,
        account_id=account_id,
        transport=get_whatsapp_shared_bot_transport(account_id),
    )

    def current_bot_agent_link_id() -> UUID | None:
        if session.tenant is None or session.tenant.bot_agent_link_id is None:
            return None
        try:
            return UUID(session.tenant.bot_agent_link_id)
        except ValueError:
            return None

    async def relay_outbound_message(message) -> None:
        await shared_runtime.store_outbound_message(
            message,
            bot_agent_link_id=current_bot_agent_link_id(),
        )

    session = WhatsAppNoiseEmulatorSession(
        auth_cert=auth_cert,
        lid="0:0@lid",
        resolve_client=resolve_client,
        on_event=record_runtime_event,
        on_outbound_message=relay_outbound_message,
        on_outbound_relay=shared_runtime.relay_raw_node,
        forward_iq=shared_runtime.forward_iq,
    )
    send_lock = asyncio.Lock()
    inbox_pump_task: asyncio.Task[None] | None = None

    async def maybe_start_inbox_pump() -> None:
        nonlocal inbox_pump_task
        if session.tenant is None or session.bundle is None:
            return
        if inbox_pump_task is not None and not inbox_pump_task.done():
            return
        inbox_pump_task = asyncio.create_task(
            _run_whatsapp_websocket_inbox_pump(
                account_id=account.id,
                bot_agent_link_id=current_bot_agent_link_id(),
                session=session,
                websocket=websocket,
                send_lock=send_lock,
            )
        )

    await websocket.accept()
    try:
        while True:
            chunk = await websocket.receive_bytes()
            async with send_lock:
                frames = await session.handle_inbound(chunk)
                for frame in frames:
                    await websocket.send_bytes(frame)
            await maybe_start_inbox_pump()
            if session.rejected:
                await websocket.close(code=1008)
                return
    except WebSocketDisconnect:
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
            with contextlib.suppress(asyncio.CancelledError):
                await inbox_pump_task


def _whatsapp_runtime_debug_details(details: dict[str, Any]) -> dict[str, Any]:
    aliases = {
        "preKeyCount": "preCount",
        "signedPreKeyId": "signedPreId",
    }
    return {aliases.get(key, key): value for key, value in details.items()}


async def _run_whatsapp_websocket_inbox_pump(
    *,
    account_id: UUID,
    bot_agent_link_id: UUID | None,
    session: WhatsAppNoiseEmulatorSession,
    websocket: WebSocket,
    send_lock: asyncio.Lock,
) -> None:
    async def wait_for_events(
        _tenant_id: str,
        after_sequence: int,
        limit: int,
    ) -> list[WhatsAppInboxPumpEvent]:
        return await _wait_whatsapp_websocket_inbox(
            account_id=account_id,
            bot_agent_link_id=bot_agent_link_id,
            after_sequence=after_sequence,
            limit=limit,
        )

    async def ack(_tenant_id: str, through_sequence: int) -> None:
        await _ack_whatsapp_websocket_inbox(
            account_id=account_id,
            bot_agent_link_id=bot_agent_link_id,
            through_sequence=through_sequence,
        )

    async def deliver(prepared):
        async with send_lock:
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
            await websocket.send_bytes(frame)
        return result

    pump = WhatsAppInboxPump(
        tenant_id=session.tenant.tenant_id if session.tenant else str(account_id),
        wait_for_events=wait_for_events,
        ack=ack,
        deliver=deliver,
        debug_events=_WhatsAppWebsocketInboxDebugEvents(account_id),
    )
    await pump.run(stop_when_idle=False)


class _WhatsAppWebsocketInboxDebugEvents:
    def __init__(self, account_id: UUID) -> None:
        self._account_id = account_id

    async def record(self, payload: dict[str, Any]) -> None:
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
    bot_agent_link_id: UUID | None,
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
    bot_agent_link_id: UUID | None,
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


@router.post(
    "/graph/v{graph_version}/{phone_number_id}/messages",
    include_in_schema=False,
)
async def whatsapp_graph_agent_messages(
    graph_version: str,
    phone_number_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    token = _extract_bearer_token(authorization)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing access token")
    agent = await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_WHATSAPP,
        token=token,
    )
    account = agent.account
    config = account.config if isinstance(account.config, dict) else {}
    configured_phone_number_id = _optional_str(config.get("phone_number_id"))
    if configured_phone_number_id and configured_phone_number_id != phone_number_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="phone number is not assigned to this channel",
        )
    params = await _request_params(request)
    recipient = _required_str_param(params, "to")
    text = _whatsapp_graph_text(params)
    await _require_bound_chat(
        db,
        account=account,
        external_chat_id=recipient,
        bot_agent_link_id=agent.link.id,
    )
    message = await send_channel_outbound_message(
        db,
        account=account,
        external_chat_id=recipient,
        text=text,
        bot_agent_link_id=agent.link.id,
    )
    await db.commit()
    return {
        "messaging_product": "whatsapp",
        "contacts": [{"input": recipient, "wa_id": recipient}],
        "messages": [{"id": message.provider_message_id or str(message.id)}],
        "clawdi_graph_version": graph_version,
    }


@router.api_route(
    "/media/{direct_path:path}",
    methods=["GET", "HEAD"],
    include_in_schema=False,
    response_model=None,
)
async def whatsapp_media_proxy(
    direct_path: str,
    request: Request,
) -> Response:
    del direct_path
    upstream_url = rewrite_whatsapp_media_to_upstream_url(str(request.url))
    if upstream_url is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="media not found")
    headers = {"Origin": "https://web.whatsapp.com"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            upstream = await client.request(request.method, upstream_url, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="whatsapp media api unreachable",
        ) from exc
    response_headers = {
        header: value
        for header in ("content-type", "content-length", "content-range", "accept-ranges")
        if (value := upstream.headers.get(header)) is not None
    }
    return Response(
        content=b"" if request.method == "HEAD" else upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type", "application/octet-stream"),
    )


@router.get(
    "/{account_id}/webhook",
    include_in_schema=False,
)
async def whatsapp_webhook_verify(
    account_id: UUID,
    hub_mode: str | None = Query(default=None, alias="hub.mode"),
    hub_verify_token: str | None = Query(default=None, alias="hub.verify_token"),
    hub_challenge: str | None = Query(default=None, alias="hub.challenge"),
    db: AsyncSession = Depends(get_session),
) -> Response:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    if (
        hub_mode == "subscribe"
        and hub_challenge is not None
        and verify_webhook_secret(hub_verify_token, account.webhook_secret_hash)
    ):
        return Response(content=hub_challenge, media_type="text/plain")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid verify token")


@router.post(
    "/{account_id}/webhook",
    include_in_schema=False,
)
async def whatsapp_webhook(
    account_id: UUID,
    request: Request,
    x_clawdi_channel_secret: str | None = Header(default=None),
    x_hub_signature_256: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> TelegramWebhookResponse:
    account = await get_active_channel_account(db, account_id=account_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    body = await request.body()
    app_secret = await get_channel_secret(db, account=account, name="app_secret")
    if not (
        verify_webhook_secret(x_clawdi_channel_secret, account.webhook_secret_hash)
        or verify_hub_signature(body=body, header=x_hub_signature_256, secret=app_secret)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid webhook secret",
        )

    payload = _json_object_from_bytes(body)
    if whatsapp_from_me_from_payload(payload):
        return TelegramWebhookResponse(ok=True)
    chat = whatsapp_chat_from_payload(payload)
    if chat is None:
        return TelegramWebhookResponse(ok=True)
    external_chat_id, external_chat_type, external_chat_name = chat
    remote_jid, alt_jid = whatsapp_jids_from_payload(payload)
    if remote_jid:
        route_jid = choose_whatsapp_route_jid(remote_jid, alt_jid)
        external_chat_id = route_jid
        external_chat_type = "group" if route_jid.endswith("@g.us") else "dm"
        binding_lookup = await resolve_whatsapp_binding_by_jids(
            db,
            account=account,
            remote_jid=remote_jid,
            alt_jid=alt_jid,
        )
        if binding_lookup.conflict:
            return TelegramWebhookResponse(ok=True)
        existing_binding = binding_lookup.binding
        if existing_binding is not None:
            external_chat_id = existing_binding.external_chat_id
            external_chat_type = existing_binding.external_chat_type
            external_chat_name = existing_binding.external_chat_name
    text = whatsapp_text_from_payload(payload)
    command = parse_pair_command(text)
    binding_result = await resolve_inbound_binding(
        db,
        account=account,
        external_chat_id=external_chat_id,
        external_chat_type=external_chat_type,
        external_chat_name=external_chat_name,
        external_user_id=whatsapp_external_user_id_from_payload(payload),
        text=text,
        command=command,
    )

    messages = await record_inbound_messages_for_bindings(
        db,
        account=account,
        binding_result=binding_result,
        external_chat_id=external_chat_id,
        provider_message_id=whatsapp_message_id_from_payload(payload),
        text=text,
        payload=payload,
    )
    if remote_jid:
        for _message, binding in messages:
            if binding is not None:
                await remember_whatsapp_binding_aliases(
                    db,
                    binding=binding,
                    remote_jid=remote_jid,
                    alt_jid=alt_jid,
                )
    await db.commit()
    reply = await send_pairing_command_reply(
        db,
        account=account,
        external_chat_id=external_chat_id,
        command=command,
        binding_result=binding_result,
    )
    if reply is not None:
        await db.commit()
    message = messages[0][0]
    return TelegramWebhookResponse(
        ok=True,
        paired=binding_result.paired,
        unpaired=binding_result.unpaired,
        binding_id=message.binding_id,
    )
