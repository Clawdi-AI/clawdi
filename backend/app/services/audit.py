from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import ControlPlaneAuditEvent

SECRETISH_KEY_PARTS = (
    "secret",
    "token",
    "password",
    "api_key",
    "apikey",
    "private_key",
    "authorization",
    "bearer",
    "cookie",
    "credential",
)


def record_control_plane_audit(
    db: AsyncSession,
    *,
    actor_type: str,
    action: str,
    resource_type: str,
    source: str,
    actor_user_id: UUID | None = None,
    target_user_id: UUID | None = None,
    resource_id: str | None = None,
    environment_id: UUID | None = None,
    channel_account_id: UUID | None = None,
    channel_agent_link_id: UUID | None = None,
    details: dict[str, Any] | None = None,
) -> ControlPlaneAuditEvent:
    event = ControlPlaneAuditEvent(
        actor_type=actor_type,
        actor_user_id=actor_user_id,
        target_user_id=target_user_id,
        source=source,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        environment_id=environment_id,
        channel_account_id=channel_account_id,
        channel_agent_link_id=channel_agent_link_id,
        details=_sanitize_audit_details(details or {}),
    )
    db.add(event)
    return event


def _sanitize_audit_details(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            safe_key = str(key)
            if _is_secretish_key(safe_key):
                result[safe_key] = _sanitize_secretish_value(item)
            else:
                result[safe_key] = _sanitize_audit_details(item)
        return result
    if isinstance(value, list):
        return [_sanitize_audit_details(item) for item in value[:100]]
    if isinstance(value, tuple):
        return [_sanitize_audit_details(item) for item in value[:100]]
    if isinstance(value, str):
        return value[:500]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(value)[:500]


def _is_secretish_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in SECRETISH_KEY_PARTS)


def _sanitize_secretish_value(value: Any) -> Any:
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return "[REDACTED]"
