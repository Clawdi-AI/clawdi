from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.session import Session
from app.models.session_share import SessionShare
from app.services.file_store import FileStore
from app.services.session_content import (
    SessionContentInvalid,
    SessionContentMissing,
    SessionContentProjection,
    SessionContentUnavailable,
    load_event_generation_projection,
    load_session_content_projection,
    load_snapshot_projection,
)

SessionShareScope = Literal["session", "through", "response"]
log = logging.getLogger(__name__)


class SessionShareConflict(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class SessionShareView:
    share: SessionShare
    messages: list[dict[str, JsonValue]]


@dataclass(frozen=True, slots=True)
class SessionShareSelection:
    start_position: int | None
    end_position: int
    messages: list[dict[str, JsonValue]]


def session_share_url(share_id: UUID) -> str:
    return f"{settings.web_origin}/s/{share_id}"


def session_share_snapshot_key(session: Session) -> str:
    if not session.content_hash:
        raise SessionContentMissing("session snapshot has no content hash")
    return f"session-share-sources/{session.user_id}/{session.id}/{session.content_hash}.json"


def _scope_selection(
    projection: SessionContentProjection,
    scope: SessionShareScope,
    position: int | None,
) -> SessionShareSelection:
    if not projection.messages:
        raise SessionShareConflict("Session has no shareable messages")
    positions = projection.source_positions
    if scope == "session":
        return SessionShareSelection(None, positions[-1], projection.messages)
    if position is None:
        raise SessionShareConflict(f"{scope} scope requires a message position")
    try:
        index = positions.index(position)
    except ValueError as exc:
        raise SessionShareConflict("Message is not part of the current Session revision") from exc
    if scope == "response":
        if projection.messages[index].get("role") != "assistant":
            raise SessionShareConflict("Only Agent responses can be shared individually")
        return SessionShareSelection(position, position, [projection.messages[index]])
    return SessionShareSelection(None, position, projection.messages[: index + 1])


def _public_metadata(
    session: Session,
    *,
    agent_type: str | None,
    scope: SessionShareScope,
    messages: list[dict[str, JsonValue]],
) -> dict[str, JsonValue]:
    model = session.model if scope == "session" else None
    for message in reversed(messages):
        candidate = message.get("model")
        if message.get("role") == "assistant" and isinstance(candidate, str) and candidate:
            model = candidate
            break
    if scope == "session":
        title = session.summary or "Shared conversation"
    elif scope == "response":
        title = "Shared response"
    else:
        title = "Shared conversation"
    return {
        "title": title,
        "agent_type": agent_type,
        "model": model,
        "started_at": session.started_at.isoformat(),
        "message_count": len(messages),
    }


async def create_session_share(
    db: AsyncSession,
    file_store: FileStore,
    session: Session,
    *,
    created_by: UUID,
    agent_type: str | None,
    scope: SessionShareScope,
    position: int | None,
) -> SessionShare:
    """Freeze one bounded view without holding a database lock across storage I/O."""
    session_id = session.id
    projection = await load_session_content_projection(session, file_store, db)
    selection = _scope_selection(projection, scope, position)

    source_protocol = session.content_protocol
    source_revision: str
    event_generation_id: UUID | None = None
    snapshot_file_key: str | None = None
    if source_protocol == "events-v1":
        if session.event_generation_id is None:
            raise SessionContentMissing("session event generation is unavailable")
        event_generation_id = session.event_generation_id
        source_revision = str(event_generation_id)
    else:
        if not session.file_key or not session.content_hash:
            raise SessionContentMissing("session snapshot is unavailable")
        source_revision = session.content_hash
        snapshot_file_key = session_share_snapshot_key(session)

    expected_identity = (
        source_protocol,
        session.file_key,
        session.content_hash,
        session.event_generation_id,
    )
    metadata = _public_metadata(
        session,
        agent_type=agent_type,
        scope=scope,
        messages=selection.messages,
    )

    # End the read-only transaction before a potentially slow object-store copy.
    # `expire_on_commit=False` keeps the captured request identity usable while
    # the later row lock still performs the revision CAS.
    await db.commit()
    if snapshot_file_key is not None:
        try:
            if not await file_store.exists(snapshot_file_key):
                source_file_key = expected_identity[1]
                if source_file_key is None:
                    raise SessionContentMissing("Session snapshot is unavailable")
                data = await file_store.get(source_file_key)
                if hashlib.sha256(data).hexdigest() != source_revision:
                    raise SessionShareConflict("Session changed while the share was being created")
                await file_store.put(snapshot_file_key, data, "application/json")
        except (SessionShareConflict, SessionContentMissing, SessionContentUnavailable):
            raise
        except FileNotFoundError as exc:
            raise SessionContentMissing("Session snapshot is unavailable") from exc
        except Exception as exc:
            log.exception("session_share_snapshot_copy_failed session_id=%s", session_id)
            raise SessionContentUnavailable("Session storage is unavailable") from exc

    locked = (
        await db.execute(select(Session).where(Session.id == session_id).with_for_update())
    ).scalar_one_or_none()
    if locked is None:
        raise SessionShareConflict("Session no longer exists")
    current_identity = (
        locked.content_protocol,
        locked.file_key,
        locked.content_hash,
        locked.event_generation_id,
    )
    if current_identity != expected_identity:
        await db.rollback()
        raise SessionShareConflict("Session changed while the share was being created")

    share = SessionShare(
        session_id=locked.id,
        created_by=created_by,
        scope=scope,
        start_position=selection.start_position,
        end_position=selection.end_position,
        source_protocol=source_protocol,
        source_revision=source_revision,
        event_generation_id=event_generation_id,
        snapshot_file_key=snapshot_file_key,
        public_metadata=metadata,
    )
    db.add(share)
    await db.commit()
    await db.refresh(share)
    return share


async def load_session_share_view(
    db: AsyncSession,
    file_store: FileStore,
    share: SessionShare,
) -> SessionShareView:
    if share.source_protocol == "events-v1":
        if share.event_generation_id is None:
            raise SessionContentInvalid("Session share has no event generation")
        projection = await load_event_generation_projection(
            share.event_generation_id,
            file_store,
            db,
        )
    else:
        if share.snapshot_file_key is None:
            raise SessionContentInvalid("Session share has no snapshot")
        projection = await load_snapshot_projection(
            share.snapshot_file_key,
            share.source_revision,
            file_store,
        )

    positions = projection.source_positions
    try:
        end_index = positions.index(share.end_position)
        start_index = 0 if share.start_position is None else positions.index(share.start_position)
    except ValueError as exc:
        raise SessionContentInvalid("Session share bounds do not match its source") from exc
    if start_index > end_index:
        raise SessionContentInvalid("Session share bounds are inverted")
    return SessionShareView(
        share=share,
        messages=projection.messages[start_index : end_index + 1],
    )


def session_share_metadata(
    share: SessionShare,
) -> tuple[str, str | None, str | None, datetime, int]:
    metadata = share.public_metadata
    title = metadata.get("title")
    agent_type = metadata.get("agent_type")
    model = metadata.get("model")
    started_at = metadata.get("started_at")
    message_count = metadata.get("message_count")
    if (
        not isinstance(title, str)
        or not isinstance(started_at, str)
        or not isinstance(message_count, int)
        or isinstance(message_count, bool)
        or (agent_type is not None and not isinstance(agent_type, str))
        or (model is not None and not isinstance(model, str))
    ):
        raise SessionContentInvalid("Session share metadata is invalid")
    try:
        parsed_started_at = datetime.fromisoformat(started_at)
    except ValueError as exc:
        raise SessionContentInvalid("Session share start time is invalid") from exc
    if parsed_started_at.tzinfo is None:
        parsed_started_at = parsed_started_at.replace(tzinfo=UTC)
    return title, agent_type, model, parsed_started_at, message_count
