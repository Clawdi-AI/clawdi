from __future__ import annotations

from fastapi import APIRouter, Header, Response

from app.core.config import settings
from app.services.metrics import metrics_content_type, render_metrics
from app.services.metrics_auth import is_metrics_request_authorized

router = APIRouter(tags=["metrics"])


@router.get("/metrics", include_in_schema=False)
async def get_metrics(authorization: str | None = Header(default=None)) -> Response:
    if not is_metrics_request_authorized(
        authorization,
        bearer_token=settings.metrics_bearer_token,
        basic_user=settings.metrics_basic_auth_user,
        basic_password=settings.metrics_basic_auth_password,
    ):
        return Response(
            content=b"unauthorized",
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
            media_type="text/plain",
        )
    return Response(content=render_metrics(), media_type=metrics_content_type())
