"""XTrace Memory API integration for Clawdi sessions and skills."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.memory import Memory
from app.models.session import Session
from app.models.skill import Skill
from app.models.xtrace_ingest import XTraceMemoryIngest
from app.services.skill_index import SkillTextFile, extract_skill_text_files

log = logging.getLogger(__name__)

_XTRACE_ROLES = {"user", "assistant", "system"}
_SESSION_SOURCE = "xtrace_session"
_SKILL_SOURCE = "xtrace_skill"
_MAX_SKILL_FILE_CHARS = 24_000
_MAX_SKILL_INGEST_CHARS = 160_000
_INGEST_RETRY_STATUSES = {429, 500, 502, 503, 504}
_INGEST_MAX_ATTEMPTS = 5


@dataclass(frozen=True)
class XTraceMemoryRef:
    id: str
    type: str
    text: str
    status: str | None = None
    operation: str | None = None
    supersedes: list[str] | None = None
    superseded_by: str | None = None
    created_at: str | None = None


@dataclass(frozen=True)
class XTraceRemoteIngest:
    payload: dict[str, Any]
    created_refs: list[XTraceMemoryRef]
    updated_refs: list[XTraceMemoryRef]
    memories_superseded_by: dict[str, str]


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


def xtrace_session_source_key(session: Session) -> str:
    version = session.content_hash or session.local_session_id
    return f"session:{session.id}:{version}"


def xtrace_skill_source_key(skill: Skill) -> str:
    return f"skill:{skill.id}:{skill.content_hash}"


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

    source_key = xtrace_session_source_key(session)
    remote = await _ingest(_build_session_payload(session, normalized))
    refs = [*remote.created_refs, *remote.updated_refs]
    mirrored_count = (
        await _store_refs(
            db,
            user_id=session.user_id,
            source=_SESSION_SOURCE,
            source_session_id=session.id,
            refs=refs,
            metadata={
                "source_type": "session",
                "source_key": source_key,
                "local_session_id": session.local_session_id,
            },
        )
        if refs
        else 0
    )
    result = _result_from_remote(remote, mirrored_count)
    db.add(
        XTraceMemoryIngest(
            user_id=session.user_id,
            source_type="session",
            session_id=session.id,
            local_session_id=session.local_session_id,
            source_key=source_key,
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


async def ingest_xtrace_skill_memories(
    db: AsyncSession,
    *,
    skill: Skill,
    data: bytes,
) -> XTraceMemoryIngestResult | None:
    """Send a skill archive to XTrace as an artifact-shaped memory source."""
    if not xtrace_memory_configured():
        return None

    text_files = extract_skill_text_files(data, skill.skill_key)
    if not text_files:
        return None

    source_key = xtrace_skill_source_key(skill)
    remote = await _ingest(_build_skill_payload(skill, text_files))
    refs = [*remote.created_refs, *remote.updated_refs]
    mirrored_count = (
        await _store_refs(
            db,
            user_id=skill.user_id,
            source=_SKILL_SOURCE,
            source_session_id=None,
            refs=refs,
            metadata={
                "source_type": "skill",
                "source_key": source_key,
                "skill_id": str(skill.id),
                "skill_key": skill.skill_key,
                "content_hash": skill.content_hash,
            },
        )
        if refs
        else 0
    )
    result = _result_from_remote(remote, mirrored_count)
    db.add(
        XTraceMemoryIngest(
            user_id=skill.user_id,
            source_type="skill",
            skill_id=skill.id,
            source_key=source_key,
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


def _build_session_payload(
    session: Session,
    messages: list[dict[str, str]],
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "messages": [_session_context_message(session), *messages],
        "user_id": str(session.user_id),
        "conv_id": str(session.id),
        "app_id": settings.xtrace_memory_app_id,
        "extract_artifacts": True,
        "metadata": {
            "source": "clawdi_cloud_session",
            "source_type": "session",
            "source_key": xtrace_session_source_key(session),
            "local_session_id": session.local_session_id,
            "project_path": session.project_path,
            "content_hash": session.content_hash,
            "summary": session.summary,
            "message_count": session.message_count,
            "started_at": _iso_or_none(session.started_at),
            "ended_at": _iso_or_none(session.ended_at),
            "last_activity_at": _iso_or_none(session.last_activity_at),
            "model": session.model,
            "models_used": session.models_used,
            "tags": session.tags,
            "related_refs": session.related_refs,
        },
    }
    if session.environment_id is not None:
        body["agent_id"] = str(session.environment_id)
        body["metadata"]["agent_environment_id"] = str(session.environment_id)
    return body


def _session_context_message(session: Session) -> dict[str, str]:
    parts = [
        "Clawdi Cloud session context.",
        "The following messages are from an AI coding or operations agent "
        "session synced to Clawdi.",
        "Extract durable beliefs, decisions, preferences, project facts, episodes, and artifacts.",
        "Ignore transient shell output unless it establishes a reusable "
        "decision, result, or failure mode.",
    ]
    if session.project_path:
        parts.append(f"Project path: {session.project_path}")
    if session.summary:
        parts.append(f"Session summary: {session.summary}")
    return {"role": "system", "content": "\n".join(parts)}


def _build_skill_payload(skill: Skill, text_files: list[SkillTextFile]) -> dict[str, Any]:
    messages = _skill_messages(skill, text_files)
    return {
        "messages": messages,
        "user_id": str(skill.user_id),
        "conv_id": f"skill:{skill.id}:{skill.content_hash[:12]}",
        "app_id": settings.xtrace_memory_app_id,
        "extract_artifacts": True,
        "metadata": {
            "source": "clawdi_cloud_skill",
            "source_type": "skill",
            "source_key": xtrace_skill_source_key(skill),
            "skill_id": str(skill.id),
            "skill_key": skill.skill_key,
            "name": skill.name,
            "description": skill.description,
            "version": skill.version,
            "project_id": str(skill.project_id),
            "source_repo": skill.source_repo,
            "content_hash": skill.content_hash,
            "file_count": skill.file_count,
            "agent_types": skill.agent_types,
        },
    }


def _skill_messages(skill: Skill, text_files: list[SkillTextFile]) -> list[dict[str, str]]:
    messages = [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "Clawdi Cloud skill bundle context.",
                    "The following files define an agent skill available in Clawdi.",
                    "Extract the reusable workflow, operating constraints, "
                    "artifact content, and when the skill should be used.",
                    "Treat SKILL.md and reference files as durable artifacts, not casual chat.",
                ]
            ),
        },
        {
            "role": "user",
            "content": "\n".join(
                [
                    "Skill metadata:",
                    f"key: {skill.skill_key}",
                    f"name: {skill.name}",
                    f"description: {skill.description or ''}",
                    f"version: {skill.version}",
                    f"source: {skill.source}",
                    f"project_id: {skill.project_id}",
                    f"content_hash: {skill.content_hash}",
                ]
            ),
        },
    ]

    used_chars = sum(len(m["content"]) for m in messages)
    for text_file in text_files:
        if used_chars >= _MAX_SKILL_INGEST_CHARS:
            break
        remaining = _MAX_SKILL_INGEST_CHARS - used_chars
        content = text_file.content[: min(_MAX_SKILL_FILE_CHARS, remaining)]
        if len(text_file.content) > len(content):
            content = f"{content}\n\n[truncated]"
        message = {
            "role": "user",
            "content": f"Skill file: {text_file.path}\n\n{content}",
        }
        messages.append(message)
        used_chars += len(message["content"])
    return messages


async def _ingest(body: dict[str, Any]) -> XTraceRemoteIngest:
    url = f"{settings.xtrace_memory_base_url.rstrip('/')}/v1/memories"
    headers = {
        "Authorization": f"Bearer {settings.xtrace_api_key}",
        "X-Org-Id": settings.xtrace_org_id,
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=settings.xtrace_memory_timeout_seconds) as client:
        response: httpx.Response | None = None
        for attempt in range(1, _INGEST_MAX_ATTEMPTS + 1):
            response = await client.post(
                url,
                headers=headers,
                params={"wait": "true"},
                json=body,
            )
            if response.status_code not in _INGEST_RETRY_STATUSES:
                break
            if attempt == _INGEST_MAX_ATTEMPTS:
                break
            delay = _retry_delay_seconds(response, attempt)
            log.warning(
                "xtrace_memory_ingest_retry status=%s attempt=%s delay_seconds=%s",
                response.status_code,
                attempt,
                delay,
            )
            await asyncio.sleep(delay)

        if response is None:
            raise RuntimeError("XTrace ingest did not return a response")
        response.raise_for_status()
        payload = response.json()

    return _extract_remote_ingest(payload)


def _retry_delay_seconds(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return min(max(float(retry_after), 1.0), 60.0)
        except ValueError:
            pass
    return min(2.0 * (2 ** (attempt - 1)), 30.0)


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
        dia_id = message.get("dia_id") or message.get("id")
        if isinstance(dia_id, str) and dia_id:
            item["dia_id"] = dia_id
        normalized.append(item)
    return normalized


def _extract_remote_ingest(payload: dict[str, Any]) -> XTraceRemoteIngest:
    created_refs: list[XTraceMemoryRef] = []
    updated_refs: list[XTraceMemoryRef] = []
    memories_superseded_by: dict[str, str] = {}

    result = payload.get("result")
    if isinstance(result, dict):
        created_refs.extend(_parse_ref_list(result.get("memories_created")))
        updated_refs.extend(_parse_ref_list(result.get("memories_updated")))
        memories_superseded_by = _parse_superseded_by(result.get("memories_superseded_by"))

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
        created_refs=_with_lineage(created_refs, "add", memories_superseded_by),
        updated_refs=_with_lineage(updated_refs, "update", memories_superseded_by),
        memories_superseded_by=memories_superseded_by,
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
        status=_string_or_none(raw.get("status")) or "active",
        operation=_string_or_none(raw.get("operation")),
        supersedes=_string_list(raw.get("supersedes")),
        superseded_by=_string_or_none(raw.get("superseded_by")),
        created_at=_string_or_none(raw.get("created_at")),
    )


def _parse_superseded_by(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for old_id, new_id in raw.items():
        if old_id and new_id:
            out[str(old_id)] = str(new_id)
    return out


def _with_lineage(
    refs: list[XTraceMemoryRef],
    operation: str,
    superseded_by: dict[str, str],
) -> list[XTraceMemoryRef]:
    if not refs:
        return []
    supersedes_by_new_id: dict[str, list[str]] = {}
    for old_id, new_id in superseded_by.items():
        supersedes_by_new_id.setdefault(new_id, []).append(old_id)

    out: list[XTraceMemoryRef] = []
    for ref in refs:
        supersedes = [*(ref.supersedes or []), *supersedes_by_new_id.get(ref.id, [])]
        out.append(
            XTraceMemoryRef(
                id=ref.id,
                type=ref.type,
                text=ref.text,
                status=ref.status or "active",
                operation=ref.operation or operation,
                supersedes=supersedes,
                superseded_by=ref.superseded_by,
                created_at=ref.created_at,
            )
        )
    return out


async def _store_refs(
    db: AsyncSession,
    *,
    user_id: UUID,
    source: str,
    source_session_id: UUID | None,
    refs: list[XTraceMemoryRef],
    metadata: dict[str, Any],
) -> int:
    if not refs:
        return 0

    texts = [r.text for r in refs]
    await _mark_superseded_refs(db, user_id=user_id, source=source, refs=refs)

    stmt = select(Memory).where(
        Memory.user_id == user_id,
        Memory.source == source,
        Memory.content.in_(texts),
    )
    if source_session_id is None:
        stmt = stmt.where(Memory.source_session_id.is_(None))
    else:
        stmt = stmt.where(Memory.source_session_id == source_session_id)
    existing = (await db.execute(stmt)).scalars().all()
    existing_by_text = {m.content: m for m in existing}
    existing_texts = set(existing_by_text)

    created = 0
    for ref in refs:
        metadata_ = _memory_metadata(metadata, ref)
        existing_memory = existing_by_text.get(ref.text)
        if existing_memory is not None:
            existing_memory.category = _category_for_xtrace_type(ref.type)
            existing_memory.tags = ["xtrace", f"xtrace:{ref.type}", source]
            existing_memory.metadata_ = {
                **(existing_memory.metadata_ or {}),
                **metadata_,
            }
            flag_modified(existing_memory, "metadata_")
            continue
        if ref.text in existing_texts:
            continue
        db.add(
            Memory(
                user_id=user_id,
                content=ref.text,
                category=_category_for_xtrace_type(ref.type),
                source=source,
                source_session_id=source_session_id,
                tags=["xtrace", f"xtrace:{ref.type}", source],
                metadata_=metadata_,
            )
        )
        existing_texts.add(ref.text)
        created += 1

    if created:
        await db.flush()
    return created


async def _mark_superseded_refs(
    db: AsyncSession,
    *,
    user_id: UUID,
    source: str,
    refs: list[XTraceMemoryRef],
) -> None:
    superseded_pairs: list[tuple[str, str]] = []
    for ref in refs:
        if not ref.id:
            continue
        for old_id in ref.supersedes or []:
            superseded_pairs.append((old_id, ref.id))
    if not superseded_pairs:
        return

    superseded_by = dict(superseded_pairs)
    old_ids = list(superseded_by)
    rows = (
        (
            await db.execute(
                select(Memory).where(
                    Memory.user_id == user_id,
                    Memory.source == source,
                    Memory.metadata_["xtrace_memory_id"].astext.in_(old_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    for memory in rows:
        metadata = dict(memory.metadata_ or {})
        remote_id = _string_or_none(metadata.get("xtrace_memory_id"))
        if remote_id is None:
            continue
        metadata["xtrace_status"] = "superseded"
        metadata["xtrace_superseded_by"] = superseded_by.get(remote_id)
        metadata["xtrace_timeline"] = [
            *_existing_timeline(memory),
            {
                "operation": "superseded",
                "content": memory.content,
                "memory_id": remote_id,
                "status": "superseded",
                "at": None,
            },
        ]
        memory.metadata_ = metadata
        flag_modified(memory, "metadata_")


def _memory_metadata(metadata: dict[str, Any], ref: XTraceMemoryRef) -> dict[str, Any]:
    return {
        **metadata,
        "xtrace_memory_id": ref.id,
        "xtrace_type": ref.type,
        "xtrace_status": ref.status or "active",
        "xtrace_operation": ref.operation or "add",
        "xtrace_supersedes": ref.supersedes or [],
        "xtrace_superseded_by": ref.superseded_by,
        "xtrace_created_at": ref.created_at,
        "xtrace_timeline": [
            {
                "operation": ref.operation or "add",
                "content": ref.text,
                "memory_id": ref.id,
                "status": ref.status or "active",
                "at": ref.created_at,
            }
        ],
    }


def _existing_timeline(memory: Memory) -> list[dict[str, Any]]:
    metadata = memory.metadata_ if isinstance(memory.metadata_, dict) else {}
    raw = metadata.get("xtrace_timeline")
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    return []


def _result_from_remote(
    remote: XTraceRemoteIngest,
    mirrored_count: int,
) -> XTraceMemoryIngestResult:
    return XTraceMemoryIngestResult(
        job_id=_string_or_none(remote.payload.get("id")),
        status=_string_or_none(remote.payload.get("status")),
        created_ref_count=len(remote.created_refs),
        updated_ref_count=len(remote.updated_refs),
        mirrored_count=mirrored_count,
        response=remote.payload,
    )


def _category_for_xtrace_type(memory_type: str) -> str:
    if memory_type == "fact":
        return "fact"
    if memory_type == "artifact":
        return "artifact"
    return "context"


def _iso_or_none(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _string_list(value: Any) -> list[str]:
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return []
