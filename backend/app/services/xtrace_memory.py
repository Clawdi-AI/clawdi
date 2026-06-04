"""XTrace Memory API integration for cloud session uploads."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.memory import Memory
from app.models.session import Session
from app.models.xtrace_ingest import XTraceMemoryIngest

log = logging.getLogger(__name__)

_XTRACE_ROLES = {"user", "assistant", "system"}
_SOURCE = "xtrace_session"


@dataclass(frozen=True)
class XTraceMemoryRef:
    id: str
    type: str
    text: str


@dataclass(frozen=True)
class XTraceRemoteIngest:
    payload: dict[str, Any]
    created_refs: list[XTraceMemoryRef]
    updated_refs: list[XTraceMemoryRef]


@dataclass(frozen=True)
class XTraceMemoryIngestResult:
    job_id: str | None
    status: str | None
    created_ref_count: int
    updated_ref_count: int
    mirrored_count: int
    response: dict[str, Any]


def xtrace_memory_configured() -> bool:
    return bool(
        settings.xtrace_memory_enabled
        and settings.xtrace_api_key.strip()
        and settings.xtrace_org_id.strip()
    )


async def ingest_xtrace_session_memories(
    db: AsyncSession,
    *,
    session: Session,
    messages: list[dict[str, Any]],
) -> XTraceMemoryIngestResult | None:
    """Send session messages to XTrace and mirror returned memory refs.

    XTrace may return a pending job even with ``wait=true``. In that case
    there are no memory refs to mirror yet, so this returns 0 and leaves
    XTrace's async job to finish remotely.
    """
    if not xtrace_memory_configured():
        return None

    normalized = _normalize_messages(messages)
    if not normalized:
        return None

    remote = await _ingest(normalized, session=session)
    refs = [*remote.created_refs, *remote.updated_refs]
    mirrored_count = await _store_refs(db, session=session, refs=refs) if refs else 0
    result = XTraceMemoryIngestResult(
        job_id=_string_or_none(remote.payload.get("id")),
        status=_string_or_none(remote.payload.get("status")),
        created_ref_count=len(remote.created_refs),
        updated_ref_count=len(remote.updated_refs),
        mirrored_count=mirrored_count,
        response=remote.payload,
    )
    db.add(
        XTraceMemoryIngest(
            user_id=session.user_id,
            session_id=session.id,
            local_session_id=session.local_session_id,
            job_id=result.job_id,
            status=result.status,
            created_ref_count=result.created_ref_count,
            updated_ref_count=result.updated_ref_count,
            mirrored_count=result.mirrored_count,
            response=result.response,
        )
    )
    await db.commit()
    return result


async def _ingest(messages: list[dict[str, str]], *, session: Session) -> XTraceRemoteIngest:
    url = f"{settings.xtrace_memory_base_url.rstrip('/')}/v1/memories"
    headers = {
        "Authorization": f"Bearer {settings.xtrace_api_key}",
        "X-Org-Id": settings.xtrace_org_id,
        "Accept": "application/json",
    }
    body: dict[str, Any] = {
        "messages": messages,
        "user_id": str(session.user_id),
        "conv_id": str(session.id),
        "app_id": settings.xtrace_memory_app_id,
        "extract_artifacts": False,
        "metadata": {
            "source": "clawdi_cloud_session",
            "local_session_id": session.local_session_id,
            "project_path": session.project_path,
            "content_hash": session.content_hash,
        },
    }
    if session.environment_id is not None:
        body["agent_id"] = str(session.environment_id)

    async with httpx.AsyncClient(timeout=settings.xtrace_memory_timeout_seconds) as client:
        response = await client.post(
            url,
            headers=headers,
            params={"wait": "true"},
            json=body,
        )
        response.raise_for_status()
        payload = response.json()

    return _extract_remote_ingest(payload)


def _normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    max_messages = max(1, settings.xtrace_memory_max_messages)
    selected = messages[-max_messages:] if len(messages) > max_messages else messages
    normalized: list[dict[str, str]] = []
    for message in selected:
        if not isinstance(message, dict):
            continue
        raw_content = message.get("content")
        if raw_content is None:
            continue
        if isinstance(raw_content, str):
            content = raw_content.strip()
        else:
            try:
                content = json.dumps(raw_content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = str(raw_content)
        if not content:
            continue

        role = str(message.get("role") or "assistant")
        if role not in _XTRACE_ROLES:
            role = "assistant"
        item = {"role": role, "content": content}
        date = message.get("date") or message.get("timestamp") or message.get("created_at")
        if isinstance(date, str) and date:
            item["date"] = date
        normalized.append(item)
    return normalized


def _extract_remote_ingest(payload: dict[str, Any]) -> XTraceRemoteIngest:
    created_refs: list[XTraceMemoryRef] = []
    updated_refs: list[XTraceMemoryRef] = []

    result = payload.get("result")
    if isinstance(result, dict):
        created_refs.extend(_parse_ref_list(result.get("memories_created")))
        updated_refs.extend(_parse_ref_list(result.get("memories_updated")))

    # Older quickstart-style response: {"results": [{data: {memory: "..."}}]}.
    raw_results = payload.get("results")
    if isinstance(raw_results, list):
        for raw in raw_results:
            if not isinstance(raw, dict):
                continue
            data = raw.get("data")
            text = data.get("memory") if isinstance(data, dict) else None
            if isinstance(text, str) and text.strip():
                created_refs.append(
                    XTraceMemoryRef(
                        id=str(raw.get("id") or ""),
                        type="fact",
                        text=text.strip(),
                    )
                )

    return XTraceRemoteIngest(
        payload=payload,
        created_refs=created_refs,
        updated_refs=updated_refs,
    )


def _parse_ref_list(raw_refs: Any) -> list[XTraceMemoryRef]:
    if not isinstance(raw_refs, list):
        return []
    refs: list[XTraceMemoryRef] = []
    for raw in raw_refs:
        ref = _parse_ref(raw)
        if ref is not None:
            refs.append(ref)
    return refs


def _parse_ref(raw: Any) -> XTraceMemoryRef | None:
    if not isinstance(raw, dict):
        return None
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    return XTraceMemoryRef(
        id=str(raw.get("id") or ""),
        type=str(raw.get("type") or "fact"),
        text=text.strip(),
    )


async def _store_refs(
    db: AsyncSession,
    *,
    session: Session,
    refs: list[XTraceMemoryRef],
) -> int:
    if not refs:
        return 0

    texts = [r.text for r in refs]
    existing = (
        await db.execute(
            select(Memory.content).where(
                Memory.user_id == session.user_id,
                Memory.source_session_id == session.id,
                Memory.source == _SOURCE,
                Memory.content.in_(texts),
            )
        )
    ).scalars()
    existing_texts = set(existing.all())

    created = 0
    for ref in refs:
        if ref.text in existing_texts:
            continue
        db.add(
            Memory(
                user_id=session.user_id,
                content=ref.text,
                category=_category_for_xtrace_type(ref.type),
                source=_SOURCE,
                source_session_id=session.id,
                tags=["xtrace", f"xtrace:{ref.type}"],
                metadata_={"xtrace_memory_id": ref.id, "xtrace_type": ref.type},
            )
        )
        existing_texts.add(ref.text)
        created += 1

    if created:
        await db.flush()
    return created


def _category_for_xtrace_type(memory_type: str) -> str:
    if memory_type == "fact":
        return "fact"
    return "context"


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)
