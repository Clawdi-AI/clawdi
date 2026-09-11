"""Complete Agent Vault snapshots, independent of native runtime manifests."""

import hashlib
import json
from collections.abc import Sequence
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, exists, select, true, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import PROJECT_KIND_ENVIRONMENT, PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.vault import Vault, VaultItem, VaultProjectAttachment
from app.schemas.vault import RuntimeVault, RuntimeVaultField, RuntimeVaultSnapshot
from app.services.sync_events import queue_runtime_vaults_changed
from app.services.vault_crypto import decrypt
from app.services.vault_requests import exact_vault_reference


def agent_vault_projects() -> Select[tuple[UUID, UUID, UUID]]:
    membership = exists().where(
        ProjectMembership.project_id == Project.id,
        ProjectMembership.member_user_id == AgentEnvironment.user_id,
    )
    linked = exists().where(
        AgentProjectBinding.agent_id == AgentEnvironment.id,
        AgentProjectBinding.project_id == Project.id,
        AgentProjectBinding.binding_type == "context",
    )
    return (
        select(
            AgentEnvironment.user_id,
            AgentEnvironment.id.label("agent_id"),
            Project.id.label("project_id"),
        )
        .select_from(AgentEnvironment)
        .join(
            Project,
            (
                (Project.id == AgentEnvironment.default_project_id)
                & (Project.kind == PROJECT_KIND_ENVIRONMENT)
                & (Project.user_id == AgentEnvironment.user_id)
            )
            | (
                (Project.kind == PROJECT_KIND_WORKSPACE)
                & linked
                & ((Project.user_id == AgentEnvironment.user_id) | membership)
            ),
        )
        .where(AgentEnvironment.archived_at.is_(None), Project.archived_at.is_(None))
    )


async def notify_vault_changed(
    db: AsyncSession, vault_id: UUID, *, values_changed: bool = False
) -> None:
    """Call before detach/delete, after writes; no consumer manifest rendering."""
    if values_changed:
        await db.execute(
            update(Vault)
            .where(Vault.id == vault_id)
            .values(runtime_revision=Vault.runtime_revision + 1)
        )
    sources = agent_vault_projects().subquery()
    targets = (
        await db.execute(
            select(sources.c.user_id, sources.c.agent_id)
            .join(VaultProjectAttachment, VaultProjectAttachment.project_id == sources.c.project_id)
            .where(VaultProjectAttachment.vault_id == vault_id)
            .distinct()
        )
    ).all()
    for user_id, agent_id in targets:
        queue_runtime_vaults_changed(db, user_id, agent_id)


async def vault_snapshot_metadata(
    db: AsyncSession, user_id: UUID, agent_id: UUID, *, allow_linked_projects: bool = False
) -> tuple[dict[UUID, RuntimeVault], str]:
    agent = await db.scalar(
        select(AgentEnvironment.id).where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.user_id == user_id,
            AgentEnvironment.archived_at.is_(None),
        )
    )
    if agent is None:
        raise HTTPException(403, "Agent access unavailable")
    sources = (
        agent_vault_projects()
        .where(AgentEnvironment.id == agent_id, AgentEnvironment.user_id == user_id)
        .where(
            true() if allow_linked_projects else Project.id == AgentEnvironment.default_project_id
        )
        .subquery()
    )
    rows = (
        await db.execute(
            select(Vault, VaultProjectAttachment.project_id)
            .join(VaultProjectAttachment, VaultProjectAttachment.vault_id == Vault.id)
            .join(sources, sources.c.project_id == VaultProjectAttachment.project_id)
            .order_by(Vault.id, VaultProjectAttachment.project_id)
            .limit(10001)
        )
    ).all()
    if len(rows) > 10000:
        raise HTTPException(413, "Vault snapshot exceeds runtime limit")
    inventory: dict[UUID, RuntimeVault] = {}
    revisions: dict[str, int] = {}
    for vault, project_id in rows:
        if vault.id not in inventory:
            inventory[vault.id] = RuntimeVault(
                id=vault.id, name=vault.name, slug=vault.slug, project_ids=[], revision=""
            )
            revisions[str(vault.id)] = vault.runtime_revision
        inventory[vault.id].project_ids.append(project_id)
    for entry in inventory.values():
        entry.revision = hashlib.sha256(
            json.dumps(
                [entry.model_dump(mode="json"), revisions[str(entry.id)]], sort_keys=True
            ).encode()
        ).hexdigest()
    metadata = [entry.model_dump(mode="json") for entry in inventory.values()]
    digest = hashlib.sha256(
        json.dumps(
            [str(user_id), str(agent_id), metadata, revisions],
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return inventory, f'"runtime-vaults-{digest}"'


async def vault_snapshot_values(
    db: AsyncSession,
    user_id: UUID,
    agent_id: UUID,
    inventory: dict[UUID, RuntimeVault],
    revisions: dict[UUID, str],
) -> RuntimeVaultSnapshot:
    changed = {key for key, vault in inventory.items() if revisions.get(key) != vault.revision}
    for key in changed:
        inventory[key].fields = []
    rows: Sequence[VaultItem] = (
        (
            await db.scalars(
                select(VaultItem)
                .where(VaultItem.vault_id.in_(changed))
                .order_by(VaultItem.vault_id, VaultItem.section, VaultItem.item_name)
                .limit(10001)
            )
        ).all()
        if changed
        else []
    )
    if (
        len(rows) > 10000
        or sum(len(item.encrypted_value) for item in rows) > 8 * 1024 * 1024
        or sum(len(inventory[item.vault_id].project_ids) for item in rows) > 10000
    ):
        raise HTTPException(413, "Vault snapshot exceeds runtime limit")
    for item in rows:
        vault = inventory[item.vault_id]
        assert vault.fields is not None
        vault.fields.append(
            RuntimeVaultField(
                id=item.id,
                section=item.section,
                name=item.item_name,
                references=[
                    exact_vault_reference(project_id, vault.slug, item.section, item.item_name)
                    for project_id in vault.project_ids
                ],
                value=decrypt(item.encrypted_value, item.nonce),
            )
        )
    return RuntimeVaultSnapshot(agent_id=agent_id, user_id=user_id, vaults=list(inventory.values()))
