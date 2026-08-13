from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.agent_project_binding import AgentProjectBinding
from app.models.ai_provider import AiProvider, AiProviderAuthPayload, AiProviderOAuthAttempt
from app.models.api_key import ApiKey
from app.models.channel import (
    BINDING_STATUS_ARCHIVED,
    BOT_AGENT_LINK_STATUS_ARCHIVED,
    CHANNEL_STATUS_DISABLED,
    PAIR_CODE_STATUS_REVOKED,
    WHATSAPP_ONBOARDING_ACTIVE_STATES,
    WHATSAPP_ONBOARDING_STATE_CANCELED,
    WHATSAPP_ONBOARDING_STATE_ERROR,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelPairCode,
    ChannelWhatsAppOnboardingSession,
)
from app.models.device_authorization import DeviceAuthorization
from app.models.hosted_runtime import HostedRuntimeState
from app.models.hosted_v1_ownership import HostedV1AgentOwnership
from app.models.principal_lifecycle import (
    ClerkPrincipalAuthority,
    ClerkWebhookEventReceipt,
    PrincipalLifecycle,
)
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.project_share_link import ProjectShareLink
from app.models.runtime_observation import (
    RUNTIME_ENVIRONMENT_ACTIVE,
    V2RuntimeEnvironmentFence,
)
from app.models.session import AgentEnvironment, Session
from app.models.session_permission import SessionPermission
from app.models.user import PRINCIPAL_KIND_CLERK, User
from app.services.ai_provider_auth_transition import transition_ai_provider_auth
from app.services.ai_provider_oauth_lifecycle import terminal_oauth_attempt
from app.services.hosted_v1_ownership import lock_hosted_v1_ownership_mutations
from app.services.project_runtime_skills import (
    lock_project_runtime_graphs,
    queue_project_runtime_manifest_changed,
)
from app.services.runtime_observation import retire_runtime_environment


class PrincipalTerminatedError(RuntimeError):
    pass


class PrincipalIdentityConflictError(RuntimeError):
    pass


class PrincipalLifecycleConfigurationError(RuntimeError):
    pass


class PrincipalWebhookConflictError(RuntimeError):
    pass


class PrincipalCleanupClaimLostError(RuntimeError):
    pass


PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS = 60
PRINCIPAL_CLEANUP_BACKOFF_CAP_SECONDS = 15 * 60


@dataclass(frozen=True, slots=True)
class PrincipalDeletionReceipt:
    lifecycle_id: UUID
    user_id: UUID | None
    fence_created: bool
    replayed: bool


@dataclass(frozen=True, slots=True)
class PrincipalCleanupResult:
    user_disabled: bool
    api_keys_revoked: int = 0
    agents_archived: int = 0
    runtime_states_deleted: int = 0
    runtime_environments_retired: int = 0
    channel_accounts_disabled: int = 0
    project_access_revoked: int = 0
    session_access_revoked: int = 0
    ai_providers_archived: int = 0
    oauth_revoke_pending: int = 0
    revoked_api_key_ids: tuple[UUID, ...] = ()


@dataclass(frozen=True, slots=True)
class ClaimedPrincipalCleanup:
    lifecycle_id: UUID
    claim_id: str
    attempt_count: int


def configured_clerk_issuer() -> str:
    issuer = settings.clerk_jwt_issuer
    if not issuer:
        raise PrincipalLifecycleConfigurationError("Clerk issuer is not configured")
    return issuer


def _principal_lock_name(issuer: str, subject: str) -> str:
    return f"principal-authority:clerk:{issuer}:{subject}"


async def _advisory_xact_lock(db: AsyncSession, name: str) -> None:
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(name, 0))))


async def _advisory_xact_lock_shared(db: AsyncSession, name: str) -> None:
    await db.execute(select(func.pg_advisory_xact_lock_shared(func.hashtextextended(name, 0))))


