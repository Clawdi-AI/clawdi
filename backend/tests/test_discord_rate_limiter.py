from __future__ import annotations

from app.services.discord_rate_limiter import DiscordRateLimiter

_ACCOUNT_SCOPE = "account-a"


class _Headers(dict[str, str]):
    def get(self, key: str, default: str | None = None) -> str | None:
        return super().get(key, default)


def _headers(entries: dict[str, str | None]) -> _Headers:
    return _Headers({key: value for key, value in entries.items() if value is not None})


def test_discord_route_key_collapses_snowflakes_and_keeps_major_parameter():
    limiter = DiscordRateLimiter()

    assert (
        limiter.route_key(
            _ACCOUNT_SCOPE,
            "PATCH",
            "/api/v10/channels/1494815997981491361/messages/1494831575131492536",
        )
        == "account-a|PATCH /channels/:major/messages/:id|1494815997981491361"
    )


def test_discord_route_key_templates_webhook_tokens():
    limiter = DiscordRateLimiter()

    key = limiter.route_key(
        _ACCOUNT_SCOPE,
        "POST",
        "/api/v10/webhooks/1469647169291026595/aW50ZXJhY3Rpb246MTQ5NDgzNDk3ODY2MjUxODkzNA__",
    )

    assert "/webhooks/:major/:token|" in key


def test_discord_route_key_keeps_different_channel_buckets_distinct():
    limiter = DiscordRateLimiter()

    a = limiter.route_key(
        _ACCOUNT_SCOPE,
        "POST",
        "/api/v10/channels/111111111111111111/messages",
    )
    b = limiter.route_key(
        _ACCOUNT_SCOPE,
        "POST",
        "/api/v10/channels/222222222222222222/messages",
    )

    assert a != b


def test_discord_route_key_strips_api_prefixes():
    limiter = DiscordRateLimiter()

    assert limiter.route_key(
        _ACCOUNT_SCOPE,
        "POST",
        "/channels/111111111111111111/messages",
    ) == (
        limiter.route_key(
            _ACCOUNT_SCOPE,
            "POST",
            "/api/v10/channels/111111111111111111/messages",
        )
    )
    assert limiter.route_key(
        _ACCOUNT_SCOPE,
        "POST",
        "/channels/111111111111111111/messages",
    ) == (
        limiter.route_key(
            _ACCOUNT_SCOPE,
            "POST",
            "/v1/channels/discord/v10/channels/111111111111111111/messages",
        )
    )


