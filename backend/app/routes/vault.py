from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_cli_auth
from app.core.database import get_session
from app.models.vault import Vault, VaultItem
from app.services.vault_crypto import decrypt, encrypt

router = APIRouter(prefix="/api/vault", tags=["vault"])


class VaultCreate(BaseModel):
    slug: str
    name: str


class VaultItemUpsert(BaseModel):
    section: str = ""
    fields: dict[str, str]  # field_name → plaintext value


class VaultItemDelete(BaseModel):
    section: str = ""
    fields: list[str]


# --- Vault CRUD ---


@router.get("")
async def list_vaults(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Vault).where(Vault.user_id == auth.user_id).order_by(Vault.slug)
    )
    return [
        {"id": str(v.id), "slug": v.slug, "name": v.name, "created_at": v.created_at.isoformat()}
        for v in result.scalars().all()
    ]


@router.post("")
async def create_vault(
    body: VaultCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    existing = await db.execute(
        select(Vault).where(Vault.user_id == auth.user_id, Vault.slug == body.slug)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, f"Vault '{body.slug}' already exists")

    vault = Vault(user_id=auth.user_id, slug=body.slug, name=body.name)
    db.add(vault)
    await db.commit()
    await db.refresh(vault)
    return {"id": str(vault.id), "slug": vault.slug}


@router.delete("/{slug}")
async def delete_vault(
    slug: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Vault).where(Vault.user_id == auth.user_id, Vault.slug == slug)
    )
    vault = result.scalar_one_or_none()
    if not vault:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vault not found")

    await db.delete(vault)
    await db.commit()
    return {"status": "deleted"}


# --- Vault Items ---


@router.get("/{slug}/items")
async def list_vault_sections(
    slug: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    vault = await _get_vault(auth.user_id, slug, db)
    result = await db.execute(
        select(VaultItem.section, VaultItem.item_name)
        .where(VaultItem.vault_id == vault.id)
        .order_by(VaultItem.section, VaultItem.item_name)
    )
    items = {}
    for section, item_name in result.all():
        items.setdefault(section or "(default)", []).append(item_name)
    return items


@router.put("/{slug}/items")
async def upsert_vault_items(
    slug: str,
    body: VaultItemUpsert,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    vault = await _get_vault(auth.user_id, slug, db)
    for field_name, plaintext in body.fields.items():
        ciphertext, nonce = encrypt(plaintext)
        existing = await db.execute(
            select(VaultItem).where(
                VaultItem.vault_id == vault.id,
                VaultItem.section == body.section,
                VaultItem.item_name == field_name,
            )
        )
        item = existing.scalar_one_or_none()
        if item:
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
    return {"status": "ok", "fields": len(body.fields)}


@router.delete("/{slug}/items")
async def delete_vault_items(
    slug: str,
    body: VaultItemDelete,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    vault = await _get_vault(auth.user_id, slug, db)
    for field_name in body.fields:
        result = await db.execute(
            select(VaultItem).where(
                VaultItem.vault_id == vault.id,
                VaultItem.section == body.section,
                VaultItem.item_name == field_name,
            )
        )
        item = result.scalar_one_or_none()
        if item:
            await db.delete(item)

    await db.commit()
    return {"status": "deleted"}


# --- Resolve (CLI only — returns plaintext values) ---


@router.post("/resolve")
async def resolve_vault(
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
):
    """Resolve all vault items to plaintext. CLI-only (requires ApiKey auth)."""
    result = await db.execute(select(Vault).where(Vault.user_id == auth.user_id))
    vaults = result.scalars().all()

    env: dict[str, str] = {}
    for vault in vaults:
        items_result = await db.execute(select(VaultItem).where(VaultItem.vault_id == vault.id))
        for item in items_result.scalars().all():
            plaintext = decrypt(item.encrypted_value, item.nonce)
            # Build env var name: SECTION_FIELDNAME (uppercase)
            if item.section:
                key = f"{item.section}_{item.item_name}".upper()
            else:
                key = item.item_name.upper()
            env[key] = plaintext

    return env


async def _get_vault(user_id, slug: str, db: AsyncSession) -> Vault:
    result = await db.execute(select(Vault).where(Vault.user_id == user_id, Vault.slug == slug))
    vault = result.scalar_one_or_none()
    if not vault:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
    return vault
