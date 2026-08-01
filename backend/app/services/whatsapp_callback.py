from __future__ import annotations

import hashlib
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    BOT_AGENT_LINK_STATUS_ACTIVE,
    ChannelAccount,
    ChannelBinding,
    ChannelBindingAlias,
    ChannelBotAgentLink,
    ChannelDebugEvent,
)
from app.models.session import AgentEnvironment
from app.schemas.whatsapp_callback import WhatsAppSidecarEvent

WHATSAPP_SIDECAR_INGRESS_SECRET_NAME = "whatsapp_sidecar_ingress_token"
WHATSAPP_IGNORED_CALLBACK_STAGE = "whatsapp_callback_ignored"
MAX_IGNORED_CALLBACK_RECEIPTS_PER_ACCOUNT = 1_000


@dataclass(frozen=True)
class WhatsAppBindingLookup:
    binding: ChannelBinding | None
    conflict: bool = False


async def resolve_whatsapp_callback_binding(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    chat_jid: str,
    chat_jid_alt: str | None,
) -> WhatsAppBindingLookup:
    matches: dict[UUID, ChannelBinding] = {}
    for candidate in _explicit_chat_identities(chat_jid, chat_jid_alt):
        direct = (
            await db.execute(
                select(ChannelBinding).where(
                    ChannelBinding.account_id == account.id,
                    ChannelBinding.external_chat_id == candidate,
                    ChannelBinding.status == BINDING_STATUS_ACTIVE,
                )
            )
        ).scalar_one_or_none()
        if direct is not None:
            matches[direct.id] = direct
        alias_binding = (
            await db.execute(
                select(ChannelBinding)
                .join(ChannelBindingAlias, ChannelBindingAlias.binding_id == ChannelBinding.id)
                .where(
                    ChannelBindingAlias.account_id == account.id,
                    ChannelBindingAlias.alias_external_chat_id == candidate,
                    ChannelBinding.status == BINDING_STATUS_ACTIVE,
                )
            )
        ).scalar_one_or_none()
        if alias_binding is not None:
            matches[alias_binding.id] = alias_binding
    if len(matches) > 1:
        return WhatsAppBindingLookup(binding=None, conflict=True)
    binding = next(iter(matches.values()), None)
    if binding is not None:
        await ensure_callback_binding_authority(db, account=account, binding=binding)
    return WhatsAppBindingLookup(binding=binding)


async def ensure_callback_binding_authority(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    binding: ChannelBinding,
) -> ChannelBotAgentLink:
    if binding.account_id != account.id or binding.status != BINDING_STATUS_ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="binding authority is no longer active",
        )
    link = (
        await db.execute(
            select(ChannelBotAgentLink)
            .join(AgentEnvironment, AgentEnvironment.id == ChannelBotAgentLink.agent_id)
            .where(
                ChannelBotAgentLink.id == binding.bot_agent_link_id,
                ChannelBotAgentLink.account_id == account.id,
                ChannelBotAgentLink.user_id == binding.user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                AgentEnvironment.user_id == binding.user_id,
            )
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="binding authority is no longer active",
        )
    return link


def ensure_whatsapp_actor_ownership(event: WhatsAppSidecarEvent, binding: ChannelBinding) -> None:
    paired_actor = binding.paired_external_user_id
    if paired_actor is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="binding has no paired actor authority",
        )
    actor_identities = {event.actor.primary, event.actor.alt} - {None}
    if paired_actor not in actor_identities:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="message actor does not own this binding",
        )