async def lock_clerk_principal(db: AsyncSession, *, issuer: str, subject: str) -> None:
    """Hold the exclusive principal authority lock for fence/cleanup."""

    await _advisory_xact_lock(db, _principal_lock_name(issuer, subject))


async def lock_clerk_principal_shared(
    db: AsyncSession,
    *,
    issuer: str,
    subject: str,
) -> None:
    """Hold the shared principal authority lock for an active request."""

    await _advisory_xact_lock_shared(db, _principal_lock_name(issuer, subject))


async def lock_user_authority(db: AsyncSession, user_id: UUID) -> None:
    """Hold the exclusive user authority lock for fence/cleanup."""

    await _advisory_xact_lock(db, f"user-authority:{user_id}")


async def lock_user_authority_shared(db: AsyncSession, user_id: UUID) -> None:
    """Hold the shared user authority lock for an active request."""

    await _advisory_xact_lock_shared(db, f"user-authority:{user_id}")


async def assert_clerk_principal_active(
    db: AsyncSession,
    *,
    subject: str,
    issuer: str | None = None,
    lock: bool = True,
) -> str | None:
    """Lock and reject a durable Clerk tombstone before any lazy create."""

    resolved_issuer = issuer or settings.clerk_jwt_issuer
    if not resolved_issuer:
        # Legacy PEM-only JWTs may not carry an issuer. They retain their
        # compatibility path, but a configuration change must never hide a
        # fence that was already persisted under a previously configured
        # issuer.
        lifecycle = (
            await db.execute(
                select(PrincipalLifecycle.issuer)
                .where(
                    PrincipalLifecycle.subject == subject,
                )
                .order_by(PrincipalLifecycle.issuer)
                .limit(1)
            )
        ).scalar_one_or_none()
        if lifecycle is not None:
            if lock:
                await lock_clerk_principal_shared(
                    db,
                    issuer=lifecycle,
                    subject=subject,
                )
            raise PrincipalTerminatedError("principal has been terminated")
        return None
    if lock:
        await lock_clerk_principal_shared(db, issuer=resolved_issuer, subject=subject)
    lifecycle_id = await db.scalar(
        select(PrincipalLifecycle.id).where(
            PrincipalLifecycle.issuer == resolved_issuer,
            PrincipalLifecycle.subject == subject,
        )
    )
    if lifecycle_id is not None:
        raise PrincipalTerminatedError("principal has been terminated")
    banned = await db.scalar(
        select(ClerkPrincipalAuthority.banned).where(
            ClerkPrincipalAuthority.issuer == resolved_issuer,
            ClerkPrincipalAuthority.subject == subject,
        )
    )
    if banned is True:
        raise PrincipalTerminatedError("principal is suspended")
    return resolved_issuer


async def resolve_clerk_owner_issuer(
    db: AsyncSession,
    *,
    subject: str,
    lock: bool = True,
) -> str:
    """Resolve a non-JWT Clerk owner without guessing an issuer.

    The configured issuer is canonical. If configuration is temporarily
    absent, an already-bound User supplies the only safe compatibility bridge.
    An unbound owner fails closed, and any tombstone remains authoritative.
    """

    if settings.clerk_jwt_issuer:
        configured_issuer = settings.clerk_jwt_issuer
        await assert_clerk_principal_active(
            db,
            subject=subject,
            issuer=configured_issuer,
            lock=lock,
        )
        return configured_issuer

    bound_issuer = await db.scalar(
        select(User.clerk_issuer).where(
            User.principal_kind == PRINCIPAL_KIND_CLERK,
            User.clerk_id == subject,
            User.clerk_issuer.is_not(None),
        )
    )
    if bound_issuer is None:
        await assert_clerk_principal_active(db, subject=subject, lock=lock)
        raise PrincipalLifecycleConfigurationError(
            "Clerk owner issuer cannot be resolved without configuration"
        )
    await assert_clerk_principal_active(
        db,
        subject=subject,
        issuer=bound_issuer,
        lock=lock,
    )
    return bound_issuer


