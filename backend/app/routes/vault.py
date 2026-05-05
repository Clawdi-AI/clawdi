from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth, require_user_cli
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.core.scope import resolve_default_write_scope, scope_ids_visible_to
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
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(default=None, description="Filter by slug / name"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
) -> Paginated[VaultResponse]:
    # Scope-filter: api_key bound to env A must not see vaults in
    # env B's scope or in Personal. JWT auth sees every scope it
    # owns (dashboard inventory unchanged).
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    base = (
        select(Vault)
        .where(
            Vault.user_id == auth.user_id,
            Vault.scope_id.in_(visible_scope_ids),
        )
        .order_by(Vault.slug)
    )
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
            VaultResponse(
                id=str(v.id),
                slug=v.slug,
                name=v.name,
                scope_id=str(v.scope_id),
                created_at=v.created_at,
            )
            for v in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("")
async def create_vault(
    body: VaultCreate,
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultCreatedResponse:
    # Phase-1 scope shim: vault writes inherit the caller's resolved
    # default scope. Vault items inherit through the parent vault
    # (no separate scope_id on items) so this single resolution
    # covers both rows and prevents the "item says A, vault says B"
    # invalid state.
    scope_id = await resolve_default_write_scope(db, auth)

    # Slug uniqueness is per (user_id, scope_id, slug) — different
    # scopes can hold the same slug. Pre-flight check is per scope
    # so the 409 message is precise about WHERE the conflict is.
    existing_result = await db.execute(
        select(Vault).where(
            Vault.user_id == auth.user_id,
            Vault.scope_id == scope_id,
            Vault.slug == body.slug,
        )
    )
    existing = existing_result.scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "vault_slug_conflict",
                "message": f"Vault '{body.slug}' already exists in this scope",
                "scope_id": str(scope_id),
            },
        )

    vault = Vault(
        user_id=auth.user_id,
        scope_id=scope_id,
        slug=body.slug,
        name=body.name,
    )
    db.add(vault)
    await db.commit()
    await db.refresh(vault)
    return VaultCreatedResponse(id=str(vault.id), slug=vault.slug)


@router.delete("/{slug}")
async def delete_vault(
    slug: str,
    scope_id: UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultDeleteResponse:
    # Reuse the scope-filtered vault lookup so a daemon key bound
    # to env A can't delete a vault that lives in env B's scope.
    # `scope_id` disambiguates when a JWT user has the same slug
    # in multiple scopes (Personal + env-A); without it, a multi-
    # match raises 409 ambiguous_vault_slug rather than silently
    # picking the most-recently-updated.
    vault = await _get_vault(auth, slug, db, scope_id=scope_id)
    await db.delete(vault)
    await db.commit()
    return VaultDeleteResponse(status="deleted")


# --- Vault Items ---


@router.get("/{slug}/items")
async def list_vault_sections(
    slug: str,
    scope_id: UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultSectionsResponse:
    vault = await _get_vault(auth, slug, db, scope_id=scope_id)
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
    scope_id: UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsUpsertResponse:
    vault = await _get_vault(auth, slug, db, scope_id=scope_id)
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
    scope_id: UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsDeleteResponse:
    vault = await _get_vault(auth, slug, db, scope_id=scope_id)
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
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> VaultResolveResponse:
    """Resolve all vault items to plaintext. CLI-only (requires ApiKey auth).

    Scope-filtered: an api_key bound to env A only sees vaults in
    that env's scope. Without this filter a leaked daemon key
    could decrypt vaults belonging to Personal or to another env.
    """
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    result = await db.execute(
        select(Vault).where(
            Vault.user_id == auth.user_id,
            Vault.scope_id.in_(visible_scope_ids),
        )
    )
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


async def _get_vault(
    auth: AuthContext,
    slug: str,
    db: AsyncSession,
    *,
    scope_id: UUID | None = None,
) -> Vault:
    """Fetch a vault by slug, scope-filtered to what the caller can
    see. api_key bound to env A → only vaults in that env's scope.
    JWT → any scope the user owns. Without the filter, a daemon
    key could read items in another scope's vault by guessing the
    slug.

    Disambiguation:
      - `scope_id` explicit: must be visible to caller; exact match.
      - Single match in visible scopes: returned.
      - Multiple matches AND no `scope_id`: 409 ambiguous_vault_slug.

    Bound api_keys only see one scope, so the multi-match path can
    only fire for JWT or unbound CLI callers. Previously the code
    silently picked the most-recently-updated row, which let a
    dashboard mutation land in the WRONG scope's vault when a JWT
    user happened to hold the same slug in two scopes — items
    listing could read or mutate items in the older scope.
    """
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    base_q = select(Vault).where(
        Vault.user_id == auth.user_id,
        Vault.scope_id.in_(visible_scope_ids),
        Vault.slug == slug,
    )
    if scope_id is not None:
        # Caller pinned a scope. If it's outside their visibility
        # we report 404 (same as if the vault didn't exist) rather
        # than leaking that the scope ID is real but inaccessible.
        if scope_id not in visible_scope_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
        base_q = base_q.where(Vault.scope_id == scope_id)
    rows = (await db.execute(base_q)).scalars().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
    if len(rows) > 1:
        # Ambiguous slug across multiple visible scopes. Refuse
        # rather than pick one — the dashboard or CLI must pass
        # `scope_id` to disambiguate. The error body lists the
        # candidate scope_ids so the client can prompt the user.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "ambiguous_vault_slug",
                "message": (
                    f"Vault '{slug}' exists in multiple scopes; "
                    "specify scope_id query param to disambiguate."
                ),
                "scope_ids": [str(r.scope_id) for r in rows],
            },
        )
    return rows[0]
