from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth, require_user_auth_unbound
from app.core.database import get_session
from app.core.project import validate_project_for_caller, validate_project_read_for_caller
from app.models.mcp import (
    McpPack,
    McpPackEntry,
    McpServer,
    ProjectMcpCredentialBinding,
    ProjectMcpInstallation,
    ProjectMcpToolPolicy,
)
from app.models.vault import Vault, VaultItem, VaultProjectAttachment
from app.schemas.mcp import (
    McpPackCreate,
    McpPackEntriesPut,
    McpPackEntryInput,
    McpPackEntryResponse,
    McpPackResponse,
    McpPackUpdate,
    McpServerCreate,
    McpServerResponse,
    McpServerUpdate,
    ProjectMcpCredentialBindingInput,
    ProjectMcpCredentialBindingResponse,
    ProjectMcpCredentialBindingsPut,
    ProjectMcpInstallationCreate,
    ProjectMcpInstallationResponse,
    ProjectMcpInstallationUpdate,
    ProjectMcpToolPoliciesPut,
    ProjectMcpToolPolicyResponse,
)

router = APIRouter(prefix="/api/mcp", tags=["mcp"])
project_router = APIRouter(prefix="/api/projects/{project_id}/mcp", tags=["project-mcp"])


def _uuid(value: str, field: str) -> UUID:
    try:
        return UUID(value)
    except ValueError as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid {field}") from err


def _server_response(server: McpServer) -> McpServerResponse:
    return McpServerResponse(
        id=str(server.id),
        owner_user_id=str(server.owner_user_id) if server.owner_user_id else None,
        slug=server.slug,
        name=server.name,
        description=server.description,
        visibility=server.visibility,
        source_type=server.source_type,
        source_ref=server.source_ref,
        transport=server.transport,
        runtime_mode=server.runtime_mode,
        default_command=server.default_command,
        default_args=server.default_args_json,
        default_cwd_template=server.default_cwd_template,
        default_url=server.default_url,
        required_inputs=server.required_inputs_json,
        auth_config=server.auth_config_json,
        runtime_config=server.runtime_config_json,
        capabilities=server.capabilities_json,
        discovery_cache=server.discovery_cache_json,
        risk_metadata=server.risk_metadata_json,
        archived_at=server.archived_at,
        created_at=server.created_at,
        updated_at=server.updated_at,
    )


def _pack_entry_response(entry: McpPackEntry, server: McpServer) -> McpPackEntryResponse:
    return McpPackEntryResponse(
        id=str(entry.id),
        pack_id=str(entry.pack_id),
        mcp_server_id=str(entry.mcp_server_id),
        server_alias=entry.server_alias,
        default_tool_prefix=entry.default_tool_prefix,
        default_enabled=entry.default_enabled,
        version_pin=entry.version_pin,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
        server=_server_response(server),
    )


def _pack_response(
    pack: McpPack,
    *,
    entries: list[McpPackEntryResponse] | None = None,
) -> McpPackResponse:
    return McpPackResponse(
        id=str(pack.id),
        owner_user_id=str(pack.owner_user_id) if pack.owner_user_id else None,
        slug=pack.slug,
        name=pack.name,
        description=pack.description,
        visibility=pack.visibility,
        archived_at=pack.archived_at,
        created_at=pack.created_at,
        updated_at=pack.updated_at,
        entries=entries or [],
    )


def _binding_response(binding: ProjectMcpCredentialBinding) -> ProjectMcpCredentialBindingResponse:
    return ProjectMcpCredentialBindingResponse(
        id=str(binding.id),
        installation_id=str(binding.installation_id),
        target_kind=binding.target_kind,
        target_name=binding.target_name,
        value_source=binding.value_source,
        vault_id=str(binding.vault_id) if binding.vault_id else None,
        vault_item_id=str(binding.vault_item_id) if binding.vault_item_id else None,
        display_vault_uri=binding.display_vault_uri,
        local_env_name=binding.local_env_name,
        input_id=binding.input_id,
        connector_ref=binding.connector_ref,
        required=binding.required,
        redact_in_logs=binding.redact_in_logs,
        created_at=binding.created_at,
        updated_at=binding.updated_at,
    )


