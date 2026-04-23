import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.core.sentry import init_sentry
from app.middleware.request_id import RequestIDMiddleware
from app.routes.auth import router as auth_router
from app.routes.connectors import router as connectors_router
from app.routes.dashboard import router as dashboard_router
from app.routes.mcp_proxy import router as mcp_proxy_router
from app.routes.memories import router as memories_router
from app.routes.sessions import router as sessions_router
from app.routes.settings import router as settings_router
from app.routes.skills import router as skills_router
from app.routes.vault import router as vault_router

logging.basicConfig(level=logging.INFO)
init_sentry()

app = FastAPI(
    title=settings.app_name,
    # Hide interactive docs in production unless explicitly enabled.
    docs_url="/docs" if settings.environment != "production" else None,
    redoc_url="/redoc" if settings.environment != "production" else None,
)

# Request-ID first so every downstream log + error response carries the
# correlation id all the way through CORS and route handlers.
app.add_middleware(RequestIDMiddleware)

# CORS: named methods + headers instead of "*" so the browser blocks
# anything unexpected. Credentials stay on because we pass a Clerk session
# cookie / Authorization bearer.
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
    max_age=600,
)

app.include_router(auth_router)
app.include_router(sessions_router)
app.include_router(dashboard_router)
app.include_router(skills_router)
app.include_router(memories_router)
app.include_router(settings_router)
app.include_router(vault_router)
app.include_router(connectors_router)
app.include_router(mcp_proxy_router)


@app.get("/health")
async def health(db: AsyncSession = Depends(get_session)) -> dict[str, str]:
    """Liveness + DB connectivity probe.

    Returns 200 + ``{"status": "ok"}`` on success. If the DB is unreachable
    the dependency raises and FastAPI returns 500 — the right signal for a
    load balancer to yank this pod out of rotation.
    """
    await db.execute(text("SELECT 1"))
    return {"status": "ok"}
