from __future__ import annotations

from app.routes.channel_routers.discord import _DiscordGatewaySessionStore


def test_discord_gateway_session_store_expires_idle_sessions():
    now = 0.0
    store = _DiscordGatewaySessionStore(
        max_sessions=2,
        ttl_seconds=5,
        now=lambda: now,
    )
    state = {"last_sequence": 3}
    store.put("session-a", state)

    now = 10.0
    assert store.get("session-a") is state
    store.disconnect("session-a")
    now = 14.9
    assert store.get("session-a") is state
    now = 20.0

    assert store.get("session-a") is None
    assert len(store) == 0


def test_discord_gateway_session_store_uses_deterministic_lru_eviction():
    store = _DiscordGatewaySessionStore(
        max_sessions=2,
        ttl_seconds=60,
        now=lambda: 0.0,
    )
    store.put("session-a", {})
    store.disconnect("session-a")
    store.put("session-b", {})
    store.disconnect("session-b")
    assert store.touch("session-a") is True

    store.put("session-c", {})
    store.disconnect("session-c")

    assert store.session_ids() == ("session-a", "session-c")
    assert store.get("session-b") is None


def test_discord_gateway_session_store_stays_bounded_under_churn():
    store = _DiscordGatewaySessionStore(
        max_sessions=3,
        ttl_seconds=60,
        now=lambda: 0.0,
    )

    for index in range(100):
        store.put(f"session-{index}", {"last_sequence": index})
        store.disconnect(f"session-{index}")

    assert len(store) == 3
    assert store.session_ids() == ("session-97", "session-98", "session-99")


def test_discord_gateway_session_store_never_evicts_connected_sessions():
    now = 0.0
    store = _DiscordGatewaySessionStore(
        max_sessions=1,
        ttl_seconds=5,
        now=lambda: now,
    )
    active = {"last_sequence": 1}
    store.put("active", active)
    for index in range(3):
        store.put(f"idle-{index}", {})
        store.disconnect(f"idle-{index}")
    now = 100.0

    assert store.get("active") is active
    assert store.session_ids() == ("active",)
