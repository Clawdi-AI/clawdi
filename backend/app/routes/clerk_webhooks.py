"""Direct, signed Clerk lifecycle ingress.

Clerk documents that webhook delivery is asynchronous and retryable, not an
exactly-once or synchronous identity boundary. Svix signs the raw request body
with ``svix-id``, ``svix-timestamp``, and one or more v1 signatures:

https://clerk.com/docs/guides/development/webhooks/overview
https://docs.svix.com/receiving/verifying-payloads/how-manual
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import time
from datetime import UTC, datetime
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import invalidate_api_key_auth_cache, invalidate_user_api_key_auth_cache
from app.core.config import settings
from app.core.database import get_session
from app.models.principal_lifecycle import PrincipalLifecycle
from app.models.user import User
from app.services.clerk_backend import clerk_backend_headers, clerk_user_url
from app.services.principal_lifecycle import (
    PrincipalLifecycleConfigurationError,
    PrincipalWebhookConflictError,
    complete_principal_cleanup,
    configured_clerk_issuer,
    fence_clerk_user_deleted,
    project_clerk_user_authority,
    record_principal_cleanup_failure,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"], include_in_schema=False)

_MAX_BODY_BYTES = 64 * 1024
_MAX_SIGNATURE_HEADER_BYTES = 8 * 1024
_MESSAGE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$")
_SUBJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
_TIMESTAMP_RE = re.compile(r"^[0-9]{1,20}$")


class ClerkWebhookResponse(BaseModel):
    status: Literal["ok"] = "ok"


class ClerkAuthorityResponse(BaseModel):
    object: Literal["user"]
    id: str
    banned: bool
    updated_at: int


def _single_header(request: Request, name: str) -> str:
    values = request.headers.getlist(name)
    if len(values) != 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Svix signature headers")
    value = values[0].strip()
    if not value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Svix signature headers")
    return value


def _v1_signatures(value: str) -> tuple[str, ...]:
    signatures: list[str] = []
    for token in value.split():
        version, separator, signature = token.partition(",")
        if separator and version == "v1" and signature:
            signatures.append(signature)
    return tuple(signatures)


def verify_clerk_webhook(payload: bytes, request: Request) -> str:
    """Verify the exact Svix raw-body construction used by Clerk."""

    signing_secret = settings.clerk_webhook_signing_secret.get_secret_value().strip()
    if not signing_secret:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk webhook receiver is not configured",
        )

    message_id = _single_header(request, "svix-id")
    timestamp_raw = _single_header(request, "svix-timestamp")
    signature_header = _single_header(request, "svix-signature")
    if _MESSAGE_ID_RE.fullmatch(message_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Svix message ID")
    if _TIMESTAMP_RE.fullmatch(timestamp_raw) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Svix timestamp")
    if len(signature_header.encode("utf-8")) > _MAX_SIGNATURE_HEADER_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Svix signature")

    timestamp = int(timestamp_raw)
    if abs(int(time.time()) - timestamp) > settings.clerk_webhook_tolerance_seconds:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Stale Svix timestamp")

    encoded_secret = signing_secret.removeprefix("whsec_")
    try:
        secret = base64.b64decode(encoded_secret, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Invalid Clerk webhook signing configuration",
        ) from None
    if not secret:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Invalid Clerk webhook signing configuration",
        )

    signed_content = f"{message_id}.{timestamp_raw}.".encode() + payload
    expected = base64.b64encode(hmac.new(secret, signed_content, hashlib.sha256).digest()).decode(
        "ascii"
    )
    signatures = _v1_signatures(signature_header)
    if not signatures or not any(
        hmac.compare_digest(signature, expected) for signature in signatures
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Svix signature")
    return message_id


def _parse_event(payload: bytes) -> tuple[str, str, datetime]:
    try:
        event = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Clerk event body") from None
    if not isinstance(event, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Clerk event body")
    event_type = event.get("type")
    if event.get("object") != "event" or event_type not in {"user.updated", "user.deleted"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unsupported Clerk event")
    event_timestamp = event.get("timestamp")
    if (
        isinstance(event_timestamp, bool)
        or not isinstance(event_timestamp, int)
        or event_timestamp < 0
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Clerk event timestamp")
    try:
        event_occurred_at = datetime.fromtimestamp(event_timestamp / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Clerk event timestamp") from None
    data = event.get("data")
    subject = data.get("id") if isinstance(data, dict) else None
    if not isinstance(subject, str) or _SUBJECT_RE.fullmatch(subject) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Clerk user subject")
    return event_type, subject, event_occurred_at


async def _fetch_clerk_authority(subject: str) -> tuple[bool, datetime]:
    if not settings.clerk_secret_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk Backend API is not configured",
        )
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                clerk_user_url(subject),
                headers=clerk_backend_headers(),
            )
        if response.status_code != 200:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Clerk authority retrieval is pending retry",
            )
        authority = ClerkAuthorityResponse.model_validate_json(response.content)
        if authority.id != subject or authority.updated_at < 0:
            raise ValueError("Clerk authority subject or timestamp mismatch")
        authority_updated_at = datetime.fromtimestamp(authority.updated_at / 1000, tz=UTC)
    except HTTPException:
        raise
    except (httpx.HTTPError, ValidationError, ValueError, OverflowError, OSError):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk authority retrieval is pending retry",
        ) from None
    # Clerk documents `banned` as the durable cannot-sign-in control. `locked`
    # is intentionally excluded: it can be a temporary failed-attempt lockout.
    # https://clerk.com/docs/reference/backend-api/tag/Users/operation/GetUser
    return authority.banned, authority_updated_at


@router.post("/clerk", response_model=ClerkWebhookResponse)
async def clerk_user_lifecycle_webhook(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> ClerkWebhookResponse:
    payload = await request.body()
    if len(payload) > _MAX_BODY_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Clerk event body too large")
    message_id = verify_clerk_webhook(payload, request)
    event_type, subject, event_occurred_at = _parse_event(payload)
    payload_sha256 = hashlib.sha256(payload).hexdigest()

    if event_type == "user.updated":
        try:
            issuer = configured_clerk_issuer()
        except PrincipalLifecycleConfigurationError:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Clerk lifecycle receiver is not configured",
            ) from None
        # A committed deletion is final and already contains all authority
        # needed to ACK a stale update. Avoid a doomed Clerk GET after the
        # provider has removed the user. The locked projection below repeats
        # this check so a deletion committing during GET still wins.
        if await db.scalar(
            select(PrincipalLifecycle.id).where(
                PrincipalLifecycle.issuer == issuer,
                PrincipalLifecycle.subject == subject,
            )
        ):
            return ClerkWebhookResponse()
        banned, authority_updated_at = await _fetch_clerk_authority(subject)
        try:
            changed = await project_clerk_user_authority(
                db,
                issuer=issuer,
                subject=subject,
                banned=banned,
                authority_updated_at=authority_updated_at,
                message_id=message_id,
                payload_sha256=payload_sha256,
            )
        except PrincipalLifecycleConfigurationError:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Clerk lifecycle receiver is not configured",
            ) from None
        await db.commit()
        if changed:
            user_id = await db.scalar(
                select(User.id).where(
                    User.clerk_issuer == issuer,
                    User.clerk_id == subject,
                )
            )
            if user_id is not None:
                invalidate_user_api_key_auth_cache(user_id)
        return ClerkWebhookResponse()

    try:
        receipt = await fence_clerk_user_deleted(
            db,
            issuer=configured_clerk_issuer(),
            subject=subject,
            message_id=message_id,
            payload_sha256=payload_sha256,
            event_occurred_at=event_occurred_at,
        )
    except PrincipalLifecycleConfigurationError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk lifecycle receiver is not configured",
        ) from None
    except PrincipalWebhookConflictError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Clerk message ID conflicts with durable evidence",
        ) from None

    # The signed receipt and irreversible tombstone become durable before any
    # cleanup. A 5xx below asks Clerk/Svix to retry while the same cleanup lease
    # remains recoverable by the existing lifecycle worker.
    await db.commit()
    try:
        cleanup = await complete_principal_cleanup(db, lifecycle_id=receipt.lifecycle_id)
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            await record_principal_cleanup_failure(db, lifecycle_id=receipt.lifecycle_id)
            await db.commit()
        except Exception:
            await db.rollback()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk deletion cleanup is pending retry",
        ) from None

    if receipt.user_id is not None:
        invalidate_user_api_key_auth_cache(receipt.user_id)
    for key_id in cleanup.revoked_api_key_ids:
        invalidate_api_key_auth_cache(key_id)
    return ClerkWebhookResponse()


__all__ = ["router", "verify_clerk_webhook"]
