"""Admin endpoints — gated by `X-Admin-Key` shared secret.

Used by upstream-SaaS batch tooling and ops-side scripts that don't
have a per-user Clerk JWT available (e.g. catching up legacy
deployments that pre-date live sync, account-deletion webhooks, fleet
revocation). Disabled by default — `settings.admin_api_key` must be
set to a strong secret to enable.

**Trust model:** admin-minted keys carry the same authority as keys
the user mints for themselves via `POST /v1/auth/keys` — full
account access by default. The X-Admin-Key is therefore a root
credential: a leak grants an attacker the ability to mint full-power
keys for any user. Protect it like a database password (rotate on
suspicion, restrict to SaaS backend egress IPs at the infra layer,
audit log access).

The product reasoning: a user's hosted pod is the user's agent
running on our infrastructure — it must be able to do everything
the user can do on their own laptop. Capping admin-minted keys
below user-mint power would make hosted strictly weaker than
self-managed (vault reads, memory reads, etc. would silently fail).

Surface kept minimal: just the operations that batch tooling
genuinely can't accomplish via per-user Clerk JWTs. Future admin
endpoints (list users, view any deployment, audit-log query, etc.)
can land in this file under the same auth dep.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_admin_api_key
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.channel import (
    CHANNEL_PROVIDERS,
    ChannelAccount,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.models.user import User
from app.schemas.admin import (
    AdminAgentCreate,
    AdminApiKeyCreate,
    AdminChannelCreate,
    AdminChannelCreatedResponse,
    AdminChannelResponse,
    AdminChannelUpdate,
    AdminChannelVisibility,
    AdminChannelWebhookSecretResponse,
    AdminEnvironmentCreate,
    AdminManagedAiProviderResponse,
    AdminManagedAiProviderUpsert,
    AdminRuntimeStateResponse,
    AdminRuntimeStateUpsert,
)
from app.schemas.api_key import ApiKeyCreated, ApiKeyRevokeResponse
from app.schemas.channel import ChannelCommandSyncRequest, ChannelCommandSyncResponse
from app.schemas.session import EnvironmentCreatedResponse
from app.services.agent_environments import (
    AgentEnvironmentIdConflict,
    local_machine_registration_key,
    register_agent_environment,
)
from app.services.api_key import mint_api_key
from app.services.audit import record_control_plane_audit
from app.services.channel_config import validate_channel_account_config_urls
from app.services.channels import (
    archive_channel_account,
    channel_webhook_url,
    encrypt_optional_token,
    generate_webhook_secret,
    hash_token,
    store_channel_secrets,
    sync_channel_commands,
    upsert_channel_secrets,
)
from app.services.managed_ai_provider import (
    MANAGED_AI_PROVIDER_API_MODE,
    MANAGED_AI_PROVIDER_ID,
    MANAGED_AI_PROVIDER_RUNTIME_ENV,
    upsert_clawdi_managed_provider,
)
from app.services.user_provisioning import lazy_create_user_with_personal_project

logger = logging.getLogger(__name__)

# `include_in_schema=False`: admin endpoints are server-to-server only
# (SaaS batch tooling + ops scripts). Excluding them from /openapi.json
# stops `bun run generate-api` (web/CLI typed-client codegen) from
# emitting bindings for them, so a leaked frontend bundle can't even
# tell admin endpoints exist let alone what header they expect. The
# routes themselves stay live — gating is `require_admin_api_key`.
router = APIRouter(prefix="/admin", tags=["admin"], include_in_schema=False)


async def _resolve_or_create_user(db: AsyncSession, clerk_id: str) -> User:
    """Resolve a user by clerk_id, lazy-creating the row + Personal
    project if needed.

    The lazy-create exists for the common SaaS-deploy entry path
    where a user clicks Deploy on clawdi.ai before ever signing
    into cloud.clawdi.ai directly. Without it the admin endpoint
    would 404, the SaaS would catch the error, the pod would deploy
    without sync, and the user would have to redeploy after their
    first direct visit.

    Trust model: `clerk_id` here is value the SaaS already
    authenticated against the user's Clerk session — the shared
    `X-Admin-Key` gate trusts first-party server-to-server callers.
    Email/name are unknown (no JWT available); the row starts with
    `email=None` and the JWT path backfills on first direct sign-in.

    Race-loser status is 500 (not 401): admin callers are
    first-party SaaS code, so a vanishing-winner-row situation is
    an operational anomaly worth a loud failure rather than a
    user-flow retry.
    """
    target = (await db.execute(select(User).where(User.clerk_id == clerk_id))).scalar_one_or_none()
    if target is not None:
        return target

    user = await lazy_create_user_with_personal_project(
        db,
        clerk_id=clerk_id,
        email=None,
        name=None,
        race_loser_status=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
    logger.info("admin_lazy_create_user clerk_id=%s user_id=%s", clerk_id, user.id)
    return user


@router.post("/auth/keys", response_model=ApiKeyCreated)
async def admin_mint_api_key(
    body: AdminApiKeyCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyCreated:
    """Mint an api_key on behalf of a user identified by Clerk id.

    Used by upstream-SaaS batch tooling: each legacy deployment that
    didn't have live sync wired up needs a fresh api_key bound to a
    fresh env, but the migration script has no per-user Clerk JWT.

    User row is lazy-created if absent — handles the common entry
    path of a user whose first interaction with cloud-api is via
    SaaS-side admin calls. See `_resolve_or_create_user` for the
    safety model.
    """
    target = await _resolve_or_create_user(db, body.target_clerk_id)

    env_uuid: UUID | None = None
    if body.environment_id:
        try:
            env_uuid = UUID(body.environment_id)
        except (TypeError, ValueError) as e:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "environment_id is not a valid UUID"
            ) from e

    # `scopes=None` is full API permission access — same default as
    # user-self-mint via `POST /v1/auth/keys`. Callers may pass a
    # narrower permission list to lock the minted key down (e.g. ops
    # tooling that only needs to push sessions); the route doesn't
    # impose a ceiling.
    try:
        minted = await mint_api_key(
            db,
            user_id=target.id,
            label=body.label,
            scopes=body.scopes,
            environment_id=env_uuid,
        )
    except ValueError as e:
        # `mint_api_key` raises ValueError for cross-tenant
        # environment_id (env not owned by target user). Surface
        # as 403 — admin can't bypass the service-layer invariant.
        # Log so an operator debugging "why is the mint failing?"
        # can grep cloud-api logs directly without correlating with
        # the SaaS side.
        logger.warning(
            "admin_mint_rejected reason=cross_tenant_env target_clerk_id=%s env=%s",
            body.target_clerk_id,
            env_uuid,
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    api_key = minted.api_key
    logger.info(
        "admin_api_key_minted target_clerk_id=%s key_id=%s environment_id=%s",
        body.target_clerk_id,
        api_key.id,
        api_key.environment_id,
    )
    return ApiKeyCreated(
        id=str(api_key.id),
        label=api_key.label,
        key_prefix=api_key.key_prefix,
        created_at=api_key.created_at,
        last_used_at=api_key.last_used_at,
        expires_at=api_key.expires_at,
        revoked_at=api_key.revoked_at,
        raw_key=minted.raw_key,
    )


@router.delete("/auth/keys/{key_id}", response_model=ApiKeyRevokeResponse)
async def admin_revoke_api_key(
    key_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyRevokeResponse:
    """Revoke any user's api_key. Used by SaaS admin/account-deletion
    paths (which don't have the user's Clerk JWT) to close the
    orphan-key gap from the cross-PR audit."""
    api_key = (await db.execute(select(ApiKey).where(ApiKey.id == key_id))).scalar_one_or_none()
    if api_key is None:
        # 404 = idempotent success for the caller. The migration
        # script can re-run after a partial failure without
        # special-casing already-revoked keys.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")

    if api_key.revoked_at is not None:
        # Already revoked — idempotent, return existing state.
        return ApiKeyRevokeResponse(status="revoked")

    api_key.revoked_at = datetime.now(UTC)
    await db.commit()
    logger.info(
        "admin_api_key_revoked target_user_id=%s key_id=%s",
        api_key.user_id,
        api_key.id,
    )
    return ApiKeyRevokeResponse(status="revoked")


@router.put(
    f"/ai-providers/{MANAGED_AI_PROVIDER_ID}",
    response_model=AdminManagedAiProviderResponse,
)
async def admin_upsert_clawdi_managed_ai_provider(
    body: AdminManagedAiProviderUpsert,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminManagedAiProviderResponse:
    """Upsert the first-party managed AI provider for a target user.

    This intentionally does not expose a generic admin AI-provider write API.
    Hosted deploy orchestration only needs to install the fixed
    Clawdi-managed OpenAI-compatible chat provider and rotate its key.
    """
    target = await _resolve_or_create_user(db, body.target_clerk_id)
    try:
        provider = await upsert_clawdi_managed_provider(
            db,
            user=target,
            base_url=body.base_url,
            api_key=body.api_key.get_secret_value(),
            default_model=body.default_model,
            models=(
                [model.model_dump(exclude_none=True) for model in body.models]
                if body.models is not None
                else None
            ),
            label=body.label,
            capabilities=body.capabilities,
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e

    record_control_plane_audit(
        db,
        actor_type="admin",
        action="ai_provider.managed.upsert",
        resource_type="ai_provider",
        resource_id=MANAGED_AI_PROVIDER_ID,
        target_user_id=target.id,
        source="api.admin",
        details={
            "provider_id": MANAGED_AI_PROVIDER_ID,
            "api_mode": MANAGED_AI_PROVIDER_API_MODE,
            "runtime_env_name": MANAGED_AI_PROVIDER_RUNTIME_ENV,
            "models": provider.models,
            "has_capabilities": body.capabilities is not None,
        },
    )
    await db.commit()
    await db.refresh(provider)
    logger.info(
        "admin_managed_ai_provider_upserted target_clerk_id=%s provider_id=%s",
        body.target_clerk_id,
        provider.provider_id,
    )
    return AdminManagedAiProviderResponse(
        owner_user_id=target.id,
        owner_clerk_id=target.clerk_id,
        provider_id=provider.provider_id,
        api_mode=provider.api_mode or "",
        runtime_env_name=provider.runtime_env_name or "",
        base_url=provider.base_url,
        models=provider.models,
        has_api_key=True,
    )


@router.get("/channels", response_model=list[AdminChannelResponse])
async def admin_list_channels(
    provider: str | None = None,
    visibility: AdminChannelVisibility | None = None,
    include_archived: bool = False,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> list[AdminChannelResponse]:
    if provider is not None and provider not in CHANNEL_PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unsupported provider")
    filters = []
    if provider is not None:
        filters.append(ChannelAccount.provider == provider)
    if visibility is not None:
        filters.append(ChannelAccount.visibility == visibility)
    if not include_archived:
        filters.append(ChannelAccount.archived_at.is_(None))

    result = await db.execute(
        select(ChannelAccount, User)
        .join(User, User.id == ChannelAccount.user_id)
        .where(*filters)
        .order_by(ChannelAccount.provider, ChannelAccount.visibility, ChannelAccount.name)
    )
    return [_admin_channel_response(account, owner) for account, owner in result.all()]


@router.post(
    "/channels",
    response_model=AdminChannelCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def admin_create_channel(
    body: AdminChannelCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminChannelCreatedResponse:
    await validate_channel_account_config_urls(provider=body.provider, config=body.config)
    target = await _resolve_or_create_user(db, body.target_clerk_id)
    ciphertext, nonce = encrypt_optional_token(body.provider_token)
    webhook_secret = generate_webhook_secret()
    account = ChannelAccount(
        user_id=target.id,
        provider=body.provider,
        name=body.name,
        visibility=body.visibility,
        encrypted_provider_token=ciphertext,
        provider_token_nonce=nonce,
        webhook_secret_hash=hash_token(webhook_secret),
        config=body.config,
    )
    db.add(account)
    try:
        await db.flush()
        await store_channel_secrets(db, account=account, secrets_by_name=body.secrets)
        record_control_plane_audit(
            db,
            actor_type="admin",
            action="channel.account.create",
            resource_type="channel_account",
            resource_id=str(account.id),
            channel_account_id=account.id,
            target_user_id=target.id,
            source="api.admin",
            details={
                "provider": account.provider,
                "visibility": account.visibility,
                "has_provider_credential": body.provider_token is not None,
                "secret_names": sorted((body.secrets or {}).keys()),
            },
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "channel name already exists for this provider and owner",
        ) from exc
    await db.refresh(account)
    logger.info(
        "admin_channel_created target_clerk_id=%s channel_id=%s provider=%s visibility=%s",
        body.target_clerk_id,
        account.id,
        account.provider,
        account.visibility,
    )
    return AdminChannelCreatedResponse(
        **_admin_channel_response(account, target).model_dump(),
        webhook_secret=webhook_secret,
    )


@router.get("/channels/{account_id}", response_model=AdminChannelResponse)
async def admin_get_channel(
    account_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminChannelResponse:
    account, owner = await _admin_get_channel_row(db, account_id=account_id, include_archived=True)
    return _admin_channel_response(account, owner)


@router.patch("/channels/{account_id}", response_model=AdminChannelResponse)
async def admin_update_channel(
    account_id: UUID,
    body: AdminChannelUpdate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminChannelResponse:
    account, owner = await _admin_get_channel_row(db, account_id=account_id)
    updates = body.model_fields_set
    if "name" in updates:
        account.name = body.name or account.name
    if "status" in updates and body.status is not None:
        account.status = body.status
    if "visibility" in updates and body.visibility is not None:
        account.visibility = body.visibility
    if "provider_token" in updates:
        ciphertext, nonce = encrypt_optional_token(body.provider_token)
        account.encrypted_provider_token = ciphertext
        account.provider_token_nonce = nonce
    if "config" in updates:
        await validate_channel_account_config_urls(provider=account.provider, config=body.config)
        account.config = body.config
    try:
        if "secrets" in updates:
            await upsert_channel_secrets(db, account=account, secrets_by_name=body.secrets)
        record_control_plane_audit(
            db,
            actor_type="admin",
            action="channel.account.update",
            resource_type="channel_account",
            resource_id=str(account.id),
            channel_account_id=account.id,
            target_user_id=account.user_id,
            source="api.admin",
            details=_admin_channel_update_audit_details(account, updates, body),
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "channel name already exists for this provider and owner",
        ) from exc
    await db.refresh(account)
    return _admin_channel_response(account, owner)


@router.post(
    "/channels/{account_id}/webhook-secret/rotate",
    response_model=AdminChannelWebhookSecretResponse,
)
async def admin_rotate_channel_webhook_secret(
    account_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminChannelWebhookSecretResponse:
    account, _owner = await _admin_get_channel_row(db, account_id=account_id)
    webhook_secret = generate_webhook_secret()
    account.webhook_secret_hash = hash_token(webhook_secret)
    record_control_plane_audit(
        db,
        actor_type="admin",
        action="channel.webhook_secret.rotate",
        resource_type="channel_account",
        resource_id=str(account.id),
        channel_account_id=account.id,
        target_user_id=account.user_id,
        source="api.admin",
        details={"provider": account.provider},
    )
    await db.commit()
    logger.info("admin_channel_webhook_secret_rotated channel_id=%s", account.id)
    return AdminChannelWebhookSecretResponse(id=account.id, webhook_secret=webhook_secret)


@router.post("/channels/{account_id}/commands/sync", response_model=ChannelCommandSyncResponse)
async def admin_sync_channel_commands(
    account_id: UUID,
    body: ChannelCommandSyncRequest,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> ChannelCommandSyncResponse:
    account, _owner = await _admin_get_channel_row(db, account_id=account_id)
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


@router.delete("/channels/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_channel(
    account_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> None:
    account, _owner = await _admin_get_channel_row(db, account_id=account_id)
    await archive_channel_account(db, account=account)
    record_control_plane_audit(
        db,
        actor_type="admin",
        action="channel.account.archive",
        resource_type="channel_account",
        resource_id=str(account.id),
        channel_account_id=account.id,
        target_user_id=account.user_id,
        source="api.admin",
        details={"provider": account.provider, "visibility": account.visibility},
    )
    await db.commit()
    logger.info("admin_channel_archived channel_id=%s", account.id)


async def _admin_register_environment(
    body: AdminEnvironmentCreate,
    db: AsyncSession,
) -> EnvironmentCreatedResponse:
    target = await _resolve_or_create_user(db, body.target_clerk_id)
    try:
        registered = await register_agent_environment(
            db,
            user_id=target.id,
            machine_id=body.machine_id,
            machine_name=body.machine_name,
            agent_type=body.agent_type,
            agent_version=body.agent_version,
            os_name=body.os_name,
            sort_order=await _next_environment_sort_order(db, target.id),
            environment_id=body.environment_id,
            registration_key=None
            if body.environment_id is not None
            else local_machine_registration_key(body.machine_id, body.agent_type),
        )
        env = registered.env
    except AgentEnvironmentIdConflict as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "concurrent registration race; retry the request",
        ) from None

    logger.info(
        "admin_environment_registered target_clerk_id=%s env_id=%s machine_id=%s explicit_id=%s",
        body.target_clerk_id,
        env.id,
        body.machine_id,
        body.environment_id is not None,
    )
    return EnvironmentCreatedResponse(id=str(env.id))


@router.post("/agents", response_model=EnvironmentCreatedResponse)
async def admin_register_agent(
    body: AdminAgentCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
    return await _admin_register_environment(
        AdminEnvironmentCreate(
            target_clerk_id=body.target_clerk_id,
            environment_id=body.agent_id,
            machine_id=body.machine_id,
            machine_name=body.machine_name,
            agent_type=body.agent_type,
            agent_version=body.agent_version,
            os_name=body.os_name,
        ),
        db,
    )


@router.post(
    "/environments",
    response_model=EnvironmentCreatedResponse,
    deprecated=True,
)
async def admin_register_environment(
    body: AdminEnvironmentCreate,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse:
    """Register an AgentEnvironment row on behalf of a target user.

    Migration tooling needs to seed env_id for legacy deployments
    where no per-user Clerk JWT is in project. The user-facing
    `POST /v1/environments` requires a Clerk-authed or Agent environment
    api_key request; this admin variant is gated by the shared
    `X-Admin-Key` header instead.

    If `environment_id` is supplied, it is the stable agent id and
    machine metadata is refreshed in place. If omitted, legacy callers
    remain idempotent through the local machine registration key.

    User row is lazy-created if absent — see `_resolve_or_create_user`.
    """
    return await _admin_register_environment(body, db)


async def _admin_delete_environment(
    environment_id: UUID,
    db: AsyncSession,
) -> None:
    env = (
        await db.execute(select(AgentEnvironment).where(AgentEnvironment.id == environment_id))
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    await db.delete(env)
    await db.commit()
    logger.info("admin_environment_deleted env_id=%s", environment_id)


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_agent(
    agent_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> None:
    await _admin_delete_environment(agent_id, db)


@router.delete(
    "/environments/{environment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    deprecated=True,
)
async def admin_delete_environment(
    environment_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Delete an AgentEnvironment row on behalf of first-party hosted infra.

    Sessions keep their history via ON DELETE SET NULL, matching the
    user-facing `/v1/environments/{id}` semantics. Unlike the dashboard route,
    first-party cleanup may delete explicit-identity rows.
    """
    await _admin_delete_environment(environment_id, db)


