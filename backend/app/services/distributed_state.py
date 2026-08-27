"""PostgreSQL-backed limits that must remain authoritative across API workers."""

from __future__ import annotations

import hashlib
import math
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, text, update

from app.core.database import async_session_factory
from app.models.distributed_state import SharedRateLimitBucket, SyncSubscriptionLease
from app.models.user import User

_RATE_LIMIT_BUCKET_CREATION_LOCK = int.from_bytes(
    hashlib.sha256(b"clawdi-shared-rate-limit-buckets-v1").digest()[:8],
    byteorder="big",
    signed=True,
)


class SharedRateLimitExceeded(Exception):
    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__("shared rate limit exceeded")
        self.retry_after_seconds = retry_after_seconds


def _rate_limit_key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


async def consume_shared_rate_limit(
    *,
    namespace: str,
    key: str,
    limit: int,
    window: timedelta,
    max_buckets: int,
    now: datetime | None = None,
) -> None:
    """Atomically consume one exact sliding-window attempt.

    Raw client identifiers are hashed before persistence. New bucket creation is
    serialized only long enough to prune and enforce the namespace-wide storage
    bound; established buckets contend only with requests for the same key.
    """
    if not namespace or len(namespace) > 64:
        raise ValueError("rate limit namespace must be 1..64 characters")
    if limit <= 0 or window <= timedelta(0) or max_buckets <= 0:
        raise ValueError("rate limit bounds must be positive")

    current = now or datetime.now(UTC)
    cutoff = current - window
    key_hash = _rate_limit_key_hash(key)
    exceeded_retry_after: int | None = None

    async with async_session_factory() as db:
        bucket = (
            await db.execute(
                select(SharedRateLimitBucket)
                .where(
                    SharedRateLimitBucket.namespace == namespace,
                    SharedRateLimitBucket.key_hash == key_hash,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()

        if bucket is None:
            await db.execute(
                text("SELECT pg_advisory_xact_lock(:key)"),
                {"key": _RATE_LIMIT_BUCKET_CREATION_LOCK},
            )
            bucket = (
                await db.execute(
                    select(SharedRateLimitBucket)
                    .where(
                        SharedRateLimitBucket.namespace == namespace,
                        SharedRateLimitBucket.key_hash == key_hash,
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if bucket is None:
                await db.execute(
                    delete(SharedRateLimitBucket).where(
                        SharedRateLimitBucket.namespace == namespace,
                        SharedRateLimitBucket.expires_at <= current,
                    )
                )
                bucket_count = (
                    await db.execute(
                        select(func.count())
                        .select_from(SharedRateLimitBucket)
                        .where(SharedRateLimitBucket.namespace == namespace)
                    )
                ).scalar_one()
                if bucket_count >= max_buckets:
                    await db.commit()
                    raise SharedRateLimitExceeded(math.ceil(window.total_seconds()))
                bucket = SharedRateLimitBucket(
                    namespace=namespace,
                    key_hash=key_hash,
                    attempts=[],
                    expires_at=current + window,
                )
                db.add(bucket)
                await db.flush()

        attempts = [attempt for attempt in bucket.attempts if attempt > cutoff]
        if len(attempts) >= limit:
            bucket.attempts = attempts
            bucket.expires_at = attempts[-1] + window
            exceeded_retry_after = max(
                1,
                math.ceil((attempts[0] + window - current).total_seconds()),
            )
        else:
            attempts.append(current)
            bucket.attempts = attempts
            bucket.expires_at = current + window
        await db.commit()

    if exceeded_retry_after is not None:
        raise SharedRateLimitExceeded(exceeded_retry_after)


async def acquire_sync_subscription_lease(
    *,
    user_id: UUID,
    bound_api_key_id: UUID | None,
    max_per_user: int,
    max_per_key: int,
    ttl: timedelta,
    now: datetime | None = None,
) -> UUID | None:
    """Acquire a short, renewable SSE slot under the authoritative user row lock."""
    if max_per_user <= 0 or max_per_key <= 0 or ttl <= timedelta(0):
        raise ValueError("subscription lease bounds must be positive")

    current = now or datetime.now(UTC)
    lease_id = uuid4()
    async with async_session_factory() as db:
        user_exists = (
            await db.execute(select(User.id).where(User.id == user_id).with_for_update())
        ).scalar_one_or_none()
        if user_exists is None:
            return None

        await db.execute(
            delete(SyncSubscriptionLease).where(
                SyncSubscriptionLease.user_id == user_id,
                SyncSubscriptionLease.expires_at <= current,
            )
        )
        active_for_user = (
            await db.execute(
                select(func.count())
                .select_from(SyncSubscriptionLease)
                .where(SyncSubscriptionLease.user_id == user_id)
            )
        ).scalar_one()
        if active_for_user >= max_per_user:
            await db.commit()
            return None

        if bound_api_key_id is not None:
            active_for_key = (
                await db.execute(
                    select(func.count())
                    .select_from(SyncSubscriptionLease)
                    .where(
                        SyncSubscriptionLease.user_id == user_id,
                        SyncSubscriptionLease.bound_api_key_id == bound_api_key_id,
                    )
                )
            ).scalar_one()
            if active_for_key >= max_per_key:
                await db.commit()
                return None

        db.add(
            SyncSubscriptionLease(
                id=lease_id,
                user_id=user_id,
                bound_api_key_id=bound_api_key_id,
                expires_at=current + ttl,
            )
        )
        await db.commit()
    return lease_id


async def refresh_sync_subscription_lease(
    lease_id: UUID,
    *,
    ttl: timedelta,
    now: datetime | None = None,
) -> bool:
    """Renew a live lease. An already-expired lease cannot be resurrected."""
    if ttl <= timedelta(0):
        raise ValueError("subscription lease ttl must be positive")
    current = now or datetime.now(UTC)
    async with async_session_factory() as db:
        result = await db.execute(
            update(SyncSubscriptionLease)
            .where(
                SyncSubscriptionLease.id == lease_id,
                SyncSubscriptionLease.expires_at > current,
            )
            .values(expires_at=current + ttl)
            .returning(SyncSubscriptionLease.id)
        )
        await db.commit()
        return result.scalar_one_or_none() is not None


async def release_sync_subscription_lease(lease_id: UUID) -> None:
    async with async_session_factory() as db:
        await db.execute(delete(SyncSubscriptionLease).where(SyncSubscriptionLease.id == lease_id))
        await db.commit()
