from __future__ import annotations

from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import JsonValue, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth_unbound
from app.core.database import get_session
from app.models.agent_plugin import AgentPluginInstallation
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import (
    RUNTIME_OBSERVATION_HEAD_ACTIVE,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.schemas.plugin_catalog import (
    EXACT_SEMVER_PATTERN,
    AgentPluginDesiredStateDeleteResponse,
    AgentPluginDesiredStateListResponse,
    AgentPluginDesiredStateResponse,
    AgentPluginInstallRequest,
    PluginCatalogEntryResponse,
    PluginCatalogResponse,
    PluginName,
)
from app.schemas.runtime import MAX_HOSTED_AGENT_PLUGIN_INSTALLATIONS
from app.schemas.runtime_observation import (
    HostedRuntimeObservedAgentPluginsV1,
    HostedRuntimeObservedAgentPluginV1,
)
from app.services.agent_bindings import get_owned_agent_or_404
from app.services.agent_lifecycle import active_owned_agent
from app.services.audit import record_control_plane_audit
from app.services.plugin_catalog import (
    catalog_entry_response,
    load_current_catalog,
    load_current_catalog_entry,
)
from app.services.sync_events import queue_runtime_manifest_changed

router = APIRouter(tags=["plugin-catalog"])

_ObservedInstallationKey = tuple[str, str, str, str]


def _desired_response(
    row: AgentPluginInstallation,
    observations: dict[_ObservedInstallationKey, HostedRuntimeObservedAgentPluginV1],
    observed_at: datetime | None,
    received_at: datetime | None,
) -> AgentPluginDesiredStateResponse:
    observed = observations.get((str(row.id), row.plugin_name, row.version, row.content_digest))
    if received_at is None or received_at < row.updated_at:
        observed = None
    return AgentPluginDesiredStateResponse(
        installation_id=row.id,
        agent_id=row.environment_id,
        plugin_name=row.plugin_name,
        version=row.version,
        catalog_revision=row.catalog_revision,
        convergence=(
            "not_observed" if observed is None or observed.status == "unknown" else observed.status
        ),
        observation_error_code=observed.error_code if observed is not None else None,
        observed_at=observed_at if observed is not None else None,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _latest_agent_plugin_observations(
    db: AsyncSession,
    *,
    agent_id: UUID,
) -> tuple[
    dict[_ObservedInstallationKey, HostedRuntimeObservedAgentPluginV1],
    datetime | None,
    datetime | None,
]:
    latest = (
        await db.execute(
            select(
                V2RuntimeObservationInbox.diagnostics,
                V2RuntimeObservationInbox.captured_at,
                V2RuntimeObservationInbox.received_at,
            )
            .join(
                V2RuntimeObservationHead,
                V2RuntimeObservationHead.latest_inbox_id == V2RuntimeObservationInbox.id,
            )
            .where(
                V2RuntimeObservationHead.environment_id == agent_id,
                V2RuntimeObservationHead.state == RUNTIME_OBSERVATION_HEAD_ACTIVE,
                V2RuntimeObservationInbox.freshness_deadline >= datetime.now(UTC),
            )
            .order_by(V2RuntimeObservationHead.latest_stream_position.desc())
            .limit(1)
        )
    ).one_or_none()
    if latest is None or not isinstance(latest.diagnostics, dict):
        return {}, None, None
    diagnostics = cast(dict[str, JsonValue], latest.diagnostics)
    payload = diagnostics.get("agentPlugins")
    if payload is None:
        return {}, None, None
    try:
        observed = HostedRuntimeObservedAgentPluginsV1.model_validate(payload)
    except ValidationError:
        return {}, None, None
    return (
        {
            (
                installation.installation_id,
                installation.name,
                installation.version,
                installation.content_digest,
            ): installation
            for installation in observed.installations
        },
        latest.captured_at,
        latest.received_at,
    )


def _selected_runtime(state: HostedRuntimeState) -> str:
    runtimes = list(state.runtimes)
    if len(runtimes) != 1 or runtimes[0] not in {"openclaw", "hermes"}:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"code": "hosted_runtime_state_invalid"},
        )
    return runtimes[0]


@router.get("/plugin-catalog", response_model=PluginCatalogResponse)
async def list_plugin_catalog(
    _auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> PluginCatalogResponse:
    catalog = await load_current_catalog(db)
    if catalog is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Plugin catalog is temporarily unavailable",
        )
    return catalog


@router.get("/plugin-catalog/{plugin_name}", response_model=PluginCatalogEntryResponse)
async def get_plugin_catalog_entry(
    plugin_name: PluginName,
    version: str | None = Query(default=None, min_length=1, max_length=256),
    _auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> PluginCatalogEntryResponse:
    if version is not None and EXACT_SEMVER_PATTERN.fullmatch(version) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "version must be exact SemVer")
    catalog = await load_current_catalog(db)
    if catalog is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Plugin catalog is temporarily unavailable",
        )
    resolved = await load_current_catalog_entry(
        db,
        plugin_name=plugin_name,
        version=version,
    )
    if resolved is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin catalog entry not found")
    return catalog_entry_response(resolved[1])


