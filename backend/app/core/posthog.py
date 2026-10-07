"""Cloud producer for the existing Hosted PostHog project and event taxonomy.

This ports Hosted's lazy, optional SDK capture pattern. It adds no event store,
exporter, worker, analytics API or separate project.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from threading import Lock
from typing import Protocol, cast
from uuid import NAMESPACE_URL, UUID, uuid5

from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from app.core.config import settings
from app.models.session import Session as ConversationSession
from app.models.session import SessionMessageSearch
from app.models.user import User

logger = logging.getLogger(__name__)
_EVENT_NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
_CORE_PRODUCT_EVENT_NAMES = frozenset(
    (
        "user_enrolled",
        "agent_connected",
        "session_synced",
        "project_created",
        "skill_saved",
        "vault_created",
        "channel_connected",
        "share_created",
        "invitation_created",
        "invitation_accepted",
        "connector_connection_started",
        "connector_connected",
    )
)
_PROPERTY_KEYS = frozenset(
    (
        "source",
        "schema_version",
        "feature",
        "resource_type",
        "protocol",
        "has_messages",
        "message_count",
        "session_id",
        "agent_id",
        "$insert_id",
    )
)
_SAFE_FEATURES = frozenset(("projects", "skills", "vault", "channels", "sharing", "connectors"))
_PENDING_KEY = "_posthog_commit_events"


class _PostHogOperations(Protocol):
    def capture(
        self,
        event: str,
        *,
        distinct_id: str,
        properties: dict[str, object],
        uuid: UUID,
        timestamp: datetime | None,
    ) -> str | None: ...

    def shutdown(self) -> None: ...


_posthog_client: _PostHogOperations | None = None
_posthog_client_lock = Lock()


def _before_send(msg: dict[str, object]) -> dict[str, object] | None:
    # The official SDK enriches captures before this hook. Keep only these
    # content-free facts and the SDK's opaque identity/deduplication fields.
    properties = msg.get("properties")
    if not isinstance(properties, dict):
        return None
    allowed = _PROPERTY_KEYS | {
        "distinct_id",
        "$lib",
        "$lib_version",
        "$geoip_disable",
        "$is_server",
    }
    safe_properties = cast(dict[str, object], properties)
    msg["properties"] = {key: value for key, value in safe_properties.items() if key in allowed}
    return msg


def _get_posthog_client() -> _PostHogOperations | None:
    global _posthog_client
    with _posthog_client_lock:
        if _posthog_client is not None:
            return _posthog_client
        if not settings.posthog_api_key.strip():
            return None
        try:
            from posthog import Posthog

            _posthog_client = Posthog(
                project_api_key=settings.posthog_api_key.strip(),
                host=settings.posthog_host,
                disable_geoip=settings.posthog_disable_geoip,
                debug=settings.debug,
                before_send=_before_send,
            )
        except Exception:
            logger.warning("PostHog initialization failed")
        return _posthog_client


def event_insert_id(event_name: str, distinct_id: str, key: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"clawdi:cloud:v1:{distinct_id}:{event_name}:{key}")


def _validated_properties(
    event_name: str, properties: Mapping[str, object] | None
) -> dict[str, object] | None:
    required: set[str] = set()
    if event_name == "session_synced":
        required = {"protocol", "session_id", "has_messages", "message_count"}
    elif event_name == "share_created":
        required = {"feature", "resource_type"}
    elif event_name not in {"user_enrolled", "agent_connected"}:
        required = {"feature"}
    keys = set(properties or {})
    allowed = required.copy()
    if event_name == "session_synced":
        allowed.add("agent_id")
    if not required <= keys or not keys <= allowed:
        return None
    result: dict[str, object] = {}
    for key, value in (properties or {}).items():
        if key not in _PROPERTY_KEYS or key in {"source", "schema_version", "$insert_id"}:
            return None
        if key in {"session_id", "agent_id"}:
            try:
                value = str(UUID(str(value)))
            except ValueError:
                return None
        elif key == "message_count":
            if value is not None and (
                not isinstance(value, int) or isinstance(value, bool) or value < 0
            ):
                return None
        elif key == "has_messages":
            if value is not None and type(value) is not bool:
                return None
        elif key == "feature" and (not isinstance(value, str) or value not in _SAFE_FEATURES):
            return None
        elif key == "resource_type" and (
            not isinstance(value, str) or value not in {"project", "session"}
        ):
            return None
        elif key == "protocol" and (
            not isinstance(value, str) or value not in {"snapshot-v1", "events-v1"}
        ):
            return None
        result[key] = value
    return result


def capture_event(
    event_name: str,
    *,
    distinct_id: str | None,
    event_key: str,
    properties: Mapping[str, object] | None = None,
    timestamp: datetime | None = None,
) -> bool:
    """Enqueue one content-free event; deterministic UUID/insert_id deduplicates replay."""
    if (
        not distinct_id
        or not _EVENT_NAME_PATTERN.fullmatch(event_name)
        or event_name not in _CORE_PRODUCT_EVENT_NAMES
    ):
        return False
    payload = _validated_properties(event_name, properties)
    if payload is None or (timestamp is not None and timestamp.utcoffset() is None):
        return False
    client = _get_posthog_client()
    if client is None:
        return False
    insert_id = event_insert_id(event_name, distinct_id, event_key)
    payload.update(source="cloud", schema_version=1, **{"$insert_id": str(insert_id)})
    try:
        return (
            client.capture(
                event_name,
                distinct_id=distinct_id,
                properties=payload,
                uuid=insert_id,
                timestamp=timestamp,
            )
            is not None
        )
    except Exception:
        logger.warning("PostHog capture failed event=%s", event_name)
        return False


@dataclass(frozen=True)
class _PendingCapture:
    event_name: str
    distinct_id: str
    event_key: str
    properties: dict[str, object]
    timestamp: datetime | None


def stage_capture(
    db: AsyncSession,
    event_name: str,
    *,
    user: User,
    event_key: str,
    properties: Mapping[str, object] | None = None,
    timestamp: datetime | None = None,
) -> None:
    """Use the repository's after-commit pattern; savepoints preserve outer rollback."""
    if not settings.posthog_api_key.strip() or not user.clerk_id:
        return
    payload = _validated_properties(event_name, properties)
    if payload is None:
        return
    sync = db.sync_session
    transaction = sync.get_nested_transaction() or sync.get_transaction()
    if transaction is None:
        raise RuntimeError("Product capture requires the owning transaction")
    pending = cast(
        dict[SessionTransaction, dict[UUID, _PendingCapture]],
        sync.info.setdefault(_PENDING_KEY, {}),
    )
    pending.setdefault(transaction, {})[event_insert_id(event_name, user.clerk_id, event_key)] = (
        _PendingCapture(
            event_name,
            user.clerk_id,
            event_key,
            payload,
            timestamp,
        )
    )


