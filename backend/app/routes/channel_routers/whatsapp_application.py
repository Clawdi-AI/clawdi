from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.channel import CHANNEL_PROVIDER_WHATSAPP, ChannelAccount, ChannelBinding
from app.routes.channel_routers.shared import _extract_bearer_token
from app.schemas.whatsapp_application import (
    WhatsAppApplicationCapabilitiesResponse,
    WhatsAppApplicationOperation,
    WhatsAppApplicationOperationName,
    WhatsAppInboxAckResponse,
    WhatsAppInboxResponse,
    WhatsAppLifecycleResponse,
    WhatsAppManualCodeRequest,
    WhatsAppOperationResponse,
    WhatsAppOperationTarget,
    WhatsAppPairingStatusResponse,
    WhatsAppRecoverRequest,
)
from app.services.channels import get_owned_private_channel_account
from app.services.whatsapp_application import (
    WHATSAPP_APPLICATION_OPERATIONS,
    WhatsAppApplicationContext,
    ack_whatsapp_inbox_event,
    build_sidecar_application_operation,
    canonical_whatsapp_application_request_hash,
    ensure_recorded_whatsapp_operation_matches,
    find_recorded_whatsapp_operation,
    get_authorized_whatsapp_binding,
    lock_whatsapp_application_operation_namespace,
    operation_response_from_message,
    project_whatsapp_inbox_event,
    record_whatsapp_application_operation,
    require_owned_whatsapp_media,
    resolve_whatsapp_application_context,
    wait_for_whatsapp_inbox,
    whatsapp_inbox_high_watermark,
)
from app.services.whatsapp_sidecar_client import (
    WhatsAppSidecarClient,
    WhatsAppSidecarPairingStatus,
    WhatsAppSidecarProtocolError,
    WhatsAppSidecarRejectedError,
    WhatsAppSidecarUnavailableError,
)
from app.services.whatsapp_sidecar_registry import get_configured_whatsapp_sidecar_client

router = APIRouter(prefix="/channels/whatsapp", tags=["channels"])


