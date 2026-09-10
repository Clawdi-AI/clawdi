"""Owner-authorized content version hints; HTTP detail remains authoritative."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import select
from starlette.types import Send

from app.core.auth import (
    AuthContext,
    bearer_scheme,
    get_auth,
    require_auth_scopes,
    require_scope_short_session,
)
from app.core.config import settings
from app.core.database import async_session_factory
from app.models.session import Session
from app.routes.sync import (
    HEARTBEAT_INTERVAL_S,
    PER_BOUND_KEY_CONNECTION_CAP,
    PER_USER_CONNECTION_CAP,
    SUBSCRIPTION_LEASE_TTL,
    _cancel_and_wait,
    _refresh_subscription_lease,
    _release_subscription_lease_safely,
    _SyncStreamingResponse,
)
from app.services.distributed_state import acquire_sync_subscription_lease
from app.services.session_content import session_has_uploaded_content
from app.services.session_content_notifications import session_content_changed
from app.services.sync_events import sync_subscriptions_changed

router = APIRouter(tags=["sessions"])
log = logging.getLogger(__name__)


class SessionContentVersion(BaseModel):
    has_content: bool
    content_hash: str | None
    content_protocol: str
    event_head_hash: str | None


async def _read_version(
    session_id: UUID, credentials: HTTPAuthorizationCredentials, user_id: UUID
) -> tuple[SessionContentVersion, AuthContext]:
    async with async_session_factory() as db:
        # Re-resolve the actual principal, scopes, key expiry/revocation and
        # user authority, rather than trusting the handshake's ORM objects.
        auth = await get_auth(credentials, db)
        require_auth_scopes(auth, "sessions:read")
        stmt = select(Session).where(Session.id == session_id, Session.user_id == user_id)
        if auth.user_id != user_id:
            raise HTTPException(401, "Invalid credentials")
        if auth.bound_environment_id is not None:
            stmt = stmt.where(Session.environment_id == auth.bound_environment_id)
        session = (await db.execute(stmt)).scalar_one_or_none()
        if session is None:
            raise HTTPException(404, "Session not found")
        return SessionContentVersion(
            has_content=session_has_uploaded_content(session),
            content_hash=session.content_hash,
            content_protocol=session.content_protocol,
            event_head_hash=session.event_head_hash,
        ), auth


class _ContentStreamingResponse(_SyncStreamingResponse):
    expires_at: datetime | None = None
    lease_id: UUID

    async def stream_response(self, send: Send) -> None:
        remaining = (
            max(0, (self.expires_at - datetime.now(UTC)).total_seconds())
            if self.expires_at is not None
            else None
        )
        closed = asyncio.Event()
        renewal = asyncio.create_task(_refresh_subscription_lease(self.lease_id, closed))
        sending = asyncio.create_task(super().stream_response(send))
        revoked = asyncio.create_task(closed.wait())
        try:
            # Deadline and lease loss also interrupt blocked header/body sends.
            async with asyncio.timeout(remaining):
                await asyncio.wait({sending, revoked}, return_when=asyncio.FIRST_COMPLETED)
        except TimeoutError:
            pass
        finally:
            try:
                await _cancel_and_wait(sending, revoked, renewal)
            finally:
                # Cancellation may precede the sending task's first step.
                await self._cleanup()


@router.get(
    "/sessions/{session_id}/content-events",
    response_class=_ContentStreamingResponse,
    status_code=200,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def session_content_events(
    session_id: UUID,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    auth: AuthContext = Depends(require_scope_short_session("sessions:read")),
) -> _ContentStreamingResponse:
    key = str(session_id)
    authority_key = str(auth.user_id)
    changed = session_content_changed.subscribe(key)
    authority_changed = sync_subscriptions_changed.subscribe(authority_key)
    lease_id: UUID | None = None
    cleaned_up = False

    async def cleanup() -> None:
        nonlocal cleaned_up
        if cleaned_up:
            return
        cleaned_up = True
        session_content_changed.unsubscribe(key, changed)
        sync_subscriptions_changed.unsubscribe(authority_key, authority_changed)
        if lease_id is not None:
            await _release_subscription_lease_safely(lease_id)

    try:
        _, fresh_auth = await _read_version(session_id, credentials, auth.user_id)
        if (
            fresh_auth.credential_expires_at is None
            and not fresh_auth.is_cli
            and not (
                settings.dev_auth_bypass and credentials.credentials == settings.dev_auth_token
            )
        ):
            raise HTTPException(401, "Credentials require an expiry")
        lease_id = await acquire_sync_subscription_lease(
            user_id=auth.user_id,
            bound_api_key_id=(
                auth.api_key.id
                if auth.api_key is not None and auth.bound_environment_id is not None
                else None
            ),
            max_per_user=PER_USER_CONNECTION_CAP,
            max_per_key=PER_BOUND_KEY_CONNECTION_CAP,
            ttl=SUBSCRIPTION_LEASE_TTL,
        )
        if lease_id is None:
            raise HTTPException(429, "Too many active subscriptions", headers={"Retry-After": "30"})
    except BaseException:
        await cleanup()
        raise

    async def generate() -> AsyncGenerator[bytes, None]:
        previous: SessionContentVersion | None = None
        try:
            while True:
                changed.clear()
                authority_changed.clear()
                version, _ = await _read_version(session_id, credentials, auth.user_id)
                if version != previous:
                    yield f"event: content-version\ndata: {version.model_dump_json()}\n\n".encode()
                    previous = version
                while not (changed.is_set() or authority_changed.is_set()):
                    tasks = [
                        asyncio.create_task(event.wait()) for event in (changed, authority_changed)
                    ]
                    try:
                        done, _ = await asyncio.wait(
                            tasks, timeout=HEARTBEAT_INTERVAL_S, return_when=asyncio.FIRST_COMPLETED
                        )
                    finally:
                        await _cancel_and_wait(*tasks)
                    if not done:
                        yield b": ping\n\n"
        except HTTPException:
            # The stream is already 200. Close without exposing authority or
            # database details; the next handshake returns the normal status.
            return
        except Exception:  # noqa: BLE001 - disconnect causes fresh authorized catch-up
            log.exception("Session content stream failed")
        finally:
            await cleanup()

    response = _ContentStreamingResponse(
        generate(),
        cleanup=cleanup,
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
    response.lease_id = lease_id
    response.expires_at = fresh_auth.credential_expires_at
    return response
