"""Historical public schema, redemption and writers from a5703bb143697ce28f79d364de0eb5aebfa81687.

Function/class bodies are copied from the pre-update implementation; only imports
are consolidated. Keep this compatibility oracle independent of current request logic.
"""

import hashlib
import shlex
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext
from app.models.project import Project
from app.models.vault import Vault, VaultItem, VaultProjectAttachment, VaultSecretRequest
from app.schemas.vault import VaultItemDelete, VaultItemUpsert
from app.schemas.vault_requests import VaultSecretRequestStatus
from app.services.principal_lifecycle import (
    PrincipalSuspendedError,
    PrincipalTerminatedError,
    assert_user_authority_active,
)
from app.services.vault import (
    VaultItemsGlobalDeleteConfirmationRequired,
    _vault_project_count,
    get_vault_for_write,
)
from app.services.vault_crypto import encrypt
from app.services.vault_requests import exact_vault_reference


class VaultSecretRequestToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class VaultSecretRequestSupply(VaultSecretRequestToken):
    fields: dict[str, str] = Field(min_length=1, max_length=32)

    @field_validator("fields")
    @classmethod
    def validate_values(cls, fields: dict[str, str]) -> dict[str, str]:
        if any(not value or len(value) > 65536 or "\x00" in value for value in fields.values()):
            raise ValueError("Values must be nonempty text of at most 65536 characters")
        return fields


async def load_vault_items_by_name(
    db: AsyncSession, vault_id: UUID, section: str
) -> dict[str, VaultItem]:
    result = await db.execute(
        select(VaultItem).where(
            VaultItem.vault_id == vault_id,
            VaultItem.section == section,
        )
    )
    return {item.item_name: item for item in result.scalars().all()}


async def upsert_owned_vault_items(
    db: AsyncSession,
    auth: AuthContext,
    slug: str,
    body: VaultItemUpsert,
    *,
    project_id: UUID | None,
    vault_id: UUID | None,
) -> int:
    vault = await get_vault_for_write(
        db,
        auth,
        slug,
        project_id=project_id,
        vault_id=vault_id,
    )
    existing_by_name = await load_vault_items_by_name(db, vault.id, body.section)

    for field_name, plaintext in body.fields.items():
        ciphertext, nonce = encrypt(plaintext)
        item = existing_by_name.get(field_name)
        if item is not None:
            item.encrypted_value = ciphertext
            item.nonce = nonce
        else:
            db.add(
                VaultItem(
                    vault_id=vault.id,
                    section=body.section,
                    item_name=field_name,
                    encrypted_value=ciphertext,
                    nonce=nonce,
                )
            )

    from app.services.runtime_vaults import notify_vault_changed

    await notify_vault_changed(db, vault.id, values_changed=True)
    await db.commit()
    return len(body.fields)


async def delete_owned_vault_items(
    db: AsyncSession,
    auth: AuthContext,
    slug: str,
    body: VaultItemDelete,
    *,
    project_id: UUID | None,
    vault_id: UUID | None,
    global_delete: bool,
) -> int:
    vault = await get_vault_for_write(
        db,
        auth,
        slug,
        project_id=project_id,
        vault_id=vault_id,
    )
    existing_by_name = await load_vault_items_by_name(db, vault.id, body.section)
    items_to_delete = [
        existing_by_name[field_name]
        for field_name in dict.fromkeys(body.fields)
        if field_name in existing_by_name
    ]

    if items_to_delete and not global_delete:
        project_count = await _vault_project_count(db, vault.id)
        if project_count > 1:
            raise VaultItemsGlobalDeleteConfirmationRequired(project_count)

    for item in items_to_delete:
        await db.delete(item)

    if items_to_delete:
        from app.services.runtime_vaults import notify_vault_changed

        await notify_vault_changed(db, vault.id, values_changed=True)
    await db.commit()
    return len(items_to_delete)


def unavailable() -> HTTPException:
    return HTTPException(410, "Secret request unavailable")


async def request_context(db: AsyncSession, row: VaultSecretRequest) -> tuple[Vault, Project]:
    context = (
        await db.execute(
            select(Vault, Project)
            .join(VaultProjectAttachment, VaultProjectAttachment.vault_id == Vault.id)
            .join(Project, Project.id == VaultProjectAttachment.project_id)
            .where(
                Vault.id == row.vault_id,
                Project.id == row.project_id,
                Project.user_id == Vault.user_id,
                Project.archived_at.is_(None),
            )
            .with_for_update()
        )
    ).one_or_none()
    if context is None:
        raise unavailable()
    return context[0], context[1]


async def describe(db: AsyncSession, row: VaultSecretRequest) -> VaultSecretRequestStatus:
    vault, project = await request_context(db, row)
    existing = await load_vault_items_by_name(db, row.vault_id, row.section)
    state: Literal["pending", "supplied", "expired", "conflict"] = (
        "supplied" if row.supplied_at else "pending"
    )
    if not row.supplied_at:
        if row.expires_at <= datetime.now(UTC):
            state = "expired"
        elif any(field in existing for field in row.fields):
            state = "conflict"
    references = {
        field: exact_vault_reference(row.project_id, vault.slug, row.section, field)
        for field in row.fields
    }
    return VaultSecretRequestStatus(
        id=row.id,
        vault_id=row.vault_id,
        project_id=row.project_id,
        vault_name=vault.name,
        project_name=project.name,
        slug=vault.slug,
        section=row.section,
        fields=row.fields,
        status=state,
        expires_at=row.expires_at,
        supplied_at=row.supplied_at,
        references=references,
        local_command=(
            f"clawdi vault materialize --vault {row.vault_id} "
            f"--project {row.project_id}"
            + (f" --section={shlex.quote(row.section)}" if row.section else "")
            + " --out <absolute-env-path>"
        ),
    )


async def token_request(db: AsyncSession, token: str) -> VaultSecretRequest:
    identity = (
        await db.execute(
            select(VaultSecretRequest.id, Vault.user_id)
            .join(Vault, Vault.id == VaultSecretRequest.vault_id)
            .where(VaultSecretRequest.token_hash == hashlib.sha256(token.encode()).hexdigest())
        )
    ).one_or_none()
    if identity is None:
        raise unavailable()
    try:
        await assert_user_authority_active(db, identity.user_id)
    except (PrincipalSuspendedError, PrincipalTerminatedError):
        raise unavailable() from None
    row = await db.scalar(
        select(VaultSecretRequest)
        .where(VaultSecretRequest.id == identity.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None or row.supplied_at is not None or row.expires_at <= datetime.now(UTC):
        raise unavailable()
    return row


async def supply(db: AsyncSession, body: VaultSecretRequestSupply) -> VaultSecretRequestStatus:
    row = await token_request(db, body.token)
    context = await describe(db, row)
    if context.status != "pending":
        raise unavailable()
    if set(body.fields) != set(row.fields):
        raise HTTPException(422, "Supply exactly the requested fields")
    for field in row.fields:
        ciphertext, nonce = encrypt(body.fields[field])
        item = VaultItem(
            vault_id=row.vault_id,
            section=row.section,
            item_name=field,
            encrypted_value=ciphertext,
            nonce=nonce,
        )
        db.add(item)
        try:
            await db.flush()
        except IntegrityError:
            # A regular Vault write may have won the unique field constraint.
            await db.rollback()
            raise HTTPException(409, "Requested field already supplied") from None
    from app.services.runtime_vaults import notify_vault_changed

    await notify_vault_changed(db, row.vault_id, values_changed=True)
    row.supplied_at = datetime.now(UTC)
    result = await describe(db, row)
    await db.commit()
    return result