def _tool_policy_response(policy: ProjectMcpToolPolicy) -> ProjectMcpToolPolicyResponse:
    return ProjectMcpToolPolicyResponse(
        id=str(policy.id),
        installation_id=str(policy.installation_id),
        tool_name=policy.tool_name,
        enabled=policy.enabled,
        risk_level=policy.risk_level,
        approval_policy=policy.approval_policy,
        created_at=policy.created_at,
        updated_at=policy.updated_at,
    )


def _installation_response(
    installation: ProjectMcpInstallation,
    server: McpServer,
    *,
    bindings: list[ProjectMcpCredentialBinding] | None = None,
    policies: list[ProjectMcpToolPolicy] | None = None,
) -> ProjectMcpInstallationResponse:
    return ProjectMcpInstallationResponse(
        id=str(installation.id),
        project_id=str(installation.project_id),
        mcp_server_id=str(installation.mcp_server_id),
        source_pack_id=str(installation.source_pack_id) if installation.source_pack_id else None,
        installed_by_user_id=str(installation.installed_by_user_id),
        server_alias=installation.server_alias,
        tool_prefix=installation.tool_prefix,
        version_pin=installation.version_pin,
        enabled=installation.enabled,
        command_override=installation.command_override,
        args_override=installation.args_override_json,
        cwd_template_override=installation.cwd_template_override,
        url_override=installation.url_override,
        env_template=installation.env_template_json,
        headers_template=installation.headers_template_json,
        auth_override=installation.auth_override_json,
        timeout_ms=installation.timeout_ms,
        startup_timeout_ms=installation.startup_timeout_ms,
        restart_policy=installation.restart_policy,
        archived_at=installation.archived_at,
        created_at=installation.created_at,
        updated_at=installation.updated_at,
        server=_server_response(server),
        bindings=[_binding_response(binding) for binding in bindings or []],
        tool_policies=[_tool_policy_response(policy) for policy in policies or []],
    )


def _readable_server_stmt(auth: AuthContext):
    return select(McpServer).where(
        McpServer.archived_at.is_(None),
        or_(McpServer.visibility == "catalog", McpServer.owner_user_id == auth.user_id),
    )


def _readable_pack_stmt(auth: AuthContext):
    return select(McpPack).where(
        McpPack.archived_at.is_(None),
        or_(McpPack.visibility == "catalog", McpPack.owner_user_id == auth.user_id),
    )


async def _get_readable_server(
    db: AsyncSession,
    auth: AuthContext,
    server_id: UUID,
) -> McpServer:
    server = (
        await db.execute(_readable_server_stmt(auth).where(McpServer.id == server_id))
    ).scalar_one_or_none()
    if server is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MCP server not found")
    return server


async def _get_readable_pack(db: AsyncSession, auth: AuthContext, pack_id: UUID) -> McpPack:
    pack = (
        await db.execute(_readable_pack_stmt(auth).where(McpPack.id == pack_id))
    ).scalar_one_or_none()
    if pack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MCP pack not found")
    return pack


