from __future__ import annotations

import asyncio
import os
from collections.abc import Generator
from contextlib import contextmanager

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    multiprocess,
)
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
provider_ingress_terminal_events = Counter(
    "msg_router_provider_ingress_terminal_events_total",
    "Provider ingress events terminally acknowledged without durable admission",
    ["channel", "reason"],
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
    multiprocess_mode="livesum",
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
channel_queue_pending = Gauge(
    "msg_router_channel_queue_pending",
    "Pending durable channel queue rows",
    ["provider", "queue"],
    registry=registry,
)
channel_queue_stuck_pending = Gauge(
    "msg_router_channel_queue_stuck_pending",
    "Pending durable channel queue rows older than the configured alert horizon",
    ["provider", "queue"],
    registry=registry,
)
channel_queue_oldest_pending_age = Gauge(
    "msg_router_channel_queue_oldest_pending_age_seconds",
    "Age in seconds of the oldest pending durable channel queue row",
    ["provider", "queue"],
    registry=registry,
)
channel_retention_deletions = Counter(
    "msg_router_channel_retention_deletions_total",
    "Channel retention rows deleted by record kind",
    ["record_kind"],
    registry=registry,
)
channel_retention_delivery_expirations = Counter(
    "msg_router_channel_retention_delivery_expirations_total",
    "Pending channel deliveries terminally consumed at a provider retention horizon",
    ["provider"],
    registry=registry,
)
channel_retention_secret_scrubs = Counter(
    "msg_router_channel_retention_secret_scrubs_total",
    "Expired provider credential fields removed from retained channel payloads",
    ["provider", "secret_kind"],
    registry=registry,
)
channel_retention_budget_exhaustions = Counter(
    "msg_router_channel_retention_budget_exhaustions_total",
    "Channel retention runs that exhausted their configured batch budget",
    ["record_kind"],
    registry=registry,
)
event_loop_lag = Histogram(
    "clawdi_backend_event_loop_lag_seconds",
    "Delay beyond the backend event loop's one-second sampling interval",
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5),
    registry=registry,
)
db_query_duration = Histogram(
    "clawdi_backend_db_query_duration_seconds",
    "Time spent executing backend database statements",
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
    registry=registry,
)
db_connection_hold_duration = Histogram(
    "clawdi_backend_db_connection_hold_duration_seconds",
    "Time backend database connections remain checked out",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60),
    registry=registry,
)
db_pool_checked_out = Gauge(
    "clawdi_backend_db_pool_checked_out",
    "Number of backend database connections currently checked out",
    multiprocess_mode="livesum",
    registry=registry,
)
db_pool_timeouts = Counter(
    "clawdi_backend_db_pool_timeouts_total",
    "Requests rejected because the backend database pool was exhausted",
    registry=registry,
)
embedding_in_flight = Gauge(
    "clawdi_backend_embedding_in_flight",
    "Embedding requests currently executing or waiting on the configured backend",
    ["backend"],
    multiprocess_mode="livesum",
    registry=registry,
)
embedding_duration = Histogram(
    "clawdi_backend_embedding_duration_seconds",
    "End-to-end embedding request latency by backend and outcome",
    ["backend", "outcome"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30),
    registry=registry,
)
embedding_rejections = Counter(
    "clawdi_backend_embedding_rejections_total",
    "Embedding requests rejected before inference",
    ["backend", "reason"],
    registry=registry,
)


def render_metrics() -> bytes:
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        multiprocess_registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(multiprocess_registry)
        return generate_latest(multiprocess_registry)
    return generate_latest(registry)


def metrics_content_type() -> str:
    return CONTENT_TYPE_LATEST


async def observe_event_loop_lag(interval_seconds: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    while True:
        started = loop.time()
        await asyncio.sleep(interval_seconds)
        event_loop_lag.observe(max(0.0, loop.time() - started - interval_seconds))


@contextmanager
def track_proxy_latency(channel: str, method: str) -> Generator[None, None, None]:
    with proxy_latency.labels(channel=channel, method=method).time():
        yield