async def _next_environment_sort_order(db: AsyncSession, user_id: UUID) -> int:
    value = (
        await db.execute(
            select(func.coalesce(func.max(AgentEnvironment.sort_order), -1) + 1).where(
                AgentEnvironment.user_id == user_id
            )
        )
    ).scalar_one()
    return int(value)


async def _admin_upsert_runtime_state(
    environment_id: UUID,
    body: AdminRuntimeStateUpsert,
    db: AsyncSession,
) -> AdminRuntimeStateResponse:
    env = (
        await db.execute(select(AgentEnvironment).where(AgentEnvironment.id == environment_id))
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent environment not found")

    state = (
        await db.execute(
            select(HostedRuntimeState)
            .where(HostedRuntimeState.environment_id == environment_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    existing_state = state
    previous_generation = state.generation if state is not None else None
    changed_fields = _runtime_state_changed_fields(existing_state, body)
    if state is None:
        state = HostedRuntimeState(environment_id=environment_id)
        db.add(state)

    state.deployment_id = body.deployment_id
    state.app_id = body.app_id
    state.instance_id = body.instance_id
    state.generation = body.generation
    state.provider_id = body.provider_id
    state.system = body.system
    state.control_plane = body.control_plane
    state.clawdi_cli = body.clawdi_cli
    state.runtimes = body.runtimes
    state.bridge = body.bridge
    state.live_sync = body.live_sync
    state.recovery = body.recovery
    if state is not existing_state or body.mitm_profiles is not None:
        state.mitm_profiles = body.mitm_profiles
    if state is not existing_state or body.mcp is not None:
        state.mcp = body.mcp
    if state is not existing_state or body.tools is not None:
        state.tools = body.tools
    record_control_plane_audit(
        db,
        actor_type="admin",
        action="hosted_runtime_state.upsert",
        resource_type="hosted_runtime_state",
        resource_id=str(environment_id),
        environment_id=environment_id,
        target_user_id=env.user_id,
        source="api.admin",
        details={
            "deployment_id": body.deployment_id,
            "app_id": body.app_id,
            "instance_id": body.instance_id,
            "generation": body.generation,
            "previous_generation": previous_generation,
            "provider_id": body.provider_id,
            "enabled_runtimes": _enabled_runtime_names(body.runtimes),
            "has_bridge": body.bridge is not None,
            "has_mcp": body.mcp is not None,
            "has_tools": body.tools is not None,
            "changed_fields": changed_fields,
        },
    )
    await db.commit()
    logger.info(
        "admin_runtime_state_upserted environment_id=%s deployment_id=%s generation=%s",
        environment_id,
        body.deployment_id,
        body.generation,
    )
    return AdminRuntimeStateResponse(
        environment_id=environment_id,
        deployment_id=body.deployment_id,
        instance_id=body.instance_id,
        generation=body.generation,
    )


@router.put(
    "/agents/{agent_id}/runtime-state",
    response_model=AdminRuntimeStateResponse,
)
async def admin_upsert_agent_runtime_state(
    agent_id: UUID,
    body: AdminRuntimeStateUpsert,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminRuntimeStateResponse:
    return await _admin_upsert_runtime_state(agent_id, body, db)


@router.put(
    "/environments/{environment_id}/runtime-state",
    response_model=AdminRuntimeStateResponse,
    deprecated=True,
)
async def admin_upsert_runtime_state(
    environment_id: UUID,
    body: AdminRuntimeStateUpsert,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> AdminRuntimeStateResponse:
    return await _admin_upsert_runtime_state(environment_id, body, db)


async def _admin_delete_runtime_state(
    environment_id: UUID,
    db: AsyncSession,
) -> None:
    env = (
        await db.execute(select(AgentEnvironment).where(AgentEnvironment.id == environment_id))
    ).scalar_one_or_none()
    if env is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent environment not found")

    state = (
        await db.execute(
            select(HostedRuntimeState)
            .where(HostedRuntimeState.environment_id == environment_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    details: dict[str, object] = {"existed": state is not None}
    if state is not None:
        details.update(
            {
                "deployment_id": state.deployment_id,
                "app_id": state.app_id,
                "instance_id": state.instance_id,
                "generation": state.generation,
                "provider_id": state.provider_id,
                "enabled_runtimes": _enabled_runtime_names(state.runtimes),
                "has_mcp": state.mcp is not None,
                "has_tools": state.tools is not None,
            }
        )
        await db.delete(state)

    record_control_plane_audit(
        db,
        actor_type="admin",
        action="hosted_runtime_state.delete",
        resource_type="hosted_runtime_state",
        resource_id=str(environment_id),
        environment_id=environment_id,
        target_user_id=env.user_id,
        source="api.admin",
        details=details,
    )
    await db.commit()
    logger.info(
        "admin_runtime_state_deleted environment_id=%s existed=%s",
        environment_id,
        state is not None,
    )


@router.delete(
    "/agents/{agent_id}/runtime-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def admin_delete_agent_runtime_state(
    agent_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> None:
    await _admin_delete_runtime_state(agent_id, db)


@router.delete(
    "/environments/{environment_id}/runtime-state",
    status_code=status.HTTP_204_NO_CONTENT,
    deprecated=True,
)
async def admin_delete_runtime_state(
    environment_id: UUID,
    _: None = Depends(require_admin_api_key),
    db: AsyncSession = Depends(get_session),
) -> None:
    await _admin_delete_runtime_state(environment_id, db)


async def _admin_get_channel_row(
    db: AsyncSession,
    *,
    account_id: UUID,
    include_archived: bool = False,
) -> tuple[ChannelAccount, User]:
    filters = [ChannelAccount.id == account_id]
    if not include_archived:
        filters.append(ChannelAccount.archived_at.is_(None))
    result = await db.execute(
        select(ChannelAccount, User).join(User, User.id == ChannelAccount.user_id).where(*filters)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "channel not found")
    account, owner = row
    return account, owner


def _admin_channel_response(account: ChannelAccount, owner: User) -> AdminChannelResponse:
    return AdminChannelResponse(
        id=account.id,
        owner_user_id=account.user_id,
        owner_clerk_id=owner.clerk_id,
        provider=account.provider,
        name=account.name,
        status=account.status,
        visibility=account.visibility,
        has_provider_token=bool(account.encrypted_provider_token and account.provider_token_nonce),
        webhook_url=channel_webhook_url(account.id, account.provider),
        config=account.config,
        archived_at=account.archived_at,
        created_at=account.created_at,
        updated_at=account.updated_at,
    )


def _enabled_runtime_names(runtimes: dict[str, object]) -> list[str]:
    return sorted(
        name
        for name, value in runtimes.items()
        if isinstance(value, dict) and value.get("enabled") is True
    )


def _runtime_state_changed_fields(
    state: HostedRuntimeState | None,
    body: AdminRuntimeStateUpsert,
) -> list[str]:
    fields = [
        "deployment_id",
        "app_id",
        "instance_id",
        "generation",
        "provider_id",
        "system",
        "control_plane",
        "clawdi_cli",
        "runtimes",
        "bridge",
        "live_sync",
        "recovery",
        "mitm_profiles",
        "mcp",
        "tools",
    ]
    if state is None:
        return fields
    changed: list[str] = []
    preserve_when_omitted = {"mitm_profiles", "mcp", "tools"}
    for field in fields:
        body_value = getattr(body, field)
        if field in preserve_when_omitted and body_value is None:
            continue
        if getattr(state, field) != body_value:
            changed.append(field)
    return changed


def _admin_channel_update_audit_details(
    account: ChannelAccount,
    updates: set[str],
    body: AdminChannelUpdate,
) -> dict[str, object]:
    changed_fields = sorted(updates)
    details: dict[str, object] = {
        "provider": account.provider,
        "visibility": account.visibility,
        "changed_fields": changed_fields,
    }
    if "status" in updates and body.status is not None:
        details["status"] = body.status
    if "provider_token" in updates:
        details["provider_credential_changed"] = True
    if "secrets" in updates:
        details["secret_names"] = sorted((body.secrets or {}).keys())
    return details
