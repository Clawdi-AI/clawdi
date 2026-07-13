from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_cli_auth
from app.core.config import settings
from app.core.database import get_runtime_snapshot_session
from app.models.hosted_runtime import HostedRuntimeState
from app.services.http_cache import if_none_match_contains, strong_json_etag
from app.services.runtime_source import (
    RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    RuntimeSourceError,
    load_runtime_source_batch,
    render_runtime_bundle,
    render_runtime_source,
    runtime_manifest_issued_at,
    vault_key_identity,
)

router = APIRouter(prefix="/runtime", tags=["runtime"])


@router.get("/manifest")
async def get_runtime_manifest(
    request: Request,
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_runtime_snapshot_session),
) -> Response:
    environment_id = _authorized_environment_id(auth, requested_environment_id)
    accept = request.headers.get("accept")
    bundle_v2 = accept == RUNTIME_BUNDLE_V2_MEDIA_TYPE
    if accept and accept.startswith("application/vnd.clawdi.") and not bundle_v2:
        raise HTTPException(status.HTTP_406_NOT_ACCEPTABLE, "Unsupported runtime media type")

    batch = await load_runtime_source_batch(
        db,
        environment_ids=[environment_id],
        owner_user_id=auth.user_id,
    )
    try:
        source = render_runtime_source(
            batch,
            environment_id=environment_id,
            public_api_url=settings.public_api_url,
            vault_key_identity=vault_key_identity(settings.vault_encryption_key),
            decrypt_secrets=True,
            include_channel_authority=bundle_v2,
        )
    except RuntimeSourceError as exc:
        code = (
            status.HTTP_404_NOT_FOUND
            if str(exc) in {"Agent environment not found", "Hosted runtime state not found"}
            else status.HTTP_409_CONFLICT
        )
        raise HTTPException(code, str(exc)) from exc

    if bundle_v2:
        payload = render_runtime_bundle(source)
        etag = strong_json_etag(payload)
        headers = {
            "ETag": etag,
            "Cache-Control": "no-store",
            "Vary": "Accept",
            "Content-Type": RUNTIME_BUNDLE_V2_MEDIA_TYPE,
        }
    else:
        payload = {"manifest": source.manifest, "secretValues": source.secret_values}
        etag = strong_json_etag(payload)
        headers = {"ETag": etag, "Cache-Control": "no-store"}
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(payload, headers=headers)


def _authorized_environment_id(auth: AuthContext, requested_environment_id: UUID | None) -> UUID:
    bound = auth.api_key.environment_id if auth.api_key is not None else None
    if bound is not None:
        if requested_environment_id is not None and requested_environment_id != bound:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "api key bound to a different environment"
            )
        return bound
    if requested_environment_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "runtime manifest requires an environment id"
        )
    return requested_environment_id


def _runtime_manifest_issued_at(state: HostedRuntimeState) -> str:
    return runtime_manifest_issued_at(state)
