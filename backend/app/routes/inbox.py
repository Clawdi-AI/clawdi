"""Share-recipient inbox API.

These routes provide a single recipient-facing surface over the two
acceptance mechanisms:
  - share-link URL/token acceptance
  - directed invitation acceptance
"""

from __future__ import annotations

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_share_token, require_user_auth_unbound
from app.core.database import get_session
from app.routes.me import accept_invitation_for_user
from app.routes.share_redeem import upgrade_share_token
from app.schemas.sharing import InboxAcceptInvitationBody, InboxAcceptLinkBody

router = APIRouter(prefix="/api/inbox", tags=["inbox"])

_RAW_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _extract_share_token(body: InboxAcceptLinkBody) -> str:
    raw = (body.token or body.url or "").strip()
    if not raw:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "token or url is required",
        )
    if _RAW_TOKEN_RE.fullmatch(raw):
        return raw
    match = re.search(r"/share/([A-Za-z0-9_-]{43})(?:/)?$", raw)
    if match:
        return match.group(1)
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "url must be a Clawdi share link",
    )


@router.post("/accept-link")
async def accept_link(
    body: InboxAcceptLinkBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict:
    token = _extract_share_token(body)
    ctx = await require_share_token(token=token, db=db)
    return await upgrade_share_token(ctx=ctx, body=body, auth=auth, db=db)


@router.post("/accept-invitation")
async def accept_invitation(
    body: InboxAcceptInvitationBody,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> dict:
    try:
        invitation_id = UUID(body.invitation_id)
    except ValueError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid invitation_id") from err
    return await accept_invitation_for_user(
        invitation_id=invitation_id,
        body=body,
        auth=auth,
        db=db,
    )
