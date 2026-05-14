from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth, require_user_cli
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.core.scope import resolve_default_write_scope, resolve_for_parent, scope_ids_visible_to
from app.models.project import Project
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
    project_id: UUID | None = Query(
        default=None,
        description="Optional project filter.",
    ),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
) -> Paginated[VaultResponse]:
    # Project-filter: api_key bound to env A must not see vaults in
    # env B's scope or in Personal. JWT + unbound CLI see every scope
    # they own AND every shared-scope membership they hold.
    #
    # Dropped the `Vault.user_id == auth.user_id` filter that was
    # here pre-sharing — it would have blocked viewer members from
    # seeing shared-scope vault slugs (and the key names inside).
    # Plaintext resolution (`/api/vault/resolve`) keeps the
    # Clerk-auth-only gate so a leaked anonymous share-token can't
    # exfiltrate secrets.
    selected_project_id = project_id or scope_id
    if selected_project_id is not None:
        visible_scope_ids = list(await resolve_for_parent(db, auth, selected_project_id))
    else:
        visible_scope_ids = await scope_ids_visible_to(db, auth)
    base = (
        select(Vault)
        .where(
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
                project_id=str(v.scope_id),
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
    project_id: UUID | None = Query(default=None),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultCreatedResponse:
    # Phase-1 scope shim: vault writes inherit the caller's resolved
    # default scope when no explicit `?scope_id=` is passed. Vault
    # items inherit through the parent vault (no separate scope_id
    # on items) so this single resolution covers both rows and
    # prevents the "item says A, vault says B" invalid state.
    #
    # When `scope_id` IS passed, validate it belongs to the caller
    # (write access — the unwidened owner-only validator), so a
    # sharee viewer can't sneak vault items into someone else's
    # scope via the explicit path.
    selected_project_id = project_id or scope_id
    if selected_project_id is not None:
        from app.core.scope import validate_scope_for_caller

        await validate_scope_for_caller(db, auth, selected_project_id)
    else:
        selected_project_id = await resolve_default_write_scope(db, auth)

    # Slug uniqueness is per (user_id, scope_id, slug) — different
    # scopes can hold the same slug. Pre-flight check is per scope
    # so the 409 message is precise about WHERE the conflict is.
    existing_result = await db.execute(
        select(Vault).where(
            Vault.user_id == auth.user_id,
            Vault.scope_id == selected_project_id,
            Vault.slug == body.slug,
        )
    )
    existing = existing_result.scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "vault_slug_conflict",
                "message": f"Vault '{body.slug}' already exists in this project",
                "project_id": str(selected_project_id),
            },
        )

    vault = Vault(
        user_id=auth.user_id,
        scope_id=selected_project_id,
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
    project_id: UUID | None = Query(default=None),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultDeleteResponse:
    # Reuse the scope-filtered vault lookup so a daemon key bound
    # to env A can't delete a vault that lives in env B's scope.
    # `scope_id` disambiguates when a JWT user has the same slug
    # in multiple scopes (Personal + env-A); without it, a multi-
    # match raises 409 ambiguous_vault_slug rather than silently
    # picking the most-recently-updated.
    vault = await _get_vault_write(auth, slug, db, project_id=project_id or scope_id)
    await db.delete(vault)
    await db.commit()
    return VaultDeleteResponse(status="deleted")


# --- Vault Items ---


@router.get("/{slug}/items")
async def list_vault_sections(
    slug: str,
    project_id: UUID | None = Query(default=None),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultSectionsResponse:
    vault = await _get_vault(auth, slug, db, project_id=project_id or scope_id)
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
    project_id: UUID | None = Query(default=None),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsUpsertResponse:
    vault = await _get_vault_write(auth, slug, db, project_id=project_id or scope_id)
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
    project_id: UUID | None = Query(default=None),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsDeleteResponse:
    vault = await _get_vault_write(auth, slug, db, project_id=project_id or scope_id)
    existing_by_name = await _load_items_by_name(db, vault.id, body.section)

    for field_name in body.fields:
        item = existing_by_name.get(field_name)
        if item:
            await db.delete(item)

    await db.commit()
    return VaultItemsDeleteResponse(status="deleted")


# --- Resolve (CLI only — returns plaintext values) ---


def _env_key(section: str, item_name: str) -> str:
    return f"{section}_{item_name}".upper() if section else item_name.upper()


async def _project_precedence(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
) -> list[dict]:
    """Return a one-project precedence chain for vault resolution."""
    visible = set(await scope_ids_visible_to(db, auth))
    if project_id not in visible:
        return []

    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        return []

    return [
        {
            "project_id": project.id,
            "alias": project.slug,
            "display": project.name,
        }
    ]


@router.post("/resolve", responses={200: {"model": VaultResolveResponse}})
async def resolve_vault(
    key: str | None = Query(default=None),
    project_id: UUID | None = Query(
        default=None,
        description="Project to resolve from (default: caller write project).",
    ),
    scope_id: UUID | None = Query(default=None, include_in_schema=False),
    debug: bool = Query(default=False),
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Resolve all vault items to plaintext. CLI-only (requires ApiKey auth).

    Project-filtered: an api_key bound to env A only sees vaults in
    that env's scope. Without this filter a leaked daemon key
    could decrypt vaults belonging to Personal or to another env.
    """
    selected_project_id = project_id or scope_id or await resolve_default_write_scope(db, auth)
    ordered = await _project_precedence(db, auth, selected_project_id)
    if not ordered:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    effective_project_ids = [entry["project_id"] for entry in ordered]

    if key is not None:
        wanted = key.upper()
        precedence: list[dict] = []
        winner: dict | None = None
        for entry in ordered:
            vaults = (
                (await db.execute(select(Vault).where(Vault.scope_id == entry["project_id"])))
                .scalars()
                .all()
            )
            hit_item: VaultItem | None = None
            hit_vault: Vault | None = None
            for vault in vaults:
                items = (
                    (await db.execute(select(VaultItem).where(VaultItem.vault_id == vault.id)))
                    .scalars()
                    .all()
                )
                for item in items:
                    if _env_key(item.section, item.item_name) == wanted:
                        hit_item = item
                        hit_vault = vault
                        break
                if hit_item is not None:
                    break

            entry_debug = {
                "project_id": str(entry["project_id"]),
                "alias": entry["alias"],
                "hit": hit_item is not None,
                "reason": "match" if hit_item is not None and winner is None else "not-found",
            }
            if hit_item is not None and winner is not None:
                entry_debug["reason"] = "skipped"
            precedence.append(entry_debug)

            if hit_item is not None and winner is None:
                winner = {
                    "value": decrypt(hit_item.encrypted_value, hit_item.nonce),
                    "source_project_id": str(entry["project_id"]),
                    "source_alias": entry["alias"],
                    "vault_slug": hit_vault.slug if hit_vault else None,
                    "section": hit_item.section,
                    "item_name": hit_item.item_name,
                }

        if winner is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail={"code": "vault_key_not_found", "key": key, "precedence": precedence},
            )

        response = {"key": key, **winner}
        if debug:
            response["precedence"] = precedence
        return response

    result = await db.execute(
        select(Vault).where(
            Vault.scope_id.in_(effective_project_ids),
        )
    )
    vaults = result.scalars().all()

    env: dict[str, str] = {}
    for vault in vaults:
        items_result = await db.execute(select(VaultItem).where(VaultItem.vault_id == vault.id))
        for item in items_result.scalars().all():
            plaintext = decrypt(item.encrypted_value, item.nonce)
            # Build env var name: SECTION_FIELDNAME (uppercase)
            env[_env_key(item.section, item.item_name)] = plaintext

    return env


async def _get_vault_write(
    auth: AuthContext,
    slug: str,
    db: AsyncSession,
    *,
    project_id: UUID | None = None,
) -> Vault:
    """Fetch a vault for mutation, restricted to caller-owned scopes.

    Shared memberships can read vault metadata, but they never grant
    mutation rights. Write paths therefore use an owner-only scope
    inventory instead of `_get_vault`'s visibility set, while still
    preserving env-bound api_key blast-radius limits.
    """
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        owned_scope_ids = [await resolve_default_write_scope(db, auth)]
    else:
        owned_scope_ids = (
            (await db.execute(select(Project.id).where(Project.user_id == auth.user_id)))
            .scalars()
            .all()
        )
    base_q = select(Vault).where(
        Vault.scope_id.in_(owned_scope_ids),
        Vault.slug == slug,
    )
    if project_id is not None:
        if project_id not in owned_scope_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
        base_q = base_q.where(Vault.scope_id == project_id)
    rows = (await db.execute(base_q)).scalars().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
    if len(rows) > 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "ambiguous_vault_slug",
                "message": (
                    f"Vault '{slug}' exists in multiple owned projects; "
                    "specify project_id query param to disambiguate."
                ),
                "project_ids": [str(r.scope_id) for r in rows],
            },
        )
    return rows[0]


async def _get_vault(
    auth: AuthContext,
    slug: str,
    db: AsyncSession,
    *,
    project_id: UUID | None = None,
) -> Vault:
    """Fetch a vault by slug, project-filtered to what the caller can
    see. api_key bound to env A -> only vaults in that env's project.
    JWT -> any project the user can see. Without the filter, a daemon
    key could read items in another project's vault by guessing the
    slug.

    Disambiguation:
      - `project_id` explicit: must be visible to caller; exact match.
      - Single match in visible projects: returned.
      - Multiple matches AND no explicit project: 409 ambiguous_vault_slug.

    Bound api_keys only see one project, so the multi-match path can
    only fire for JWT or unbound CLI callers. Previously the code
    silently picked the most-recently-updated row, which let a
    dashboard mutation land in the wrong project's vault when a JWT
    user happened to hold the same slug in two projects.
    """
    # No `Vault.user_id == auth.user_id` filter — visibility comes
    # from scope_ids_visible_to which already accounts for owned +
    # shared-membership projects. Sharee viewers need to read vault
    # metadata for projects they joined; plaintext resolution is a
    # separate endpoint with its own auth contract.
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    base_q = select(Vault).where(
        Vault.scope_id.in_(visible_scope_ids),
        Vault.slug == slug,
    )
    if project_id is not None:
        # Caller pinned a project. If it's outside their visibility
        # we report 404 (same as if the vault didn't exist) rather
        # than leaking that the project ID is real but inaccessible.
        if project_id not in visible_scope_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
        base_q = base_q.where(Vault.scope_id == project_id)
    rows = (await db.execute(base_q)).scalars().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
    if len(rows) > 1:
        # Ambiguous slug across multiple visible projects. Refuse
        # rather than pick one — the dashboard or CLI must pass
        # `project_id` to disambiguate. The error body lists the
        # candidate project IDs so the client can prompt the user.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "ambiguous_vault_slug",
                "message": (
                    f"Vault '{slug}' exists in multiple projects; "
                    "specify project_id query param to disambiguate."
                ),
                "project_ids": [str(r.scope_id) for r in rows],
            },
        )
    return rows[0]
