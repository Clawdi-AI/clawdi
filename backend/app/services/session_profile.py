from collections.abc import Iterable, Sequence
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session, SessionSyncSuppression


def profile_required() -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": "profile_required",
            "message": "Ambiguous session profile; send profile_key or upgrade Clawdi CLI.",
        },
    )


def resolve_profile_key(
    profile_key: str | None,
    existing_keys: Iterable[str],
    suppressed_keys: Iterable[str] = (),
) -> str:
    """Keep omitted old-CLI keys bound to their one existing or suppressed profile."""
    if profile_key is not None:
        return profile_key
    keys = set(existing_keys) or set(suppressed_keys)
    if len(keys) > 1:
        raise profile_required()
    return next(iter(keys), "")


def require_session_match(
    matches: Sequence[Session],
    profile_key: str | None,
    *,
    origin_required_message: str,
) -> Session:
    if not matches:
        raise HTTPException(404, "Session not found")
    if len({row.origin_environment_id for row in matches}) > 1:
        raise HTTPException(
            409,
            detail={"code": "session_origin_required", "message": origin_required_message},
        )
    resolve_profile_key(profile_key, (row.origin_profile_key for row in matches))
    return matches[0]


async def resolve_session_profile(
    db: AsyncSession,
    user_id: UUID,
    environment_id: UUID,
    local_session_id: str,
    profile_key: str | None,
) -> str:
    if profile_key is not None:
        return profile_key
    keys = set(
        (
            await db.execute(
                select(Session.origin_profile_key).where(
                    Session.user_id == user_id,
                    Session.origin_environment_id == environment_id,
                    Session.local_session_id == local_session_id,
                )
            )
        ).scalars()
    )
    # Deleted attributed sessions must remain suppressed when an old CLI returns.
    if not keys:
        keys = set(
            (
                await db.execute(
                    select(SessionSyncSuppression.origin_profile_key).where(
                        SessionSyncSuppression.user_id == user_id,
                        SessionSyncSuppression.origin_environment_id == environment_id,
                        SessionSyncSuppression.local_session_id == local_session_id,
                    )
                )
            ).scalars()
        )
    return resolve_profile_key(profile_key, keys)
