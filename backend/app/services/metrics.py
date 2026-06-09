from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram
from prometheus_client.exposition import generate_latest

registry = CollectorRegistry()

inbound_messages = Counter(
    "msg_router_inbound_total",
    "Total inbound messages routed to tenant inboxes",
    ["channel"],
    registry=registry,
)
outbound_messages = Counter(
    "msg_router_outbound_total",
    "Total outbound API calls proxied to provider",
    ["channel", "method"],
    registry=registry,
)
outbound_errors = Counter(
    "msg_router_outbound_errors_total",
    "Total outbound proxy errors (non-2xx or network failure)",
    ["channel", "method"],
    registry=registry,
)
discord_command_fanout_runs = Counter(
    "msg_router_discord_command_fanout_runs_total",
    "Discord application command fan-out replay runs by outcome",
    ["outcome"],
    registry=registry,
)
rate_limit_rejects = Counter(
    "msg_router_rate_limit_rejects_total",
    "Total outbound requests rejected by rate limiter",
    ["channel", "scope"],
    registry=registry,
)
ingress_errors = Counter(
    "msg_router_ingress_errors_total",
    "Total ingress poll errors",
    ["channel", "bot_id"],
    registry=registry,
)
proxy_latency = Histogram(
    "msg_router_proxy_latency_seconds",
    "Outbound proxy request latency in seconds",
    ["channel", "method"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
    registry=registry,
)
active_polls = Gauge(
    "msg_router_active_polls",
    "Number of active ingress poll loops",
    ["channel"],
    registry=registry,
)
webhook_deliveries = Counter(
    "msg_router_webhook_deliveries_total",
    "Total webhook delivery attempts by outcome",
    ["outcome"],
    registry=registry,
)
webhook_ttl_drops = Counter(
    "msg_router_webhook_ttl_drops_total",
    "Total inbox rows dropped by TTL sweep or expired before delivery",
    registry=registry,
)


def render_metrics() -> bytes:
    return generate_latest(registry)


def metrics_content_type() -> str:
    return CONTENT_TYPE_LATEST


@contextmanager
def track_proxy_latency(channel: str, method: str) -> Iterator[None]:
    with proxy_latency.labels(channel=channel, method=method).time():
        yield
