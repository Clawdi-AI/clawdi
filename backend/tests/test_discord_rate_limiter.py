from __future__ import annotations

from app.services.discord_rate_limiter import DiscordRateLimiter


class _Headers(dict[str, str]):
    def get(self, key: str, default: str | None = None) -> str | None:
        return super().get(key, default)


def _headers(entries: dict[str, str | None]) -> _Headers:
    return _Headers({key: value for key, value in entries.items() if value is not None})


def test_discord_route_key_collapses_snowflakes_and_keeps_major_parameter():
    limiter = DiscordRateLimiter()

    assert limiter.route_key(
        "PATCH",
        "/api/v10/channels/1494815997981491361/messages/1494831575131492536",
    ) == "PATCH /channels/:major/messages/:id|1494815997981491361"


def test_discord_route_key_templates_webhook_tokens():
    limiter = DiscordRateLimiter()

    key = limiter.route_key(
        "POST",
        "/api/v10/webhooks/1469647169291026595/aW50ZXJhY3Rpb246MTQ5NDgzNDk3ODY2MjUxODkzNA__",
    )

    assert "/webhooks/:major/:token|" in key


def test_discord_route_key_keeps_different_channel_buckets_distinct():
    limiter = DiscordRateLimiter()

    a = limiter.route_key("POST", "/api/v10/channels/111111111111111111/messages")
    b = limiter.route_key("POST", "/api/v10/channels/222222222222222222/messages")

    assert a != b


def test_discord_route_key_strips_api_prefixes():
    limiter = DiscordRateLimiter()

    assert limiter.route_key("POST", "/channels/111111111111111111/messages") == (
        limiter.route_key("POST", "/api/v10/channels/111111111111111111/messages")
    )
    assert limiter.route_key("POST", "/channels/111111111111111111/messages") == (
        limiter.route_key(
            "POST",
            "/api/channels/discord/v10/channels/111111111111111111/messages",
        )
    )


def test_discord_limiter_allows_by_default_and_observes_headers():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"

    assert limiter.check("POST", path).allowed is True
    limiter.observe(
        "POST",
        path,
        _headers(
            {
                "x-ratelimit-limit": "5",
                "x-ratelimit-remaining": "4",
                "x-ratelimit-reset-after": "2",
            }
        ),
        200,
    )
    state = limiter.inspect("POST", path)

    assert state is not None
    assert state.remaining == 4
    assert state.reset_at == 2.0


def test_discord_limiter_blocks_until_bucket_reset_then_clears():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"
    limiter.observe(
        "POST",
        path,
        _headers({"x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1"}),
        200,
    )

    blocked = limiter.check("POST", path)
    now = 1.5
    after = limiter.check("POST", path)

    assert blocked.allowed is False
    assert blocked.retry_after_seconds == 1.0
    assert after.allowed is True


def test_discord_limiter_honors_retry_after_on_429():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"

    limiter.observe("POST", path, _headers({"retry-after": "5"}), 429)
    blocked = limiter.check("POST", path)

    assert blocked.allowed is False
    assert blocked.retry_after_seconds == 5.0


def test_discord_limiter_consume_decrements_remaining_for_in_flight_requests():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"
    limiter.observe(
        "POST",
        path,
        _headers({"x-ratelimit-remaining": "2", "x-ratelimit-reset-after": "2"}),
        200,
    )

    limiter.consume("POST", path)
    limiter.consume("POST", path)

    assert limiter.inspect("POST", path).remaining == 0
    assert limiter.check("POST", path).allowed is False


def test_discord_limiter_blocks_past_global_budget_and_resets_after_one_second():
    now = 0.0
    limiter = DiscordRateLimiter(global_per_second=3, now=lambda: now)
    limiter.consume("GET", "/users/@me")
    limiter.consume("GET", "/users/@me")
    limiter.consume("GET", "/users/@me")

    blocked = limiter.check("GET", "/users/@me")
    now = 1.001
    after = limiter.check("GET", "/users/@me")

    assert blocked.allowed is False
    assert blocked.global_limit is True
    assert after.allowed is True


def test_discord_limiter_upstream_global_429_clamps_window():
    now = 0.0
    limiter = DiscordRateLimiter(global_per_second=100, now=lambda: now)

    limiter.observe(
        "POST",
        "/channels/111111111111111111/messages",
        _headers({"retry-after": "2", "x-ratelimit-global": "true"}),
        429,
    )
    blocked = limiter.check("POST", "/channels/111111111111111111/messages")

    assert blocked.allowed is False
    assert blocked.global_limit is True
