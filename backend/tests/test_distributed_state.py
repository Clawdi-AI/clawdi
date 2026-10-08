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


@pytest.fixture
async def bound_key(db_session: AsyncSession, seed_user: User) -> UUID:
    key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid4().hex * 2,
        key_prefix="test-evict",
        label="Subscription eviction test key",
    )
    db_session.add(key)
    await db_session.commit()
    return key.id


async def _acquire_bound_lease(
    user_id: UUID,
    key_id: UUID,
    now: datetime,
    *,
    max_per_user: int = 10,
    max_per_key: int = 3,
    min_age: timedelta | None = timedelta(seconds=60),
) -> UUID | None:
    return await acquire_sync_subscription_lease(
        user_id=user_id,
        bound_api_key_id=key_id,
        max_per_user=max_per_user,
        max_per_key=max_per_key,
        ttl=timedelta(minutes=5),
        evict_bound_key_min_age=min_age,
        now=now,
    )


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
@pytest.mark.parametrize("eviction", [False, True])
async def test_sync_subscription_cap_serializes_competing_workers(
    db_session: AsyncSession,
    seed_user: User,
    bound_key: UUID,
    eviction: bool,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    original = None
    if eviction:
        original = await _acquire_bound_lease(seed_user.id, bound_key, start, max_per_key=1)
        assert original is not None

    async def acquire() -> UUID | None:
        return await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=bound_key if eviction else None,
            max_per_user=10 if eviction else 1,
            max_per_key=1,
            ttl=timedelta(seconds=90),
            evict_bound_key_min_age=timedelta(seconds=60) if eviction else None,
            now=start + timedelta(seconds=120),
        )

    leases = await asyncio.gather(acquire(), acquire())
    assert sum(lease is not None for lease in leases) == 1
    remaining = list(
        await db_session.scalars(
            select(SyncSubscriptionLease.id).where(SyncSubscriptionLease.user_id == seed_user.id)
        )
    )
    assert remaining == [lease for lease in leases if lease is not None]
    if original is not None:
        assert not await refresh_sync_subscription_lease(
            original, ttl=timedelta(seconds=90), now=start + timedelta(seconds=120)
        )


