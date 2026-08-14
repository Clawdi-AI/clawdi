from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from app.core.config import settings
from app.core.database import runtime_snapshot_session
from app.services.runtime_source import (
    RuntimeSourceNotFoundError,
    expected_runtime_bundle_v2_etag,
    load_runtime_source_batch,
    render_runtime_source,
    vault_key_identity,
)


@dataclass(frozen=True, slots=True)
class RuntimeSourceAuthority:
    environment_id: UUID
    deployment_id: str
    instance_id: str
    source_revision: str
    etag: str


async def load_runtime_source_authority(
    *,
    environment_id: UUID,
    owner_user_id: UUID,
) -> RuntimeSourceAuthority:
    """Render the non-secret authority for one exact owner/environment binding."""

    async with runtime_snapshot_session() as source_db:
        batch = await load_runtime_source_batch(
            source_db,
            environment_ids=[environment_id],
            owner_user_id=owner_user_id,
        )
        source = render_runtime_source(
            batch,
            environment_id=environment_id,
            public_api_url=settings.public_api_url,
            vault_key_identity=vault_key_identity(settings.vault_encryption_key),
            decrypt_secrets=False,
        )
        row = batch.rows[environment_id]
        state = row.state
        if state is None:
            raise RuntimeSourceNotFoundError("Runtime source not found")
        return RuntimeSourceAuthority(
            environment_id=row.environment.id,
            deployment_id=state.deployment_id,
            instance_id=state.instance_id,
            source_revision=source.source_revision,
            etag=expected_runtime_bundle_v2_etag(source.source_revision),
        )