@router.get("/application/{account_id}/capabilities")
async def whatsapp_application_capabilities(
    account_id: UUID,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppApplicationCapabilitiesResponse:
    context = await _application_context(db, account_id=account_id, authorization=authorization)
    client = _require_sidecar_client(context.account.id)
    try:
        capabilities = await client.capabilities()
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    required_sidecar_operation = {
        "send_text": "send",
        "send_media": "send",
        "reaction": "reaction",
        "typing": "presence",
        "edit_message": "edit",
        "delete_message": "delete",
        "mark_read": "read",
    }
    operations: list[WhatsAppApplicationOperationName] = [
        operation
        for operation in WHATSAPP_APPLICATION_OPERATIONS
        if required_sidecar_operation[operation] in capabilities.operations
    ]
    return WhatsAppApplicationCapabilitiesResponse(
        operations=operations,
        typingStates=(
            ["composing", "recording", "paused"] if "presence" in capabilities.operations else []
        ),
    )


@router.get("/application/{account_id}/inbox")
async def whatsapp_application_inbox(
    request: Request,
    account_id: UUID,
    cursor: Annotated[str | None, Query(max_length=20)] = None,
    wait_seconds: Annotated[float, Query(ge=0, le=30)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppInboxResponse:
    context = await _application_context(db, account_id=account_id, authorization=authorization)
    sequence = _parse_cursor(cursor)
    messages = await wait_for_whatsapp_inbox(
        db,
        context=context,
        cursor=sequence,
        limit=limit,
        wait_seconds=wait_seconds,
        poll_interval_seconds=settings.channel_long_poll_interval_seconds,
    )

    def media_url_for(media_id: str) -> str:
        return str(
            request.url_for(
                "whatsapp_application_media",
                account_id=str(account_id),
                media_id=media_id,
            )
        )

    try:
        events = [
            project_whatsapp_inbox_event(message, media_url_for=media_url_for)
            for message in messages
        ]
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="invalid inbox event",
        ) from exc
    if messages:
        next_cursor = str(max(sequence, messages[0].inbox_sequence - 1))
    else:
        high_watermark = await whatsapp_inbox_high_watermark(db, context=context)
        next_cursor = str(max(sequence, high_watermark))
    return WhatsAppInboxResponse(events=events, cursor=next_cursor)


@router.post("/application/{account_id}/inbox/{event_id}/ack")
async def whatsapp_application_inbox_ack(
    account_id: UUID,
    event_id: UUID,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppInboxAckResponse:
    context = await _application_context(db, account_id=account_id, authorization=authorization)
    duplicate = await ack_whatsapp_inbox_event(db, context=context, event_id=event_id)
    await db.commit()
    return WhatsAppInboxAckResponse(id=event_id, duplicate=duplicate)


@router.post("/application/{account_id}/operations")
async def whatsapp_application_operation(
    account_id: UUID,
    body: WhatsAppApplicationOperation,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppOperationResponse:
    context = await _application_context(db, account_id=account_id, authorization=authorization)
    binding = await get_authorized_whatsapp_binding(db, context=context, target=body.target)
    await lock_whatsapp_application_operation_namespace(db, context=context)
    request_hash = canonical_whatsapp_application_request_hash(body)
    existing = await find_recorded_whatsapp_operation(
        db,
        context=context,
        operation_id=body.operation_id,
    )
    if existing is not None:
        ensure_recorded_whatsapp_operation_matches(existing, request_hash=request_hash)
        operation_id, message_id, status_value, error_code = operation_response_from_message(
            existing
        )
        _raise_operation_outcome(
            operation_id=operation_id,
            status_value=status_value,
            error_code=error_code,
        )
        return WhatsAppOperationResponse(
            operationId=operation_id,
            messageId=message_id,
            status="completed",
            duplicate=True,
        )
    client = _require_sidecar_client(context.account.id)
    try:
        capabilities = await client.capabilities()
        required_operation = {
            "send_text": "send",
            "send_media": "send",
            "reaction": "reaction",
            "typing": "presence",
            "edit_message": "edit",
            "delete_message": "delete",
            "mark_read": "read",
        }[body.type]
        if required_operation not in capabilities.operations:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="operation is not supported by this sidecar",
            )
        payload, application_message_id = await build_sidecar_application_operation(
            db,
            context=context,
            binding=binding,
            operation=body,
            client=client,
        )
        expected_operation_id = payload["operationId"]
        if not isinstance(expected_operation_id, str):
            raise WhatsAppSidecarProtocolError("operationId projection failed")
        result = await client.execute_operation(
            payload,
            expected_operation_id=expected_operation_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    try:
        recorded, created = await record_whatsapp_application_operation(
            db,
            context=context,
            binding=binding,
            operation=body,
            result=result,
            application_message_id=application_message_id,
            request_hash=request_hash,
        )
    except WhatsAppSidecarProtocolError as exc:
        raise _map_sidecar_error(exc) from exc
    await db.commit()
    if not created:
        operation_id, message_id, status_value, error_code = operation_response_from_message(
            recorded
        )
        _raise_operation_outcome(
            operation_id=operation_id,
            status_value=status_value,
            error_code=error_code,
        )
        return WhatsAppOperationResponse(
            operationId=operation_id,
            messageId=message_id,
            status="completed",
            duplicate=True,
        )
    _raise_operation_outcome(
        operation_id=body.operation_id,
        status_value=result.status,
        error_code=result.error_code,
    )
    return WhatsAppOperationResponse(
        operationId=body.operation_id,
        messageId=(result.message_id if body.type in {"send_text", "send_media"} else None),
        status="completed",
    )


@router.get(
    "/application/{account_id}/media/{media_id}",
    name="whatsapp_application_media",
)
async def whatsapp_application_media(
    account_id: UUID,
    media_id: Annotated[str, Path(pattern=r"^media_[A-Za-z0-9_-]{43}$")],
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> Response:
    context = await _application_context(db, account_id=account_id, authorization=authorization)
    _message, binding = await require_owned_whatsapp_media(
        db,
        context=context,
        media_id=media_id,
    )
    await get_authorized_whatsapp_binding(
        db,
        context=context,
        target=_binding_target(binding),
    )
    client = _require_sidecar_client(context.account.id)
    try:
        media = await client.fetch_media(media_id)
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if media.file_name is not None:
        safe_name = media.file_name.replace('"', "").replace("\r", "").replace("\n", "")
        headers["Content-Disposition"] = f'inline; filename="{safe_name[:255]}"'
    return Response(content=media.content, media_type=media.content_type, headers=headers)


@router.get("/{account_id}/sidecar/pairing/status")
async def whatsapp_sidecar_pairing_status(
    account_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppPairingStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    account = await _owned_whatsapp_account(db, account_id=account_id, user_id=auth.user_id)
    try:
        result = await _require_sidecar_client(account.id).pairing_status()
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    return _pairing_response(result)


@router.post("/{account_id}/sidecar/pairing/qr")
async def whatsapp_sidecar_pair_qr(
    account_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppPairingStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    account = await _linking_account(db, account_id=account_id, user_id=auth.user_id)
    try:
        result = await _require_sidecar_client(account.id).pairing_qr()
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    return _pairing_response(result)


@router.post("/{account_id}/sidecar/pairing/code")
async def whatsapp_sidecar_pair_code(
    account_id: UUID,
    body: WhatsAppManualCodeRequest,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppPairingStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    account = await _linking_account(db, account_id=account_id, user_id=auth.user_id)
    try:
        result = await _require_sidecar_client(account.id).pairing_code(
            phone_number=body.phone_number
        )
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    return _pairing_response(result)


@router.post("/{account_id}/sidecar/pairing/cancel")
async def whatsapp_sidecar_pairing_cancel(
    account_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppPairingStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    account = await _owned_whatsapp_account(db, account_id=account_id, user_id=auth.user_id)
    try:
        result = await _require_sidecar_client(account.id).pairing_cancel()
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    return _pairing_response(result)


@router.post("/{account_id}/sidecar/pairing/logout")
async def whatsapp_sidecar_pairing_logout(
    account_id: UUID,
    response: Response,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppPairingStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    account = await _owned_whatsapp_account(db, account_id=account_id, user_id=auth.user_id)
    try:
        result = await _require_sidecar_client(account.id).pairing_logout()
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    return _pairing_response(result)


@router.post("/{account_id}/sidecar/recover")
async def whatsapp_sidecar_recover(
    account_id: UUID,
    body: WhatsAppRecoverRequest,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> WhatsAppLifecycleResponse:
    account = await _linking_account(db, account_id=account_id, user_id=auth.user_id)
    try:
        await _require_sidecar_client(account.id).recover(
            accept_version_change=body.accept_version_change,
            reset_logged_out=body.reset_logged_out,
        )
    except Exception as exc:
        raise _map_sidecar_error(exc) from exc
    return WhatsAppLifecycleResponse()


async def _application_context(
    db: AsyncSession,
    *,
    account_id: UUID,
    authorization: str | None,
) -> WhatsAppApplicationContext:
    token = _extract_bearer_token(authorization)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing link token")
    return await resolve_whatsapp_application_context(db, account_id=account_id, token=token)


async def _owned_whatsapp_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    account = await get_owned_private_channel_account(db, account_id=account_id, user_id=user_id)
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="channel not found")
    return account


async def _linking_account(
    db: AsyncSession,
    *,
    account_id: UUID,
    user_id: UUID,
) -> ChannelAccount:
    account = await _owned_whatsapp_account(db, account_id=account_id, user_id=user_id)
    config = account.config if isinstance(account.config, dict) else {}
    if (
        not settings.channel_whatsapp_linking_enabled
        or config.get("sidecar_linking_enabled") is not True
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="WhatsApp linking is not available.",
        )
    return account


def _require_sidecar_client(account_id: UUID) -> WhatsAppSidecarClient:
    client = get_configured_whatsapp_sidecar_client(account_id)
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp sidecar is unavailable",
        )
    return client


def _parse_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not cursor.isdecimal():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid cursor",
        )
    parsed = int(cursor)
    if parsed > 9_223_372_036_854_775_807:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid cursor",
        )
    return parsed


def _binding_target(binding: ChannelBinding) -> WhatsAppOperationTarget:
    return WhatsAppOperationTarget(
        bindingId=binding.id,
        chatId=binding.id,
        chatType="group" if binding.external_chat_type == "group" else "direct",
    )


def _pairing_response(result: WhatsAppSidecarPairingStatus) -> WhatsAppPairingStatusResponse:
    return WhatsAppPairingStatusResponse(
        status=result.status,
        registered=result.registered,
        method=result.method,
        qr=result.qr,
        code=result.code,
    )


def _map_sidecar_error(exc: Exception) -> HTTPException:
    if isinstance(exc, WhatsAppSidecarRejectedError):
        if exc.code == "operation_id_conflict":
            return HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="operationId was already used with a different request",
            )
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"WhatsApp sidecar rejected the request: {exc.code}",
        )
    if isinstance(exc, WhatsAppSidecarProtocolError):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="WhatsApp sidecar returned an invalid response",
        )
    if isinstance(exc, WhatsAppSidecarUnavailableError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="WhatsApp sidecar is unavailable",
        )
    if isinstance(exc, HTTPException):
        return exc
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="WhatsApp sidecar request failed",
    )


def _raise_operation_outcome(
    *,
    operation_id: str,
    status_value: str,
    error_code: str | None,
) -> None:
    if status_value == "completed":
        return
    if status_value == "ambiguous" or error_code == "operation_id_conflict":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": (
                    "operation_id_conflict"
                    if error_code == "operation_id_conflict"
                    else "operation_outcome_ambiguous"
                ),
                "operationId": operation_id,
                "status": status_value,
            },
        )
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={
            "code": "operation_failed",
            "operationId": operation_id,
            "status": "failed",
        },
    )
