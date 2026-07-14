import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from http import HTTPStatus
from typing import Any, Literal

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.core.database import get_session
from app.core.sentry import init_sentry
from app.middleware.body_size_limit import BodySizeLimitMiddleware
from app.middleware.request_id import RequestIDMiddleware
from app.middleware.request_timing import RequestTimingMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware
from app.middleware.skill_upload_preflight import SkillUploadPreflightMiddleware
from app.routes.admin import router as admin_router
from app.routes.agent_project_bindings import router as agent_project_bindings_router
from app.routes.ai_providers import router as ai_providers_router
from app.routes.audit import router as audit_router
from app.routes.auth import router as auth_router
from app.routes.capabilities import router as capabilities_router
from app.routes.channels import router as channels_router
from app.routes.cli_auth import router as cli_auth_router
from app.routes.connectors import router as connectors_router
from app.routes.dashboard import router as dashboard_router
from app.routes.mcp_bridge import router as mcp_bridge_router
from app.routes.me import router as me_router
from app.routes.memories import router as memories_router
from app.routes.metrics import router as metrics_router
from app.routes.platform import router as platform_router
from app.routes.projects import router as projects_router
from app.routes.public_sessions import router as public_sessions_router
from app.routes.runtime import router as runtime_router
from app.routes.search import router as search_router
from app.routes.sessions import router as sessions_router
from app.routes.settings import router as settings_router
from app.routes.share_redeem import router as share_redeem_router
from app.routes.sharing import router as sharing_router
from app.routes.skills import project_router as skills_project_router
from app.routes.skills import router as skills_router
from app.routes.skills import scope_router as skills_scope_router
from app.routes.sync import router as sync_router
from app.routes.vault import router as vault_router
from app.services.composio import close_composio_client
from app.services.embedding import LocalEmbedder
from app.services.sync_events import start_postgres_listener, stop_postgres_listener
from app.services.whatsapp_sidecar_registry import ConfiguredWhatsAppSidecarRegistry

logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger(__name__)
init_sentry()


def _validation_errors_for_log(exc: RequestValidationError) -> list[dict[str, object]]:
    errors: list[dict[str, object]] = []
    for err in exc.errors():
        item: dict[str, object] = {
            "type": err.get("type"),
            "loc": err.get("loc"),
            "msg": err.get("msg"),
        }
        if "ctx" in err:
            item["ctx"] = err["ctx"]
        errors.append(item)
    return errors


class HealthResponse(BaseModel):
    status: Literal["ok"]


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """ASGI lifespan — warm slow singletons at startup so the first request
    path isn't the one that pays for them.

    Fastembed downloads ~1GB on first `memory add` otherwise. We kick the
    load off the main thread so it doesn't block startup itself; if it
    finishes before the first embedding call, that call is fast.
    """
    background: set[asyncio.Task[None]] = set()
    whatsapp_sidecars = ConfiguredWhatsAppSidecarRegistry(
        settings.channel_whatsapp_baileys_sidecars_json
    )
    await start_postgres_listener()
    try:
        await whatsapp_sidecars.start()
    except Exception:
        await stop_postgres_listener()
        raise

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
        try:
            await whatsapp_sidecars.stop()
        finally:
            await stop_postgres_listener()
            await close_composio_client()


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
#   request → SecurityHeaders → RequestID → RequestTiming → CORS
#           → SkillUploadPreflight → BodySizeLimit → route
#                                                        ↓
#   response ← SecurityHeaders ← RequestID ← RequestTiming ← CORS
#            ← SkillUploadPreflight ← BodySizeLimit ← route
#
# so security headers are a final response wrapper, a CORS-rejected preflight
# still carries X-Request-ID on the way back out, RequestTiming can correlate
# slow logs with that id, and BodySizeLimit fires AFTER CORS preflight
# (preflight is OPTIONS, which the limiter ignores anyway). The limiter sits
# inside CORS so legitimate CORS responses still apply when we 413; otherwise
# a browser upload over the cap would see an opaque network error instead of
# "Request body too large". SkillUploadPreflight sits in front of the limiter
# so invalid daemon upload metadata can be rejected before FastAPI's multipart
# parser spools a doomed file part.

