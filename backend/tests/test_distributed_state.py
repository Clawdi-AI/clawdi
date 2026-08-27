"""Cross-connection contracts for PostgreSQL-backed worker coordination."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_key import ApiKey
from app.models.distributed_state import SharedRateLimitBucket, SyncSubscriptionLease
from app.models.user import User
from app.services.distributed_state import (
    SharedRateLimitExceeded,
    acquire_sync_subscription_lease,
    consume_shared_rate_limit,
    refresh_sync_subscription_lease,
    release_sync_subscription_lease,
)

pytestmark = pytest.mark.committed_db


@pytest.mark.asyncio
async def test_shared_rate_limit_is_exact_bounded_and_hashes_keys(
    db_session: AsyncSession,
) -> None:
    namespace = f"test-{uuid4().hex}"
    start = datetime(2026, 8, 27, tzinfo=UTC)
    window = timedelta(minutes=1)

    for offset in (0, 10):
        await consume_shared_rate_limit(
            namespace=namespace,
            key="raw-client-identifier",
            limit=2,
            window=window,
            max_buckets=2,
            now=start + timedelta(seconds=offset),
        )
    with pytest.raises(SharedRateLimitExceeded) as limited:
        await consume_shared_rate_limit(
            namespace=namespace,
            key="raw-client-identifier",
            limit=2,
            window=window,
            max_buckets=2,
            now=start + timedelta(seconds=30),
        )
    assert limited.value.retry_after_seconds == 30

    await consume_shared_rate_limit(
        namespace=namespace,
        key="second-client",
        limit=2,
        window=window,
        max_buckets=2,
        now=start + timedelta(seconds=30),
    )
    with pytest.raises(SharedRateLimitExceeded):
        await consume_shared_rate_limit(
            namespace=namespace,
            key="third-client",
            limit=2,
            window=window,
            max_buckets=2,
            now=start + timedelta(seconds=30),
        )

    await consume_shared_rate_limit(
        namespace=namespace,
        key="third-client",
        limit=2,
        window=window,
        max_buckets=2,
        now=start + timedelta(seconds=91),
    )
    rows = (
        (
            await db_session.execute(
                select(SharedRateLimitBucket).where(SharedRateLimitBucket.namespace == namespace)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].key_hash != "third-client"
    assert len(rows[0].key_hash) == 64


@pytest.mark.asyncio
async def test_shared_rate_limit_serializes_competing_consumers() -> None:
    namespace = f"test-race-{uuid4().hex}"

    async def consume() -> bool:
        try:
            await consume_shared_rate_limit(
                namespace=namespace,
                key="same-client",
                limit=1,
                window=timedelta(minutes=1),
                max_buckets=1,
            )
        except SharedRateLimitExceeded:
            return False
        return True

    assert sorted(await asyncio.gather(consume(), consume())) == [False, True]


@pytest.mark.asyncio
async def test_sync_subscription_leases_share_caps_and_cannot_resurrect(
    db_session: AsyncSession,
    seed_user: User,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    ttl = timedelta(seconds=90)
    first_api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid4().hex * 2,
        key_prefix="test-first",
        label="First test key",
    )
    second_api_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid4().hex * 2,
        key_prefix="test-second",
        label="Second test key",
    )
    db_session.add_all([first_api_key, second_api_key])
    await db_session.commit()

    first_key = first_api_key.id
    second_key = second_api_key.id
    first = await acquire_sync_subscription_lease(
        user_id=seed_user.id,
        bound_api_key_id=first_key,
        max_per_user=2,
        max_per_key=1,
        ttl=ttl,
        now=start,
    )
    assert first is not None
    assert (
        await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=first_key,
            max_per_user=2,
            max_per_key=1,
            ttl=ttl,
            now=start,
        )
        is None
    )
    second = await acquire_sync_subscription_lease(
        user_id=seed_user.id,
        bound_api_key_id=second_key,
        max_per_user=2,
        max_per_key=1,
        ttl=ttl,
        now=start,
    )
    assert second is not None
    assert (
        await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=None,
            max_per_user=2,
            max_per_key=1,
            ttl=ttl,
            now=start,
        )
        is None
    )

    assert await refresh_sync_subscription_lease(
        first,
        ttl=ttl,
        now=start + timedelta(seconds=30),
    )
    assert not await refresh_sync_subscription_lease(
        first,
        ttl=ttl,
        now=start + timedelta(seconds=121),
    )
    await release_sync_subscription_lease(second)
    replacement = await acquire_sync_subscription_lease(
        user_id=seed_user.id,
        bound_api_key_id=None,
        max_per_user=2,
        max_per_key=1,
        ttl=ttl,
        now=start + timedelta(seconds=121),
    )
    assert replacement is not None
    await release_sync_subscription_lease(replacement)
    lease_count = (
        await db_session.execute(
            select(func.count())
            .select_from(SyncSubscriptionLease)
            .where(SyncSubscriptionLease.user_id == seed_user.id)
        )
    ).scalar_one()
    assert lease_count == 0


@pytest.mark.asyncio
async def test_sync_subscription_cap_serializes_competing_workers(seed_user: User) -> None:
    async def acquire() -> UUID | None:
        return await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=None,
            max_per_user=1,
            max_per_key=1,
            ttl=timedelta(seconds=90),
        )

    leases = await asyncio.gather(acquire(), acquire())
    assert sum(lease is not None for lease in leases) == 1
