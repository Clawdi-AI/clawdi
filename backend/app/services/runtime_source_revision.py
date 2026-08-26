from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import settings
from app.models.hosted_runtime import HostedRuntimeState
from app.services.runtime_source import (
    RUNTIME_SOURCE_RENDERER_REVISION,
    RuntimeSourceError,
    load_runtime_source_batch,
    render_runtime_source,
    vault_key_identity,
)

log = logging.getLogger(__name__)


def runtime_source_contract_revision() -> str:
    material = {
        "publicApiUrl": settings.public_api_url.rstrip("/"),
        "rendererRevision": RUNTIME_SOURCE_RENDERER_REVISION,
        "vaultKeyIdentity": vault_key_identity(settings.vault_encryption_key),
    }
    canonical = json.dumps(material, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def persisted_runtime_source_revision(state: HostedRuntimeState) -> str | None:
    if state.source_revision_contract != runtime_source_contract_revision():
        return None
    return state.source_revision


async def refresh_runtime_source_revisions(
    db: AsyncSession,
    environment_ids: Iterable[UUID],
) -> dict[UUID, str | None]:
    requested_ids = sorted(set(environment_ids), key=str)
    if not requested_ids:
        return {}

    await db.flush()
    await db.execute(
        select(HostedRuntimeState.environment_id)
        .where(HostedRuntimeState.environment_id.in_(requested_ids))
        .order_by(HostedRuntimeState.environment_id)
        .with_for_update()
    )
    batch = await load_runtime_source_batch(db, environment_ids=requested_ids)
    contract_revision = runtime_source_contract_revision()
    revisions: dict[UUID, str | None] = {}
    for environment_id in requested_ids:
        row = batch.rows.get(environment_id)
        if row is None or row.state is None:
            continue
        try:
            revision = render_runtime_source(
                batch,
                environment_id=environment_id,
                public_api_url=settings.public_api_url,
                vault_key_identity=vault_key_identity(settings.vault_encryption_key),
                decrypt_secrets=False,
            ).source_revision
        except RuntimeSourceError as exc:
            revision = None
            log.warning(
                "runtime source revision refresh failed environment_id=%s reason=%s",
                environment_id,
                str(exc),
            )
        revisions[environment_id] = revision
        state = row.state
        if revision is None and state.source_revision is None:
            continue
        if (
            state.source_revision == revision
            and state.source_revision_contract == contract_revision
        ):
            continue
        await db.execute(
            update(HostedRuntimeState)
            .where(HostedRuntimeState.environment_id == environment_id)
            .values(
                source_revision=revision,
                source_revision_contract=contract_revision,
                updated_at=HostedRuntimeState.updated_at,
            )
            .execution_options(synchronize_session=False)
        )
        set_committed_value(state, "source_revision", revision)
        set_committed_value(state, "source_revision_contract", contract_revision)
    return revisions


async def repair_runtime_source_revision(
    db: AsyncSession,
    *,
    environment_id: UUID,
    expected_revision: str | None,
    expected_contract: str | None,
    computed_revision: str | None,
) -> bool:
    contract_revision = runtime_source_contract_revision()
    repaired_id = await db.scalar(
        update(HostedRuntimeState)
        .where(
            HostedRuntimeState.environment_id == environment_id,
            HostedRuntimeState.source_revision.is_not_distinct_from(expected_revision),
            HostedRuntimeState.source_revision_contract.is_not_distinct_from(expected_contract),
        )
        .values(
            source_revision=computed_revision,
            source_revision_contract=contract_revision,
            updated_at=HostedRuntimeState.updated_at,
        )
        .returning(HostedRuntimeState.environment_id)
        .execution_options(synchronize_session=False)
    )
    if repaired_id is None:
        return False
    if expected_revision is not None or expected_contract is not None:
        log.warning(
            "repaired stale runtime source revision environment_id=%s "
            "persisted_revision=%s computed_revision=%s",
            environment_id,
            expected_revision,
            computed_revision,
        )
    return True
