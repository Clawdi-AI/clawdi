import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.core.sentry import init_sentry
from app.middleware.request_id import RequestIDMiddleware
from app.routes.auth import router as auth_router
from app.routes.cli_auth import router as cli_auth_router
from app.routes.connectors import router as connectors_router
from app.routes.dashboard import router as dashboard_router
from app.routes.mcp_proxy import router as mcp_proxy_router
from app.routes.memories import router as memories_router
from app.routes.search import router as search_router
from app.routes.sessions import router as sessions_router
from app.routes.settings import router as settings_router
from app.routes.skills import router as skills_router
from app.routes.vault import router as vault_router
from app.services.embedding import LocalEmbedder

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)
init_sentry()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """ASGI lifespan — warm slow singletons at startup so the first request
    path isn't the one that pays for them.

    Fastembed downloads ~1GB on first `memory add` otherwise. We kick the
    load off the main thread so it doesn't block startup itself; if it
    finishes before the first embedding call, that call is fast.
    """
    background: set[asyncio.Task[None]] = set()

    if settings.memory_embedding_mode.lower() == "local":

        async def _warm() -> None:
            try:
                await asyncio.to_thread(LocalEmbedder.get)
                log.info("Local embedder warmed.")
            except Exception as e:  # noqa: BLE001 — never block startup on embedder
                log.warning("Local embedder warmup failed: %s", e)

        # Hold a strong reference — asyncio.create_task returns a weak-ref'd
        # Task and the GC can reap it mid-flight otherwise. Python docs
        # explicitly warn about this pattern.
        task = asyncio.create_task(_warm(), name="embedder-warm")
        background.add(task)
        task.add_done_callback(background.discard)

    try:
        yield
    finally:
        # On shutdown, cancel anything still running and wait for it so we
        # don't leak a task into whatever signal handler runs next.
        for t in background:
            t.cancel()
        if background:
            await asyncio.gather(*background, return_exceptions=True)


app = FastAPI(
    title=settings.app_name,
    # Hide interactive docs in production unless explicitly enabled.
    docs_url="/docs" if settings.environment != "production" else None,
    redoc_url="/redoc" if settings.environment != "production" else None,
    lifespan=lifespan,
)

# Middleware is added in innermost-to-outermost order. Starlette wraps each
# subsequent `add_middleware` call around the previous stack, so the LAST
# call becomes the OUTERMOST handler seeing the request first. We want:
#
#   request → RequestID → CORS → route → CORS → RequestID → response
#
# so a CORS-rejected preflight still carries X-Request-ID on the way back out.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Request-ID",
        "X-Correlation-ID",
        "X-Clawdi-Environment-Id",
        "X-Clawdi-Token",
    ],
    expose_headers=["X-Request-ID"],
    # 10 min production, but in dev the preflight cache outlives endpoint
    # changes (new routes registered during uvicorn --reload get rejected by
    # stale cached 404 preflights). Shorten in dev for fast iteration.
    max_age=30 if settings.environment != "production" else 600,
)
app.add_middleware(RequestIDMiddleware)

app.include_router(auth_router)
app.include_router(cli_auth_router)
app.include_router(sessions_router)
app.include_router(dashboard_router)
app.include_router(skills_router)
app.include_router(memories_router)
app.include_router(settings_router)
app.include_router(vault_router)
app.include_router(connectors_router)
app.include_router(mcp_proxy_router)
app.include_router(search_router)


@app.get("/health")
async def health(db: AsyncSession = Depends(get_session)) -> dict[str, str]:
    """Liveness + DB connectivity probe.

    Returns 200 + ``{"status": "ok"}`` on success. If the DB is unreachable
    the dependency raises and FastAPI returns 500 — the right signal for a
    load balancer to yank this pod out of rotation.
    """
    await db.execute(text("SELECT 1"))
    return {"status": "ok"}