@pytest.mark.asyncio
async def test_sync_subscription_evicts_oldest_eligible_bound_key_lease(
    db_session: AsyncSession,
    seed_user: User,
    bound_key: UUID,
    caplog: pytest.LogCaptureFixture,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    leases = [
        await _acquire_bound_lease(seed_user.id, bound_key, start + timedelta(seconds=offset))
        for offset in range(3)
    ]
    assert all(lease is not None for lease in leases)
    current = start + timedelta(seconds=120)
    with caplog.at_level("INFO", logger="app.services.distributed_state"):
        replacement = await _acquire_bound_lease(seed_user.id, bound_key, current)
    assert replacement is not None
    for index, lease in enumerate(leases):
        assert lease is not None
        assert await refresh_sync_subscription_lease(
            lease, ttl=timedelta(minutes=5), now=current
        ) is (index != 0)
    remaining = set(
        await db_session.scalars(
            select(SyncSubscriptionLease.id).where(
                SyncSubscriptionLease.bound_api_key_id == bound_key
            )
        )
    )
    assert remaining == {leases[1], leases[2], replacement}
    assert caplog.messages == [
        "sync events: evicted oldest bound-key subscription lease "
        f"id={str(leases[0])[:8]} age=120.0s"
    ]


@pytest.mark.asyncio
async def test_sync_subscription_bound_key_replacement_frees_user_slot(
    db_session: AsyncSession,
    seed_user: User,
    bound_key: UUID,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    bound_leases = [
        await _acquire_bound_lease(seed_user.id, bound_key, start + timedelta(seconds=offset))
        for offset in range(3)
    ]
    other_leases = [
        await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=None,
            max_per_user=10,
            max_per_key=3,
            ttl=timedelta(minutes=5),
            now=start,
        )
        for _ in range(7)
    ]
    assert all(lease is not None for lease in [*bound_leases, *other_leases])

    current = start + timedelta(seconds=120)
    replacement = await _acquire_bound_lease(seed_user.id, bound_key, current)
    assert replacement is not None
    assert (
        await refresh_sync_subscription_lease(
            bound_leases[0], ttl=timedelta(minutes=5), now=current
        )
        is False
    )
    for lease in [*bound_leases[1:], *other_leases, replacement]:
        assert lease is not None
        assert await refresh_sync_subscription_lease(lease, ttl=timedelta(minutes=5), now=current)

    lease_count = (
        await db_session.execute(
            select(func.count())
            .select_from(SyncSubscriptionLease)
            .where(SyncSubscriptionLease.user_id == seed_user.id)
        )
    ).scalar_one()
    assert lease_count == 10


@pytest.mark.asyncio
async def test_sync_subscription_user_cap_rejects_bound_key_below_key_cap(
    db_session: AsyncSession,
    seed_user: User,
    bound_key: UUID,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    bound_leases = [await _acquire_bound_lease(seed_user.id, bound_key, start) for _ in range(2)]
    other_leases = [
        await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=None,
            max_per_user=10,
            max_per_key=3,
            ttl=timedelta(minutes=5),
            now=start,
        )
        for _ in range(8)
    ]
    assert all(lease is not None for lease in [*bound_leases, *other_leases])

    current = start + timedelta(seconds=120)
    assert await _acquire_bound_lease(seed_user.id, bound_key, current) is None
    for lease in [*bound_leases, *other_leases]:
        assert lease is not None
        assert await refresh_sync_subscription_lease(lease, ttl=timedelta(minutes=5), now=current)

    lease_count = (
        await db_session.execute(
            select(func.count())
            .select_from(SyncSubscriptionLease)
            .where(SyncSubscriptionLease.user_id == seed_user.id)
        )
    ).scalar_one()
    assert lease_count == 10


@pytest.mark.asyncio
@pytest.mark.parametrize("age_seconds", [10, 59, 60])
async def test_sync_subscription_bound_key_eviction_respects_min_age(
    db_session: AsyncSession,
    seed_user: User,
    bound_key: UUID,
    age_seconds: int,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    leases = [await _acquire_bound_lease(seed_user.id, bound_key, start) for _ in range(3)]
    assert all(lease is not None for lease in leases)
    current = start + timedelta(seconds=age_seconds)
    replacement = await _acquire_bound_lease(seed_user.id, bound_key, current)
    assert (replacement is not None) is (age_seconds == 60)
    ordered = list(
        await db_session.scalars(
            select(SyncSubscriptionLease.id)
            .where(SyncSubscriptionLease.bound_api_key_id == bound_key)
            .order_by(SyncSubscriptionLease.created_at, SyncSubscriptionLease.id)
        )
    )
    # Equal creation times are ordered deterministically by lease ID.
    evicted = min(lease for lease in leases if lease is not None) if replacement else None
    assert set(ordered) == ({*leases} - {evicted}) | ({replacement} if replacement else set())
    for lease in leases:
        assert lease is not None
        assert await refresh_sync_subscription_lease(
            lease, ttl=timedelta(minutes=5), now=current
        ) is (lease != evicted)


@pytest.mark.asyncio
async def test_sync_subscription_per_user_cap_never_evicts(
    db_session: AsyncSession,
    seed_user: User,
    bound_key: UUID,
) -> None:
    other_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid4().hex * 2,
        key_prefix="test-other",
        label="Other subscription test key",
    )
    db_session.add(other_key)
    await db_session.commit()
    start = datetime(2026, 8, 27, tzinfo=UTC)
    leases = [
        await _acquire_bound_lease(seed_user.id, key, start, max_per_user=2)
        for key in (bound_key, other_key.id)
    ]
    current = start + timedelta(seconds=120)
    assert await _acquire_bound_lease(seed_user.id, bound_key, current, max_per_user=2) is None
    for lease in leases:
        assert lease is not None
        assert await refresh_sync_subscription_lease(lease, ttl=timedelta(minutes=5), now=current)


@pytest.mark.asyncio
async def test_sync_subscription_bound_key_eviction_defaults_off(
    seed_user: User,
    bound_key: UUID,
) -> None:
    start = datetime(2026, 8, 27, tzinfo=UTC)
    original = await _acquire_bound_lease(seed_user.id, bound_key, start, max_per_key=1)
    assert original is not None
    current = start + timedelta(seconds=120)
    assert (
        await acquire_sync_subscription_lease(
            user_id=seed_user.id,
            bound_api_key_id=bound_key,
            max_per_user=10,
            max_per_key=1,
            ttl=timedelta(minutes=5),
            now=current,
        )
        is None
    )
    assert await refresh_sync_subscription_lease(original, ttl=timedelta(minutes=5), now=current)