async def remember_explicit_whatsapp_chat_alias(
    db: AsyncSession,
    *,
    binding: ChannelBinding,
    chat_jid: str,
    chat_jid_alt: str | None,
) -> None:
    if chat_jid_alt is None:
        return
    candidates = _explicit_chat_identities(chat_jid, chat_jid_alt)
    aliases = (
        tuple(item for item in candidates if item != binding.external_chat_id)
        if binding.external_chat_id in candidates
        else candidates
    )
    await db.execute(
        select(ChannelAccount.id).where(ChannelAccount.id == binding.account_id).with_for_update()
    )
    for alias_jid in aliases:
        direct = (
            await db.execute(
                select(ChannelBinding).where(
                    ChannelBinding.account_id == binding.account_id,
                    ChannelBinding.external_chat_id == alias_jid,
                    ChannelBinding.status == BINDING_STATUS_ACTIVE,
                )
            )
        ).scalar_one_or_none()
        if direct is not None:
            if direct.id != binding.id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="WhatsApp chat aliases resolve to different bindings",
                )
            continue
        existing = (
            await db.execute(
                select(ChannelBindingAlias).where(
                    ChannelBindingAlias.account_id == binding.account_id,
                    ChannelBindingAlias.alias_external_chat_id == alias_jid,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            if existing.binding_id != binding.id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="WhatsApp chat aliases resolve to different bindings",
                )
            continue
        try:
            async with db.begin_nested():
                db.add(
                    ChannelBindingAlias(
                        account_id=binding.account_id,
                        bot_agent_link_id=binding.bot_agent_link_id,
                        binding_id=binding.id,
                        user_id=binding.user_id,
                        alias_external_chat_id=alias_jid,
                        alias_kind="whatsapp_explicit_pn_lid",
                    )
                )
                await db.flush()
        except IntegrityError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="WhatsApp chat alias is already bound",
            ) from exc


def stable_whatsapp_message_id(namespace: str, *identities: object) -> str:
    material = ":".join(("clawdi-whatsapp", namespace, *(str(item) for item in identities)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest().upper()


def _explicit_chat_identities(chat_jid: str, chat_jid_alt: str | None) -> tuple[str, ...]:
    return (chat_jid,) if chat_jid_alt is None else (chat_jid, chat_jid_alt)


async def ignored_whatsapp_callback_exists(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    provider_event_id: str,
) -> bool:
    receipt_id = (
        await db.execute(
            select(ChannelDebugEvent.id)
            .where(
                ChannelDebugEvent.account_id == account.id,
                ChannelDebugEvent.provider == account.provider,
                ChannelDebugEvent.direction == "inbound",
                ChannelDebugEvent.stage == WHATSAPP_IGNORED_CALLBACK_STAGE,
                ChannelDebugEvent.request_id == provider_event_id,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return receipt_id is not None


async def record_ignored_whatsapp_callback(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    provider_event_id: str,
    reason: str,
) -> bool:
    """Persist a bounded receipt without creating an Agent inbox message.

    The account row lock makes the lookup/insert deterministic for concurrent
    retries while keeping unpaired and self-authored traffic outside
    ChannelMessage entirely.
    """
    await db.execute(
        select(ChannelAccount.id).where(ChannelAccount.id == account.id).with_for_update()
    )
    if await ignored_whatsapp_callback_exists(
        db,
        account=account,
        provider_event_id=provider_event_id,
    ):
        return False
    db.add(
        ChannelDebugEvent(
            account_id=account.id,
            user_id=account.user_id,
            provider=account.provider,
            external_chat_id=None,
            direction="inbound",
            stage=WHATSAPP_IGNORED_CALLBACK_STAGE,
            outcome="ignored",
            request_id=provider_event_id,
            details={"reason": reason},
        )
    )
    await db.flush()
    stale_ids = (
        select(ChannelDebugEvent.id)
        .where(
            ChannelDebugEvent.account_id == account.id,
            ChannelDebugEvent.provider == account.provider,
            ChannelDebugEvent.direction == "inbound",
            ChannelDebugEvent.stage == WHATSAPP_IGNORED_CALLBACK_STAGE,
        )
        .order_by(ChannelDebugEvent.created_at.desc(), ChannelDebugEvent.id.desc())
        .offset(MAX_IGNORED_CALLBACK_RECEIPTS_PER_ACCOUNT)
    )
    await db.execute(delete(ChannelDebugEvent).where(ChannelDebugEvent.id.in_(stale_ids)))
    return True
