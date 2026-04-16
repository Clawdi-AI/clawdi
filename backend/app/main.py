from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routes.auth import router as auth_router
from app.routes.dashboard import router as dashboard_router
from app.routes.memories import router as memories_router
from app.routes.sessions import router as sessions_router
from app.routes.settings import router as settings_router
from app.routes.skills import router as skills_router
from app.routes.connectors import router as connectors_router
from app.routes.mcp_proxy import router as mcp_proxy_router
from app.routes.vault import router as vault_router

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
async def health():
    return {"status": "ok"}
