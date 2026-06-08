from __future__ import annotations

from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
)
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    require_user_auth,
)
from app.core.database import get_session
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    CHANNEL_PROVIDERS,
    CHANNEL_STATUS_ACTIVE,
    CHANNEL_VISIBILITY_PUBLIC,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
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
    ChannelAgentLinkCreate,
    ChannelAgentLinkResponse,
    ChannelBindingResponse,
    ChannelCommandSyncRequest,
    ChannelCommandSyncResponse,
    ChannelMessageResponse,
    ChannelPairCodeCreate,
    ChannelPairCodeResponse,
    ChannelSendMessageRequest,
)
from app.services.agent_bindings import get_owned_agent_or_404
from app.services.channels import (
    archive_channel_account,
    create_pair_code,
    encrypt_optional_token,
    enqueue_channel_outbound_message,
    generate_agent_token,
    generate_webhook_secret,
    get_accessible_channel_account,
    get_or_create_bot_agent_link,
    get_owned_bot_agent_link,
    get_owned_channel_account,
    hash_token,
    list_owned_active_bot_agent_links,
    rotate_bot_agent_link_token,
    store_channel_secrets,
    sync_channel_commands,
)

router = APIRouter(prefix="/api/channels", tags=["channels"])


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


@router.get("")
async def list_channels(
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ChannelAccountResponse]:
    result = await db.execute(
        select(ChannelAccount)
        .where(
            ChannelAccount.archived_at.is_(None),
            or_(
                ChannelAccount.user_id == auth.user_id,
                and_(
                    ChannelAccount.visibility == CHANNEL_VISIBILITY_PUBLIC,
                    ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ),
            ),
        )
        .order_by(ChannelAccount.provider, ChannelAccount.visibility, ChannelAccount.name)
    )
    return [_account_response(account) for account in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_channel(
    body: ChannelAccountCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelAccountCreatedResponse:
    if body.provider not in CHANNEL_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unsupported provider")
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
    account = await get_owned_channel_account(db, account_id=account_id, user_id=auth.user_id)
    await archive_channel_account(db, account=account)
    await db.commit()


@router.post("/{account_id}/pair-codes", status_code=status.HTTP_201_CREATED)
async def create_channel_pair_code(
    account_id: UUID,
    body: ChannelPairCodeCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ChannelPairCodeResponse:
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    link, agent_token = await _resolve_pair_code_link(db, auth=auth, account=account, body=body)
    created = await create_pair_code(
        db,
        account=account,
        link=link,
        ttl_seconds=body.ttl_seconds,
        agent_token=agent_token,
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
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    agent_id = await _resolve_agent_id_for_link(db, auth=auth, requested_agent_id=body.agent_id)
    link, agent_token = await get_or_create_bot_agent_link(
        db,
        account=account,
        agent_id=agent_id,
        user_id=auth.user_id,
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
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
    link = await get_owned_bot_agent_link(
        db, account=account, link_id=link_id, user_id=auth.user_id
    )
    agent_token = await rotate_bot_agent_link_token(db, account=account, link=link)
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
    account = await get_owned_channel_account(db, account_id=account_id, user_id=auth.user_id)
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
    account = await get_accessible_channel_account(db, account_id=account_id, user_id=auth.user_id)
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
