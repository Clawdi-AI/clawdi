from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import quote
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
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
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_PROVIDERS,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PRIVATE,
    CHANNEL_VISIBILITY_PUBLIC,
    DELIVERY_STATUS_FAILED,
    DELIVERY_STATUS_IN_PROGRESS,
    DELIVERY_STATUS_PENDING,
    ChannelAccount,
    ChannelAgentCredential,
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
    _channel_visibility,
    _discord_binding_guild_id,
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
    ChannelAgentLinkWithAccountResponse,
    ChannelBindingDeleteResponse,
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
    ChannelRuntimeCredentialResponse,
    ChannelSendMessageRequest,
)
from app.services.agent_bindings import get_owned_agent_or_404
from app.services.audit import record_control_plane_audit
from app.services.channel_config import (
    discord_interactions_config_error,
    discord_public_account_is_eligible,
    validate_channel_account_config_urls,
    validate_required_discord_interactions_config,
)
from app.services.channel_debug_events import (
    public_channel_debug_details_response,
    public_channel_delivery_error,
    public_channel_operation_error,
)
from app.services.channels import (
    PAIR_COMMAND,
    archive_bot_agent_link,
    archive_channel_account,
    bot_agent_link_has_strict_v2_authority,
    build_channel_account,
    channel_bot_link_limit,
    channel_webhook_url,
    configure_discord_application,
    configure_telegram_provider_webhook,
    consume_pending_inbound_messages_for_bindings,
    create_pair_code,
    decrypt_agent_link_token,
    discord_bot_install_url,
    discord_config_without_unverified_install_state,
    discord_install_config_is_current,
    discord_reserved_commands_are_current,
    discord_user_install_url,
    encrypt_optional_token,
    enqueue_channel_outbound_message,
    ensure_bot_agent_link_provider_cardinality_or_409,
    ensure_discord_application_identity_available,
    ensure_hosted_agent_provider_link_available,
    generate_agent_token,
    generate_webhook_secret,
    get_accessible_channel_account,
    get_or_create_bot_agent_link,
    get_owned_bot_agent_link,
    get_owned_private_channel_account,
    get_strict_v2_hosted_channel_agent_or_409,
    get_usable_channel_account,
    hash_token,
    list_owned_active_bot_agent_links,
    list_owned_active_bot_agent_links_for_agent,
    list_strict_v2_hosted_channel_agent_ids,
    lock_channel_binding_identity,
    mark_discord_reserved_commands_current,
    normalize_telegram_bot_username,
    rearm_discord_command_reconciliation,
    rotate_bot_agent_link_token,
    store_channel_secrets,
    sync_channel_commands,
)
from app.services.http_cache import if_none_match_contains, strong_json_etag
from app.services.sync_events import queue_environment_runtime_manifest_changed
from app.services.vault_crypto import decrypt
from app.services.whatsapp_baileys import (
    buffer_json,
    deserialize_creds,
    encode_buffer_json,
    load_or_create_whatsapp_auth_cert,
    mint_whatsapp_agent_credential,
    whatsapp_agent_websocket_url,
)
from app.services.whatsapp_device_onboarding import require_whatsapp_logout_for_archive
from app.services.whatsapp_sidecar_registry import get_active_whatsapp_sidecar_registry

router = APIRouter(prefix="/channels", tags=["channels"])

RUNTIME_CHANNEL_PROVIDERS = (
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_WHATSAPP,
)


