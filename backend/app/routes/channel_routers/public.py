from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    require_user_auth,
)
from app.core.database import get_session
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_PROVIDERS,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PRIVATE,
    CHANNEL_VISIBILITY_PUBLIC,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelDelivery,
    ChannelMessage,
)
from app.models.session import AgentEnvironment
from app.routes.channel_routers.shared import (
    _account_response,
    _binding_response,
    _message_response,
)
from app.schemas.channel import (
    ChannelAccountCreate,
    ChannelAccountCreatedResponse,
    ChannelAccountResponse,
    ChannelActivityItemResponse,
    ChannelActivityListResponse,
    ChannelAgentLinkCreate,
    ChannelAgentLinkResponse,
    ChannelBindingResponse,
    ChannelBotPoolAccess,
    ChannelBotPoolCapabilities,
    ChannelBotPoolItem,
    ChannelBotPoolResponse,
    ChannelCommandSyncRequest,
    ChannelCommandSyncResponse,
    ChannelHealthItemResponse,
    ChannelHealthListResponse,
    ChannelMessageResponse,
    ChannelPairCodeCreate,
    ChannelPairCodeResponse,
    ChannelRuntimeAccountResponse,
    ChannelRuntimeAgentLinkResponse,
    ChannelSendMessageRequest,
)
from app.services.agent_bindings import get_owned_agent_or_404
from app.services.audit import record_control_plane_audit
from app.services.channel_config import validate_channel_account_config_urls
from app.services.channels import (
    archive_channel_account,
    channel_bot_link_limit,
    create_pair_code,
    decrypt_agent_link_token,
    encrypt_optional_token,
    enqueue_channel_outbound_message,
    generate_agent_token,
    generate_webhook_secret,
    get_accessible_channel_account,
    get_or_create_bot_agent_link,
    get_owned_bot_agent_link,
    get_owned_private_channel_account,
    get_usable_channel_account,
    hash_token,
    list_owned_active_bot_agent_links,
    rotate_bot_agent_link_token,
    store_channel_secrets,
    sync_channel_commands,
)
from app.services.http_cache import if_none_match_contains, strong_json_etag

router = APIRouter(prefix="/api/channels", tags=["channels"])

SECRETISH_ACTIVITY_DETAIL_KEYS = (
    "secret",
    "token",
    "password",
    "authorization",
    "auth",
    "api_key",
    "apikey",
    "key",
    "credential",
    "cookie",
)


def _agent_link_response(
    link: ChannelBotAgentLink,
    *,
    agent_token: str | None = None,
) -> ChannelAgentLinkResponse:
    return ChannelAgentLinkResponse(
        id=link.id,
        account_id=link.account_id,
        agent_id=link.agent_id,
        status=link.status,
        created_at=link.created_at,
        agent_token=agent_token,
    )


def _runtime_agent_link_response(
    link: ChannelBotAgentLink,
    *,
    agent_token: str | None = None,
) -> ChannelRuntimeAgentLinkResponse:
    return ChannelRuntimeAgentLinkResponse(
        id=link.id,
        account_id=link.account_id,
        agent_id=link.agent_id,
        status=link.status,
        created_at=link.created_at,
        agent_token=agent_token,
    )