def test_discord_limiter_allows_by_default_and_observes_headers():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"

    assert limiter.check(_ACCOUNT_SCOPE, "POST", path).allowed is True
    limiter.observe(
        _ACCOUNT_SCOPE,
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
    state = limiter.inspect(_ACCOUNT_SCOPE, "POST", path)

    assert state is not None
    assert state.remaining == 4
    assert state.reset_at == 2.0


def test_discord_limiter_blocks_until_bucket_reset_then_clears():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"
    limiter.observe(
        _ACCOUNT_SCOPE,
        "POST",
        path,
        _headers({"x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1"}),
        200,
    )

    blocked = limiter.check(_ACCOUNT_SCOPE, "POST", path)
    now = 1.5
    after = limiter.check(_ACCOUNT_SCOPE, "POST", path)

    assert blocked.allowed is False
    assert blocked.retry_after_seconds == 1.0
    assert after.allowed is True


def test_discord_limiter_honors_retry_after_on_429():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"

    limiter.observe(_ACCOUNT_SCOPE, "POST", path, _headers({"retry-after": "5"}), 429)
    blocked = limiter.check(_ACCOUNT_SCOPE, "POST", path)

    assert blocked.allowed is False
    assert blocked.retry_after_seconds == 5.0


def test_discord_limiter_treats_zero_retry_after_as_immediately_due():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"

    limiter.observe(_ACCOUNT_SCOPE, "POST", path, _headers({"retry-after": "0"}), 429)

    assert limiter.check(_ACCOUNT_SCOPE, "POST", path).allowed is True


def test_discord_limiter_consume_decrements_remaining_for_in_flight_requests():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    path = "/channels/111111111111111111/messages"
    limiter.observe(
        _ACCOUNT_SCOPE,
        "POST",
        path,
        _headers({"x-ratelimit-remaining": "2", "x-ratelimit-reset-after": "2"}),
        200,
    )

    limiter.consume(_ACCOUNT_SCOPE, "POST", path)
    limiter.consume(_ACCOUNT_SCOPE, "POST", path)

    state = limiter.inspect(_ACCOUNT_SCOPE, "POST", path)
    assert state is not None
    assert state.remaining == 0
    assert limiter.check(_ACCOUNT_SCOPE, "POST", path).allowed is False


def test_discord_limiter_blocks_past_global_budget_and_resets_after_one_second():
    now = 0.0
    limiter = DiscordRateLimiter(global_per_second=3, now=lambda: now)
    limiter.consume(_ACCOUNT_SCOPE, "GET", "/users/@me")
    limiter.consume(_ACCOUNT_SCOPE, "GET", "/users/@me")
    limiter.consume(_ACCOUNT_SCOPE, "GET", "/users/@me")

    blocked = limiter.check(_ACCOUNT_SCOPE, "GET", "/users/@me")
    now = 1.001
    after = limiter.check(_ACCOUNT_SCOPE, "GET", "/users/@me")

    assert blocked.allowed is False
    assert blocked.global_limit is True
    assert after.allowed is True


def test_discord_limiter_upstream_global_429_clamps_window():
    now = 0.0
    limiter = DiscordRateLimiter(global_per_second=100, now=lambda: now)

    limiter.observe(
        _ACCOUNT_SCOPE,
        "POST",
        "/channels/111111111111111111/messages",
        _headers({"retry-after": "2", "x-ratelimit-global": "true"}),
        429,
    )
    blocked = limiter.check(
        _ACCOUNT_SCOPE,
        "POST",
        "/channels/111111111111111111/messages",
    )
    now = 1.001
    still_blocked = limiter.check(
        _ACCOUNT_SCOPE,
        "GET",
        "/applications/222222222222222222/commands",
    )
    now = 2.001
    after = limiter.check(
        _ACCOUNT_SCOPE,
        "GET",
        "/applications/222222222222222222/commands",
    )

    assert blocked.allowed is False
    assert blocked.global_limit is True
    assert blocked.retry_after_seconds == 2.0
    assert still_blocked.allowed is False
    assert still_blocked.global_limit is True
    assert still_blocked.retry_after_seconds is not None
    assert 0.99 < still_blocked.retry_after_seconds < 1.0
    assert after.allowed is True


def test_discord_limiter_isolates_route_and_global_state_by_account_scope():
    # https://discord.com/developers/docs/topics/rate-limits: individual bots
    # are identified for rate limiting through request authentication.
    now = 0.0
    limiter = DiscordRateLimiter(global_per_second=1, now=lambda: now)
    path = "/channels/111111111111111111/messages"

    limiter.observe(
        "account-a",
        "POST",
        path,
        _headers({"retry-after": "5"}),
        429,
    )
    limiter.consume("account-a", "GET", "/users/@me")

    assert limiter.check("account-a", "POST", path).allowed is False
    assert limiter.check("account-a", "GET", "/users/@me").global_limit is True
    assert limiter.check("account-b", "POST", path).allowed is True
    assert limiter.check("account-b", "GET", "/users/@me").allowed is True


def test_discord_limiter_prunes_expired_buckets_during_unrelated_checks():
    now = 0.0
    limiter = DiscordRateLimiter(now=lambda: now)
    limiter.observe(
        _ACCOUNT_SCOPE,
        "POST",
        "/channels/111111111111111111/messages",
        _headers({"x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1"}),
        200,
    )

    now = 2.0
    assert limiter.check("account-b", "GET", "/users/@me").allowed is True
    assert (
        limiter.inspect(
            _ACCOUNT_SCOPE,
            "POST",
            "/channels/111111111111111111/messages",
        )
        is None
    )


def test_discord_limiter_bounds_buckets_and_scopes_with_lru_eviction():
    now = 0.0
    limiter = DiscordRateLimiter(
        global_per_second=100,
        max_buckets=2,
        max_scopes=2,
        now=lambda: now,
    )
    paths = [f"/channels/{value}/messages" for value in (111, 222, 333)]
    for index, path in enumerate(paths):
        scope = f"account-{index}"
        limiter.observe(
            scope,
            "POST",
            path,
            _headers({"x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "60"}),
            200,
        )
        limiter.consume(scope, "GET", "/users/@me")

    assert limiter.inspect("account-0", "POST", paths[0]) is None
    assert limiter.inspect("account-1", "POST", paths[1]) is not None
    assert limiter.inspect("account-2", "POST", paths[2]) is not None
    assert "account-0" not in limiter._global_states
    assert tuple(limiter._global_states) == ("account-1", "account-2")


def test_discord_limiter_prunes_idle_account_scopes():
    now = 0.0
    limiter = DiscordRateLimiter(scope_idle_ttl_seconds=2, now=lambda: now)
    limiter.consume(_ACCOUNT_SCOPE, "GET", "/users/@me")

    now = 2.1
    assert limiter.check("account-b", "GET", "/users/@me").allowed is True
    assert _ACCOUNT_SCOPE not in limiter._global_states
