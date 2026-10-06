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
    if len(keys) > 1:
        raise profile_required()
    return next(iter(keys), "")
