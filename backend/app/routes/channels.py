from __future__ import annotations

from fastapi import APIRouter

from app.routes.channel_routers import (
    debug,
    discord,
    imessage,
    migrations,
    public,
    telegram,
    whatsapp,
)

router = APIRouter(tags=["channels"])

# Control-plane routes come first so fixed paths such as
# /api/channels/debug/* and /api/channels/migrations/* cannot be captured by
# /api/channels/{account_id}.
router.include_router(debug.router)
router.include_router(migrations.router)
router.include_router(public.router)

# Provider routers own the SDK-compatible and webhook surfaces under
# /api/channels/{provider}/*.
router.include_router(whatsapp.router)
router.include_router(telegram.router)
router.include_router(imessage.router)
router.include_router(discord.router)
