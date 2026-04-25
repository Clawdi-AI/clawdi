from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth, require_cli_auth
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.vault import Vault, VaultItem
from app.schemas.common import Paginated
from app.schemas.vault import (
    VaultCreate,
    VaultCreatedResponse,
    VaultDeleteResponse,
    VaultItemDelete,
    VaultItemsDeleteResponse,
    VaultItemsUpsertResponse,
    VaultItemUpsert,
    VaultResolveResponse,
    VaultResponse,
    VaultSectionsResponse,
)
from app.services.vault_crypto import decrypt, encrypt

router = APIRouter(prefix="/api/vault", tags=["vault"])


# --- Vault CRUD ---


@router.get("")
async def list_vaults(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(default=None, description="Filter by slug / name"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
) -> Paginated[VaultResponse]:
    base = select(Vault).where(Vault.user_id == auth.user_id).order_by(Vault.slug)
    if q:
        needle = like_needle(q)
        base = base.where(
            or_(
                Vault.slug.ilike(needle, escape="\\"),
                Vault.name.ilike(needle, escape="\\"),
            )
        )

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    rows = (await db.execute(base.limit(page_size).offset((page - 1) * page_size))).scalars().all()
    return Paginated[VaultResponse](
        items=[
            VaultResponse(id=str(v.id), slug=v.slug, name=v.name, created_at=v.created_at)
            for v in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("")
async def create_vault(
    body: VaultCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultCreatedResponse:
    existing = await db.execute(
        select(Vault).where(Vault.user_id == auth.user_id, Vault.slug == body.slug)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, f"Vault '{body.slug}' already exists")

    vault = Vault(user_id=auth.user_id, slug=body.slug, name=body.name)
    db.add(vault)
    await db.commit()
    await db.refresh(vault)
    return VaultCreatedResponse(id=str(vault.id), slug=vault.slug)


@router.delete("/{slug}")
async def delete_vault(
    slug: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultDeleteResponse:
    result = await db.execute(
        select(Vault).where(Vault.user_id == auth.user_id, Vault.slug == slug)
    )
    vault = result.scalar_one_or_none()
    if not vault:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vault not found")

    await db.delete(vault)
    await db.commit()
    return VaultDeleteResponse(status="deleted")


# --- Vault Items ---


@router.get("/{slug}/items")
async def list_vault_sections(
    slug: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultSectionsResponse:
    vault = await _get_vault(auth.user_id, slug, db)
    result = await db.execute(
        select(VaultItem.section, VaultItem.item_name)
        .where(VaultItem.vault_id == vault.id)
        .order_by(VaultItem.section, VaultItem.item_name)
    )
    items = {}
    for section, item_name in result.all():
        items.setdefault(section or "(default)", []).append(item_name)
    return VaultSectionsResponse(items)


async def _load_items_by_name(db: AsyncSession, vault_id, section: str) -> dict[str, VaultItem]:
    """Batch-prefetch all vault items for a vault+section keyed by item_name."""
    result = await db.execute(
        select(VaultItem).where(
            VaultItem.vault_id == vault_id,
            VaultItem.section == section,
        )
    )
    return {item.item_name: item for item in result.scalars().all()}


@router.put("/{slug}/items")
async def upsert_vault_items(
    slug: str,
    body: VaultItemUpsert,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsUpsertResponse:
    vault = await _get_vault(auth.user_id, slug, db)
    existing_by_name = await _load_items_by_name(db, vault.id, body.section)

    for field_name, plaintext in body.fields.items():
        ciphertext, nonce = encrypt(plaintext)
        item = existing_by_name.get(field_name)
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
    return VaultItemsUpsertResponse(status="ok", fields=len(body.fields))


@router.delete("/{slug}/items")
async def delete_vault_items(
    slug: str,
    body: VaultItemDelete,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsDeleteResponse:
    vault = await _get_vault(auth.user_id, slug, db)
    existing_by_name = await _load_items_by_name(db, vault.id, body.section)

    for field_name in body.fields:
        item = existing_by_name.get(field_name)
        if item:
            await db.delete(item)

    await db.commit()
    return VaultItemsDeleteResponse(status="deleted")


# --- Resolve (CLI only — returns plaintext values) ---


@router.post("/resolve")
async def resolve_vault(
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultResolveResponse:
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

    return VaultResolveResponse(env)


async def _get_vault(user_id, slug: str, db: AsyncSession) -> Vault:
    result = await db.execute(select(Vault).where(Vault.user_id == user_id, Vault.slug == slug))
    vault = result.scalar_one_or_none()
    if not vault:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
    return vault