async def _get_owned_server(db: AsyncSession, auth: AuthContext, server_id: UUID) -> McpServer:
    server = (
        await db.execute(
            select(McpServer).where(
                McpServer.id == server_id,
                McpServer.owner_user_id == auth.user_id,
                McpServer.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if server is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MCP server not found")
    return server


async def _get_owned_pack(db: AsyncSession, auth: AuthContext, pack_id: UUID) -> McpPack:
    pack = (
        await db.execute(
            select(McpPack).where(
                McpPack.id == pack_id,
                McpPack.owner_user_id == auth.user_id,
                McpPack.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if pack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "MCP pack not found")
    return pack


async def _load_pack_response(db: AsyncSession, pack: McpPack) -> McpPackResponse:
    rows = (
        await db.execute(
            select(McpPackEntry, McpServer)
            .join(McpServer, McpServer.id == McpPackEntry.mcp_server_id)
            .where(
                McpPackEntry.pack_id == pack.id,
                McpServer.archived_at.is_(None),
            )
            .order_by(McpPackEntry.server_alias)
        )
    ).all()
    return _pack_response(
        pack,
        entries=[_pack_entry_response(entry, server) for entry, server in rows],
    )


async def _replace_pack_entries(
    db: AsyncSession,
    auth: AuthContext,
    pack: McpPack,
    entries: list[McpPackEntryInput],
) -> None:
    validated = await _validate_pack_entries(db, auth, entries)
    await db.execute(delete(McpPackEntry).where(McpPackEntry.pack_id == pack.id))
    _add_pack_entries(db, pack, validated)


async def _validate_pack_entries(
    db: AsyncSession,
    auth: AuthContext,
    entries: list[McpPackEntryInput],
) -> list[tuple[McpPackEntryInput, UUID]]:
    validated: list[tuple[McpPackEntryInput, UUID]] = []
    for item in entries:
        server = await _get_readable_server(db, auth, _uuid(item.mcp_server_id, "mcp_server_id"))
        validated.append((item, server.id))
    return validated


def _add_pack_entries(
    db: AsyncSession,
    pack: McpPack,
    entries: list[tuple[McpPackEntryInput, UUID]],
) -> None:
    for item, server_id in entries:
        db.add(
            McpPackEntry(
                pack_id=pack.id,
                mcp_server_id=server_id,
                server_alias=item.server_alias,
                default_tool_prefix=item.default_tool_prefix,
                default_enabled=item.default_enabled,
                version_pin=item.version_pin,
            )
        )


async def _validate_source_pack_for_server(
    db: AsyncSession,
    auth: AuthContext,
    source_pack_id: str | None,
    server_id: UUID,
) -> UUID | None:
    if source_pack_id is None:
        return None
    pack_id = _uuid(source_pack_id, "source_pack_id")
    await _get_readable_pack(db, auth, pack_id)
    entry = (
        await db.execute(
            select(McpPackEntry.id).where(
                McpPackEntry.pack_id == pack_id,
                McpPackEntry.mcp_server_id == server_id,
            )
        )
    ).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "MCP server is not part of source pack")
    return pack_id


async def _get_project_installation(
    db: AsyncSession,
    project_id: UUID,
    installation_id: UUID,
) -> ProjectMcpInstallation:
    installation = (
        await db.execute(
            select(ProjectMcpInstallation).where(
                ProjectMcpInstallation.id == installation_id,
                ProjectMcpInstallation.project_id == project_id,
                ProjectMcpInstallation.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if installation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project MCP installation not found")
    return installation


async def _load_installation_response(
    db: AsyncSession,
    installation: ProjectMcpInstallation,
) -> ProjectMcpInstallationResponse:
    server = (
        await db.execute(select(McpServer).where(McpServer.id == installation.mcp_server_id))
    ).scalar_one()
    bindings = (
        await db.execute(
            select(ProjectMcpCredentialBinding).where(
                ProjectMcpCredentialBinding.installation_id == installation.id
            )
        )
    ).scalars()
    policies = (
        await db.execute(
            select(ProjectMcpToolPolicy).where(
                ProjectMcpToolPolicy.installation_id == installation.id
            )
        )
    ).scalars()
    return _installation_response(
        installation,
        server,
        bindings=list(bindings.all()),
        policies=list(policies.all()),
    )


def _apply_server_update(server: McpServer, body: McpServerUpdate) -> None:
    data = body.model_dump(exclude_unset=True)
    field_map = {
        "default_args": "default_args_json",
        "required_inputs": "required_inputs_json",
        "auth_config": "auth_config_json",
        "runtime_config": "runtime_config_json",
        "capabilities": "capabilities_json",
        "discovery_cache": "discovery_cache_json",
        "risk_metadata": "risk_metadata_json",
    }
    for key, value in data.items():
        setattr(server, field_map.get(key, key), value)


def _apply_installation_update(
    installation: ProjectMcpInstallation,
    body: ProjectMcpInstallationUpdate,
) -> None:
    data = body.model_dump(exclude_unset=True)
    field_map = {
        "args_override": "args_override_json",
        "env_template": "env_template_json",
        "headers_template": "headers_template_json",
        "auth_override": "auth_override_json",
    }
    for key, value in data.items():
        setattr(installation, field_map.get(key, key), value)


@router.get("/servers", response_model=list[McpServerResponse])
async def list_mcp_servers(
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[McpServerResponse]:
    rows = (
        await db.execute(_readable_server_stmt(auth).order_by(McpServer.visibility, McpServer.slug))
    ).scalars()
    return [_server_response(row) for row in rows.all()]


@router.post("/servers", response_model=McpServerResponse, status_code=status.HTTP_201_CREATED)
async def create_mcp_server(
    body: McpServerCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpServerResponse:
    if body.visibility != "private":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "catalog MCP servers are operator-managed")
    server = McpServer(
        owner_user_id=auth.user_id,
        slug=body.slug,
        name=body.name,
        description=body.description,
        visibility=body.visibility,
        source_type=body.source_type,
        source_ref=body.source_ref,
        transport=body.transport,
        runtime_mode=body.runtime_mode,
        default_command=body.default_command,
        default_args_json=body.default_args,
        default_cwd_template=body.default_cwd_template,
        default_url=body.default_url,
        required_inputs_json=body.required_inputs,
        auth_config_json=body.auth_config,
        runtime_config_json=body.runtime_config,
        capabilities_json=body.capabilities,
        discovery_cache_json=body.discovery_cache,
        risk_metadata_json=body.risk_metadata,
    )
    db.add(server)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "MCP server slug already exists") from exc
    await db.refresh(server)
    return _server_response(server)


@router.get("/servers/{server_id}", response_model=McpServerResponse)
async def get_mcp_server(
    server_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpServerResponse:
    return _server_response(await _get_readable_server(db, auth, server_id))


@router.patch("/servers/{server_id}", response_model=McpServerResponse)
async def update_mcp_server(
    server_id: UUID,
    body: McpServerUpdate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpServerResponse:
    server = await _get_owned_server(db, auth, server_id)
    _apply_server_update(server, body)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "MCP server update conflict") from exc
    await db.refresh(server)
    return _server_response(server)


@router.delete("/servers/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mcp_server(
    server_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> None:
    server = await _get_owned_server(db, auth, server_id)
    server.archived_at = datetime.now(UTC)
    await db.commit()


@router.get("/packs", response_model=list[McpPackResponse])
async def list_mcp_packs(
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[McpPackResponse]:
    rows = (
        await db.execute(_readable_pack_stmt(auth).order_by(McpPack.visibility, McpPack.slug))
    ).scalars()
    return [await _load_pack_response(db, row) for row in rows.all()]


@router.post("/packs", response_model=McpPackResponse, status_code=status.HTTP_201_CREATED)
async def create_mcp_pack(
    body: McpPackCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpPackResponse:
    if body.visibility != "private":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "catalog MCP packs are operator-managed")
    pack = McpPack(
        owner_user_id=auth.user_id,
        slug=body.slug,
        name=body.name,
        description=body.description,
        visibility=body.visibility,
    )
    try:
        entries = await _validate_pack_entries(db, auth, body.entries)
        db.add(pack)
        await db.flush()
        _add_pack_entries(db, pack, entries)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "MCP pack conflict") from exc
    await db.refresh(pack)
    return await _load_pack_response(db, pack)


@router.get("/packs/{pack_id}", response_model=McpPackResponse)
async def get_mcp_pack(
    pack_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpPackResponse:
    return await _load_pack_response(db, await _get_readable_pack(db, auth, pack_id))


@router.patch("/packs/{pack_id}", response_model=McpPackResponse)
async def update_mcp_pack(
    pack_id: UUID,
    body: McpPackUpdate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpPackResponse:
    pack = await _get_owned_pack(db, auth, pack_id)
    data = body.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(pack, key, value)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "MCP pack update conflict") from exc
    await db.refresh(pack)
    return await _load_pack_response(db, pack)


@router.put("/packs/{pack_id}/entries", response_model=McpPackResponse)
async def put_mcp_pack_entries(
    pack_id: UUID,
    body: McpPackEntriesPut,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> McpPackResponse:
    pack = await _get_owned_pack(db, auth, pack_id)
    try:
        await _replace_pack_entries(db, auth, pack, body.entries)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "duplicate MCP pack entry") from exc
    await db.refresh(pack)
    return await _load_pack_response(db, pack)


@router.delete("/packs/{pack_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mcp_pack(
    pack_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> None:
    pack = await _get_owned_pack(db, auth, pack_id)
    pack.archived_at = datetime.now(UTC)
    await db.commit()


@project_router.get("", response_model=list[ProjectMcpInstallationResponse])
async def list_project_mcp_installations(
    project_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> list[ProjectMcpInstallationResponse]:
    await validate_project_read_for_caller(db, auth, project_id)
    rows = (
        await db.execute(
            select(ProjectMcpInstallation)
            .where(
                ProjectMcpInstallation.project_id == project_id,
                ProjectMcpInstallation.archived_at.is_(None),
            )
            .order_by(ProjectMcpInstallation.server_alias)
        )
    ).scalars()
    return [await _load_installation_response(db, row) for row in rows.all()]


@project_router.post(
    "/installations",
    response_model=ProjectMcpInstallationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_mcp_installation(
    project_id: UUID,
    body: ProjectMcpInstallationCreate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectMcpInstallationResponse:
    await validate_project_for_caller(db, auth, project_id)
    server = await _get_readable_server(db, auth, _uuid(body.mcp_server_id, "mcp_server_id"))
    source_pack_id = await _validate_source_pack_for_server(
        db,
        auth,
        body.source_pack_id,
        server.id,
    )
    installation = ProjectMcpInstallation(
        project_id=project_id,
        mcp_server_id=server.id,
        source_pack_id=source_pack_id,
        installed_by_user_id=auth.user_id,
        server_alias=body.server_alias or server.slug,
        tool_prefix=body.tool_prefix,
        version_pin=body.version_pin,
        enabled=body.enabled,
        command_override=body.command_override,
        args_override_json=body.args_override,
        cwd_template_override=body.cwd_template_override,
        url_override=body.url_override,
        env_template_json=body.env_template,
        headers_template_json=body.headers_template,
        auth_override_json=body.auth_override,
        timeout_ms=body.timeout_ms,
        startup_timeout_ms=body.startup_timeout_ms,
        restart_policy=body.restart_policy,
    )
    db.add(installation)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Project MCP alias already exists") from exc
    await db.refresh(installation)
    return _installation_response(installation, server)


@project_router.post(
    "/packs/{pack_id}/install",
    response_model=list[ProjectMcpInstallationResponse],
    status_code=status.HTTP_201_CREATED,
)
async def install_mcp_pack_in_project(
    project_id: UUID,
    pack_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> list[ProjectMcpInstallationResponse]:
    await validate_project_for_caller(db, auth, project_id)
    pack = await _get_readable_pack(db, auth, pack_id)
    rows = (
        await db.execute(
            select(McpPackEntry, McpServer)
            .join(McpServer, McpServer.id == McpPackEntry.mcp_server_id)
            .where(
                McpPackEntry.pack_id == pack.id,
                McpServer.archived_at.is_(None),
            )
            .order_by(McpPackEntry.server_alias)
        )
    ).all()
    installations: list[tuple[ProjectMcpInstallation, McpServer]] = []
    for entry, server in rows:
        installation = ProjectMcpInstallation(
            project_id=project_id,
            mcp_server_id=server.id,
            source_pack_id=pack.id,
            installed_by_user_id=auth.user_id,
            server_alias=entry.server_alias,
            tool_prefix=entry.default_tool_prefix,
            version_pin=entry.version_pin,
            enabled=entry.default_enabled,
        )
        db.add(installation)
        installations.append((installation, server))
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Project MCP alias already exists") from exc
    for installation, _server in installations:
        await db.refresh(installation)
    return [_installation_response(installation, server) for installation, server in installations]


@project_router.get(
    "/installations/{installation_id}",
    response_model=ProjectMcpInstallationResponse,
)
async def get_project_mcp_installation(
    project_id: UUID,
    installation_id: UUID,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> ProjectMcpInstallationResponse:
    await validate_project_read_for_caller(db, auth, project_id)
    installation = await _get_project_installation(db, project_id, installation_id)
    return await _load_installation_response(db, installation)


@project_router.patch(
    "/installations/{installation_id}",
    response_model=ProjectMcpInstallationResponse,
)
async def update_project_mcp_installation(
    project_id: UUID,
    installation_id: UUID,
    body: ProjectMcpInstallationUpdate,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectMcpInstallationResponse:
    await validate_project_for_caller(db, auth, project_id)
    installation = await _get_project_installation(db, project_id, installation_id)
    _apply_installation_update(installation, body)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Project MCP update conflict") from exc
    await db.refresh(installation)
    return await _load_installation_response(db, installation)


@project_router.delete(
    "/installations/{installation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_project_mcp_installation(
    project_id: UUID,
    installation_id: UUID,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> None:
    await validate_project_for_caller(db, auth, project_id)
    installation = await _get_project_installation(db, project_id, installation_id)
    installation.archived_at = datetime.now(UTC)
    await db.commit()


async def _validate_binding_project_scope(
    db: AsyncSession,
    project_id: UUID,
    binding: ProjectMcpCredentialBindingInput,
) -> tuple[UUID | None, UUID | None]:
    vault_id = _uuid(binding.vault_id, "vault_id") if binding.vault_id else None
    vault_item_id = _uuid(binding.vault_item_id, "vault_item_id") if binding.vault_item_id else None
    if binding.value_source != "vault":
        return vault_id, vault_item_id
    if vault_id is None or vault_item_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "vault bindings require vault_id and vault_item_id",
        )
    row = (
        await db.execute(
            select(VaultItem)
            .join(Vault, Vault.id == VaultItem.vault_id)
            .join(VaultProjectAttachment, VaultProjectAttachment.vault_id == Vault.id)
            .where(
                Vault.id == vault_id,
                VaultProjectAttachment.project_id == project_id,
                VaultItem.id == vault_item_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vault item not found in this Project")
    return vault_id, vault_item_id


@project_router.put(
    "/installations/{installation_id}/bindings",
    response_model=ProjectMcpInstallationResponse,
)
async def put_project_mcp_credential_bindings(
    project_id: UUID,
    installation_id: UUID,
    body: ProjectMcpCredentialBindingsPut,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectMcpInstallationResponse:
    await validate_project_for_caller(db, auth, project_id)
    installation = await _get_project_installation(db, project_id, installation_id)
    validated_bindings = []
    for item in body.bindings:
        vault_id, vault_item_id = await _validate_binding_project_scope(db, project_id, item)
        validated_bindings.append((item, vault_id, vault_item_id))
    await db.execute(
        delete(ProjectMcpCredentialBinding).where(
            ProjectMcpCredentialBinding.installation_id == installation.id
        )
    )
    for item, vault_id, vault_item_id in validated_bindings:
        db.add(
            ProjectMcpCredentialBinding(
                installation_id=installation.id,
                target_kind=item.target_kind,
                target_name=item.target_name,
                value_source=item.value_source,
                vault_id=vault_id,
                vault_item_id=vault_item_id,
                display_vault_uri=item.display_vault_uri,
                local_env_name=item.local_env_name,
                input_id=item.input_id,
                connector_ref=item.connector_ref,
                required=item.required,
                redact_in_logs=item.redact_in_logs,
            )
        )
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "duplicate MCP credential binding") from exc
    await db.refresh(installation)
    return await _load_installation_response(db, installation)


@project_router.put(
    "/installations/{installation_id}/tools",
    response_model=ProjectMcpInstallationResponse,
)
async def put_project_mcp_tool_policies(
    project_id: UUID,
    installation_id: UUID,
    body: ProjectMcpToolPoliciesPut,
    auth: AuthContext = Depends(require_user_auth_unbound),
    db: AsyncSession = Depends(get_session),
) -> ProjectMcpInstallationResponse:
    await validate_project_for_caller(db, auth, project_id)
    installation = await _get_project_installation(db, project_id, installation_id)
    await db.execute(
        delete(ProjectMcpToolPolicy).where(ProjectMcpToolPolicy.installation_id == installation.id)
    )
    for item in body.tools:
        db.add(
            ProjectMcpToolPolicy(
                installation_id=installation.id,
                tool_name=item.tool_name,
                enabled=item.enabled,
                risk_level=item.risk_level,
                approval_policy=item.approval_policy,
            )
        )
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "duplicate MCP tool policy") from exc
    await db.refresh(installation)
    return await _load_installation_response(db, installation)
