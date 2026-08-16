from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.agent_plugin import (
    AgentPluginInstallation,
    PluginCatalogEntry,
    PluginCatalogSnapshot,
    PluginCatalogSyncState,
)
from app.schemas.plugin_catalog import (
    RESERVED_AGENT_PLUGIN_NAMES,
    TRUSTED_PLUGIN_CATALOG_BRANCH,
    TRUSTED_PLUGIN_CATALOG_PATH,
    PluginCatalogDocument,
    PluginCatalogDocumentEntry,
    PluginCatalogEntryResponse,
    PluginCatalogResponse,
    catalog_source_path,
    parse_catalog_document,
)
from app.schemas.runtime import AGENT_PLUGINS_SCHEMA_1_0_0

log = logging.getLogger(__name__)

_GITHUB_HEAD_URL = (
    f"https://api.github.com/repos/Clawdi-AI/store/commits/{TRUSTED_PLUGIN_CATALOG_BRANCH}"
)
_GITHUB_RAW_CATALOG_URL = (
    f"https://raw.githubusercontent.com/Clawdi-AI/store/{{revision}}/{TRUSTED_PLUGIN_CATALOG_PATH}"
)
_HTTP_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "clawdi-plugin-catalog/1",
    "X-GitHub-Api-Version": "2022-11-28",
}
_MAX_HEAD_RESPONSE_BYTES = 256 * 1024
_MAX_CATALOG_RESPONSE_BYTES = 4 * 1024 * 1024
_SNAPSHOT_RETENTION = 20


class PluginCatalogSyncError(RuntimeError):
    pass


class _GitHubHeadResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    sha: str


@dataclass(frozen=True)
class _SyncClaim:
    attempted_at: datetime
    current_revision: str | None
    head_etag: str | None


@dataclass(frozen=True)
class PluginCatalogSyncResult:
    attempted: bool
    updated: bool = False
    revision: str | None = None


def _entry_metadata(entry: PluginCatalogDocumentEntry) -> dict[str, Any]:
    return {
        "display_name": entry.displayName,
        "description": entry.description,
        "publisher": entry.publisher,
        "category": entry.category,
        "keywords": entry.keywords,
        "languages": entry.languages,
        "icon": entry.icon,
        "components": entry.components.model_dump(mode="json"),
    }


def _entry_response(entry: PluginCatalogEntry) -> PluginCatalogEntryResponse:
    installability_reason = None
    if entry.name in RESERVED_AGENT_PLUGIN_NAMES:
        installability_reason = "reserved_name"
    elif entry.has_configuration:
        installability_reason = "configuration_not_supported"
    elif not entry.compatible_runtimes:
        installability_reason = "no_supported_runtime"
    return PluginCatalogEntryResponse.model_validate(
        {
            "name": entry.name,
            "version": entry.version,
            **entry.public_metadata,
            "runtimes": entry.compatible_runtimes,
            "installable": installability_reason is None,
            "installability_reason": installability_reason,
        }
    )


def _semver_key(version: str) -> tuple[object, ...]:
    without_build = version.split("+", 1)[0]
    core, separator, prerelease = without_build.partition("-")
    major, minor, patch = (int(value) for value in core.split("."))
    if not separator:
        return (major, minor, patch, 1, ())
    identifiers = tuple(
        (0, int(value)) if value.isdigit() else (1, value) for value in prerelease.split(".")
    )
    return (major, minor, patch, 0, identifiers)


async def load_current_catalog(db: AsyncSession) -> PluginCatalogResponse | None:
    state = await db.scalar(
        select(PluginCatalogSyncState)
        .where(PluginCatalogSyncState.id == 1)
        .with_for_update(read=True, key_share=True)
    )
    if state is None or state.current_revision is None:
        return None
    snapshot = await db.get(PluginCatalogSnapshot, state.current_revision)
    if snapshot is None:
        return None
    entries = list(
        (
            await db.scalars(
                select(PluginCatalogEntry).where(
                    PluginCatalogEntry.snapshot_revision == state.current_revision
                )
            )
        ).all()
    )
    entries.sort(key=lambda entry: _semver_key(entry.version), reverse=True)
    entries.sort(key=lambda entry: entry.name)
    return PluginCatalogResponse(
        revision=snapshot.revision,
        synced_at=snapshot.fetched_at,
        plugins=[_entry_response(entry) for entry in entries],
    )