async def assert_user_authority_active(
    db: AsyncSession,
    user_id: UUID,
    *,
    lock: bool = True,
) -> None:
    """Hold the user authority lock and reject disabled/fenced identities."""

    if lock:
        await lock_user_authority_shared(db, user_id)
    active_id = await db.scalar(
        select(User.id).where(
            User.id == user_id,
            ~select(PrincipalLifecycle.id).where(PrincipalLifecycle.user_id == User.id).exists(),
            ~select(ClerkPrincipalAuthority.id)
            .where(
                ClerkPrincipalAuthority.issuer == User.clerk_issuer,
                ClerkPrincipalAuthority.subject == User.clerk_id,
                ClerkPrincipalAuthority.banned.is_(True),
            )
            .exists(),
        )
    )
    if active_id is None:
        raise PrincipalTerminatedError("user authority is disabled")


async def project_clerk_user_authority(
    db: AsyncSession,
    *,
    issuer: str,
    subject: str,
    banned: bool,
    authority_updated_at: datetime,
    message_id: str,
    payload_sha256: str,
) -> bool:
    """Project a current Clerk ban value; deletion is permanently dominant."""

    if issuer != configured_clerk_issuer():
        raise PrincipalIdentityConflictError("principal issuer is not accepted")
    if authority_updated_at.tzinfo is None:
        raise ValueError("Clerk authority timestamp must be timezone-aware")
    await lock_clerk_principal(db, issuer=issuer, subject=subject)
    if await db.scalar(
        select(PrincipalLifecycle.id).where(
            PrincipalLifecycle.issuer == issuer,
            PrincipalLifecycle.subject == subject,
        )
    ):
        return False

    projection = (
        await db.execute(
            select(ClerkPrincipalAuthority)
            .where(
                ClerkPrincipalAuthority.issuer == issuer,
                ClerkPrincipalAuthority.subject == subject,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if projection is not None and projection.authority_updated_at >= authority_updated_at:
        return False
    changed = projection is None or projection.banned != banned
    if projection is None:
        projection = ClerkPrincipalAuthority(
            issuer=issuer,
            subject=subject,
            banned=banned,
            authority_updated_at=authority_updated_at,
            message_id=message_id,
            payload_sha256=payload_sha256,
        )
        db.add(projection)
    else:
        projection.banned = banned
        projection.authority_updated_at = authority_updated_at
        projection.message_id = message_id
        projection.payload_sha256 = payload_sha256
    user = await load_clerk_user_for_issuer(
        db,
        issuer=issuer,
        subject=subject,
        bind_legacy=True,
    )
    if user is not None:
        await db.flush()
    return changed


async def load_clerk_user_for_issuer(
    db: AsyncSession,
    *,
    issuer: str,
    subject: str,
    bind_legacy: bool,
    allow_issuer_mismatch: bool = False,
    for_update: bool = False,
) -> User | None:
    statement = select(User).where(
        User.principal_kind == PRINCIPAL_KIND_CLERK,
        User.clerk_id == subject,
    )
    user = (await db.execute(statement)).scalar_one_or_none()
    if user is None:
        return None
    if user.clerk_issuer is not None and user.clerk_issuer != issuer:
        if allow_issuer_mismatch:
            return None
        raise PrincipalIdentityConflictError("Clerk subject belongs to another issuer")
    if for_update or (bind_legacy and user.clerk_issuer is None):
        # Authority locks must precede User row locks. In particular, a
        # different issuer may bind the released legacy row while termination
        # is resolving the same globally-unique subject.
        await lock_user_authority_shared(db, user.id)
        user = (
            await db.execute(
                select(User)
                .where(User.id == user.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        if user.clerk_issuer is not None and user.clerk_issuer != issuer:
            if allow_issuer_mismatch:
                return None
            raise PrincipalIdentityConflictError("Clerk subject belongs to another issuer")
    if bind_legacy and user.clerk_issuer is None:
        user.clerk_issuer = issuer
    return user


async def fence_clerk_user_deleted(
    db: AsyncSession,
    *,
    issuer: str,
    subject: str,
    message_id: str,
    payload_sha256: str,
    event_occurred_at: datetime,
    now: datetime | None = None,
) -> PrincipalDeletionReceipt:
    """Persist verified Clerk evidence and its fail-closed fence together."""

    if issuer != configured_clerk_issuer():
        raise PrincipalIdentityConflictError("principal issuer is not accepted")
    if event_occurred_at.tzinfo is None:
        raise ValueError("Clerk event timestamp must be timezone-aware")
    await _advisory_xact_lock(db, f"clerk-webhook-event:{message_id}")
    await lock_clerk_principal(db, issuer=issuer, subject=subject)

    existing_receipt = await db.get(ClerkWebhookEventReceipt, message_id)
    if existing_receipt is not None:
        lifecycle = await db.get(PrincipalLifecycle, existing_receipt.lifecycle_id)
        if (
            lifecycle is None
            or lifecycle.issuer != issuer
            or lifecycle.subject != subject
            or existing_receipt.receipt_source != "clerk"
            or existing_receipt.event_type != "user.deleted"
            or existing_receipt.payload_sha256 != payload_sha256
        ):
            raise PrincipalWebhookConflictError(
                "Clerk message ID was already used with different evidence"
            )
        return PrincipalDeletionReceipt(
            lifecycle_id=lifecycle.id,
            user_id=lifecycle.user_id,
            fence_created=False,
            replayed=True,
        )

    lifecycle = (
        await db.execute(
            select(PrincipalLifecycle)
            .where(
                PrincipalLifecycle.issuer == issuer,
                PrincipalLifecycle.subject == subject,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    current_time = now or datetime.now(UTC)
    fence_created = lifecycle is None
    if lifecycle is None:
        candidate = await load_clerk_user_for_issuer(
            db,
            issuer=issuer,
            subject=subject,
            bind_legacy=False,
            allow_issuer_mismatch=True,
        )
        user = None
        if candidate is not None:
            # All authority paths take the advisory user lock before a row
            # lock. Preserve that order here so a terminating command cannot
            # deadlock a request that is already mutating the User row.
            await lock_user_authority(db, candidate.id)
            user = await load_clerk_user_for_issuer(
                db,
                issuer=issuer,
                subject=subject,
                bind_legacy=False,
                allow_issuer_mismatch=True,
                for_update=True,
            )
        if user is not None:
            if user.clerk_issuer is None:
                user.clerk_issuer = issuer
        lifecycle = PrincipalLifecycle(
            issuer=issuer,
            subject=subject,
            user_id=user.id if user is not None else None,
            terminated_at=event_occurred_at,
            next_cleanup_attempt_at=current_time,
        )
        db.add(lifecycle)
        await db.flush()
    db.add(
        ClerkWebhookEventReceipt(
            message_id=message_id,
            lifecycle_id=lifecycle.id,
            receipt_source="clerk",
            event_type="user.deleted",
            payload_sha256=payload_sha256,
            event_occurred_at=event_occurred_at,
        )
    )
    await db.flush()
    return PrincipalDeletionReceipt(
        lifecycle_id=lifecycle.id,
        user_id=lifecycle.user_id,
        fence_created=fence_created,
        replayed=False,
    )


async def complete_principal_cleanup(
    db: AsyncSession,
    *,
    lifecycle_id: UUID,
    expected_claim_id: str | None = None,
    now: datetime | None = None,
) -> PrincipalCleanupResult:
    """Revoke local authority transactionally, queuing remote OAuth repair."""

    identity = await db.get(PrincipalLifecycle, lifecycle_id)
    if identity is None:
        raise RuntimeError("principal lifecycle fence disappeared")
    await lock_clerk_principal(db, issuer=identity.issuer, subject=identity.subject)
    lifecycle = (
        await db.execute(
            select(PrincipalLifecycle)
            .where(PrincipalLifecycle.id == lifecycle_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    if lifecycle.cleanup_completed_at is not None:
        return PrincipalCleanupResult(user_disabled=lifecycle.user_id is not None)
    if expected_claim_id is not None and lifecycle.cleanup_claim_id != expected_claim_id:
        raise PrincipalCleanupClaimLostError("principal cleanup claim changed")

    current_time = now or datetime.now(UTC)
    attempt_already_recorded = lifecycle.cleanup_claim_id is not None
    if lifecycle.user_id is None:
        if not attempt_already_recorded:
            lifecycle.cleanup_attempts += 1
        _mark_principal_cleanup_complete(lifecycle, completed_at=current_time)
        await db.flush()
        return PrincipalCleanupResult(user_disabled=False)

    await lock_user_authority(db, lifecycle.user_id)
    user = await db.get(User, lifecycle.user_id)
    if user is None:
        if not attempt_already_recorded:
            lifecycle.cleanup_attempts += 1
        _mark_principal_cleanup_complete(lifecycle, completed_at=current_time)
        await db.flush()
        return PrincipalCleanupResult(user_disabled=False)

    await lock_hosted_v1_ownership_mutations(db)

    # Owner deletion removes every other user's access to the owner's Projects.
    # Take all Project locks before any affected Agent lock, notify managed
    # Agents, and remove their links in this same transaction. Otherwise those
    # Agents would keep a stale desired bundle until their next periodic poll.
    owned_project_id_values = tuple(
        (
            await db.scalars(
                select(Project.id).where(Project.user_id == user.id).order_by(Project.id)
            )
        ).all()
    )
    await lock_project_runtime_graphs(db, owned_project_id_values)
    for project_id in owned_project_id_values:
        await queue_project_runtime_manifest_changed(db, project_id=project_id)
    if owned_project_id_values:
        await db.execute(
            delete(AgentProjectBinding).where(
                AgentProjectBinding.project_id.in_(owned_project_id_values),
                AgentProjectBinding.binding_type == "context",
            )
        )

    key_ids = tuple(
        (
            await db.scalars(
                update(ApiKey)
                .where(ApiKey.user_id == user.id, ApiKey.revoked_at.is_(None))
                .values(revoked_at=current_time)
                .returning(ApiKey.id)
            )
        ).all()
    )
    agent_ids = tuple(
        (
            await db.scalars(select(AgentEnvironment.id).where(AgentEnvironment.user_id == user.id))
        ).all()
    )
    archived_agent_ids = tuple(
        (
            await db.scalars(
                update(AgentEnvironment)
                .where(
                    AgentEnvironment.user_id == user.id,
                    AgentEnvironment.archived_at.is_(None),
                )
                .values(archived_at=current_time)
                .returning(AgentEnvironment.id)
            )
        ).all()
    )
    if agent_ids:
        await db.execute(
            update(HostedV1AgentOwnership)
            .where(
                HostedV1AgentOwnership.environment_id.in_(agent_ids),
                HostedV1AgentOwnership.archived_at.is_(None),
            )
            .values(archived_at=current_time, archive_reason="agent_archived")
        )
    await db.execute(
        update(Project)
        .where(
            Project.user_id == user.id,
            Project.kind == PROJECT_KIND_ENVIRONMENT,
            Project.archived_at.is_(None),
        )
        .values(archived_at=current_time)
    )
    runtime_states_deleted = 0
    if agent_ids:
        deleted_runtime_state_ids = tuple(
            (
                await db.scalars(
                    delete(HostedRuntimeState)
                    .where(HostedRuntimeState.environment_id.in_(agent_ids))
                    .returning(HostedRuntimeState.environment_id)
                )
            ).all()
        )
        runtime_states_deleted = len(deleted_runtime_state_ids)

    active_runtime_fences = list(
        (
            await db.scalars(
                select(V2RuntimeEnvironmentFence)
                .where(
                    V2RuntimeEnvironmentFence.owner_id == user.id,
                    V2RuntimeEnvironmentFence.state == RUNTIME_ENVIRONMENT_ACTIVE,
                )
                .order_by(V2RuntimeEnvironmentFence.environment_id)
            )
        ).all()
    )
    runtime_environments_retired = 0
    retirement_id = f"principal-termination:{lifecycle.id}"
    for runtime_fence in active_runtime_fences:
        retirement = await retire_runtime_environment(
            db,
            environment_id=runtime_fence.environment_id,
            expected_deployment_id=runtime_fence.deployment_id,
            retirement_id=retirement_id,
            owner_id=user.id,
            retired_at=current_time,
        )
        runtime_environments_retired += int(retirement.transitioned)

    channel_account_ids = tuple(
        (
            await db.scalars(
                update(ChannelAccount)
                .where(
                    ChannelAccount.user_id == user.id,
                    or_(
                        ChannelAccount.status != CHANNEL_STATUS_DISABLED,
                        ChannelAccount.archived_at.is_(None),
                    ),
                )
                .values(status=CHANNEL_STATUS_DISABLED, archived_at=current_time)
                .returning(ChannelAccount.id)
            )
        ).all()
    )
    await db.execute(
        update(ChannelBotAgentLink)
        .where(
            ChannelBotAgentLink.user_id == user.id,
            or_(
                ChannelBotAgentLink.status != BOT_AGENT_LINK_STATUS_ARCHIVED,
                ChannelBotAgentLink.archived_at.is_(None),
            ),
        )
        .values(status=BOT_AGENT_LINK_STATUS_ARCHIVED, archived_at=current_time)
    )
    await db.execute(
        update(ChannelBinding)
        .where(
            ChannelBinding.user_id == user.id,
            ChannelBinding.status != BINDING_STATUS_ARCHIVED,
        )
        .values(status=BINDING_STATUS_ARCHIVED)
    )
    await db.execute(
        update(ChannelPairCode)
        .where(
            ChannelPairCode.user_id == user.id,
            ChannelPairCode.status != PAIR_CODE_STATUS_REVOKED,
        )
        .values(status=PAIR_CODE_STATUS_REVOKED)
    )
    await db.execute(
        update(ChannelAgentCredential)
        .where(
            ChannelAgentCredential.user_id == user.id,
            ChannelAgentCredential.revoked_at.is_(None),
        )
        .values(revoked_at=current_time)
    )
    await db.execute(
        update(ChannelWhatsAppOnboardingSession)
        .where(
            ChannelWhatsAppOnboardingSession.user_id == user.id,
            ChannelWhatsAppOnboardingSession.state.in_(
                (*WHATSAPP_ONBOARDING_ACTIVE_STATES, WHATSAPP_ONBOARDING_STATE_ERROR)
            ),
        )
        .values(state=WHATSAPP_ONBOARDING_STATE_CANCELED, completed_at=current_time)
    )

    owned_project_ids = select(Project.id).where(Project.user_id == user.id)
    deleted_membership_ids = tuple(
        (
            await db.scalars(
                delete(ProjectMembership)
                .where(
                    or_(
                        ProjectMembership.member_user_id == user.id,
                        ProjectMembership.project_id.in_(owned_project_ids),
                    )
                )
                .returning(ProjectMembership.id)
            )
        ).all()
    )
    deleted_invitation_ids = tuple(
        (
            await db.scalars(
                delete(ProjectInvitation)
                .where(
                    or_(
                        ProjectInvitation.invitee_user_id == user.id,
                        ProjectInvitation.invited_by == user.id,
                        ProjectInvitation.project_id.in_(owned_project_ids),
                    )
                )
                .returning(ProjectInvitation.id)
            )
        ).all()
    )
    revoked_share_link_ids = tuple(
        (
            await db.scalars(
                update(ProjectShareLink)
                .where(
                    or_(
                        ProjectShareLink.created_by == user.id,
                        ProjectShareLink.project_id.in_(owned_project_ids),
                    ),
                    ProjectShareLink.revoked_at.is_(None),
                )
                .values(revoked_at=current_time)
                .returning(ProjectShareLink.id)
            )
        ).all()
    )
    owned_session_ids = select(Session.id).where(Session.user_id == user.id)
    revoked_permission_ids = tuple(
        (
            await db.scalars(
                update(SessionPermission)
                .where(
                    or_(
                        SessionPermission.user_id == user.id,
                        SessionPermission.invited_by == user.id,
                        SessionPermission.session_id.in_(owned_session_ids),
                    ),
                    SessionPermission.revoked_at.is_(None),
                )
                .values(revoked_at=current_time)
                .returning(SessionPermission.id)
            )
        ).all()
    )
    await db.execute(
        update(DeviceAuthorization)
        .where(
            DeviceAuthorization.user_id == user.id,
            DeviceAuthorization.status.in_(("pending", "approved")),
        )
        .values(status="denied", api_key_raw=None)
    )

    providers = list(
        (
            await db.scalars(
                select(AiProvider)
                .where(AiProvider.owner_user_id == user.id, AiProvider.archived_at.is_(None))
                .order_by(AiProvider.id)
                .with_for_update()
            )
        ).all()
    )
    oauth_revoke_pending = 0
    for provider in providers:
        transition = await transition_ai_provider_auth(
            db,
            owner_user_id=user.id,
            provider=provider,
            auth_type=provider.auth_type,
            auth_ref=provider.auth_ref,
            auth_metadata=provider.auth_metadata,
            archive_provider=True,
        )
        oauth_revoke_pending += int(transition.remote_revoke_status == "pending")
    await db.execute(
        update(AiProviderAuthPayload)
        .where(
            AiProviderAuthPayload.owner_user_id == user.id,
            AiProviderAuthPayload.archived_at.is_(None),
        )
        .values(
            archived_at=current_time,
            consumer_environment_id=None,
            consumer_runtime=None,
        )
    )
    await db.execute(
        update(AiProviderOAuthAttempt)
        .where(
            AiProviderOAuthAttempt.owner_user_id == user.id,
            AiProviderOAuthAttempt.status.in_(("pending", "polling", "exchanging")),
        )
        .values(**terminal_oauth_attempt("failed", completed_at=current_time).update_values())
    )

    if not attempt_already_recorded:
        lifecycle.cleanup_attempts += 1
    _mark_principal_cleanup_complete(lifecycle, completed_at=current_time)
    await db.flush()
    project_access_revoked = (
        len(deleted_membership_ids) + len(deleted_invitation_ids) + len(revoked_share_link_ids)
    )
    return PrincipalCleanupResult(
        user_disabled=True,
        api_keys_revoked=len(key_ids),
        agents_archived=len(archived_agent_ids),
        runtime_states_deleted=runtime_states_deleted,
        runtime_environments_retired=runtime_environments_retired,
        channel_accounts_disabled=len(channel_account_ids),
        project_access_revoked=project_access_revoked,
        session_access_revoked=len(revoked_permission_ids),
        ai_providers_archived=len(providers),
        oauth_revoke_pending=oauth_revoke_pending,
        revoked_api_key_ids=key_ids,
    )


def _mark_principal_cleanup_complete(
    lifecycle: PrincipalLifecycle,
    *,
    completed_at: datetime,
) -> None:
    lifecycle.cleanup_completed_at = completed_at
    lifecycle.next_cleanup_attempt_at = None
    lifecycle.cleanup_claim_id = None
    lifecycle.cleanup_claimed_at = None


async def claim_principal_cleanup(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    lease_seconds: int = PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS,
) -> ClaimedPrincipalCleanup | None:
    """Claim one due cleanup without blocking another worker's row."""

    claimed_at = now or datetime.now(UTC)
    stale_before = claimed_at - timedelta(seconds=lease_seconds)
    lifecycle = (
        await db.execute(
            select(PrincipalLifecycle)
            .where(
                PrincipalLifecycle.cleanup_completed_at.is_(None),
                or_(
                    and_(
                        PrincipalLifecycle.cleanup_claim_id.is_(None),
                        PrincipalLifecycle.next_cleanup_attempt_at <= claimed_at,
                    ),
                    and_(
                        PrincipalLifecycle.cleanup_claim_id.is_not(None),
                        PrincipalLifecycle.cleanup_claimed_at <= stale_before,
                    ),
                ),
            )
            .order_by(
                PrincipalLifecycle.next_cleanup_attempt_at,
                PrincipalLifecycle.created_at,
                PrincipalLifecycle.id,
            )
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if lifecycle is None:
        return None
    claim_id = secrets.token_hex(16)
    lifecycle.cleanup_claim_id = claim_id
    lifecycle.cleanup_claimed_at = claimed_at
    lifecycle.cleanup_attempts += 1
    await db.flush()
    return ClaimedPrincipalCleanup(
        lifecycle_id=lifecycle.id,
        claim_id=claim_id,
        attempt_count=lifecycle.cleanup_attempts,
    )


async def record_principal_cleanup_failure(
    db: AsyncSession,
    *,
    lifecycle_id: UUID,
    expected_claim_id: str | None = None,
    now: datetime | None = None,
) -> bool:
    identity = await db.get(PrincipalLifecycle, lifecycle_id)
    if identity is None:
        return False
    await lock_clerk_principal(db, issuer=identity.issuer, subject=identity.subject)
    lifecycle = (
        await db.execute(
            select(PrincipalLifecycle)
            .where(PrincipalLifecycle.id == lifecycle_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if lifecycle is None or lifecycle.cleanup_completed_at is not None:
        return False
    if expected_claim_id is not None and lifecycle.cleanup_claim_id != expected_claim_id:
        return False
    if expected_claim_id is None and lifecycle.cleanup_claim_id is not None:
        return False
    if lifecycle.cleanup_claim_id is None:
        lifecycle.cleanup_attempts += 1
    backoff_seconds = min(
        2 ** min(max(lifecycle.cleanup_attempts - 1, 0), 10),
        PRINCIPAL_CLEANUP_BACKOFF_CAP_SECONDS,
    )
    lifecycle.next_cleanup_attempt_at = (now or datetime.now(UTC)) + timedelta(
        seconds=backoff_seconds
    )
    lifecycle.cleanup_claim_id = None
    lifecycle.cleanup_claimed_at = None
    await db.flush()
    return True


__all__ = [
    "PrincipalCleanupResult",
    "ClaimedPrincipalCleanup",
    "PRINCIPAL_CLEANUP_BACKOFF_CAP_SECONDS",
    "PRINCIPAL_CLEANUP_CLAIM_LEASE_SECONDS",
    "PrincipalCleanupClaimLostError",
    "PrincipalDeletionReceipt",
    "PrincipalIdentityConflictError",
    "PrincipalLifecycleConfigurationError",
    "PrincipalTerminatedError",
    "PrincipalWebhookConflictError",
    "assert_clerk_principal_active",
    "assert_user_authority_active",
    "claim_principal_cleanup",
    "complete_principal_cleanup",
    "configured_clerk_issuer",
    "fence_clerk_user_deleted",
    "load_clerk_user_for_issuer",
    "lock_clerk_principal",
    "lock_user_authority",
    "project_clerk_user_authority",
    "resolve_clerk_owner_issuer",
    "record_principal_cleanup_failure",
]
