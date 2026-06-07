from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.models.channel import CHANNEL_PROVIDER_IMESSAGE, ChannelAccount
from app.services.channels import ChannelAgentContext, resolve_channel_agent_by_token


@dataclass(frozen=True)
class BlueBubblesAuth:
    token: str | None


type BlueBubblesAccount = ChannelAccount
type BlueBubblesAgent = ChannelAgentContext


def bluebubbles_auth(
    password: str | None = Query(default=None),
    x_api_key: str | None = Header(default=None),
    x_password: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> BlueBubblesAuth:
    return BlueBubblesAuth(
        token=_optional_str(password)
        or _optional_str(x_api_key)
        or _optional_str(x_password)
        or _extract_bearer_token(authorization)
    )


async def bluebubbles_account(
    db: AsyncSession = Depends(get_session),
    auth: BlueBubblesAuth = Depends(bluebubbles_auth),
) -> ChannelAccount:
    return (await bluebubbles_agent(db=db, auth=auth)).account


async def bluebubbles_agent(
    db: AsyncSession = Depends(get_session),
    auth: BlueBubblesAuth = Depends(bluebubbles_auth),
) -> ChannelAgentContext:
    if auth.token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing agent token")
    return await resolve_channel_agent_by_token(
        db,
        provider=CHANNEL_PROVIDER_IMESSAGE,
        token=auth.token,
    )


def _optional_str(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, int):
        return str(value)
    return None


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()