@router.get(
    "/agents/{agent_id}/agent-plugins",
    response_model=AgentPluginDesiredStateListResponse,
)
async def list_agent_plugin_desired_state(
    agent_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentPluginDesiredStateListResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    rows = list(
        (
            await db.scalars(
                select(AgentPluginInstallation)
                .where(AgentPluginInstallation.environment_id == agent_id)
                .order_by(AgentPluginInstallation.plugin_name)
            )
        ).all()
    )
    observations, observed_at, received_at = await _latest_agent_plugin_observations(
        db, agent_id=agent_id
    )
    return AgentPluginDesiredStateListResponse(
        plugins=[_desired_response(row, observations, observed_at, received_at) for row in rows]
    )


@router.get(
    "/agents/{agent_id}/agent-plugins/{plugin_name}",
    response_model=AgentPluginDesiredStateResponse,
)
async def get_agent_plugin_desired_state(
    agent_id: UUID,
    plugin_name: PluginName,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentPluginDesiredStateResponse:
    await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    row = await db.scalar(
        select(AgentPluginInstallation).where(
            AgentPluginInstallation.environment_id == agent_id,
            AgentPluginInstallation.plugin_name == plugin_name,
        )
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent Plugin desired state not found")
    observations, observed_at, received_at = await _latest_agent_plugin_observations(
        db, agent_id=agent_id
    )
    return _desired_response(row, observations, observed_at, received_at)


@router.put(
    "/agents/{agent_id}/agent-plugins/{plugin_name}",
    response_model=AgentPluginDesiredStateResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def put_agent_plugin_desired_state(
    agent_id: UUID,
    body: AgentPluginInstallRequest,
    plugin_name: PluginName,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentPluginDesiredStateResponse:
    agent = await active_owned_agent(
        db,
        user_id=auth.user_id,
        agent_id=agent_id,
        for_update=True,
    )
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")
    state = await db.scalar(
        select(HostedRuntimeState)
        .where(HostedRuntimeState.environment_id == agent_id)
        .with_for_update()
    )
    if state is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"code": "hosted_v2_runtime_required"},
        )
    selected_runtime = _selected_runtime(state)
    resolved = await load_current_catalog_entry(
        db,
        plugin_name=plugin_name,
        version=body.version,
        lock_selection=True,
    )
    if resolved is None:
        catalog = await load_current_catalog(db)
        if catalog is None:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Plugin catalog is temporarily unavailable",
            )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plugin catalog entry not found")
    catalog_revision, entry = resolved
    if entry.has_configuration:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"code": "plugin_configuration_not_supported"},
        )
    if selected_runtime not in entry.compatible_runtimes:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": "plugin_runtime_not_supported",
                "runtime": selected_runtime,
            },
        )
    row = await db.scalar(
        select(AgentPluginInstallation)
        .where(
            AgentPluginInstallation.environment_id == agent_id,
            AgentPluginInstallation.plugin_name == plugin_name,
        )
        .with_for_update()
    )
    if row is None:
        installation_count = await db.scalar(
            select(func.count())
            .select_from(AgentPluginInstallation)
            .where(AgentPluginInstallation.environment_id == agent_id)
        )
        if (installation_count or 0) >= MAX_HOSTED_AGENT_PLUGIN_INSTALLATIONS:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {"code": "agent_plugin_limit_reached"},
            )
    changed = row is None or (
        row.catalog_revision,
        row.version,
        row.agent_plugins_schema,
        row.source_path,
        row.content_digest,
    ) != (
        catalog_revision,
        entry.version,
        entry.agent_plugins_schema,
        entry.source_path,
        entry.content_digest,
    )
    if row is None:
        row = AgentPluginInstallation(
            environment_id=agent_id,
            plugin_name=plugin_name,
            catalog_revision=catalog_revision,
            version=entry.version,
            agent_plugins_schema=entry.agent_plugins_schema,
            source_path=entry.source_path,
            content_digest=entry.content_digest,
        )
        db.add(row)
    elif changed:
        row.catalog_revision = catalog_revision
        row.version = entry.version
        row.agent_plugins_schema = entry.agent_plugins_schema
        row.source_path = entry.source_path
        row.content_digest = entry.content_digest
    if changed:
        queue_runtime_manifest_changed(db, auth.user_id, agent_id)
    await db.flush()
    observations, observed_at, received_at = await _latest_agent_plugin_observations(
        db, agent_id=agent_id
    )
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        source="agent_plugins.api",
        action="agent_plugin.desired_present",
        resource_type="agent_plugin_installation",
        resource_id=str(row.id),
        environment_id=agent_id,
        details={
            "plugin_name": plugin_name,
            "version": entry.version,
            "catalog_revision": catalog_revision,
            "changed": changed,
            "convergence": "not_observed",
        },
    )
    await db.commit()
    await db.refresh(row)
    return _desired_response(row, observations, observed_at, received_at)


@router.delete(
    "/agents/{agent_id}/agent-plugins/{plugin_name}",
    response_model=AgentPluginDesiredStateDeleteResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def delete_agent_plugin_desired_state(
    agent_id: UUID,
    plugin_name: PluginName,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> AgentPluginDesiredStateDeleteResponse:
    agent = await active_owned_agent(
        db,
        user_id=auth.user_id,
        agent_id=agent_id,
        for_update=True,
    )
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")
    row = await db.scalar(
        select(AgentPluginInstallation)
        .where(
            AgentPluginInstallation.environment_id == agent_id,
            AgentPluginInstallation.plugin_name == plugin_name,
        )
        .with_for_update()
    )
    changed = row is not None
    resource_id = str(row.id) if row is not None else None
    if row is not None:
        await db.delete(row)
        queue_runtime_manifest_changed(db, auth.user_id, agent_id)
    record_control_plane_audit(
        db,
        actor_type="user",
        actor_user_id=auth.user_id,
        target_user_id=auth.user_id,
        source="agent_plugins.api",
        action="agent_plugin.desired_absent",
        resource_type="agent_plugin_installation",
        resource_id=resource_id,
        environment_id=agent_id,
        details={
            "plugin_name": plugin_name,
            "changed": changed,
            "convergence": "not_observed",
        },
    )
    await db.commit()
    return AgentPluginDesiredStateDeleteResponse(agent_id=agent_id, plugin_name=plugin_name)
