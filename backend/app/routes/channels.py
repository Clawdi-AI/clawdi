from __future__ import annotations

from fastapi import APIRouter

from app.routes.channel_routers import (
    debug,
    discord,
    imessage,
    public,
    telegram,
    whatsapp,
)

router = APIRouter(tags=["channels"])

# Control-plane routes come first so fixed paths such as
# /v1/channels/debug/* cannot be captured by /v1/channels/{account_id}.
router.include_router(debug.router)
router.include_router(public.router)

# Provider routers own the SDK-compatible and webhook surfaces under
# /v1/channels/{provider}/*.
router.include_router(whatsapp.router)
router.include_router(telegram.router)
router.include_router(imessage.router)
router.include_router(discord.router)