def _on_commit(session: Session) -> None:
    pending = cast(
        dict[SessionTransaction, dict[UUID, _PendingCapture]], session.info.get(_PENDING_KEY, {})
    )
    transaction = session.get_nested_transaction() or session.get_transaction()
    if transaction is None:
        return
    items = pending.pop(transaction, {})
    if transaction.nested and transaction.parent is not None:
        pending.setdefault(transaction.parent, {}).update(items)
        return
    for item in items.values():
        capture_event(
            item.event_name,
            distinct_id=item.distinct_id,
            event_key=item.event_key,
            properties=item.properties,
            timestamp=item.timestamp,
        )
    session.info.pop(_PENDING_KEY, None)


def _on_rollback(session: Session) -> None:
    pending = cast(
        dict[SessionTransaction, dict[UUID, _PendingCapture]], session.info.get(_PENDING_KEY, {})
    )
    transaction = session.get_nested_transaction() or session.get_transaction()
    if transaction is not None:
        pending.pop(transaction, None)
    if not pending:
        session.info.pop(_PENDING_KEY, None)


event.listen(Session, "after_commit", _on_commit)
event.listen(Session, "after_rollback", _on_rollback)


def shutdown_posthog() -> None:
    if _posthog_client is not None:
        try:
            _posthog_client.shutdown()
        except Exception:
            logger.warning("PostHog shutdown failed")


async def stage_user_capture(
    db: AsyncSession,
    event_name: str,
    *,
    user_id: UUID,
    event_key: str,
    properties: Mapping[str, object] | None = None,
    timestamp: datetime | None = None,
) -> None:
    if not settings.posthog_api_key.strip():
        return
    user = await db.get(User, user_id)
    if user is not None:
        stage_capture(
            db,
            event_name,
            user=user,
            event_key=event_key,
            properties=properties,
            timestamp=timestamp,
        )


async def stage_session_sync(
    db: AsyncSession,
    session: ConversationSession,
    *,
    user: User,
    message_count: int | None = None,
    projection_complete: bool = True,
) -> None:
    """Mark the first successful sync under the caller's Session row lock.

    Persist even when capture is disabled, so enabling analytics never replays
    old sessions. The marker and event share the content transaction's rollback.
    """
    if session.first_synced_at is not None:
        return
    session.first_synced_at = session.content_uploaded_at
    if not settings.posthog_api_key.strip() or not user.clerk_id:
        return
    if session.content_protocol == "events-v1" and projection_complete:
        message_count = await db.scalar(
            select(func.count(func.distinct(SessionMessageSearch.position))).where(
                SessionMessageSearch.session_id == session.id,
                SessionMessageSearch.generation_id == session.event_generation_id,
            )
        )
    if not projection_complete:
        message_count = None
    properties: dict[str, object] = {
        "protocol": session.content_protocol,
        "session_id": str(session.id),
        "has_messages": bool(message_count) if message_count is not None else None,
        "message_count": message_count,
    }
    if session.origin_environment_id is not None:
        properties["agent_id"] = str(session.origin_environment_id)
    stage_capture(
        db,
        "session_synced",
        user=user,
        event_key=str(session.id),
        properties=properties,
        timestamp=session.created_at,
    )