def _runtime_account_response(
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> ChannelRuntimeAccountResponse:
    runtime_link = _runtime_agent_link_response(
        link,
        agent_token=decrypt_agent_link_token(link),
    )
    return ChannelRuntimeAccountResponse(
        **_account_response(account).model_dump(),
        runtime_links=[runtime_link],
    )


def _activity_message_response(
    account: ChannelAccount,
    message: ChannelMessage,
    delivery: ChannelDelivery | None,
) -> ChannelActivityItemResponse:
    return ChannelActivityItemResponse(
        kind="message",
        id=message.id,
        account_id=message.account_id,
        provider=account.provider,
        direction=message.direction,
        external_chat_id=message.external_chat_id,
        message_id=message.id,
        delivery_id=delivery.id if delivery is not None else None,
        delivery_status=delivery.status if delivery is not None else None,
        delivery_attempts=delivery.attempts if delivery is not None else None,
        delivery_max_attempts=delivery.max_attempts if delivery is not None else None,
        delivery_next_attempt_at=delivery.next_attempt_at if delivery is not None else None,
        delivery_last_error=delivery.last_error if delivery is not None else None,
        provider_message_id=message.provider_message_id,
        text=message.text,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def _activity_debug_event_response(
    account: ChannelAccount,
    event: ChannelDebugEvent,
) -> ChannelActivityItemResponse:
    return ChannelActivityItemResponse(
        kind="debug_event",
        id=event.id,
        account_id=account.id,
        provider=event.provider,
        direction=event.direction,
        external_chat_id=event.external_chat_id,
        stage=event.stage,
        outcome=event.outcome,
        status_code=event.status_code,
        error=event.error,
        details=_sanitize_activity_details(event.details),
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


def _bot_pool_item(
    account: ChannelAccount,
    *,
    user_id: UUID,
    link_count: int = 0,
) -> ChannelBotPoolItem:
    access = _bot_pool_access(account, user_id=user_id)
    max_links = channel_bot_link_limit(account)
    available = max_links is None or link_count < max_links
    return ChannelBotPoolItem(
        **_account_response(account).model_dump(),
        access=access,
        capabilities=_bot_pool_capabilities(access, available=available),
        link_count=link_count,
        max_links=max_links,
        available=available,
    )


def _bot_pool_access(account: ChannelAccount, *, user_id: UUID) -> ChannelBotPoolAccess:
    if account.user_id == user_id and account.visibility == CHANNEL_VISIBILITY_PRIVATE:
        return "owner"
    return "public"


def _bot_pool_capabilities(
    access: ChannelBotPoolAccess,
    *,
    available: bool,
) -> ChannelBotPoolCapabilities:
    can_manage_account = access == "owner"
    return ChannelBotPoolCapabilities(
        link_agent=available,
        pair_chat=available,
        send_message=True,
        manage_account=can_manage_account,
        sync_commands=can_manage_account,
    )


async def _active_bot_agent_link_counts(
    db: AsyncSession,
    *,
    account_ids: list[UUID],
) -> dict[UUID, int]:
    if not account_ids:
        return {}
    result = await db.execute(
        select(ChannelBotAgentLink.account_id, func.count())
        .where(
            ChannelBotAgentLink.account_id.in_(account_ids),
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
        )
        .group_by(ChannelBotAgentLink.account_id)
    )
    return {account_id: int(count) for account_id, count in result.all()}


@router.get("", response_model=list[ChannelAccountResponse | ChannelRuntimeAccountResponse])
async def list_channels(
    request: Request,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> Response:
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        result = await db.execute(
            select(ChannelAccount, ChannelBotAgentLink)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
            .where(
                ChannelAccount.archived_at.is_(None),
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.user_id == auth.user_id,
                ChannelBotAgentLink.agent_id == auth.api_key.environment_id,
            )
            .order_by(
                ChannelAccount.provider,
                ChannelAccount.visibility,
                ChannelAccount.name,
                ChannelAccount.id,
            )
        )
        payload = [
            _runtime_account_response(account, link).model_dump(mode="json")
            for account, link in result.all()
        ]
        etag = strong_json_etag(payload)
        headers = {"ETag": etag, "Cache-Control": "no-store"}
        if if_none_match_contains(request.headers.get("if-none-match"), etag):
            return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
        return JSONResponse(payload, headers=headers)

    result = await db.execute(
        select(ChannelAccount)
        .where(
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.user_id == auth.user_id,
            ChannelAccount.visibility == CHANNEL_VISIBILITY_PRIVATE,
        )
        .order_by(
            ChannelAccount.provider,
            ChannelAccount.visibility,
            ChannelAccount.name,
            ChannelAccount.id,
        )
    )
    payload = [
        _account_response(account).model_dump(mode="json") for account in result.scalars().all()
    ]
    etag = strong_json_etag(payload)
    headers = {"ETag": etag, "Cache-Control": "no-store"}
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(payload, headers=headers)


@router.get("/bot-pool")
async def list_channel_bot_pool(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelBotPoolResponse:
    result = await db.execute(
        select(ChannelAccount)
        .where(
            ChannelAccount.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            or_(
                ChannelAccount.user_id == auth.user_id,
                ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
            ),
        )
        .order_by(ChannelAccount.provider, ChannelAccount.visibility.desc(), ChannelAccount.name)
    )
    providers: dict[str, list[ChannelBotPoolItem]] = {
        provider: [] for provider in CHANNEL_PROVIDERS
    }
    accounts = list(result.scalars().all())
    link_counts = await _active_bot_agent_link_counts(
        db,
        account_ids=[account.id for account in accounts],
    )
    for account in accounts:
        providers.setdefault(account.provider, []).append(
            _bot_pool_item(
                account,
                user_id=auth.user_id,
                link_count=link_counts.get(account.id, 0),
            )
        )
    for items in providers.values():
        items.sort(key=lambda item: (not item.available, item.link_count, item.name, str(item.id)))
    return ChannelBotPoolResponse(providers=providers)


@router.get("/health")
async def list_channel_health(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelHealthListResponse:
    accounts = await _health_accounts(db, user_id=auth.user_id)
    return ChannelHealthListResponse(
        items=[
            await _channel_health_item(db, account=account, user_id=auth.user_id)
            for account in accounts
        ],
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_channel(
    body: ChannelAccountCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelAccountCreatedResponse:
    if body.provider not in CHANNEL_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unsupported provider")
    await validate_channel_account_config_urls(provider=body.provider, config=body.config)
    initial_agent_id = await _resolve_initial_agent_id(
        db,
        auth=auth,
        requested_agent_id=body.agent_id,
    )

    ciphertext, nonce = encrypt_optional_token(body.provider_token)
    webhook_secret = generate_webhook_secret()
    account = ChannelAccount(
        user_id=auth.user_id,
        provider=body.provider,
        name=body.name,
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        webhook_secret_hash=hash_token(webhook_secret),
        config=body.config,
    )
    db.add(account)
    try:
        await db.flush()
        link: ChannelBotAgentLink | None = None
        link_agent_token: str | None = None
        if initial_agent_id is not None:
            link_agent_token = generate_agent_token(body.provider)
            link, created_token = await get_or_create_bot_agent_link(
                db,
                account=account,
                agent_id=initial_agent_id,
                user_id=auth.user_id,
                agent_token=link_agent_token,
            )
            link_agent_token = created_token or link_agent_token
        await store_channel_secrets(db, account=account, secrets_by_name=body.secrets)
        record_control_plane_audit(
            db,
            actor_type="user",
            actor_user_id=auth.user_id,
            target_user_id=auth.user_id,
            action="channel.account.create",
            resource_type="channel_account",
            resource_id=str(account.id),
            channel_account_id=account.id,
            channel_agent_link_id=link.id if link else None,
            source="api.channels",
            details={
                "provider": account.provider,
                "visibility": account.visibility,
                "initial_agent_id": str(initial_agent_id) if initial_agent_id else None,
                "has_provider_credential": body.provider_token is not None,
                "secret_names": sorted((body.secrets or {}).keys()),
            },
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="channel name already exists for this provider",
        ) from exc
    await db.refresh(account)
    return ChannelAccountCreatedResponse(
        **_account_response(account).model_dump(),
        webhook_secret=webhook_secret,
        agent_link_id=link.id if link else None,
        agent_id=link.agent_id if link else None,
        agent_token=link_agent_token,
    )


@router.get("/{account_id}/activity")
async def list_channel_activity(
    account_id: UUID,
    external_chat_id: str | None = Query(default=None, min_length=1, max_length=300),
    limit: int = Query(default=50, ge=1, le=200),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelActivityListResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    message_filters = [
        ChannelMessage.account_id == account.id,
        ChannelMessage.user_id == auth.user_id,
    ]
    debug_filters = [
        ChannelDebugEvent.account_id == account.id,
        ChannelDebugEvent.user_id == auth.user_id,
    ]
    if external_chat_id is not None:
        message_filters.append(ChannelMessage.external_chat_id == external_chat_id)
        debug_filters.append(ChannelDebugEvent.external_chat_id == external_chat_id)

    message_rows = (
        await db.execute(
            select(ChannelMessage, ChannelDelivery)
            .outerjoin(ChannelDelivery, ChannelDelivery.message_id == ChannelMessage.id)
            .where(*message_filters)
            .order_by(ChannelMessage.created_at.desc(), ChannelMessage.id.desc())
            .limit(limit)
        )
    ).all()
    debug_events = (
        (
            await db.execute(
                select(ChannelDebugEvent)
                .where(*debug_filters)
                .order_by(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    items = [
        _activity_message_response(account, message, delivery) for message, delivery in message_rows
    ]
    items.extend(_activity_debug_event_response(account, event) for event in debug_events)
    items.sort(key=lambda item: (item.created_at, str(item.id)), reverse=True)
    return ChannelActivityListResponse(items=items[:limit])


@router.get("/{account_id}")
async def get_channel(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelAccountResponse:
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    return _account_response(account)


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    account = await get_owned_private_channel_account(
        db,
        account_id=account_id,
        user_id=auth.user_id,
    )
    await archive_channel_account(db, account=account)
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        action="channel.account.archive",
        resource_type="channel_account",
        resource_id=str(account.id),
        channel_account_id=account.id,
        source="api.channels",
        details={"provider": account.provider, "visibility": account.visibility},
    )
    await db.commit()


@router.post("/{account_id}/pair-codes", status_code=status.HTTP_201_CREATED)
async def create_channel_pair_code(
    account_id: UUID,
    body: ChannelPairCodeCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelPairCodeResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    link, agent_token = await _resolve_pair_code_link(db, auth=auth, account=account, body=body)
    created = await create_pair_code(
        db,
        account=account,
        link=link,
        ttl_seconds=body.ttl_seconds,
        agent_token=agent_token,
    )
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        action="channel.pair_code.create",
        resource_type="channel_pair_code",
        resource_id=str(created.pair_code.id),
        channel_account_id=account.id,
        channel_agent_link_id=created.link.id,
        source="api.channels",
        details={
            "provider": account.provider,
            "agent_id": str(created.link.agent_id),
            "ttl_seconds": body.ttl_seconds,
        },
    )
    await db.commit()
    await db.refresh(created.pair_code)
    return ChannelPairCodeResponse(
        id=created.pair_code.id,
        agent_link_id=created.link.id,
        agent_id=created.link.agent_id,
        agent_token=created.agent_token,
        code=created.code,
        expires_at=created.pair_code.expires_at,
    )


@router.get("/{account_id}/agent-links")
async def list_channel_agent_links(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ChannelAgentLinkResponse]:
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    result = await db.execute(
        select(ChannelBotAgentLink)
        .where(
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.user_id == auth.user_id,
            ChannelBotAgentLink.archived_at.is_(None),
        )
        .order_by(ChannelBotAgentLink.created_at)
    )
    return [_agent_link_response(link) for link in result.scalars().all()]


@router.post("/{account_id}/agent-links", status_code=status.HTTP_201_CREATED)
async def create_channel_agent_link(
    account_id: UUID,
    body: ChannelAgentLinkCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelAgentLinkResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    agent_id = await _resolve_agent_id_for_link(db, auth=auth, requested_agent_id=body.agent_id)
    link, agent_token = await get_or_create_bot_agent_link(
        db,
        account=account,
        agent_id=agent_id,
        user_id=auth.user_id,
    )
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        action="channel.agent_link.create" if agent_token else "channel.agent_link.ensure",
        resource_type="channel_agent_link",
        resource_id=str(link.id),
        channel_account_id=account.id,
        channel_agent_link_id=link.id,
        source="api.channels",
        details={
            "provider": account.provider,
            "agent_id": str(agent_id),
            "created": agent_token is not None,
        },
    )
    await db.commit()
    await db.refresh(link)
    return _agent_link_response(link, agent_token=agent_token)


@router.post("/{account_id}/agent-links/{link_id}/token")
async def rotate_channel_agent_link_token(
    account_id: UUID,
    link_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelAgentLinkResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    link = await get_owned_bot_agent_link(
        db, account=account, link_id=link_id, user_id=auth.user_id
    )
    agent_token = await rotate_bot_agent_link_token(db, account=account, link=link)
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        action="channel.agent_link.credential_rotate",
        resource_type="channel_agent_link",
        resource_id=str(link.id),
        channel_account_id=account.id,
        channel_agent_link_id=link.id,
        source="api.channels",
        details={"provider": account.provider, "agent_id": str(link.agent_id)},
    )
    await db.commit()
    await db.refresh(link)
    return _agent_link_response(link, agent_token=agent_token)


@router.get("/{account_id}/bindings")
async def list_channel_bindings(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ChannelBindingResponse]:
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    result = await db.execute(
        select(ChannelBinding)
        .where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.user_id == auth.user_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
        .order_by(ChannelBinding.created_at.desc())
    )
    return [_binding_response(binding) for binding in result.scalars().all()]


@router.post("/{account_id}/commands/sync")
async def sync_channel_commands_route(
    account_id: UUID,
    body: ChannelCommandSyncRequest,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelCommandSyncResponse:
    account = await get_owned_private_channel_account(
        db,
        account_id=account_id,
        user_id=auth.user_id,
    )
    commands = (
        [command.model_dump(exclude_none=True) for command in body.commands]
        if body.commands is not None
        else None
    )
    synced = await sync_channel_commands(
        account=account,
        commands=commands,
        guild_id=body.guild_id,
    )
    return ChannelCommandSyncResponse(provider=account.provider, commands=synced)


@router.post("/{account_id}/messages", status_code=status.HTTP_201_CREATED)
async def send_channel_message(
    account_id: UUID,
    body: ChannelSendMessageRequest,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelMessageResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    external_chat_id = body.external_chat_id
    bot_agent_link_id: UUID | None = None
    if body.binding_id is not None:
        result = await db.execute(
            select(ChannelBinding).where(
                ChannelBinding.id == body.binding_id,
                ChannelBinding.account_id == account.id,
                ChannelBinding.user_id == auth.user_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
        )
        binding = result.scalar_one_or_none()
        if binding is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="binding not found")
        external_chat_id = binding.external_chat_id
        bot_agent_link_id = binding.bot_agent_link_id
    elif account.visibility == CHANNEL_VISIBILITY_PUBLIC and external_chat_id is not None:
        result = await db.execute(
            select(ChannelBinding)
            .where(
                ChannelBinding.account_id == account.id,
                ChannelBinding.user_id == auth.user_id,
                ChannelBinding.external_chat_id == external_chat_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            )
            .order_by(ChannelBinding.created_at.desc())
            .limit(1)
        )
        binding = result.scalar_one_or_none()
        if binding is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="chat is not paired with this user",
            )
        bot_agent_link_id = binding.bot_agent_link_id
    if external_chat_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="binding_id or external_chat_id is required",
        )
    message, delivery = await enqueue_channel_outbound_message(
        db,
        account=account,
        external_chat_id=external_chat_id,
        text=body.text,
        bot_agent_link_id=bot_agent_link_id,
    )
    await db.commit()
    await db.refresh(message)
    await db.refresh(delivery)
    return _message_response(message, delivery=delivery)


async def _resolve_agent_id_for_link(
    db: AsyncSession,
    *,
    auth: AuthContext,
    requested_agent_id: UUID | None,
) -> UUID:
    if requested_agent_id is not None:
        await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=requested_agent_id)
        return requested_agent_id
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        await get_owned_agent_or_404(
            db,
            user_id=auth.user_id,
            agent_id=auth.api_key.environment_id,
        )
        return auth.api_key.environment_id
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="agent_id is required")


async def _resolve_initial_agent_id(
    db: AsyncSession,
    *,
    auth: AuthContext,
    requested_agent_id: UUID | None,
) -> UUID | None:
    if requested_agent_id is not None:
        await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=requested_agent_id)
        return requested_agent_id
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        await get_owned_agent_or_404(
            db,
            user_id=auth.user_id,
            agent_id=auth.api_key.environment_id,
        )
        return auth.api_key.environment_id
    result = await db.execute(
        select(AgentEnvironment.id)
        .where(AgentEnvironment.user_id == auth.user_id)
        .order_by(AgentEnvironment.created_at)
    )
    agent_ids = list(result.scalars().all())
    if len(agent_ids) == 1:
        return agent_ids[0]
    return None


async def _resolve_pair_code_link(
    db: AsyncSession,
    *,
    auth: AuthContext,
    account: ChannelAccount,
    body: ChannelPairCodeCreate,
) -> tuple[ChannelBotAgentLink, str | None]:
    if body.agent_link_id is not None:
        return (
            await get_owned_bot_agent_link(
                db,
                account=account,
                link_id=body.agent_link_id,
                user_id=auth.user_id,
            ),
            None,
        )
    if body.agent_id is not None:
        await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=body.agent_id)
        link, agent_token = await get_or_create_bot_agent_link(
            db,
            account=account,
            agent_id=body.agent_id,
            user_id=auth.user_id,
        )
        return link, agent_token
    links = await list_owned_active_bot_agent_links(db, account=account, user_id=auth.user_id)
    if len(links) == 1:
        return links[0], None
    detail = "agent_id or agent_link_id is required"
    if len(links) > 1:
        detail = "agent_id or agent_link_id is required for channels with multiple agents"
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


async def _health_accounts(
    db: AsyncSession,
    *,
    user_id: UUID,
) -> list[ChannelAccount]:
    result = await db.execute(
        select(ChannelAccount)
        .outerjoin(
            ChannelBinding,
            and_(
                ChannelBinding.account_id == ChannelAccount.id,
                ChannelBinding.user_id == user_id,
                ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ),
        )
        .where(
            ChannelAccount.archived_at.is_(None),
            or_(
                ChannelAccount.user_id == user_id,
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                    ChannelBinding.id.is_not(None),
                ),
            ),
        )
        .order_by(ChannelAccount.provider, ChannelAccount.visibility, ChannelAccount.name)
    )
    accounts: list[ChannelAccount] = []
    seen: set[UUID] = set()
    for account in result.scalars().all():
        if account.id in seen:
            continue
        seen.add(account.id)
        accounts.append(account)
    return accounts


async def _channel_health_item(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
) -> ChannelHealthItemResponse:
    pending_inbox = await _count_pending_inbox(db, account=account, user_id=user_id)
    pending_deliveries = await _count_deliveries(
        db,
        account=account,
        user_id=user_id,
        status_value=DELIVERY_STATUS_PENDING,
    )
    in_progress_deliveries = await _count_deliveries(
        db,
        account=account,
        user_id=user_id,
        status_value=DELIVERY_STATUS_IN_PROGRESS,
    )
    failed_deliveries = await _count_deliveries(
        db,
        account=account,
        user_id=user_id,
        status_value=DELIVERY_STATUS_FAILED,
    )
    last_message_at = await _last_message_at(db, account=account, user_id=user_id)
    last_event = await _last_debug_event(db, account=account, user_id=user_id, error_only=False)
    last_debug_error = await _last_debug_event(
        db,
        account=account,
        user_id=user_id,
        error_only=True,
    )
    last_delivery_error = await _last_delivery_error(db, account=account, user_id=user_id)
    last_error_at = None
    last_error = None
    last_error_stage = None
    last_error_outcome = None
    if last_debug_error is not None:
        last_error_at = last_debug_error.created_at
        last_error = last_debug_error.error
        last_error_stage = last_debug_error.stage
        last_error_outcome = last_debug_error.outcome
    if last_delivery_error is not None and (
        last_error_at is None or last_delivery_error.updated_at > last_error_at
    ):
        last_error_at = last_delivery_error.updated_at
        last_error = last_delivery_error.last_error
        last_error_stage = "delivery"
        last_error_outcome = "failure"

    reasons: list[str] = []
    if account.status != CHANNEL_STATUS_ACTIVE:
        reasons.append("channel_disabled")
    if failed_deliveries > 0:
        reasons.append("failed_deliveries")
    if last_error is not None:
        reasons.append("recent_error")
    if in_progress_deliveries > 0:
        reasons.append("deliveries_in_progress")
    if pending_deliveries > 0:
        reasons.append("pending_deliveries")
    if pending_inbox > 0:
        reasons.append("pending_inbox")
    health_status = "ok"
    if any(
        reason in reasons for reason in ("channel_disabled", "failed_deliveries", "recent_error")
    ):
        health_status = "error"
    elif reasons:
        health_status = "warning"

    return ChannelHealthItemResponse(
        account_id=account.id,
        provider=account.provider,
        name=account.name,
        visibility=account.visibility,
        channel_status=account.status,
        health_status=health_status,
        reasons=reasons,
        pending_inbox=pending_inbox,
        pending_deliveries=pending_deliveries,
        in_progress_deliveries=in_progress_deliveries,
        failed_deliveries=failed_deliveries,
        last_message_at=last_message_at,
        last_event_at=last_event.created_at if last_event is not None else None,
        last_error_at=last_error_at,
        last_error=last_error,
        last_error_stage=last_error_stage,
        last_error_outcome=last_error_outcome,
        native_transport=_native_transport_health(account),
    )


async def _count_pending_inbox(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
) -> int:
    result = await db.execute(
        select(func.count())
        .select_from(ChannelMessage)
        .where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.user_id == user_id,
            ChannelMessage.direction == "inbound",
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
        )
    )
    return int(result.scalar_one())


async def _count_deliveries(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
    status_value: str,
) -> int:
    result = await db.execute(
        select(func.count())
        .select_from(ChannelDelivery)
        .where(
            ChannelDelivery.account_id == account.id,
            ChannelDelivery.user_id == user_id,
            ChannelDelivery.status == status_value,
        )
    )
    return int(result.scalar_one())


async def _last_message_at(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
):
    result = await db.execute(
        select(ChannelMessage.created_at)
        .where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.user_id == user_id,
        )
        .order_by(ChannelMessage.created_at.desc(), ChannelMessage.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _last_debug_event(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
    error_only: bool,
) -> ChannelDebugEvent | None:
    query = select(ChannelDebugEvent).where(
        ChannelDebugEvent.account_id == account.id,
        ChannelDebugEvent.user_id == user_id,
    )
    if error_only:
        query = query.where(
            (ChannelDebugEvent.outcome == "failure") | ChannelDebugEvent.error.is_not(None)
        )
    result = await db.execute(
        query.order_by(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc()).limit(1)
    )
    return result.scalar_one_or_none()


async def _last_delivery_error(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    user_id: UUID,
) -> ChannelDelivery | None:
    result = await db.execute(
        select(ChannelDelivery)
        .where(
            ChannelDelivery.account_id == account.id,
            ChannelDelivery.user_id == user_id,
            ChannelDelivery.last_error.is_not(None),
        )
        .order_by(ChannelDelivery.updated_at.desc(), ChannelDelivery.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


def _native_transport_health(account: ChannelAccount) -> dict[str, Any] | None:
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        return None
    from app.services.whatsapp_shared_runtime import whatsapp_shared_bot_transport_status

    return whatsapp_shared_bot_transport_status(account.id).as_dict()


def _sanitize_activity_details(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:500]
    if isinstance(value, list):
        return [_sanitize_activity_details(item, depth=depth + 1) for item in value[:20]]
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in list(value.items())[:40]:
            safe_key = str(key)
            if _is_secretish_activity_key(safe_key):
                result[safe_key] = "[redacted]"
            else:
                result[safe_key] = _sanitize_activity_details(item, depth=depth + 1)
        return result
    return str(value)[:500]


def _is_secretish_activity_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in SECRETISH_ACTIVITY_DETAIL_KEYS)
