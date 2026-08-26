from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import runtime_snapshot_session
from app.models.agent_plugin import AgentPluginInstallation
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.schemas.plugin_catalog import RESERVED_AGENT_PLUGIN_NAMES
from app.services.runtime_source import (
    RuntimeSourceNotFoundError,
    expected_runtime_bundle_v2_etag,
    load_runtime_source_batch,
    render_runtime_source,
    vault_key_identity,
)
from app.services.runtime_source_revision import runtime_source_contract_revision


@dataclass(frozen=True, slots=True)
class RuntimeSourceAuthority:
    environment_id: UUID
    deployment_id: str
    instance_id: str
    source_revision: str
    etag: str


@dataclass(frozen=True, slots=True)
class PersistedRuntimeSourceAuthority:
    environment_id: UUID
    deployment_id: str
    instance_id: str
    source_revision: str | None
    has_agent_plugins: bool
    has_github_release_agent_plugins: bool

    @property
    def etag(self) -> str | None:
        if self.source_revision is None:
            return None
        return expected_runtime_bundle_v2_etag(self.source_revision)

    def matches_projection(
        self,
        *,
        project_agent_plugins: bool,
        project_agent_plugin_github_release_sources: bool,
    ) -> bool:
        if not self.has_agent_plugins:
            return True
        if not project_agent_plugins:
            return False
        return (
            project_agent_plugin_github_release_sources or not self.has_github_release_agent_plugins
        )


async def load_persisted_runtime_source_authority(
    db: AsyncSession,
    *,
    environment_id: UUID,
    owner_user_id: UUID,
) -> PersistedRuntimeSourceAuthority:
    has_agent_plugins = (
        select(AgentPluginInstallation.id)
        .where(
            AgentPluginInstallation.environment_id == AgentEnvironment.id,
            AgentPluginInstallation.plugin_name.not_in(RESERVED_AGENT_PLUGIN_NAMES),
        )
        .exists()
    )
    has_github_release_agent_plugins = (
        select(AgentPluginInstallation.id)
        .where(
            AgentPluginInstallation.environment_id == AgentEnvironment.id,
            AgentPluginInstallation.plugin_name.not_in(RESERVED_AGENT_PLUGIN_NAMES),
            AgentPluginInstallation.source["type"].as_string() == "github-release",
        )
        .exists()
    )
    row = (
        await db.execute(
            select(
                AgentEnvironment.id,
                HostedRuntimeState.environment_id,
                HostedRuntimeState.deployment_id,
                HostedRuntimeState.instance_id,
                HostedRuntimeState.source_revision,
                HostedRuntimeState.source_revision_contract,
                has_agent_plugins,
                has_github_release_agent_plugins,
            )
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == owner_user_id,
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).one_or_none()
    if row is None:
        raise RuntimeSourceNotFoundError("Agent environment not found")
    (
        environment_id,
        state_environment_id,
        deployment_id,
        instance_id,
        source_revision,
        source_revision_contract,
        has_agent_plugins,
        has_github_release_agent_plugins,
    ) = row
    if state_environment_id is None:
        raise RuntimeSourceNotFoundError("Hosted runtime state not found")
    return PersistedRuntimeSourceAuthority(
        environment_id=environment_id,
        deployment_id=deployment_id,
        instance_id=instance_id,
        source_revision=(
            source_revision
            if source_revision_contract == runtime_source_contract_revision()
            else None
        ),
        has_agent_plugins=has_agent_plugins,
        has_github_release_agent_plugins=has_github_release_agent_plugins,
    )


async def load_runtime_source_authority(
    *,
    environment_id: UUID,
    owner_user_id: UUID,
) -> RuntimeSourceAuthority:
    """Load the persisted authority, rendering only an unbackfilled legacy row."""

    async with runtime_snapshot_session() as source_db:
        persisted = await load_persisted_runtime_source_authority(
            source_db,
            environment_id=environment_id,
            owner_user_id=owner_user_id,
        )
        if persisted.source_revision is not None and persisted.etag is not None:
            return RuntimeSourceAuthority(
                environment_id=persisted.environment_id,
                deployment_id=persisted.deployment_id,
                instance_id=persisted.instance_id,
                source_revision=persisted.source_revision,
                etag=persisted.etag,
            )
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
