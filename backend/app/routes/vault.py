from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_user_auth, require_user_cli
from app.core.database import get_session
from app.core.project import (
    project_ids_readable_by_user,
    project_ids_visible_to,
    resolve_default_write_project,
    resolve_for_parent,
    resolve_personal_project,
    validate_project_for_caller,
)
from app.core.query_utils import like_needle
from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import Project
from app.models.vault import Vault, VaultCredentialProfile, VaultItem
from app.schemas.common import Paginated
from app.schemas.vault import (
    VaultCreate,
    VaultCreatedResponse,
    VaultCredentialProfileResolveRequest,
    VaultCredentialProfileResolveResponse,
    VaultCredentialProfileResponse,
    VaultCredentialProfileUpsert,
    VaultDeleteResponse,
    VaultItemDelete,
    VaultItemsDeleteResponse,
    VaultItemsUpsertResponse,
    VaultItemUpsert,
    VaultResolveResponse,
    VaultResponse,
    VaultSectionsResponse,
)
from app.services.agent_bindings import get_owned_agent_or_404
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
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
) -> Paginated[VaultResponse]:
    # Project-filter: an Agent API key for Agent A must not see vaults in
    # Agent B's project or in Personal. JWT + unbound CLI see every project
    # they own AND every shared-project membership they hold.
    #
    # Dropped the `Vault.user_id == auth.user_id` filter that was
    # here pre-sharing — it would have blocked viewer members from
    # seeing shared-project vault slugs (and the key names inside).
    # Plaintext resolution (`/api/vault/resolve`) keeps the CLI/API-key
    # gate so a leaked anonymous share-token can't exfiltrate secrets.
    selected_project_id = project_id
    if selected_project_id is not None:
        visible_project_ids = list(await resolve_for_parent(db, auth, selected_project_id))
    else:
        visible_project_ids = await project_ids_visible_to(db, auth)
    base = (
        select(Vault)
        .where(
            Vault.project_id.in_(visible_project_ids),
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
                project_id=str(v.project_id),
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
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultCreatedResponse:
    # Phase-1 project shim: vault writes inherit the caller's resolved
    # default project when no explicit `?project_id=` is passed. Vault
    # items inherit through the parent vault (no separate project_id
    # on items) so this single resolution covers both rows and
    # prevents the "item says A, vault says B" invalid state.
    #
    # When `project_id` IS passed, validate it belongs to the caller
    # (write access — the unwidened owner-only validator), so a
    # recipient viewer can't sneak vault items into someone else's
    # project via the explicit path.
    selected_project_id = project_id
    if selected_project_id is not None:
        await validate_project_for_caller(db, auth, selected_project_id)
    else:
        selected_project_id = await resolve_default_write_project(db, auth)

    # Slug uniqueness is per (user_id, project_id, slug) — different
    # projects can hold the same slug. Pre-flight check is per project
    # so the 409 message is precise about WHERE the conflict is.
    existing_result = await db.execute(
        select(Vault).where(
            Vault.user_id == auth.user_id,
            Vault.project_id == selected_project_id,
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
        project_id=selected_project_id,
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
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultDeleteResponse:
    # Reuse the project-filtered vault lookup so a daemon key bound
    # to Agent A can't delete a vault that lives in Agent B's project.
    # `project_id` disambiguates when a JWT user has the same slug
    # in multiple projects (Personal + Agent A); without it, a multi-
    # match raises 409 ambiguous_vault_slug rather than silently
    # picking the most-recently-updated.
    vault = await _get_vault_write(auth, slug, db, project_id=project_id)
    await db.delete(vault)
    await db.commit()
    return VaultDeleteResponse(status="deleted")


# --- Vault Items ---


@router.get("/{slug}/items")
async def list_vault_sections(
    slug: str,
    project_id: UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultSectionsResponse:
    vault = await _get_vault(auth, slug, db, project_id=project_id)
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
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsUpsertResponse:
    vault = await _get_vault_write(auth, slug, db, project_id=project_id)
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
    auth: AuthContext = Depends(require_user_auth),
    db: AsyncSession = Depends(get_session),
) -> VaultItemsDeleteResponse:
    vault = await _get_vault_write(auth, slug, db, project_id=project_id)
    existing_by_name = await _load_items_by_name(db, vault.id, body.section)

    for field_name in body.fields:
        item = existing_by_name.get(field_name)
        if item:
            await db.delete(item)

    await db.commit()
    return VaultItemsDeleteResponse(status="deleted")


# --- Credential profiles (CLI auth/config file sync; not env injection) ---


@router.post("/credential-profiles")
async def upsert_credential_profile(
    body: VaultCredentialProfileUpsert,
    project_id: UUID | None = Query(default=None),
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> VaultCredentialProfileResponse:
    """Store an encrypted local CLI credential profile.

    Credential profiles are deliberately separate from `vault_items`: they
    should not be returned by `/api/vault/resolve` all-env injection. The CLI
    materializes them back to tool-specific local files instead.
    """
    _require_user_level_credential_profile_auth(auth)
    if project_id is not None:
        await validate_project_for_caller(db, auth, project_id)
        selected_project_id = project_id
    else:
        selected_project_id = await resolve_personal_project(db, auth)

    ciphertext, nonce = encrypt(body.payload)
    existing = (
        await db.execute(
            select(VaultCredentialProfile).where(
                VaultCredentialProfile.user_id == auth.user_id,
                VaultCredentialProfile.project_id == selected_project_id,
                VaultCredentialProfile.tool == body.tool,
                VaultCredentialProfile.profile == body.profile,
            )
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.encrypted_payload = ciphertext
        existing.nonce = nonce
        profile = existing
    else:
        profile = VaultCredentialProfile(
            user_id=auth.user_id,
            project_id=selected_project_id,
            tool=body.tool,
            profile=body.profile,
            encrypted_payload=ciphertext,
            nonce=nonce,
        )
        db.add(profile)

    await db.commit()
    await db.refresh(profile)
    return VaultCredentialProfileResponse(
        id=str(profile.id),
        project_id=str(profile.project_id),
        tool=profile.tool,
        profile=profile.profile,
        updated_at=profile.updated_at,
    )


@router.post("/credential-profiles/resolve")
async def resolve_credential_profile(
    body: VaultCredentialProfileResolveRequest,
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> VaultCredentialProfileResolveResponse:
    """Resolve one local CLI credential profile for materialization.

    Plaintext is restricted to CLI auth, matching `/api/vault/resolve`.
    """
    _require_user_level_credential_profile_auth(auth)
    if body.project_id is not None:
        await validate_project_for_caller(db, auth, body.project_id)
        selected_project_id = body.project_id
    else:
        selected_project_id = await resolve_personal_project(db, auth)

    profile = (
        await db.execute(
            select(VaultCredentialProfile).where(
                VaultCredentialProfile.user_id == auth.user_id,
                VaultCredentialProfile.project_id == selected_project_id,
                VaultCredentialProfile.tool == body.tool,
                VaultCredentialProfile.profile == body.profile,
            )
        )
    ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "credential profile not found")

    return VaultCredentialProfileResolveResponse(
        id=str(profile.id),
        project_id=str(profile.project_id),
        tool=profile.tool,
        profile=profile.profile,
        updated_at=profile.updated_at,
        payload=decrypt(profile.encrypted_payload, profile.nonce),
    )


def _require_user_level_credential_profile_auth(auth: AuthContext) -> None:
    """Credential profiles are personal backup/restore, not Agent runtime grants."""
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "credential profile sync requires user-level CLI authentication",
        )


# --- Resolve (CLI only — returns plaintext values) ---


def _env_key(section: str, item_name: str) -> str:
    return f"{section}_{item_name}".upper() if section else item_name.upper()


async def _plaintext_project_ids(db: AsyncSession, auth: AuthContext) -> list[UUID]:
    """Projects whose vault plaintext may be resolved by this CLI caller.

    User-level CLI auth can read vault plaintext for every Project the
    account can read, including shared Projects. Env-bound Agent keys stay
    capped to their default Project unless the caller resolves through the
    matching Agent runtime boundary (`agent_id`), where explicit Project
    attachments define the read set.
    """
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        return [await resolve_default_write_project(db, auth)]

    return await project_ids_readable_by_user(db, auth.user_id)


async def _project_precedence(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
) -> list[dict]:
    """Return a one-project precedence chain for vault resolution."""
    allowed = set(await _plaintext_project_ids(db, auth))
    if project_id not in allowed:
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
            "binding_type": "project",
            "priority": 0,
        }
    ]


async def _agent_project_precedence(
    db: AsyncSession,
    auth: AuthContext,
    agent_id: UUID,
) -> list[dict]:
    """Return an agent's primary + context projects in runtime order."""
    if (
        auth.is_cli
        and auth.api_key is not None
        and auth.api_key.environment_id is not None
        and auth.api_key.environment_id != agent_id
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "api key bound to a different agent")

    agent = await get_owned_agent_or_404(db, user_id=auth.user_id, agent_id=agent_id)
    # Agent runtime reads are computed at the Agent boundary: the key
    # must either be user-level or bound to this exact Agent, then the
    # explicit primary/context bindings decide which Projects participate.
    # This lets attached shared Projects contribute vault env values while
    # preserving the bound-key blast radius: no attachment, no access.
    allowed = set(await project_ids_readable_by_user(db, auth.user_id))
    rows = (
        await db.execute(
            select(AgentProjectBinding, Project)
            .join(Project, Project.id == AgentProjectBinding.project_id)
            .where(AgentProjectBinding.agent_id == agent_id)
            .order_by(
                case((AgentProjectBinding.binding_type == "primary", 0), else_=1),
                AgentProjectBinding.priority.asc(),
                AgentProjectBinding.created_at.asc(),
            )
        )
    ).all()

    entries: list[dict] = []
    has_primary = False
    for binding, project in rows:
        if project.id not in allowed:
            continue
        binding_type = binding.binding_type
        if binding.binding_type == "primary" and project.id != agent.default_project_id:
            binding_type = "context"
        if binding_type == "primary":
            has_primary = True
        entries.append(
            {
                "project_id": project.id,
                "alias": project.slug,
                "display": project.name,
                "binding_type": binding_type,
                "priority": binding.priority,
            }
        )

    if not has_primary and agent.default_project_id in allowed:
        project = (
            await db.execute(select(Project).where(Project.id == agent.default_project_id))
        ).scalar_one_or_none()
        if project is not None:
            entries.insert(
                0,
                {
                    "project_id": project.id,
                    "alias": project.slug,
                    "display": project.name,
                    "binding_type": "primary",
                    "priority": 0,
                },
            )

    entries.sort(key=lambda e: (0 if e["binding_type"] == "primary" else 1, e["priority"]))
    return entries


async def _first_vault_key_hit(
    db: AsyncSession,
    *,
    project_id: UUID,
    wanted: str,
) -> tuple[Vault | None, VaultItem | None]:
    for vault, item in await _vault_item_rows_for_projects(db, [project_id]):
        if _env_key(item.section, item.item_name) == wanted:
            return vault, item
    return None, None


async def _exact_vault_reference_hit(
    db: AsyncSession,
    *,
    project_id: UUID,
    vault_slug: str,
    section: str,
    field: str,
) -> tuple[Vault | None, VaultItem | None]:
    row = (
        await db.execute(
            select(Vault, VaultItem)
            .join(VaultItem, VaultItem.vault_id == Vault.id)
            .where(
                Vault.project_id == project_id,
                Vault.slug == vault_slug,
                VaultItem.section == section,
                VaultItem.item_name == field,
            )
        )
    ).first()
    if row is None:
        return None, None
    return row[0], row[1]


async def _vault_item_rows_for_projects(
    db: AsyncSession,
    project_ids: list[UUID],
) -> list[tuple[Vault, VaultItem]]:
    if not project_ids:
        return []
    rows = (
        await db.execute(
            select(Vault, VaultItem)
            .join(VaultItem, VaultItem.vault_id == Vault.id)
            .where(Vault.project_id.in_(project_ids))
            .order_by(
                Vault.project_id.asc(),
                Vault.created_at.asc(),
                Vault.id.asc(),
                VaultItem.created_at.asc(),
                VaultItem.id.asc(),
            )
        )
    ).all()
    return [(vault, item) for vault, item in rows]


@router.post("/resolve", responses={200: {"model": VaultResolveResponse}})
async def resolve_vault(
    key: str | None = Query(default=None),
    vault_slug: str | None = Query(
        default=None,
        description="Exact clawdi:// vault slug to resolve.",
    ),
    section: str = Query(default="", description="Exact clawdi:// section to resolve."),
    field: str | None = Query(default=None, description="Exact clawdi:// field to resolve."),
    project_id: UUID | None = Query(
        default=None,
        description="Project to resolve from (default: caller write project).",
    ),
    agent_id: UUID | None = Query(
        default=None,
        description="Resolve through an Agent Project and attached Project order.",
    ),
    allow_conflicts: bool = Query(
        default=False,
        description="Allow first-match wins when attached Projects contain the same key.",
    ),
    debug: bool = Query(default=False),
    preview: bool = Query(
        default=False,
        description="Return provenance only for single-key/reference resolution; do not decrypt.",
    ),
    auth: AuthContext = Depends(require_user_cli),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Resolve all vault items to plaintext. CLI-only (requires ApiKey auth).

    Project membership grants CLI/API-key callers read access to vault values.
    A bound Agent API key is capped to its default-write Project unless
    resolving through its own `agent_id`, where the Agent Project plus explicit
    attached Projects define runtime reads.
    """
    if preview and key is None and vault_slug is None and field is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "preview requires key or vault_slug/field",
        )

    if agent_id is not None:
        ordered = await _agent_project_precedence(db, auth, agent_id)
        if project_id is not None:
            ordered = [entry for entry in ordered if entry["project_id"] == project_id]
    else:
        selected_project_id = project_id or await resolve_default_write_project(db, auth)
        ordered = await _project_precedence(db, auth, selected_project_id)
    if not ordered:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    effective_project_ids = [entry["project_id"] for entry in ordered]

    if vault_slug is not None or field is not None:
        if key is not None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "pass key or vault_slug/field, not both",
            )
        if not vault_slug or not field:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "vault_slug and field are required for reference resolve",
            )
        precedence: list[dict] = []
        winner: dict | None = None
        conflicts: list[dict] = []
        for entry in ordered:
            hit_vault, hit_item = await _exact_vault_reference_hit(
                db,
                project_id=entry["project_id"],
                vault_slug=vault_slug,
                section=section,
                field=field,
            )
            entry_debug = {
                "project_id": str(entry["project_id"]),
                "alias": entry["alias"],
                "display": entry["display"],
                "binding_type": entry["binding_type"],
                "priority": entry["priority"],
                "hit": hit_item is not None,
                "reason": "match" if hit_item is not None and winner is None else "not-found",
            }
            if hit_item is not None and winner is not None:
                entry_debug["reason"] = "conflict"
                conflicts.append(
                    {
                        "project_id": str(entry["project_id"]),
                        "alias": entry["alias"],
                        "display": entry["display"],
                        "binding_type": entry["binding_type"],
                        "priority": entry["priority"],
                        "vault_slug": hit_vault.slug if hit_vault else None,
                        "section": hit_item.section,
                        "item_name": hit_item.item_name,
                    }
                )
            precedence.append(entry_debug)
            if hit_item is not None and winner is None:
                winner = {
                    "source_project_id": str(entry["project_id"]),
                    "source_alias": entry["alias"],
                    "source_display": entry["display"],
                    "source_binding_type": entry["binding_type"],
                    "source_priority": entry["priority"],
                    "vault_slug": hit_vault.slug if hit_vault else None,
                    "section": hit_item.section,
                    "item_name": hit_item.item_name,
                }
                if not preview:
                    winner["value"] = decrypt(hit_item.encrypted_value, hit_item.nonce)

        reference = (
            f"clawdi://{vault_slug}/{section}/{field}"
            if section
            else f"clawdi://{vault_slug}/{field}"
        )
        if winner is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "vault_reference_not_found",
                    "reference": reference,
                    "precedence": precedence,
                },
            )
        if conflicts and not allow_conflicts:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "vault_conflicts_blocked",
                    "reference": reference,
                    "message": (
                        "Vault reference exists in multiple attached Projects; "
                        "pass allow_conflicts=true to use the first Project in Agent order."
                    ),
                    "winner": {
                        "source_project_id": winner["source_project_id"],
                        "source_alias": winner["source_alias"],
                        "source_display": winner["source_display"],
                        "source_binding_type": winner["source_binding_type"],
                        "source_priority": winner["source_priority"],
                        "vault_slug": winner["vault_slug"],
                        "section": winner["section"],
                        "item_name": winner["item_name"],
                    },
                    "conflicts": conflicts,
                    "precedence": precedence,
                },
            )
        response = {"reference": reference, **winner}
        if debug:
            response["precedence"] = precedence
        if conflicts:
            response["conflicts"] = conflicts
        return response

    if key is not None:
        wanted = key.upper()
        precedence: list[dict] = []
        winner: dict | None = None
        conflicts: list[dict] = []
        for entry in ordered:
            hit_vault, hit_item = await _first_vault_key_hit(
                db,
                project_id=entry["project_id"],
                wanted=wanted,
            )

            entry_debug = {
                "project_id": str(entry["project_id"]),
                "alias": entry["alias"],
                "display": entry["display"],
                "binding_type": entry["binding_type"],
                "priority": entry["priority"],
                "hit": hit_item is not None,
                "reason": "match" if hit_item is not None and winner is None else "not-found",
            }
            if hit_item is not None and winner is not None:
                entry_debug["reason"] = "conflict"
                conflicts.append(
                    {
                        "project_id": str(entry["project_id"]),
                        "alias": entry["alias"],
                        "display": entry["display"],
                        "binding_type": entry["binding_type"],
                        "priority": entry["priority"],
                        "vault_slug": hit_vault.slug if hit_vault else None,
                        "section": hit_item.section,
                        "item_name": hit_item.item_name,
                    }
                )
            precedence.append(entry_debug)

            if hit_item is not None and winner is None:
                winner = {
                    "source_project_id": str(entry["project_id"]),
                    "source_alias": entry["alias"],
                    "source_display": entry["display"],
                    "source_binding_type": entry["binding_type"],
                    "source_priority": entry["priority"],
                    "vault_slug": hit_vault.slug if hit_vault else None,
                    "section": hit_item.section,
                    "item_name": hit_item.item_name,
                }
                if not preview:
                    winner["value"] = decrypt(hit_item.encrypted_value, hit_item.nonce)

        if winner is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                detail={"code": "vault_key_not_found", "key": key, "precedence": precedence},
            )

        if conflicts and not allow_conflicts:
            assert winner is not None
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "vault_conflicts_blocked",
                    "key": key,
                    "message": (
                        "Vault key exists in multiple attached Projects; "
                        "pass allow_conflicts=true to use the first Project in Agent order."
                    ),
                    "winner": {
                        "source_project_id": winner["source_project_id"],
                        "source_alias": winner["source_alias"],
                        "source_display": winner["source_display"],
                        "source_binding_type": winner["source_binding_type"],
                        "source_priority": winner["source_priority"],
                        "vault_slug": winner["vault_slug"],
                        "section": winner["section"],
                        "item_name": winner["item_name"],
                    },
                    "conflicts": conflicts,
                    "precedence": precedence,
                },
            )

        response = {"key": key, **winner}
        if debug:
            response["precedence"] = precedence
        if conflicts:
            response["conflicts"] = conflicts
        return response

    if agent_id is not None:
        env: dict[str, str] = {}
        seen: dict[str, dict] = {}
        conflicts: list[dict] = []
        rows_by_project: dict[UUID, list[tuple[Vault, VaultItem]]] = {}
        for vault, item in await _vault_item_rows_for_projects(db, effective_project_ids):
            rows_by_project.setdefault(vault.project_id, []).append((vault, item))
        for entry in ordered:
            for vault, item in rows_by_project.get(entry["project_id"], []):
                env_key = _env_key(item.section, item.item_name)
                source = {
                    "project_id": str(entry["project_id"]),
                    "alias": entry["alias"],
                    "display": entry["display"],
                    "binding_type": entry["binding_type"],
                    "priority": entry["priority"],
                    "vault_slug": vault.slug,
                    "section": item.section,
                    "item_name": item.item_name,
                }
                if env_key in env:
                    conflicts.append(
                        {
                            "key": env_key,
                            "winner": seen[env_key],
                            "conflict": source,
                        }
                    )
                    continue
                env[env_key] = decrypt(item.encrypted_value, item.nonce)
                seen[env_key] = source
        if conflicts and not allow_conflicts:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "vault_conflicts_blocked",
                    "message": (
                        "Vault keys conflict across attached Projects; "
                        "pass allow_conflicts=true to use the first Project in Agent order."
                    ),
                    "conflicts": conflicts,
                },
            )
        if debug:
            return {"env": env, "precedence": ordered, "conflicts": conflicts}
        return env

    env: dict[str, str] = {}
    for _vault, item in await _vault_item_rows_for_projects(db, effective_project_ids):
        plaintext = decrypt(item.encrypted_value, item.nonce)
        env[_env_key(item.section, item.item_name)] = plaintext

    return env


async def _get_vault_write(
    auth: AuthContext,
    slug: str,
    db: AsyncSession,
    *,
    project_id: UUID | None = None,
) -> Vault:
    """Fetch a vault for mutation, restricted to caller-owned projects.

    Shared memberships can read vault metadata, but they never grant
    mutation rights. Write paths therefore use an owner-only project
    inventory instead of `_get_vault`'s visibility set, while still
    preserving Agent API key blast-radius limits.
    """
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        owned_project_ids = [await resolve_default_write_project(db, auth)]
    else:
        owned_project_ids = (
            (await db.execute(select(Project.id).where(Project.user_id == auth.user_id)))
            .scalars()
            .all()
        )
    base_q = select(Vault).where(
        Vault.project_id.in_(owned_project_ids),
        Vault.slug == slug,
    )
    if project_id is not None:
        if project_id not in owned_project_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
        base_q = base_q.where(Vault.project_id == project_id)
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
                "project_ids": [str(r.project_id) for r in rows],
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
    see. Agent API key -> only vaults in its Agent Project.
    JWT -> any Project the user can see. Without the filter, a daemon
    key could read items in another Project's vault by guessing the
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
    # from project_ids_visible_to which already accounts for owned +
    # shared-membership projects. Recipients need to read vault
    # metadata for projects they joined; plaintext resolution is a
    # separate endpoint with its own auth contract.
    visible_project_ids = await project_ids_visible_to(db, auth)
    base_q = select(Vault).where(
        Vault.project_id.in_(visible_project_ids),
        Vault.slug == slug,
    )
    if project_id is not None:
        # Caller pinned a project. If it's outside their visibility
        # we report 404 (same as if the vault didn't exist) rather
        # than leaking that the project ID is real but inaccessible.
        if project_id not in visible_project_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Vault '{slug}' not found")
        base_q = base_q.where(Vault.project_id == project_id)
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
                "project_ids": [str(r.project_id) for r in rows],
            },
        )
    return rows[0]
