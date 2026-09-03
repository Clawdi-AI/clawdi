from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.core.auth import AuthContext, is_env_bound_api_key
from app.core.project import (
    project_ids_owned_by_user,
    resolve_default_write_project,
    validate_project_for_caller,
)
from app.models.vault import (
    Vault,
    VaultItem,
    VaultProjectAttachment,
    VaultProjectSlugAlias,
)
from app.schemas.vault import VaultCreate, VaultItemDelete, VaultItemUpsert
from app.services.vault_crypto import encrypt


class VaultItemsGlobalDeleteConfirmationRequired(Exception):
    def __init__(self, project_count: int) -> None:
        super().__init__("Vault item deletion requires global confirmation")
        self.project_count = project_count


def ambiguous_vault_detail(
    *, slug: str, project_id: UUID | None, exact_reference: bool = False
) -> dict[str, str | None]:
    return {
        "code": "ambiguous_vault_reference_slug" if exact_reference else "ambiguous_vault_slug",
        "message": f"Vault slug '{slug}' identifies multiple Vaults in the requested scope.",
        "project_id": str(project_id) if project_id is not None else None,
        "vault_slug": slug,
    }


def vault_project_slug_alias_condition() -> ColumnElement[bool]:
    return (VaultProjectSlugAlias.vault_id == Vault.id) & (
        VaultProjectSlugAlias.project_id == VaultProjectAttachment.project_id
    )


def vault_slug_or_alias_clause(slug: str) -> ColumnElement[bool]:
    return or_(Vault.slug == slug, VaultProjectSlugAlias.slug == slug)


async def create_account_vault(
    db: AsyncSession,
    auth: AuthContext,
    body: VaultCreate,
    *,
    project_id: UUID | None,
    create_only: bool,
) -> Vault:
    selected_project_id = project_id
    if selected_project_id is not None:
        await validate_project_for_caller(db, auth, selected_project_id)
    elif not create_only:
        selected_project_id = await resolve_default_write_project(db, auth)

    vault = (
        await db.execute(
            select(Vault).where(
                Vault.user_id == auth.user_id,
                Vault.slug == body.slug,
            )
        )
    ).scalar_one_or_none()
    if vault is not None and create_only:
        raise HTTPException(status.HTTP_409_CONFLICT, "Vault slug already exists")
    if vault is None:
        vault = Vault(user_id=auth.user_id, slug=body.slug, name=body.name)
        db.add(vault)
        await db.flush()

    if selected_project_id is not None:
        await _ensure_vault_attached(db, vault.id, selected_project_id)
    await db.commit()
    await db.refresh(vault)
    return vault


async def get_vault_for_write(
    db: AsyncSession,
    auth: AuthContext,
    slug: str,
    *,
    project_id: UUID | None = None,
    vault_id: UUID | None = None,
) -> Vault:
    """Resolve an account-owned Vault inside the caller's write boundary."""
    if is_env_bound_api_key(auth):
        owned_project_ids = [await resolve_default_write_project(db, auth)]
    else:
        owned_project_ids = await project_ids_owned_by_user(db, auth.user_id)
    base_q = select(Vault).where(Vault.user_id == auth.user_id, Vault.slug == slug)
    if vault_id is not None:
        base_q = base_q.where(Vault.id == vault_id)
    if project_id is not None:
        if project_id not in owned_project_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
        base_q = (
            select(Vault)
            .join(
                VaultProjectAttachment,
                VaultProjectAttachment.vault_id == Vault.id,
            )
            .outerjoin(
                VaultProjectSlugAlias,
                vault_project_slug_alias_condition(),
            )
            .where(
                Vault.user_id == auth.user_id,
                Vault.id == vault_id if vault_id is not None else true(),
                VaultProjectAttachment.project_id == project_id,
                Vault.slug == slug if vault_id is not None else vault_slug_or_alias_clause(slug),
            )
            .distinct()
        )
    elif is_env_bound_api_key(auth):
        base_q = (
            select(Vault)
            .join(
                VaultProjectAttachment,
                VaultProjectAttachment.vault_id == Vault.id,
            )
            .outerjoin(
                VaultProjectSlugAlias,
                vault_project_slug_alias_condition(),
            )
            .where(
                Vault.user_id == auth.user_id,
                Vault.id == vault_id if vault_id is not None else true(),
                VaultProjectAttachment.project_id.in_(owned_project_ids),
                Vault.slug == slug if vault_id is not None else vault_slug_or_alias_clause(slug),
            )
            .distinct()
        )
    rows = (await db.execute(base_q)).scalars().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
    if len(rows) > 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=ambiguous_vault_detail(slug=slug, project_id=project_id),
        )
    return rows[0]


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

    await db.commit()
    return len(items_to_delete)


async def _ensure_vault_attached(
    db: AsyncSession,
    vault_id: UUID,
    project_id: UUID,
) -> None:
    existing = (
        await db.execute(
            select(VaultProjectAttachment.id).where(
                VaultProjectAttachment.vault_id == vault_id,
                VaultProjectAttachment.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(VaultProjectAttachment(vault_id=vault_id, project_id=project_id))


async def _vault_project_count(db: AsyncSession, vault_id: UUID) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(VaultProjectAttachment)
            .where(VaultProjectAttachment.vault_id == vault_id)
        )
    ).scalar_one()
