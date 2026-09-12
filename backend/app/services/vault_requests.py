"""Write-only capabilities for exact Vault fields at their requested state."""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, true
from sqlalchemy.exc import DBAPIError, IntegrityError
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


def field_baseline(item: VaultItem | None) -> str | None:
    if item is None:
        return None
    return hashlib.sha256(item.id.bytes + item.nonce + item.encrypted_value).hexdigest()


def fields_conflict(row: VaultSecretRequest, existing: dict[str, VaultItem]) -> bool:
    return (
        row.conflicted_at is not None
        or not set(row.fields).issubset(row.field_baselines)
        or any(
            field_baseline(existing.get(field)) != row.field_baselines[field]
            for field in row.fields
        )
    )


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
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if context is None:
        raise unavailable()
    return context[0], context[1]


async def describe(db: AsyncSession, row: VaultSecretRequest) -> VaultSecretRequestStatus:
    vault, project = await request_context(db, row)
    # Owner reads can load the request before waiting on a concurrent Vault writer.
    # Autoflush preserves this transaction's own successful submission first.
    await db.execute(
        select(VaultSecretRequest)
        .where(VaultSecretRequest.id == row.id)
        .execution_options(populate_existing=True)
    )
    existing = await load_vault_items_by_name(db, row.vault_id, row.section)
    state: Literal["pending", "supplied", "expired", "conflict"] = (
        "supplied" if row.supplied_at else "pending"
    )
    if not row.supplied_at:
        if row.conflicted_at is not None:
            state = "conflict"
        elif row.expires_at <= datetime.now(UTC):
            state = "expired"
        elif fields_conflict(row, existing):
            state = "conflict"
    all_fields = [*row.fields, *row.extra_fields]
    references = {
        field: exact_vault_reference(row.project_id, vault.slug, row.section, field)
        for field in all_fields
    }
    return VaultSecretRequestStatus(
        id=row.id,
        vault_id=row.vault_id,
        project_id=row.project_id,
        vault_name=vault.name,
        project_name=project.name,
        slug=vault.slug,
        section=row.section,
        fields=all_fields,
        extra_fields=list(row.extra_fields),
        update_fields=[field for field in all_fields if row.field_baselines.get(field) is not None],
        content_version=vault.runtime_revision,
        status=state,
        expires_at=row.expires_at,
        supplied_at=row.supplied_at,
        references=references,
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
                VaultSecretRequest.conflicted_at.is_(None),
                VaultSecretRequest.expires_at > datetime.now(UTC),
            )
        )
    ).all()
    for row in pending:
        if not set(body.fields).intersection(row.fields):
            continue
        if not fields_conflict(row, existing):
            raise HTTPException(409, "Fields already requested")
        # Retire the conflicted reservation in the successor's transaction.
        now = datetime.now(UTC)
        row.conflicted_at = now
        row.expires_at = min(row.expires_at, now)
    token = "v2_" + secrets.token_urlsafe(32)
    row = VaultSecretRequest(
        vault_id=vault.id,
        project_id=body.project_id,
        section=body.section,
        fields=body.fields,
        field_baselines={
            **{field: field_baseline(item) for field, item in existing.items()},
            **{field: field_baseline(existing.get(field)) for field in body.fields},
        },
        extra_fields=[],
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
            select(VaultSecretRequest.id, VaultSecretRequest.vault_id, Vault.user_id)
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
    # Every mutation locks Vault before request rows, including durable conflict fences.
    await db.execute(select(Vault.id).where(Vault.id == identity.vault_id).with_for_update())
    row = await db.scalar(
        select(VaultSecretRequest)
        .where(VaultSecretRequest.id == identity.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        row is None
        or row.supplied_at is not None
        or row.conflicted_at is not None
        or row.expires_at <= datetime.now(UTC)
    ):
        raise unavailable()
    return row


async def check_selection(
    db: AsyncSession, row: VaultSecretRequest, fields: list[str]
) -> list[str]:
    """Check only selected names against creation state under the Vault lock."""
    chosen = set(row.fields) | set(fields)
    if len(chosen) > 32:
        raise HTTPException(422, "Supply at most 32 fields")
    existing = await load_vault_items_by_name(db, row.vault_id, row.section)
    if any(field_baseline(existing.get(name)) != row.field_baselines.get(name) for name in chosen):
        raise HTTPException(409, "Selected fields changed")
    extras = chosen - set(row.fields)
    if extras:
        pending = (
            await db.scalars(
                select(VaultSecretRequest).where(
                    VaultSecretRequest.vault_id == row.vault_id,
                    VaultSecretRequest.section == row.section,
                    VaultSecretRequest.id != row.id,
                    VaultSecretRequest.supplied_at.is_(None),
                    VaultSecretRequest.conflicted_at.is_(None),
                    VaultSecretRequest.expires_at > datetime.now(UTC),
                )
            )
        ).all()
        if any(
            extras.intersection(other.fields) and not fields_conflict(other, existing)
            for other in pending
        ):
            raise HTTPException(409, "Selected fields already requested")
    return [name for name in fields if row.field_baselines.get(name) is not None]


async def supply(db: AsyncSession, body: VaultSecretRequestSupply) -> VaultSecretRequestStatus:
    try:
        row = await token_request(db, body.token)
        context = await describe(db, row)
        if context.status != "pending":
            raise unavailable()
        requested_fields = list(body.fields)
        if not set(row.fields).issubset(requested_fields):
            raise HTTPException(422, "Supply every requested field")
        await check_selection(db, row, requested_fields)
        existing = await load_vault_items_by_name(
            db, row.vault_id, row.section, lock_fields=requested_fields
        )
        for field in requested_fields:
            ciphertext, nonce = encrypt(body.fields[field])
            item = existing.get(field)
            if item is None:
                db.add(
                    VaultItem(
                        vault_id=row.vault_id,
                        section=row.section,
                        item_name=field,
                        encrypted_value=ciphertext,
                        nonce=nonce,
                    )
                )
            else:
                item.encrypted_value = ciphertext
                item.nonce = nonce
            await db.flush()
        from app.services.runtime_vaults import notify_vault_changed

        await notify_vault_changed(db, row.vault_id, values_changed=True)
        row.extra_fields = [field for field in requested_fields if field not in row.fields]
        row.supplied_at = datetime.now(UTC)
        result = await describe(db, row)
        await db.commit()
        return result
    except DBAPIError as exc:
        await db.rollback()
        # Conflicting writes abort the entire batch; only a successful commit consumes it.
        if isinstance(exc, IntegrityError) or getattr(exc.orig, "sqlstate", None) in {
            "55P03",
            "40P01",
            "40001",
        }:
            raise HTTPException(409, "Requested fields changed") from None
        raise
