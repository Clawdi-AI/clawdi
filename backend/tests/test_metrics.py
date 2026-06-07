from __future__ import annotations

import base64
import re
import uuid

import httpx

from app.core.config import settings
from app.services.metrics import (
    active_polls,
    inbound_messages,
    ingress_errors,
    outbound_errors,
    outbound_messages,
    proxy_latency,
    rate_limit_rejects,
    render_metrics,
)


def _metrics_text() -> str:
    return render_metrics().decode("utf-8")


def _basic(user: str, password: str) -> str:
    encoded = base64.b64encode(f"{user}:{password}".encode()).decode()
    return f"Basic {encoded}"


def _metric_value(name: str, labels: dict[str, str]) -> float:
    label_text = ",".join(f'{key}="{value}"' for key, value in labels.items())
    pattern = rf"^{re.escape(name)}\{{{re.escape(label_text)}\}} ([0-9.]+)$"
    match = re.search(pattern, _metrics_text(), re.MULTILINE)
    return float(match.group(1)) if match else 0.0


def test_metrics_exports_all_expected_metrics() -> None:
    text = _metrics_text()
    assert "msg_router_inbound_total" in text
    assert "msg_router_outbound_total" in text
    assert "msg_router_outbound_errors_total" in text
    assert "msg_router_discord_command_fanout_runs_total" in text
    assert "msg_router_rate_limit_rejects_total" in text
    assert "msg_router_ingress_errors_total" in text
    assert "msg_router_proxy_latency_seconds" in text
    assert "msg_router_active_polls" in text
    assert "msg_router_webhook_deliveries_total" in text
    assert "msg_router_webhook_ttl_drops_total" in text


def test_metrics_increment_counters() -> None:
    suffix = uuid.uuid4().hex
    channel = f"telegram-{suffix}"
    method = f"sendMessage-{suffix}"
    bot_id = f"b-{suffix}"

    inbound_messages.labels(channel=channel).inc()
    inbound_messages.labels(channel=channel).inc()
    outbound_messages.labels(channel=channel, method=method).inc()
    outbound_errors.labels(channel=channel, method=method).inc()
    rate_limit_rejects.labels(channel=channel, scope="chat").inc()
    ingress_errors.labels(channel=channel, bot_id=bot_id).inc()

    text = _metrics_text()
    assert f'msg_router_inbound_total{{channel="{channel}"}} 2.0' in text
    assert f'msg_router_outbound_total{{channel="{channel}",method="{method}"}} 1.0' in text


def test_metrics_records_histogram_observations() -> None:
    suffix = uuid.uuid4().hex
    proxy_latency.labels(channel=f"telegram-{suffix}", method="sendMessage").observe(0.11)

    text = _metrics_text()
    assert "msg_router_proxy_latency_seconds_count" in text


def test_metrics_tracks_gauge_up_and_down() -> None:
    channel = f"telegram-{uuid.uuid4().hex}"
    active_polls.labels(channel=channel).inc()
    active_polls.labels(channel=channel).inc()
    active_polls.labels(channel=channel).dec()

    text = _metrics_text()
    assert f'msg_router_active_polls{{channel="{channel}"}} 1.0' in text


async def test_metrics_route_allows_when_no_auth_is_configured(
    client: httpx.AsyncClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "metrics_bearer_token", "")
    monkeypatch.setattr(settings, "metrics_basic_auth_password", "")

    response = await client.get("/metrics")

    assert response.status_code == 200
    assert "msg_router_inbound_total" in response.text


async def test_metrics_route_supports_bearer_auth(
    client: httpx.AsyncClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "metrics_bearer_token", "secret-token")
    monkeypatch.setattr(settings, "metrics_basic_auth_password", "")

    unauthorized = await client.get("/metrics", headers={"Authorization": "Bearer wrong"})
    authorized = await client.get("/metrics", headers={"Authorization": "Bearer secret-token"})

    assert unauthorized.status_code == 401
    assert unauthorized.headers["www-authenticate"] == "Bearer"
    assert authorized.status_code == 200


async def test_metrics_route_supports_basic_auth(
    client: httpx.AsyncClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "metrics_bearer_token", "")
    monkeypatch.setattr(settings, "metrics_basic_auth_user", "prometheus")
    monkeypatch.setattr(settings, "metrics_basic_auth_password", "secret-password")

    unauthorized = await client.get(
        "/metrics",
        headers={"Authorization": _basic("prometheus", "wrong")},
    )
    authorized = await client.get(
        "/metrics",
        headers={"Authorization": _basic("prometheus", "secret-password")},
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200


async def test_telegram_webhook_increments_inbound_metric(
    client: httpx.AsyncClient,
    channel_agent,
) -> None:
    before = _metric_value("msg_router_inbound_total", {"channel": "telegram"})
    created = (
        await client.post(
            "/api/channels",
            json={"provider": "telegram", "name": f"metrics-{uuid.uuid4().hex}"},
        )
    ).json()
    pair = (
        await client.post(
            f"/api/channels/{created['id']}/pair-codes",
            json={"ttl_seconds": 900},
        )
    ).json()

    response = await client.post(
        f"/api/channels/telegram/{created['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": created["webhook_secret"]},
        json={
            "update_id": int(uuid.uuid4().int % 1_000_000_000),
            "message": {
                "message_id": 1,
                "chat": {"id": 42, "type": "private", "first_name": "Metrics"},
                "text": f"/bot_pair {pair['code']}",
            },
        },
    )

    assert response.status_code == 200
    assert _metric_value("msg_router_inbound_total", {"channel": "telegram"}) == before + 1.0
