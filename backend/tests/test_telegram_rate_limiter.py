from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from app.services.telegram_rate_limiter import TelegramRateLimiter


def _consume(
    limiter: TelegramRateLimiter,
    *,
    account_id: str = "account-a",
    chat_id: str = "chat-a",
):
    return limiter.check_and_consume(
        account_id=account_id,
        method="sendMessage",
        chat_id=chat_id,
    )


def test_telegram_limiter_preserves_bot_and_chat_budgets():
    limiter = TelegramRateLimiter(
        bot_capacity=2,
        bot_refill_per_second=1,
        chat_capacity=2,
        chat_refill_per_second=1,
        now=lambda: 0.0,
    )

    assert _consume(limiter).allowed is True
    assert _consume(limiter).allowed is True
    blocked = _consume(limiter)

    assert blocked.allowed is False
    assert blocked.scope == "bot"


def test_telegram_limiter_refunds_bot_budget_when_chat_is_limited():
    limiter = TelegramRateLimiter(
        bot_capacity=2,
        bot_refill_per_second=1,
        chat_capacity=1,
        chat_refill_per_second=1,
        now=lambda: 0.0,
    )

    assert _consume(limiter, chat_id="chat-a").allowed is True
    blocked = _consume(limiter, chat_id="chat-a")
    other_chat = _consume(limiter, chat_id="chat-b")

    assert blocked.allowed is False
    assert blocked.scope == "chat"
    assert other_chat.allowed is True


def test_telegram_limiter_prunes_idle_buckets_during_unrelated_requests():
    now = 0.0
    limiter = TelegramRateLimiter(
        bot_capacity=1,
        bot_refill_per_second=1,
        chat_capacity=1,
        chat_refill_per_second=1,
        idle_ttl_seconds=2,
        now=lambda: now,
    )
    assert _consume(limiter).allowed is True
    assert len(limiter._buckets) == 2

    now = 2.1
    assert _consume(limiter, account_id="account-b", chat_id="chat-b").allowed is True

    assert tuple(limiter._buckets) == (
        ("bot", "account-b", None),
        ("chat", "account-b", "chat-b"),
    )


def test_telegram_limiter_bounds_buckets_with_deterministic_lru_eviction():
    limiter = TelegramRateLimiter(max_buckets=4, now=lambda: 0.0)

    for index in range(3):
        assert (
            _consume(
                limiter,
                account_id=f"account-{index}",
                chat_id=f"chat-{index}",
            ).allowed
            is True
        )

    assert tuple(limiter._buckets) == (
        ("bot", "account-1", None),
        ("chat", "account-1", "chat-1"),
        ("bot", "account-2", None),
        ("chat", "account-2", "chat-2"),
    )


def test_telegram_limiter_is_thread_safe_under_concurrent_consumers():
    limiter = TelegramRateLimiter(
        bot_capacity=100,
        bot_refill_per_second=1,
        chat_capacity=100,
        chat_refill_per_second=1,
        now=lambda: 0.0,
    )

    with ThreadPoolExecutor(max_workers=16) as executor:
        decisions = list(executor.map(lambda _index: _consume(limiter), range(100)))

    assert all(decision.allowed for decision in decisions)
    assert limiter._buckets[("bot", "account-a", None)].tokens == 0
    assert limiter._buckets[("chat", "account-a", "chat-a")].tokens == 0
