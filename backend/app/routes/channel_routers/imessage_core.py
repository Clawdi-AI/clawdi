from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.routes.channel_routers.imessage_auth import (
    BlueBubblesAccount,
    BlueBubblesAuth,
    bluebubbles_account,
    bluebubbles_auth,
)
from app.routes.channel_routers.shared import (
    _bluebubbles_ok,
    _bluebubbles_webhook_config,
    _bluebubbles_webhook_events,
    _optional_str,
    _request_params,
    _required_str_param,
    _validate_agent_webhook_url,
)
from app.services.channel_webhooks import bluebubbles_webhook_update

router = APIRouter(prefix="/api/channels/imessage/bluebubbles/v1", tags=["channels"])


@router.get(
    "/server/info",
    include_in_schema=False,
)
async def bluebubbles_server_info(
    account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    config = account.config if isinstance(account.config, dict) else {}
    return {
        "status": 200,
        "message": "OK",
        "data": {
            "server_version": "clawdi",
            "private_api": True,
            "os_version": config.get("os_version") or "15.0",
            "detected_imessage": config.get("detected_imessage"),
            "detected_icloud": config.get("detected_icloud"),
            "detected_icloud_name": config.get("detected_icloud_name"),
        },
    }


@router.get("/ping", include_in_schema=False)
async def bluebubbles_ping(
    _account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    return _bluebubbles_ok({"message": "pong"})


@router.get("/webhook", include_in_schema=False)
async def bluebubbles_list_webhooks(
    account: BlueBubblesAccount = Depends(bluebubbles_account),
) -> dict[str, Any]:
    webhook = _bluebubbles_webhook_config(account)
    url = _optional_str(webhook.get("url"))
    return _bluebubbles_ok(
        [
            {
                "id": str(account.id),
                "url": url,
                "events": _bluebubbles_webhook_events(),
            }
        ]
        if url
        else []
    )


@router.post("/webhook", include_in_schema=False)
async def bluebubbles_register_webhook(
    request: Request,
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    auth: BlueBubblesAuth = Depends(bluebubbles_auth),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    params = await _request_params(request)
    url = _required_str_param(params, "url")
    await _validate_agent_webhook_url(account, url)
    token = auth.token
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing agent token")
    events = params.get("events") if isinstance(params.get("events"), list) else []
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config["bluebubbles_webhook"] = bluebubbles_webhook_update(
        url=url,
        events=events,
        password=token,
    )
    account.config = config
    await db.commit()
    return _bluebubbles_ok(
        {
            "id": str(account.id),
            "url": url,
            "events": _bluebubbles_webhook_events(),
        }
    )


@router.delete("/webhook/{webhook_id}", include_in_schema=False)
async def bluebubbles_delete_webhook(
    webhook_id: str,
    account: BlueBubblesAccount = Depends(bluebubbles_account),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    if webhook_id != str(account.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="webhook not found")
    config = dict(account.config) if isinstance(account.config, dict) else {}
    config.pop("bluebubbles_webhook", None)
    account.config = config
    await db.commit()
    return _bluebubbles_ok(None)