# Global cap on declared body size for body-bearing methods.
# Sized ABOVE the largest legitimate route-level cap so multipart
# framing (boundary, form-data Content-Disposition, filename header,
# trailing CRLF) doesn't push a near-limit upload over the global
# threshold. The session-upload route caps content at 50 MB and
# re-checks after streaming; an honest 50 MB multipart body
# carries ~1-4 KB of framing overhead, but we headroom by a full
# 1 MB so a generous boundary token + long filename can't trip
# the global rejection before the route's check fires. Without
# this headroom, near-limit session files were 413'd by the
# middleware even though the underlying content fit the per-route
# cap.
_MAX_SESSION_CONTENT_BYTES = 50 * 1024 * 1024  # mirror of sessions.py
_MULTIPART_OVERHEAD_HEADROOM = 1 * 1024 * 1024  # 1 MB
_MAX_REQUEST_BODY_BYTES = _MAX_SESSION_CONTENT_BYTES + _MULTIPART_OVERHEAD_HEADROOM
app.add_middleware(BodySizeLimitMiddleware, max_bytes=_MAX_REQUEST_BODY_BYTES)
app.add_middleware(SkillUploadPreflightMiddleware)

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
        # `If-None-Match` carries the daemon's last seen
        # `skills_revision` for the conditional GET /v1/skills.
        # The CLI daemon hits this without going through CORS, so
        # this is forward-compat for any browser-side caller.
        "If-None-Match",
    ],
    expose_headers=[
        "X-Request-ID",
        # `ETag` carries the user's `skills_revision` counter on
        # /v1/skills responses. Without exposing it, browser JS
        # gets `null` from `response.headers.get("ETag")` and the
        # dashboard can't conditional-GET. CLI daemon is unaffected
        # but the dashboard relies on this once it stops fetching
        # the full list every render.
        "ETag",
        "X-Process-Time-Ms",
    ],
    # 10 min production, but in dev the preflight cache outlives endpoint
    # changes (new routes registered during uvicorn --reload get rejected by
    # stale cached 404 preflights). Shorten in dev for fast iteration.
    max_age=30 if settings.environment != "production" else 600,
)
app.add_middleware(RequestTimingMiddleware, slow_ms=settings.slow_request_log_ms)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(SecurityHeadersMiddleware)


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    path = request.url.path
    if path.endswith("/skills/upload") or path.endswith("/sessions/batch"):
        log.warning(
            (
                "request_validation_failed method=%s path=%s user_agent=%r "
                "content_type=%r content_length=%r errors=%s"
            ),
            request.method,
            path,
            request.headers.get("user-agent", ""),
            request.headers.get("content-type", ""),
            request.headers.get("content-length", ""),
            _validation_errors_for_log(exc),
        )
    return JSONResponse(
        status_code=422,
        content={"detail": jsonable_encoder(exc.errors())},
    )


# API routers are mounted canonically under /v1 (the only
# form in the OpenAPI schema — we serve on a dedicated API domain, so
# versioning sits at the root). Older APIs also retain the legacy /api alias;
# unlaunched runtime and platform contracts are canonical-only.
#
# Note for public_sessions_router: share routes live at
# /v1/public/sessions/{id}/..., auth is optional (signed-in owners +
# active link permissions get served; anon hits 401, signed-in
# non-grantees hit 403). See routes/public_sessions.py.
_VERSIONED_ROUTERS = (
    auth_router,
    admin_router,
    ai_providers_router,
    audit_router,
    channels_router,
    cli_auth_router,
    sessions_router,
    public_sessions_router,
    dashboard_router,
    projects_router,
    runtime_router,
    skills_router,
    skills_project_router,
    sync_router,
    memories_router,
    settings_router,
    capabilities_router,
    platform_router,
    vault_router,
    connectors_router,
    mcp_bridge_router,
    search_router,
    share_redeem_router,
    sharing_router,
    me_router,
    agent_project_bindings_router,
)
for _router in _VERSIONED_ROUTERS:
    app.include_router(_router, prefix="/v1")
    if _router not in (runtime_router, platform_router):
        app.include_router(_router, prefix="/api", include_in_schema=False)
# Scope skill reads predate the Scope -> Project migration and only
# exist for old binaries; legacy /api alias only.
app.include_router(skills_scope_router, prefix="/api", include_in_schema=False)
app.include_router(metrics_router)


@app.exception_handler(StarletteHTTPException)
async def clawdi_http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
):
    if _is_bluebubbles_request(request):
        return _bluebubbles_error_response(
            status_code=exc.status_code,
            detail=exc.detail,
            headers=exc.headers,
        )
    return await http_exception_handler(request, exc)


@app.exception_handler(RequestValidationError)
async def clawdi_request_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
):
    if _is_bluebubbles_request(request):
        return _bluebubbles_error_response(
            status_code=422,
            detail="validation error",
        )
    return await request_validation_exception_handler(request, exc)


def _is_bluebubbles_request(request: Request) -> bool:
    return request.url.path.startswith(
        ("/api/channels/imessage/bluebubbles/", "/v1/channels/imessage/bluebubbles/")
    )


def _bluebubbles_error_response(
    *,
    status_code: int,
    detail: Any,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    message = _bluebubbles_error_message(status_code=status_code, detail=detail)
    return JSONResponse(
        status_code=status_code,
        content={"status": status_code, "message": message, "data": None},
        headers=headers,
    )


def _bluebubbles_error_message(*, status_code: int, detail: Any) -> str:
    if isinstance(detail, str) and detail:
        return detail
    if isinstance(detail, dict):
        message = detail.get("message") or detail.get("detail")
        if isinstance(message, str) and message:
            return message
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


@app.get("/health", response_model=HealthResponse)
async def health(db: AsyncSession = Depends(get_session)) -> HealthResponse:
    """Liveness + DB connectivity probe.

    Returns 200 + ``{"status": "ok"}`` on success. If the DB is unreachable
    the dependency raises and FastAPI returns 500 — the right signal for a
    load balancer to yank this pod out of rotation.
    """
    await db.execute(text("SELECT 1"))
    return HealthResponse(status="ok")