async def load_current_catalog_entry(
    db: AsyncSession,
    *,
    plugin_name: str,
    version: str | None,
    lock_selection: bool = False,
) -> tuple[str, PluginCatalogEntry] | None:
    statement = (
        select(PluginCatalogEntry)
        .join(
            PluginCatalogSyncState,
            PluginCatalogSyncState.current_revision == PluginCatalogEntry.snapshot_revision,
        )
        .where(
            PluginCatalogSyncState.id == 1,
            PluginCatalogEntry.name == plugin_name,
            *((PluginCatalogEntry.version == version,) if version is not None else ()),
        )
    )
    if lock_selection:
        statement = statement.with_for_update(
            read=True,
            key_share=True,
            of=(PluginCatalogSyncState, PluginCatalogEntry),
        )
    entries = list((await db.scalars(statement)).all())
    if not entries:
        return None
    entry = max(entries, key=lambda item: (_semver_key(item.version), item.version))
    return entry.snapshot_revision, entry


def catalog_entry_response(entry: PluginCatalogEntry) -> PluginCatalogEntryResponse:
    return _entry_response(entry)


async def _bounded_response_bytes(response: httpx.Response, *, maximum: int) -> bytes:
    declared = response.headers.get("content-length")
    if declared is not None:
        try:
            declared_size = int(declared)
            if declared_size < 0:
                raise PluginCatalogSyncError("upstream_content_length_invalid")
            if declared_size > maximum:
                raise PluginCatalogSyncError("upstream_response_too_large")
        except ValueError as exc:
            raise PluginCatalogSyncError("upstream_content_length_invalid") from exc
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > maximum:
            raise PluginCatalogSyncError("upstream_response_too_large")
    return bytes(body)


async def _resolve_github_head(
    client: httpx.AsyncClient,
    claim: _SyncClaim,
) -> tuple[str, str | None]:
    headers = dict(_HTTP_HEADERS)
    if claim.head_etag is not None:
        headers["If-None-Match"] = claim.head_etag
    try:
        async with client.stream("GET", _GITHUB_HEAD_URL, headers=headers) as response:
            if response.status_code == 304:
                if claim.current_revision is None:
                    raise PluginCatalogSyncError("head_not_modified_without_snapshot")
                return claim.current_revision, claim.head_etag
            if response.status_code != 200:
                raise PluginCatalogSyncError(f"head_http_{response.status_code}")
            body = await _bounded_response_bytes(
                response,
                maximum=_MAX_HEAD_RESPONSE_BYTES,
            )
            head_etag = response.headers.get("etag")
    except httpx.HTTPError as exc:
        raise PluginCatalogSyncError("head_network_error") from exc
    try:
        revision = _GitHubHeadResponse.model_validate_json(body).sha
    except ValidationError as exc:
        raise PluginCatalogSyncError("head_response_invalid") from exc
    if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
        raise PluginCatalogSyncError("head_revision_invalid")
    return revision, head_etag


async def _fetch_catalog_document(
    client: httpx.AsyncClient,
    revision: str,
) -> tuple[PluginCatalogDocument, str | None]:
    url = _GITHUB_RAW_CATALOG_URL.format(revision=revision)
    try:
        async with client.stream(
            "GET",
            url,
            headers={"Accept": "application/json", "User-Agent": _HTTP_HEADERS["User-Agent"]},
        ) as response:
            if response.status_code != 200:
                raise PluginCatalogSyncError(f"catalog_http_{response.status_code}")
            body = await _bounded_response_bytes(
                response,
                maximum=_MAX_CATALOG_RESPONSE_BYTES,
            )
            catalog_etag = response.headers.get("etag")
    except httpx.HTTPError as exc:
        raise PluginCatalogSyncError("catalog_network_error") from exc
    try:
        document = parse_catalog_document(body)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise PluginCatalogSyncError("catalog_schema_invalid") from exc
    return document, catalog_etag


class PluginCatalogSyncWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        interval_seconds: int = 300,
        timeout_seconds: float = 10.0,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._interval = timedelta(seconds=interval_seconds)
        self._timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 5.0))
        self._poll_seconds = min(30.0, max(1.0, interval_seconds / 10))

    async def run_once(self) -> PluginCatalogSyncResult:
        claim = await self._claim()
        if claim is None:
            return PluginCatalogSyncResult(attempted=False)
        try:
            async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False) as client:
                revision, head_etag = await _resolve_github_head(client, claim)
                if revision == claim.current_revision:
                    await self._record_success(claim, revision=revision, head_etag=head_etag)
                    return PluginCatalogSyncResult(
                        attempted=True,
                        updated=False,
                        revision=revision,
                    )
                document, catalog_etag = await _fetch_catalog_document(client, revision)
            updated = await self._activate_snapshot(
                claim,
                revision=revision,
                head_etag=head_etag,
                catalog_etag=catalog_etag,
                document=document,
            )
            return PluginCatalogSyncResult(attempted=True, updated=updated, revision=revision)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - every upstream/parser failure preserves LKG.
            code = str(exc) if isinstance(exc, PluginCatalogSyncError) else "catalog_sync_failed"
            await self._record_failure(claim, code=code)
            log.warning("Plugin catalog sync failed: %s", code)
            return PluginCatalogSyncResult(attempted=True)

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        while not stop_event.is_set():
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - DB outages must not kill the worker.
                log.exception("Plugin catalog sync cycle failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._poll_seconds)
            except TimeoutError:
                pass

    async def _claim(self) -> _SyncClaim | None:
        now = datetime.now(UTC)
        async with self._sessionmaker() as db:
            state = await db.scalar(
                select(PluginCatalogSyncState)
                .where(PluginCatalogSyncState.id == 1)
                .with_for_update(skip_locked=True)
            )
            if state is None or (state.next_sync_at is not None and state.next_sync_at > now):
                await db.rollback()
                return None
            state.last_attempt_at = now
            state.next_sync_at = now + self._interval
            claim = _SyncClaim(
                attempted_at=now,
                current_revision=state.current_revision,
                head_etag=state.head_etag,
            )
            await db.commit()
            return claim

    async def _activate_snapshot(
        self,
        claim: _SyncClaim,
        *,
        revision: str,
        head_etag: str | None,
        catalog_etag: str | None,
        document: PluginCatalogDocument,
    ) -> bool:
        now = datetime.now(UTC)
        async with self._sessionmaker() as db:
            state = await db.scalar(
                select(PluginCatalogSyncState)
                .where(PluginCatalogSyncState.id == 1)
                .with_for_update()
            )
            if state is None or state.last_attempt_at != claim.attempted_at:
                await db.rollback()
                return False
            snapshot = await db.get(PluginCatalogSnapshot, revision)
            if snapshot is None:
                snapshot = PluginCatalogSnapshot(
                    revision=revision,
                    schema_version=document.schemaVersion,
                    entry_count=len(document.plugins),
                    source_etag=catalog_etag,
                    fetched_at=now,
                )
                db.add(snapshot)
                await db.flush()
                db.add_all(
                    [
                        PluginCatalogEntry(
                            snapshot_revision=revision,
                            name=entry.name,
                            version=entry.version,
                            agent_plugins_schema=AGENT_PLUGINS_SCHEMA_1_0_0,
                            source_path=catalog_source_path(entry),
                            content_digest=entry.digest,
                            public_metadata=_entry_metadata(entry),
                            has_configuration=entry.hasConfiguration,
                            compatible_runtimes=entry.runtimes,
                        )
                        for entry in document.plugins
                    ]
                )
                await db.flush()
            previous = state.current_revision
            state.current_revision = revision
            state.head_etag = head_etag
            state.failure_count = 0
            state.last_success_at = now
            state.next_sync_at = now + self._interval
            state.last_error = None
            await db.flush()
            await self._prune_snapshots(db, current_revision=revision)
            await db.commit()
            return previous != revision

    async def _record_success(
        self,
        claim: _SyncClaim,
        *,
        revision: str,
        head_etag: str | None,
    ) -> None:
        now = datetime.now(UTC)
        async with self._sessionmaker() as db:
            state = await db.scalar(
                select(PluginCatalogSyncState)
                .where(PluginCatalogSyncState.id == 1)
                .with_for_update()
            )
            if state is None or state.last_attempt_at != claim.attempted_at:
                await db.rollback()
                return
            state.current_revision = revision
            state.head_etag = head_etag
            state.failure_count = 0
            state.last_success_at = now
            state.next_sync_at = now + self._interval
            state.last_error = None
            await db.commit()

    async def _record_failure(self, claim: _SyncClaim, *, code: str) -> None:
        now = datetime.now(UTC)
        async with self._sessionmaker() as db:
            state = await db.scalar(
                select(PluginCatalogSyncState)
                .where(PluginCatalogSyncState.id == 1)
                .with_for_update()
            )
            if state is None or state.last_attempt_at != claim.attempted_at:
                await db.rollback()
                return
            state.failure_count += 1
            backoff_seconds = min(
                self._interval.total_seconds(),
                30 * (2 ** min(state.failure_count - 1, 10)),
            )
            state.next_sync_at = now + timedelta(seconds=backoff_seconds)
            state.last_error = code[:200]
            await db.commit()

    async def _prune_snapshots(self, db: AsyncSession, *, current_revision: str) -> None:
        revisions = list(
            (
                await db.scalars(
                    select(PluginCatalogSnapshot.revision)
                    .order_by(PluginCatalogSnapshot.fetched_at.desc())
                    .offset(_SNAPSHOT_RETENTION)
                )
            ).all()
        )
        if not revisions:
            return
        referenced = set(
            (
                await db.scalars(
                    select(AgentPluginInstallation.catalog_revision).where(
                        AgentPluginInstallation.catalog_revision.in_(revisions)
                    )
                )
            ).all()
        )
        removable = [
            revision
            for revision in revisions
            if revision != current_revision and revision not in referenced
        ]
        if removable:
            await db.execute(
                delete(PluginCatalogSnapshot).where(PluginCatalogSnapshot.revision.in_(removable))
            )