async def _queue_agent_link_runtime_changed(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> None:
    # The strict v2 runtime source currently projects Telegram and Discord
    # AgentLinks. Bindings are deliberately absent from that source identity.
    if account.provider not in (CHANNEL_PROVIDER_TELEGRAM, CHANNEL_PROVIDER_DISCORD):
        return
    await queue_environment_runtime_manifest_changed(db, link.user_id, link.agent_id)


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


async def _runtime_account_response(
    db: AsyncSession,
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
        runtime_credentials=await _runtime_credentials_response(db, account=account, link=link),
    )


async def _runtime_credentials_response(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    link: ChannelBotAgentLink,
) -> list[ChannelRuntimeCredentialResponse]:
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        return []
    await db.execute(
        select(ChannelAccount.id)
        .where(
            ChannelAccount.id == account.id,
        )
        .with_for_update()
    )
    credential = (
        await db.execute(
            select(ChannelAgentCredential)
            .where(
                ChannelAgentCredential.account_id == account.id,
                ChannelAgentCredential.bot_agent_link_id == link.id,
                ChannelAgentCredential.provider == CHANNEL_PROVIDER_WHATSAPP,
                ChannelAgentCredential.revoked_at.is_(None),
            )
            .order_by(ChannelAgentCredential.created_at.desc(), ChannelAgentCredential.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    auth_cert = await load_or_create_whatsapp_auth_cert(db, account=account)
    if credential is None:
        stored = await mint_whatsapp_agent_credential(
            db,
            account=account,
            bot_agent_link_id=link.id,
            user_id=link.user_id,
        )
        credential = stored.credential
        creds = stored.minted.creds
        await db.commit()
        await db.refresh(credential)
    else:
        creds = deserialize_creds(
            decrypt(credential.encrypted_credentials, credential.credential_nonce)
        )
        await db.commit()
    material: dict[str, Any] = {
        "schemaVersion": "clawdi.whatsappBaileysAuthState.v1",
        "creds": encode_buffer_json(creds),
        "websocketUrl": whatsapp_agent_websocket_url(),
        "authCert": {
            "SERIAL": auth_cert.serial,
            "ISSUER": auth_cert.issuer,
            "PUBLIC_KEY": buffer_json(auth_cert.root_public_key),
        },
    }
    return [
        ChannelRuntimeCredentialResponse(
            id=credential.id,
            account_id=credential.account_id,
            agent_link_id=credential.bot_agent_link_id,
            agent_id=link.agent_id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            kind="whatsapp_baileys_auth_state",
            created_at=credential.created_at,
            jid=credential.synthetic_jid,
            identity_pub_key_hex=credential.identity_public_key.hex(),
            material=material,
        )
    ]


def _agent_link_with_account_response(
    link: ChannelBotAgentLink,
    account: ChannelAccount,
    *,
    binding_count: int = 0,
) -> ChannelAgentLinkWithAccountResponse:
    return ChannelAgentLinkWithAccountResponse(
        **_agent_link_response(link).model_dump(),
        account=_account_response(account),
        binding_count=binding_count,
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
        delivery_last_error=(
            public_channel_delivery_error(delivery.last_error) if delivery is not None else None
        ),
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
        error=public_channel_operation_error(event.error),
        details=public_channel_debug_details_response(event.details),
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
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> Response:
    runtime_environment_id = await _runtime_channels_environment_id(
        db,
        auth=auth,
        requested_environment_id=requested_environment_id,
    )
    if runtime_environment_id is not None:
        try:
            await get_strict_v2_hosted_channel_agent_or_409(
                db,
                user_id=auth.user_id,
                agent_id=runtime_environment_id,
            )
        except HTTPException as exc:
            if exc.status_code != status.HTTP_409_CONFLICT:
                raise
            runtime_rows: list[tuple[ChannelAccount, ChannelBotAgentLink]] = []
        else:
            result = await db.execute(
                select(ChannelAccount, ChannelBotAgentLink)
                .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
                .where(
                    ChannelAccount.archived_at.is_(None),
                    ChannelAccount.provider.in_(RUNTIME_CHANNEL_PROVIDERS),
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                    ChannelBotAgentLink.archived_at.is_(None),
                    ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                    ChannelBotAgentLink.user_id == auth.user_id,
                    ChannelBotAgentLink.agent_id == runtime_environment_id,
                )
                .order_by(
                    ChannelAccount.provider,
                    ChannelAccount.visibility,
                    ChannelAccount.name,
                    ChannelAccount.id,
                )
            )
            runtime_rows = list(result.tuples().all())
        payload = []
        for account, link in runtime_rows:
            if not await bot_agent_link_has_strict_v2_authority(db, link=link):
                continue
            await ensure_bot_agent_link_provider_cardinality_or_409(
                db,
                account=account,
                link=link,
            )
            payload.append(
                (await _runtime_account_response(db, account, link)).model_dump(mode="json")
            )
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
            ChannelAccount.provider.in_(CHANNEL_PROVIDERS),
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


async def _runtime_channels_environment_id(
    db: AsyncSession,
    *,
    auth: AuthContext,
    requested_environment_id: UUID | None,
) -> UUID | None:
    if not auth.is_cli or auth.api_key is None:
        return None

    bound_environment_id = auth.api_key.environment_id
    if bound_environment_id is not None:
        if (
            requested_environment_id is not None
            and requested_environment_id != bound_environment_id
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "api key bound to a different environment",
            )
        return bound_environment_id

    if requested_environment_id is None:
        return None

    env = (
        await db.execute(
            select(AgentEnvironment.id).where(
                AgentEnvironment.id == requested_environment_id,
                AgentEnvironment.user_id == auth.user_id,
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent environment not found")
    return requested_environment_id


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
            ChannelAccount.provider.in_(CHANNEL_PROVIDERS),
            or_(
                and_(
                    ChannelAccount.user_id == auth.user_id,
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PRIVATE,
                ),
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                    ChannelAccount.user_id.is_(None),
                ),
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
        if (
            account.provider == CHANNEL_PROVIDER_DISCORD
            and account.visibility == CHANNEL_VISIBILITY_PUBLIC
            and not discord_public_account_is_eligible(account)
        ):
            # Historical/incomplete shared Discord accounts remain manageable
            # through admin APIs but are never offered as usable bot-pool
            # infrastructure.
            continue
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
        items=await _channel_health_items(
            db,
            accounts=accounts,
            user_id=auth.user_id,
        ),
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
    if body.provider == CHANNEL_PROVIDER_DISCORD:
        if body.provider_token is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Discord channels require a bot token.",
            )
        validate_required_discord_interactions_config(body.config)
    initial_agent_id = (
        None
        if "agent_id" in body.model_fields_set and body.agent_id is None
        else await _resolve_initial_agent_id(
            db,
            auth=auth,
            requested_agent_id=body.agent_id,
            provider=body.provider,
        )
    )

    ciphertext, nonce = encrypt_optional_token(body.provider_token)
    webhook_secret = generate_webhook_secret()
    account_config = (
        discord_config_without_unverified_install_state(body.config)
        if body.provider == CHANNEL_PROVIDER_DISCORD
        else body.config
    )
    account = build_channel_account(
        owner_user_id=auth.user_id,
        provider=body.provider,
        name=body.name,
        visibility=CHANNEL_VISIBILITY_PRIVATE,
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        webhook_secret_hash=hash_token(webhook_secret),
        config=account_config,
    )
    if initial_agent_id is not None:
        # Runtime authority and provider support checks must precede Telegram
        # setWebhook or any other provider I/O.
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=initial_agent_id,
            lock_runtime_fence=True,
        )
        await ensure_hosted_agent_provider_link_available(
            db,
            account=account,
            agent_id=initial_agent_id,
            user_id=auth.user_id,
        )
    db.add(account)
    try:
        await db.flush()
        if body.provider == CHANNEL_PROVIDER_TELEGRAM and body.provider_token:
            bot_username = await configure_telegram_provider_webhook(
                provider_token=body.provider_token,
                webhook_url=channel_webhook_url(account.id, body.provider),
                webhook_secret=webhook_secret,
            )
            if bot_username is not None:
                config = dict(account.config) if isinstance(account.config, dict) else {}
                config["bot_username"] = bot_username
                account.config = config
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
            await _queue_agent_link_runtime_changed(db, account=account, link=link)
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


@router.get("/agent-links")
async def list_agent_channel_links(
    agent_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ChannelAgentLinkWithAccountResponse]:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    rows = await list_owned_active_bot_agent_links_for_agent(
        db,
        user_id=auth.user_id,
        agent_id=agent_id,
    )
    return [
        _agent_link_with_account_response(
            link,
            account,
            binding_count=binding_count,
        )
        for link, account, binding_count in rows
    ]


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
    active_links = list(
        (
            await db.execute(
                select(ChannelBotAgentLink).where(
                    ChannelBotAgentLink.account_id == account.id,
                    ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                    ChannelBotAgentLink.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    await require_whatsapp_logout_for_archive(
        db,
        account=account,
        registry=get_active_whatsapp_sidecar_registry(),
    )
    await archive_channel_account(db, account=account)
    for link in active_links:
        await _queue_agent_link_runtime_changed(db, account=account, link=link)
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
    if account.provider == CHANNEL_PROVIDER_DISCORD:
        await ensure_discord_application_identity_available(db, account=account)
        config_error = discord_interactions_config_error(account.config)
        if config_error is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Discord pairing is unavailable: {config_error}",
            )
        config = dict(account.config) if isinstance(account.config, dict) else {}
        interactions_configured = config.get("discord_interactions_configured") is True
        commands_current = discord_reserved_commands_are_current(account)
        install_config_current = discord_install_config_is_current(account)
        if not interactions_configured or not install_config_current:
            await configure_discord_application(account)
            await rearm_discord_command_reconciliation(db, account=account)
            config = dict(account.config) if isinstance(account.config, dict) else {}
        if not interactions_configured or not install_config_current or not commands_current:
            # Reserved control-plane commands are true account-global
            # commands so they remain available before any Guild or DM is
            # paired. Agent runtime commands are virtualized per Link.
            await sync_channel_commands(
                account=account,
                use_configured_discord_guild=False,
            )
            legacy_guild_id = config.get("guild_id")
            if (
                interactions_configured
                and not commands_current
                and isinstance(legacy_guild_id, str)
                and legacy_guild_id.strip()
            ):
                # Older accounts could have installed the reserved commands in
                # their configured guild scope. Reconcile that known scope too
                # so the legacy bot_* commands cannot remain visible beside the
                # new global commands.
                await sync_channel_commands(
                    account=account,
                    guild_id=legacy_guild_id.strip(),
                )
            config["discord_interactions_configured"] = True
            account.config = config
            mark_discord_reserved_commands_current(account)
    link, agent_token = await _resolve_pair_code_link(db, auth=auth, account=account, body=body)
    created = await create_pair_code(
        db,
        account=account,
        link=link,
        ttl_seconds=body.ttl_seconds,
        agent_token=agent_token,
    )
    if agent_token is not None:
        await _queue_agent_link_runtime_changed(db, account=account, link=created.link)
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
    pairing_command = f"{PAIR_COMMAND} {created.code}"
    bot_username = _telegram_bot_username(account)
    deep_link = (
        f"https://t.me/{bot_username}?start={quote(created.code, safe='')}"
        if bot_username is not None
        else None
    )
    return ChannelPairCodeResponse(
        id=created.pair_code.id,
        agent_link_id=created.link.id,
        agent_id=created.link.agent_id,
        agent_token=created.agent_token,
        code=created.code,
        expires_at=created.pair_code.expires_at,
        pairing_command=pairing_command,
        bot_username=bot_username,
        deep_link=deep_link,
        qr_payload=deep_link,
        discord_install_url=discord_bot_install_url(account),
        discord_user_install_url=discord_user_install_url(account),
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
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
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
    if agent_token is not None:
        await _queue_agent_link_runtime_changed(db, account=account, link=link)
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
    await _queue_agent_link_runtime_changed(db, account=account, link=link)
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


@router.delete("/{account_id}/agent-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel_agent_link(
    account_id: UUID,
    link_id: UUID,
    background_tasks: BackgroundTasks,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    link_result = await db.execute(
        select(ChannelBotAgentLink)
        .where(
            ChannelBotAgentLink.id == link_id,
            ChannelBotAgentLink.account_id == account.id,
            ChannelBotAgentLink.user_id == auth.user_id,
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    link = link_result.scalar_one_or_none()
    if link is None or link.status != BOT_AGENT_LINK_STATUS_ACTIVE or link.archived_at is not None:
        return

    bindings = list(
        (
            await db.execute(
                select(ChannelBinding).where(
                    ChannelBinding.bot_agent_link_id == link.id,
                    ChannelBinding.status == BINDING_STATUS_ACTIVE,
                )
            )
        ).scalars()
    )
    discord_guild_ids = (
        {
            guild_id
            for binding in bindings
            if (guild_id := _discord_binding_guild_id(binding)) is not None
        }
        if account.provider == CHANNEL_PROVIDER_DISCORD
        else set()
    )
    for binding in sorted(bindings, key=lambda item: item.external_chat_id):
        await lock_channel_binding_identity(
            db,
            account_id=account.id,
            external_chat_id=binding.external_chat_id,
        )
    await archive_bot_agent_link(db, link=link, account=account)
    await _queue_agent_link_runtime_changed(db, account=account, link=link)
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        action="channel.agent_link.archive",
        resource_type="channel_agent_link",
        resource_id=str(link.id),
        channel_account_id=account.id,
        channel_agent_link_id=link.id,
        source="api.channels",
        details={"provider": account.provider, "agent_id": str(link.agent_id)},
    )
    await db.commit()
    if discord_guild_ids:
        from app.routes.channel_routers.discord import (
            cleanup_discord_guild_commands_after_authority_revoked,
        )

        background_tasks.add_task(
            cleanup_discord_guild_commands_after_authority_revoked,
            account_id=account.id,
            bot_agent_link_id=link.id,
            guild_ids=discord_guild_ids,
        )
    elif account.provider == CHANNEL_PROVIDER_TELEGRAM and bindings:
        from app.routes.channel_routers.telegram import reconcile_telegram_link_unlink

        cleaned = await reconcile_telegram_link_unlink(
            db=db,
            account=account,
            link=link,
            bindings=bindings,
        )
        if not cleaned:
            record_control_plane_audit(
                db,
                actor_type="system",
                target_user_id=auth.user_id,
                action="channel.agent_link.telegram_cleanup_failed",
                resource_type="channel_agent_link",
                resource_id=str(link.id),
                channel_account_id=account.id,
                channel_agent_link_id=link.id,
                source="api.channels",
                details={"provider": account.provider},
            )
        await db.commit()


@router.get("/{account_id}/bindings")
async def list_channel_bindings(
    account_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ChannelBindingResponse]:
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    binding_activity = (
        select(
            ChannelMessage.binding_id.label("binding_id"),
            func.max(ChannelMessage.created_at).label("last_message_at"),
        )
        .where(
            ChannelMessage.account_id == account.id,
            ChannelMessage.user_id == auth.user_id,
            ChannelMessage.binding_id.is_not(None),
        )
        .group_by(ChannelMessage.binding_id)
        .subquery()
    )
    result = await db.execute(
        select(ChannelBinding, binding_activity.c.last_message_at)
        .outerjoin(binding_activity, binding_activity.c.binding_id == ChannelBinding.id)
        .where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.user_id == auth.user_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
        .order_by(ChannelBinding.created_at.desc())
    )
    return [
        _binding_response(binding, last_message_at=last_message_at)
        for binding, last_message_at in result.all()
    ]


@router.delete("/{account_id}/bindings/{binding_id}")
async def delete_channel_binding(
    account_id: UUID,
    binding_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelBindingDeleteResponse:
    account = await get_usable_channel_account(db, account_id=account_id, user_id=auth.user_id)
    row = (
        await db.execute(
            select(ChannelBinding, ChannelBotAgentLink)
            .join(
                ChannelBotAgentLink,
                and_(
                    ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id,
                    ChannelBotAgentLink.account_id == ChannelBinding.account_id,
                    ChannelBotAgentLink.user_id == ChannelBinding.user_id,
                ),
            )
            .where(
                ChannelBinding.id == binding_id,
                ChannelBinding.account_id == account.id,
                ChannelBinding.user_id == auth.user_id,
                ChannelBotAgentLink.user_id == auth.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            )
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="binding not found")
    binding, _link = row
    await lock_channel_binding_identity(
        db,
        account_id=account.id,
        external_chat_id=binding.external_chat_id,
    )
    row = (
        await db.execute(
            select(ChannelBinding, ChannelBotAgentLink)
            .join(
                ChannelBotAgentLink,
                and_(
                    ChannelBotAgentLink.id == ChannelBinding.bot_agent_link_id,
                    ChannelBotAgentLink.account_id == ChannelBinding.account_id,
                    ChannelBotAgentLink.user_id == ChannelBinding.user_id,
                ),
            )
            .where(
                ChannelBinding.id == binding_id,
                ChannelBinding.account_id == account.id,
                ChannelBinding.user_id == auth.user_id,
                ChannelBotAgentLink.user_id == auth.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            )
            .execution_options(populate_existing=True)
            .with_for_update(of=ChannelBinding)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="binding not found")
    binding, link = row
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=link.agent_id)
    discord_guild_id = (
        _discord_binding_guild_id(binding) if account.provider == CHANNEL_PROVIDER_DISCORD else None
    )

    if binding.status != BINDING_STATUS_ACTIVE:
        return ChannelBindingDeleteResponse(
            binding_id=binding.id,
            unpaired=False,
            notification_status="not_applicable",
            provider_cleanup_status="not_applicable",
        )

    binding.status = BINDING_STATUS_ARCHIVED
    await consume_pending_inbound_messages_for_bindings(db, bindings=[binding])
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        action="channel.binding.archive",
        resource_type="channel_binding",
        resource_id=str(binding.id),
        environment_id=link.agent_id,
        channel_account_id=account.id,
        channel_agent_link_id=link.id,
        source="api.channels",
        details={
            "provider": account.provider,
            "external_chat_id": binding.external_chat_id,
        },
    )
    # Authority commits before any provider I/O. Notification or provider cleanup
    # failure can never roll back a completed unpair.
    await db.commit()

    notification_status = "not_applicable"
    provider_cleanup_status = "not_applicable"
    warning: str | None = None
    if account.provider == CHANNEL_PROVIDER_TELEGRAM:
        from app.routes.channel_routers.telegram import (
            reconcile_telegram_binding_unpair_from_ui,
        )

        outcome = await reconcile_telegram_binding_unpair_from_ui(
            db=db,
            account=account,
            link=link,
            binding=binding,
        )
        notification_status = "sent" if outcome.notification_sent else "failed"
        provider_cleanup_status = (
            "succeeded" if outcome.commands_cleared and outcome.menu_reset else "failed"
        )
        if notification_status == "failed" or provider_cleanup_status == "failed":
            warning = (
                "Chat was unpaired, but Telegram notification or per-chat cleanup did not complete."
            )
        record_control_plane_audit(
            db,
            actor_type="user",
            actor_user_id=auth.user_id,
            target_user_id=auth.user_id,
            action="channel.binding.telegram_cleanup",
            resource_type="channel_binding",
            resource_id=str(binding.id),
            environment_id=link.agent_id,
            channel_account_id=account.id,
            channel_agent_link_id=link.id,
            source="api.channels",
            details={
                "notification_status": notification_status,
                "provider_cleanup_status": provider_cleanup_status,
            },
        )
        await db.commit()
    elif account.provider == CHANNEL_PROVIDER_DISCORD and discord_guild_id is not None:
        from app.routes.channel_routers.discord import (
            cleanup_discord_guild_commands_after_authority_revoked,
        )

        cleanup_succeeded = await cleanup_discord_guild_commands_after_authority_revoked(
            account_id=account.id,
            bot_agent_link_id=link.id,
            guild_ids={discord_guild_id},
        )
        provider_cleanup_status = "succeeded" if cleanup_succeeded else "failed"
        if not cleanup_succeeded:
            warning = "Chat was unpaired, but Discord server command cleanup did not complete."
        record_control_plane_audit(
            db,
            actor_type="user",
            actor_user_id=auth.user_id,
            target_user_id=auth.user_id,
            action="channel.binding.discord_cleanup",
            resource_type="channel_binding",
            resource_id=str(binding.id),
            environment_id=link.agent_id,
            channel_account_id=account.id,
            channel_agent_link_id=link.id,
            source="api.channels",
            details={
                "guild_id": discord_guild_id,
                "provider_cleanup_status": provider_cleanup_status,
            },
        )
        await db.commit()

    return ChannelBindingDeleteResponse(
        binding_id=binding.id,
        unpaired=True,
        notification_status=notification_status,
        provider_cleanup_status=provider_cleanup_status,
        warning=warning,
    )


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
    if account.provider == CHANNEL_PROVIDER_DISCORD and commands is None and body.guild_id is None:
        mark_discord_reserved_commands_current(account)
        await db.commit()
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
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=requested_agent_id,
        )
        return requested_agent_id
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        await get_owned_agent_or_404(
            db,
            user_id=auth.user_id,
            agent_id=auth.api_key.environment_id,
        )
        await get_strict_v2_hosted_channel_agent_or_409(
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
    provider: str,
) -> UUID | None:
    if requested_agent_id is not None:
        await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=requested_agent_id)
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=requested_agent_id,
        )
        return requested_agent_id
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        await get_owned_agent_or_404(
            db,
            user_id=auth.user_id,
            agent_id=auth.api_key.environment_id,
        )
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=auth.api_key.environment_id,
        )
        return auth.api_key.environment_id
    agent_ids = await list_strict_v2_hosted_channel_agent_ids(
        db,
        user_id=auth.user_id,
        provider=provider,
    )
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
        link = await get_owned_bot_agent_link(
            db,
            account=account,
            link_id=body.agent_link_id,
            user_id=auth.user_id,
        )
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=link.agent_id,
            lock_runtime_fence=True,
        )
        if not await bot_agent_link_has_strict_v2_authority(db, link=link):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This Agent Link has no managed runtime authority.",
            )
        await ensure_bot_agent_link_provider_cardinality_or_409(
            db,
            account=account,
            link=link,
        )
        return link, None
    if body.agent_id is not None:
        await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=body.agent_id)
        link, agent_token = await get_or_create_bot_agent_link(
            db,
            account=account,
            agent_id=body.agent_id,
            user_id=auth.user_id,
        )
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=link.agent_id,
            lock_runtime_fence=True,
        )
        if not await bot_agent_link_has_strict_v2_authority(db, link=link):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This Agent Link has no managed runtime authority.",
            )
        await ensure_bot_agent_link_provider_cardinality_or_409(
            db,
            account=account,
            link=link,
        )
        return link, agent_token
    links = await list_owned_active_bot_agent_links(db, account=account, user_id=auth.user_id)
    if len(links) == 1:
        await get_strict_v2_hosted_channel_agent_or_409(
            db,
            user_id=auth.user_id,
            agent_id=links[0].agent_id,
            lock_runtime_fence=True,
        )
        if not await bot_agent_link_has_strict_v2_authority(db, link=links[0]):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This Agent Link has no managed runtime authority.",
            )
        await ensure_bot_agent_link_provider_cardinality_or_409(
            db,
            account=account,
            link=links[0],
        )
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
            ChannelBotAgentLink,
            and_(
                ChannelBotAgentLink.account_id == ChannelAccount.id,
                ChannelBotAgentLink.user_id == user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
            ),
        )
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
                and_(
                    ChannelAccount.user_id == user_id,
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PRIVATE,
                ),
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                    ChannelAccount.user_id.is_(None),
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                    or_(
                        ChannelBotAgentLink.id.is_not(None),
                        ChannelBinding.id.is_not(None),
                    ),
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


async def _channel_health_items(
    db: AsyncSession,
    *,
    accounts: list[ChannelAccount],
    user_id: UUID,
) -> list[ChannelHealthItemResponse]:
    if not accounts:
        return []
    account_ids = [account.id for account in accounts]

    pending_inbox_rows = await db.execute(
        select(
            ChannelMessage.account_id,
            func.count(ChannelMessage.id),
            func.min(ChannelMessage.created_at),
        )
        .join(
            ChannelBinding,
            and_(
                ChannelBinding.id == ChannelMessage.binding_id,
                ChannelBinding.account_id == ChannelMessage.account_id,
                ChannelBinding.bot_agent_link_id == ChannelMessage.bot_agent_link_id,
                ChannelBinding.user_id == ChannelMessage.user_id,
            ),
        )
        .join(
            ChannelBotAgentLink,
            and_(
                ChannelBotAgentLink.id == ChannelMessage.bot_agent_link_id,
                ChannelBotAgentLink.account_id == ChannelMessage.account_id,
            ),
        )
        .join(ChannelAccount, ChannelAccount.id == ChannelMessage.account_id)
        .where(
            ChannelMessage.account_id.in_(account_ids),
            ChannelMessage.user_id == user_id,
            ChannelMessage.direction == "inbound",
            ChannelMessage.binding_id.is_not(None),
            ChannelMessage.delivered_at.is_(None),
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
            ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
            ChannelBotAgentLink.archived_at.is_(None),
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
        .group_by(ChannelMessage.account_id)
    )
    pending_inbox_by_account = {
        account_id: (int(count), oldest_pending_at)
        for account_id, count, oldest_pending_at in pending_inbox_rows.all()
    }

    delivery_rows = await db.execute(
        select(
            ChannelDelivery.account_id,
            func.count(ChannelDelivery.id)
            .filter(ChannelDelivery.status == DELIVERY_STATUS_PENDING)
            .label("pending_count"),
            func.count(ChannelDelivery.id)
            .filter(ChannelDelivery.status == DELIVERY_STATUS_IN_PROGRESS)
            .label("in_progress_count"),
            func.count(ChannelDelivery.id)
            .filter(ChannelDelivery.status == DELIVERY_STATUS_FAILED)
            .label("failed_count"),
        )
        .where(
            ChannelDelivery.account_id.in_(account_ids),
            ChannelDelivery.user_id == user_id,
        )
        .group_by(ChannelDelivery.account_id)
    )
    delivery_counts_by_account = {
        account_id: (int(pending), int(in_progress), int(failed))
        for account_id, pending, in_progress, failed in delivery_rows.all()
    }

    message_rows = await db.execute(
        select(ChannelMessage.account_id, func.max(ChannelMessage.created_at))
        .where(
            ChannelMessage.account_id.in_(account_ids),
            ChannelMessage.user_id == user_id,
        )
        .group_by(ChannelMessage.account_id)
    )
    last_message_by_account: dict[UUID, datetime] = {
        account_id: timestamp for account_id, timestamp in message_rows.tuples().all()
    }

    event_rows = await db.execute(
        select(ChannelDebugEvent.account_id, func.max(ChannelDebugEvent.created_at))
        .where(
            ChannelDebugEvent.account_id.in_(account_ids),
            ChannelDebugEvent.user_id == user_id,
        )
        .group_by(ChannelDebugEvent.account_id)
    )
    last_event_by_account: dict[UUID, datetime] = {
        account_id: timestamp
        for account_id, timestamp in event_rows.tuples().all()
        if account_id is not None
    }

    debug_error_ranked = (
        select(
            ChannelDebugEvent.account_id,
            ChannelDebugEvent.created_at,
            ChannelDebugEvent.stage,
            ChannelDebugEvent.outcome,
            ChannelDebugEvent.error,
            func.row_number()
            .over(
                partition_by=ChannelDebugEvent.account_id,
                order_by=(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc()),
            )
            .label("row_number"),
        )
        .where(
            ChannelDebugEvent.account_id.in_(account_ids),
            ChannelDebugEvent.user_id == user_id,
            or_(
                ChannelDebugEvent.outcome == "failure",
                ChannelDebugEvent.error.is_not(None),
            ),
        )
        .subquery()
    )
    debug_error_rows = await db.execute(
        select(
            debug_error_ranked.c.account_id,
            debug_error_ranked.c.created_at,
            debug_error_ranked.c.stage,
            debug_error_ranked.c.outcome,
            debug_error_ranked.c.error,
        ).where(debug_error_ranked.c.row_number == 1)
    )
    debug_error_by_account = {
        account_id: (created_at, stage, outcome, error)
        for account_id, created_at, stage, outcome, error in debug_error_rows.all()
    }

    delivery_error_ranked = (
        select(
            ChannelDelivery.account_id,
            ChannelDelivery.updated_at,
            ChannelDelivery.last_error,
            func.row_number()
            .over(
                partition_by=ChannelDelivery.account_id,
                order_by=(ChannelDelivery.updated_at.desc(), ChannelDelivery.id.desc()),
            )
            .label("row_number"),
        )
        .where(
            ChannelDelivery.account_id.in_(account_ids),
            ChannelDelivery.user_id == user_id,
            ChannelDelivery.last_error.is_not(None),
        )
        .subquery()
    )
    delivery_error_rows = await db.execute(
        select(
            delivery_error_ranked.c.account_id,
            delivery_error_ranked.c.updated_at,
            delivery_error_ranked.c.last_error,
        ).where(delivery_error_ranked.c.row_number == 1)
    )
    delivery_error_by_account = {
        account_id: (updated_at, last_error)
        for account_id, updated_at, last_error in delivery_error_rows.all()
    }

    return [
        _channel_health_item(
            account=account,
            pending_inbox_stats=pending_inbox_by_account.get(account.id, (0, None)),
            delivery_counts=delivery_counts_by_account.get(account.id, (0, 0, 0)),
            last_message_at=last_message_by_account.get(account.id),
            last_event_at=last_event_by_account.get(account.id),
            debug_error=debug_error_by_account.get(account.id),
            delivery_error=delivery_error_by_account.get(account.id),
        )
        for account in accounts
    ]


def _channel_health_item(
    *,
    account: ChannelAccount,
    pending_inbox_stats: tuple[int, datetime | None],
    delivery_counts: tuple[int, int, int],
    last_message_at: datetime | None,
    last_event_at: datetime | None,
    debug_error: tuple[datetime, str, str, str | None] | None,
    delivery_error: tuple[datetime, str] | None,
) -> ChannelHealthItemResponse:
    pending_inbox, oldest_pending_inbox_at = pending_inbox_stats
    pending_deliveries, in_progress_deliveries, failed_deliveries = delivery_counts
    last_error_at = None
    last_error = None
    last_error_stage = None
    last_error_outcome = None
    if debug_error is not None:
        last_error_at, last_error_stage, last_error_outcome, raw_error = debug_error
        last_error = public_channel_operation_error(raw_error)
    if delivery_error is not None and (last_error_at is None or delivery_error[0] > last_error_at):
        last_error_at = delivery_error[0]
        last_error = public_channel_delivery_error(delivery_error[1])
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
        visibility=_channel_visibility(account),
        channel_status=account.status,
        health_status=health_status,
        reasons=reasons,
        pending_inbox=pending_inbox,
        oldest_pending_inbox_at=oldest_pending_inbox_at,
        pending_deliveries=pending_deliveries,
        in_progress_deliveries=in_progress_deliveries,
        failed_deliveries=failed_deliveries,
        last_message_at=last_message_at,
        last_event_at=last_event_at,
        last_error_at=last_error_at,
        last_error=last_error,
        last_error_stage=last_error_stage,
        last_error_outcome=last_error_outcome,
        native_transport=_native_transport_health(account),
    )


def _native_transport_health(account: ChannelAccount) -> dict[str, Any] | None:
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        return None
    from app.services.whatsapp_provider_bridge import whatsapp_provider_transport_status

    return whatsapp_provider_transport_status(account.id).as_dict()


def _telegram_bot_username(account: ChannelAccount) -> str | None:
    if account.provider != CHANNEL_PROVIDER_TELEGRAM or not isinstance(account.config, dict):
        return None
    value = account.config.get("bot_username")
    if not isinstance(value, str):
        return None
    return normalize_telegram_bot_username(value)
