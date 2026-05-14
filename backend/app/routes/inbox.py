"""Inbox API skeleton for project access accepts.

Pass 1 exposes the route surface; flow wiring lands in pass 2.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.auth import AuthContext, require_user_auth_unbound
from app.schemas.sharing import UpgradeBody

router = APIRouter(prefix="/api/inbox", tags=["inbox"])


@router.post("/accept-link")
async def accept_link(
    body: UpgradeBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
) -> dict[str, str]:
    _ = (body, auth)
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="accept-link is not wired yet; use /api/share/{token}/upgrade in pass 1",
    )


@router.post("/accept-invitation")
async def accept_invitation(
    body: UpgradeBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
) -> dict[str, str]:
    _ = (body, auth)
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="accept-invitation is not wired yet; use /api/me/invitations/{id}/accept in pass 1",
    )
