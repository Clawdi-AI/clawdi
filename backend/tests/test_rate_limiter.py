from __future__ import annotations

import pytest

from app.services.rate_limiter import RateLimiter, TokenBucket


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_token_bucket_allows_requests_within_capacity() -> None:
    bucket = TokenBucket(5, 1, now=_Clock())

    for _ in range(5):
        assert bucket.try_consume().allowed


def test_token_bucket_rejects_when_exhausted() -> None:
    bucket = TokenBucket(2, 1, now=_Clock())
    bucket.try_consume()
    bucket.try_consume()

    result = bucket.try_consume()

    assert not result.allowed
    assert result.retry_after_ms > 0


def test_token_bucket_refills_over_time() -> None:
    clock = _Clock()
    bucket = TokenBucket(2, 1, now=clock)
    bucket.try_consume()
    bucket.try_consume()

    clock.advance(1.0)
    result = bucket.try_consume()

    assert result.allowed


def test_token_bucket_does_not_exceed_capacity_on_refill() -> None:
    clock = _Clock()
    bucket = TokenBucket(3, 10, now=clock)

    clock.advance(5.0)
    consumed = 0
    while bucket.try_consume().allowed:
        consumed += 1

    assert consumed == 3


def test_token_bucket_returns_retry_after_ms() -> None:
    bucket = TokenBucket(1, 2, now=_Clock())
    bucket.try_consume()

    result = bucket.try_consume()

    assert not result.allowed
    assert result.retry_after_ms == 500


def test_rate_limiter_creates_separate_buckets_per_key() -> None:
    limiter = RateLimiter(1, 1, now=_Clock())

    assert limiter.try_consume("a").allowed
    assert limiter.try_consume("b").allowed
    assert not limiter.try_consume("a").allowed
    assert not limiter.try_consume("b").allowed


def test_rate_limiter_limits_within_single_key() -> None:
    limiter = RateLimiter(2, 1, now=_Clock())
    limiter.try_consume("x")
    limiter.try_consume("x")

    assert not limiter.try_consume("x").allowed


@pytest.mark.parametrize(
    ("capacity", "refill_rate", "count"),
    [(0, 1, 1), (1, 0, 1), (1, 1, 0)],
)
def test_rate_limiter_rejects_invalid_limits(
    capacity: int,
    refill_rate: float,
    count: int,
) -> None:
    if capacity <= 0 or refill_rate <= 0:
        with pytest.raises(ValueError):
            TokenBucket(capacity, refill_rate)
        return
    bucket = TokenBucket(capacity, refill_rate)
    with pytest.raises(ValueError):
        bucket.try_consume(count)
