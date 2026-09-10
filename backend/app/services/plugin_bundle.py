"""One-time channel recommendations, using the trusted Store installation contract."""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_plugin import AgentPluginInstallation
from app.models.session import AgentEnvironment
from app.schemas.plugin_catalog import RESERVED_AGENT_PLUGIN_NAMES, PluginCatalogEntryResponse
from app.schemas.runtime import MAX_HOSTED_AGENT_PLUGIN_INSTALLATIONS
from app.services.plugin_catalog import load_current_catalog, load_current_catalog_entry
from app.services.sync_events import queue_runtime_manifest_changed


async def initialize_plugin_bundle(
    db: AsyncSession, *, agent: AgentEnvironment, bundle: str, runtime: str
) -> None:
    # Caller holds the Agent row lock. The marker and all desired rows commit
    # with runtime-state; rollback leaves initialization retryable.
    if agent.plugin_bundle_revision is not None or bundle != "sui":
        return
    catalog = await load_current_catalog(db)
    if catalog is None:
        raise HTTPException(503, "Plugin catalog is temporarily unavailable")
    selected: dict[str, PluginCatalogEntryResponse] = {}
    for entry in catalog.plugins:
        if "sui" in entry.keywords and entry.name not in RESERVED_AGENT_PLUGIN_NAMES:
            selected.setdefault(entry.name, entry)
    if not selected:
        raise HTTPException(503, "Plugin bundle is temporarily unavailable")
    existing = set(
        await db.scalars(
            select(AgentPluginInstallation.plugin_name).where(
                AgentPluginInstallation.environment_id == agent.id,
                AgentPluginInstallation.plugin_name.not_in(RESERVED_AGENT_PLUGIN_NAMES),
            )
        )
    )
    if len(existing | selected.keys()) > MAX_HOSTED_AGENT_PLUGIN_INSTALLATIONS:
        raise HTTPException(409, {"code": "agent_plugin_limit_reached"})
    for name, metadata in selected.items():
        if name in existing:
            continue
        resolved = await load_current_catalog_entry(
            db, plugin_name=name, version=metadata.version, lock_selection=True
        )
        if resolved is None or resolved[0] != catalog.revision:
            raise HTTPException(503, "Plugin catalog is temporarily unavailable")
        revision, entry = resolved
        if runtime not in entry.compatible_runtimes:
            raise HTTPException(409, {"code": "plugin_runtime_not_supported"})
        db.add(
            AgentPluginInstallation(
                environment_id=agent.id,
                plugin_name=name,
                catalog_revision=revision,
                version=entry.version,
                agent_plugins_schema=entry.agent_plugins_schema,
                source=entry.source,
                content_digest=entry.content_digest,
            )
        )
    agent.plugin_bundle_revision = catalog.revision
    await queue_runtime_manifest_changed(db, agent.user_id, agent.id)
