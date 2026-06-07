from __future__ import annotations

from fastapi import APIRouter

from app.routes.channel_routers import (
    imessage_attachments,
    imessage_chats,
    imessage_core,
    imessage_extended,
    imessage_messages,
    imessage_realtime,
    imessage_sends,
)

router = APIRouter(tags=["channels"])
router.include_router(imessage_sends.router)
router.include_router(imessage_attachments.router)
router.include_router(imessage_core.router)
router.include_router(imessage_chats.router)
router.include_router(imessage_messages.router)
router.include_router(imessage_extended.router)
router.include_router(imessage_realtime.router)
