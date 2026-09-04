from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, multiprocess
from prometheus_client.exposition import CONTENT_TYPE_LATEST, generate_latest

registry = CollectorRegistry()
workers_live = Gauge(
    "test_workers_live",
    "Workers whose application lifespan is active",
    multiprocess_mode="livesum",
    registry=registry,
)
worker_starts = Counter(
    "test_worker_starts_total",
    "Worker application lifespan starts",
    registry=registry,
)
worker_start_duration = Histogram(
    "test_worker_start_duration_seconds",
    "Worker application startup duration",
    registry=registry,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    workers_live.inc()
    worker_starts.inc()
    worker_start_duration.observe(0.001)
    try:
        yield
    finally:
        workers_live.dec()


app = FastAPI(lifespan=lifespan)


@app.get("/metrics")
async def metrics() -> Response:
    multiprocess_registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(multiprocess_registry)
    return Response(generate_latest(multiprocess_registry), media_type=CONTENT_TYPE_LATEST)
