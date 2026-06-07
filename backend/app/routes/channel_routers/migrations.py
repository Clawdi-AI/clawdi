from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth
from app.core.database import get_session
from app.models.channel import CHANNEL_PROVIDERS
from app.services.agent_bindings import get_owned_agent_or_404
from app.services.msg_router_migration import (
    MsgRouterMigrationImportResult,
    import_msg_router_migration_dump,
    validate_migration_dump,
)

router = APIRouter(prefix="/api/channels/migrations/msg-router", tags=["channels"])


@router.post("/import-tenant")
async def import_msg_router_tenant(
    request: Request,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid json body",
        ) from exc
    if not isinstance(body, Mapping):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="body must be an object",
        )
    validation_error = validate_migration_dump(body)
    if validation_error is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=validation_error)

    agent_id = await _migration_agent_id(body, auth=auth, db=db)
    provider_tokens = _provider_tokens(body)
    discord_base_url = _optional_str(body.get("discord_base_url", body.get("discordBaseUrl")))

    result = await import_msg_router_migration_dump(
        db,
        user_id=auth.user_id,
        agent_id=agent_id,
        dump=body,
        provider_tokens=provider_tokens,
        discord_base_url=discord_base_url or "https://discord.com",
    )
    await db.commit()
    return _migration_import_response(result)


async def _migration_agent_id(
    body: Mapping[str, Any],
    *,
    auth: AuthContext,
    db: AsyncSession,
) -> UUID:
    raw_agent_id = body.get("agent_id", body.get("agentId"))
    if raw_agent_id is None:
        if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
            await get_owned_agent_or_404(
                db,
                user_id=auth.user_id,
                agent_id=auth.api_key.environment_id,
            )
            return auth.api_key.environment_id
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="agent_id is required",
        )
    try:
        agent_id = UUID(str(raw_agent_id))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="agent_id must be a UUID",
        ) from exc
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    return agent_id


def _provider_tokens(body: Mapping[str, Any]) -> dict[str, str] | None:
    value = body.get("provider_tokens", body.get("providerTokens"))
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="provider_tokens must be an object",
        )
    tokens: dict[str, str] = {}
    for provider, token in value.items():
        provider_name = str(provider)
        if provider_name not in CHANNEL_PROVIDERS:
            continue
        if not isinstance(token, str) or not token.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"provider_tokens.{provider_name} must be a non-empty string",
            )
        tokens[provider_name] = token.strip()
    return tokens


def _optional_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _migration_import_response(result: MsgRouterMigrationImportResult) -> dict[str, Any]:
    return {
        "channelAccounts": {
            provider: {
                "accountId": str(account.account_id),
                "provider": account.provider,
            }
            for provider, account in result.channel_accounts.items()
        },
        "channelTokens": result.channel_tokens,
        "webhookSecrets": result.webhook_secrets,
        "bindingsImported": result.bindings_imported,
        "bindingsSkipped": [
            {
                "channel": skip.channel,
                "routeKey": skip.route_key,
                "reason": skip.reason,
            }
            for skip in result.bindings_skipped
        ],
    }
