"""Write-only capabilities for exact, initially absent Vault fields."""

import hashlib
import secrets
import shlex
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext
from app.core.config import settings
from app.models.project import Project
from app.models.vault import Vault, VaultItem, VaultProjectAttachment, VaultSecretRequest
from app.schemas.vault_requests import (
    VaultSecretRequestCreate,
    VaultSecretRequestCreated,
    VaultSecretRequestStatus,
    VaultSecretRequestSupply,
)
from app.services.principal_lifecycle import (
    PrincipalSuspendedError,
    PrincipalTerminatedError,
    assert_user_authority_active,
)
from app.services.vault import get_vault_for_write, load_vault_items_by_name
from app.services.vault_crypto import encrypt


def exact_vault_reference(project_id: UUID, slug: str, section: str, field: str) -> str:
    parts = ["project", str(project_id), "vault", slug]
    if section:
        parts.extend(["section", section])
    parts.extend(["field", field])
    return "clawdi://" + "/".join(quote(part, safe="") for part in parts)


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


async def recent_requests(
    db: AsyncSession, vault_id: UUID, project_id: UUID | None, *, limit: int = 50
) -> list[VaultSecretRequestStatus]:
    rows = (
        await db.scalars(
            select(VaultSecretRequest)
            .where(
                VaultSecretRequest.vault_id == vault_id,
                VaultSecretRequest.project_id == project_id if project_id else true(),
            )
            .order_by(VaultSecretRequest.created_at.desc())
            .limit(limit)
        )
    ).all()
    results: list[VaultSecretRequestStatus] = []
    for row in rows:
        try:
            results.append(await describe(db, row))
        except HTTPException as exc:
            if exc.status_code != 410:
                raise
    return results


async def create_request(
    db: AsyncSession, auth: AuthContext, body: VaultSecretRequestCreate
) -> VaultSecretRequestCreated:
    vault = await get_vault_for_write(
        db, auth, body.slug, project_id=body.project_id, vault_id=body.vault_id
    )
    # Serialize reservations in this Vault, including requests with overlapping fields.
    await db.execute(select(Vault.id).where(Vault.id == vault.id).with_for_update())
    existing = await load_vault_items_by_name(db, vault.id, body.section)
    pending = (
        await db.scalars(
            select(VaultSecretRequest).where(
                VaultSecretRequest.vault_id == vault.id,
                VaultSecretRequest.section == body.section,
                VaultSecretRequest.supplied_at.is_(None),
                VaultSecretRequest.expires_at > datetime.now(UTC),
            )
        )
    ).all()
    if any(field in existing for field in body.fields) or any(
        set(body.fields).intersection(row.fields) for row in pending
    ):
        raise HTTPException(409, "Fields already supplied or requested")
    token = secrets.token_urlsafe(32)
    row = VaultSecretRequest(
        vault_id=vault.id,
        project_id=body.project_id,
        section=body.section,
        fields=body.fields,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=datetime.now(UTC) + timedelta(seconds=body.expires_in_seconds),
    )
    db.add(row)
    await db.flush()
    result = await describe(db, row)
    await db.commit()
    return VaultSecretRequestCreated(
        **result.model_dump(), url=f"{settings.web_origin.rstrip('/')}/vault-request#{token}"
    )


async def owned_request(
    db: AsyncSession, auth: AuthContext, request_id: UUID
) -> VaultSecretRequest:
    row = await db.get(VaultSecretRequest, request_id)
    if row is None:
        raise HTTPException(404, "Secret request not found")
    vault = await db.get(Vault, row.vault_id)
    if vault is None:
        raise HTTPException(404, "Secret request not found")
    await get_vault_for_write(
        db, auth, vault.slug, project_id=row.project_id, vault_id=row.vault_id
    )
    return row


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
