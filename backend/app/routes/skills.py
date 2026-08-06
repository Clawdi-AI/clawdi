import hashlib
import io
import json
import logging
import re
import tarfile
from typing import TypedDict
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Path,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_scope_short_session
from app.core.database import async_session_factory, get_session
from app.core.project import (
    project_ids_visible_to,
    resolve_default_write_project,
    validate_project_for_caller,
    validate_project_read_for_caller,
)
from app.core.query_utils import like_needle
from app.core.skill_key import (
    MAX_SKILL_KEY_LEN,
    RESERVED_SKILL_KEY_SUFFIXES,
    SKILL_KEY_PATTERN,
    SkillKeyValidationError,
    has_reserved_skill_key_suffix,
    validate_derived_skill_key,
)
from app.core.skill_sync_protocol import (
    SKILL_SYNC_PROTOCOL_HEADER,
    SkillSyncProtocol,
    resolve_skill_sync_protocol,
)
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.skill import (
    SKILL_AUTHORITY_AGENT_SYNC,
    SKILL_AUTHORITY_CLOUD,
    Skill,
)
from app.models.user import User
from app.schemas.common import Paginated
from app.schemas.skill import (
    PersistedProjectKind,
    PersistedSkillAuthority,
    SkillContentUpdateRequest,
    SkillCreateRequest,
    SkillDeleteResponse,
    SkillDetailResponse,
    SkillInstallRequest,
    SkillInstallResponse,
    SkillSummaryResponse,
    SkillUploadResponse,
)
from app.services.file_store import get_file_store
from app.services.http_cache import if_none_match_contains
from app.services.project_runtime_skills import (
    assert_agent_workspace_skill_write_compatible,
    assert_project_skill_write_compatible,
)
from app.services.runtime_manifest_resources import (
    assert_project_skill_not_runtime_managed,
    project_skill_advisory_lock_key,
)
from app.services.sync_events import (
    AGENT_SKILL_CHANGED_EVENT,
    AGENT_SKILL_DELETED_EVENT,
    bump_skills_revision,
    get_skills_revision,
)
from app.services.tar_utils import (
    SkillTextValidationError,
    TarValidationError,
    extract_skill_md,
    parse_frontmatter,
    replace_skill_md,
    skill_document,
    tar_from_content,
    validate_tar,
)

router = APIRouter(prefix="/skills", tags=["skills"])

# Phase-2 router: project-explicit skill routes. Same handlers as the
# legacy router; the only difference is where `project_id` comes from
# (URL path here vs caller-resolved in the legacy router).
# Mounted in `app/main.py` alongside the legacy router. After all
# callers migrate, the legacy write paths return 410 (see step 3
# of phase 2).
project_router = APIRouter(prefix="/projects/{project_id}/skills", tags=["skills"])

# Agent-authoritative filesystem projection. Unlike project routes, these
# endpoints derive current project authority from the authenticated Agent
# identity. Deletes may carry a previously stamped project fence so a durable
# queue can remove that Agent's exact old projection after reassignment; the
# server never accepts caller-supplied authority. Bound keys must match the
# path, and user-level CLI identities must own the Agent.
agent_router = APIRouter(prefix="/agents/{agent_id}/skills", tags=["skills"])

# Back-compat for binaries built during the Scope -> Project migration.
# The table row id was preserved, so old `/api/scopes/{id}/skills/...`
# read URLs can be served by the project-explicit handlers.
scope_router = APIRouter(
    prefix="/scopes/{scope_id}/skills",
    tags=["skills"],
    include_in_schema=False,
)

log = logging.getLogger(__name__)

file_store = get_file_store()
_SKILLS_LIST_CACHE_CONTROL = "no-transform"
_SKILLS_ETAG_VERSION = "skills-v2"


class _ProjectSkillMetadata(TypedDict):
    name: str
    kind: PersistedProjectKind
    environment_id: UUID | None
    machine_name: str | None


def _persisted_skill_authority(value: str) -> PersistedSkillAuthority:
    if value == SKILL_AUTHORITY_AGENT_SYNC:
        return "agent_sync"
    if value == SKILL_AUTHORITY_CLOUD:
        return "cloud"
    raise ValueError(f"Unsupported persisted Skill authority: {value}")


def _persisted_project_kind(value: str) -> PersistedProjectKind:
    if value == "environment":
        return "environment"
    if value == "personal":
        return "personal"
    if value == "workspace":
        return "workspace"
    raise ValueError(f"Unsupported persisted Project kind: {value}")


def _file_key(user_id: UUID, project_id: UUID, skill_key: str, content_hash: str) -> str:
    """Immutable object identity for new writes; historical keys remain readable."""
    return f"skills/{user_id}/{project_id}/{skill_key}/{content_hash}.tar.gz"


def _sanitize_log(value: object) -> str:
    """Strip newlines / CR / null bytes / non-printable ASCII from
    a value before logging. Attacker-controlled fields (tar member
    names inside `TarValidationError`, GitHub-fetch error strings)
    can contain `\\n` / ANSI escapes that forge fake log lines in
    a JSON-line / syslog pipeline. Replace with a single space and
    truncate at 500 chars so a 2 KB error blob doesn't dominate
    the log entry.
    """
    s = str(value).replace("\n", " ").replace("\r", " ").replace("\x00", "")
    # Strip remaining control chars (\x01-\x1f except tab) — keep
    # tab so legitimate tab-separated content still reads.
    s = "".join(c if c == "\t" or c.isprintable() else " " for c in s)
    return s[:500]


# Mirror of SKILL_TAR_EXCLUDE in packages/cli/src/lib/tar.ts:12-30. The two
# MUST match — what's hashed must equal what's tarred. If you change one,
# change the other in the same commit. The TS file's filter at
# tar.ts:82-85 uses the same shape: skip if any path segment after the
# skill-key root is in this set.
_SKILL_HASH_EXCLUDE = {
    "node_modules",
    ".git",
    ".turbo",
    ".cache",
    "dist",
    "build",
    "out",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    "coverage",
    # Cross-agent skill bundles — see tar.ts for full reasoning.
    # gstack-shaped meta-skills ship sub-skills for other agents
    # under these dotfile dirs; the outer skill's hash must NOT
    # include them or it'd diverge from what the CLI tar uploads.
    ".agents",
    ".cursor",
    ".factory",
    ".openclaw",
    ".hermes",
    ".gbrain",
    ".claude",
    ".codex",
}


def _compute_file_tree_hash(tar_bytes: bytes, skill_key: str | None = None) -> str:
    """File-tree content hash of a skill tar.gz.

    Walks each file in the archive (skipping directories and any path
    whose segments include the exclude set above), sorts by relative
    path, then sha256 over `path + content` per file. Mirrors the TS
    `computeSkillFolderHash` in `packages/cli/src/lib/skills-lock.ts` so
    server-side and client-side hashes are identical for the same tar.

    `skill_key` controls how many leading path components the entry
    name carries. For flat keys (e.g. ``mySkill``) the tar entry is
    ``mySkill/SKILL.md`` and we strip one segment. For nested
    Hermes keys (e.g. ``category/foo``) the tar entry is
    ``category/foo/SKILL.md`` and we MUST strip two segments —
    otherwise the relative path is ``foo/SKILL.md`` while the CLI's
    `computeSkillFolderHash` reports ``SKILL.md`` (it walks files
    inside the skill dir), and the two hashes never match. Pre-fix
    this divergence broke nested-key projection claims: the stored
    `content_hash` never matched the CLI's local hash, so every
    reconciliation re-uploaded the same bytes and SSE invalidations caused
    redundant rescans. Passing `skill_key=None` (legacy callers / marketplace
    install on flat keys) keeps the strip-one behavior.

    Used in two places:
    - `upload_skill` fallback when a legacy client doesn't send `content_hash`.
    - `install_skill` for marketplace tars fetched from GitHub.
    """
    strip_count = len(skill_key.split("/")) if skill_key else 1
    files: list[tuple[str, bytes]] = []
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            # Names are like "<skill_key>/SKILL.md" or
            # "<category>/<foo>/SKILL.md". Drop `strip_count` leading
            # segments so the relative path matches the TS side,
            # which hashes paths from the skill dir's POV.
            parts = member.name.split("/")
            if any(p in _SKILL_HASH_EXCLUDE for p in parts[strip_count:]):
                continue
            relative_path = "/".join(parts[strip_count:])
            if not relative_path:
                continue
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            files.append((relative_path, extracted.read()))

    files.sort(key=lambda x: x[0])
    h = hashlib.sha256()
    for path, content in files:
        h.update(path.encode("utf-8"))
        h.update(content)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# List / Get
# ---------------------------------------------------------------------------


@router.get("", response_model=Paginated[SkillSummaryResponse])
async def list_skills(
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    q: str | None = Query(default=None, description="Search name / description / skill_key"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    include_content: bool = Query(default=False),
    project_id: UUID | None = Query(
        default=None,
        description=(
            "Optional explicit project to list. Without it, results span every "
            "project the caller can read (Agent API keys see only "
            "their Agent Project, everyone else sees all projects). The serve "
            "daemon passes its Agent Project id when it boots with an unbound "
            "CLI key + an explicit --environment-id, so projection catch-up "
            "lists the right Project instead of the most-recently-active one."
        ),
    ),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
) -> Paginated[SkillSummaryResponse] | Response:
    if (
        (auth.is_cli or auth.oauth_cli)
        and auth.api_key is not None
        and auth.api_key.environment_id is not None
    ):
        resolve_skill_sync_protocol(skill_sync_protocol)
    async with async_session_factory() as db:
        return await _list_skills_with_db(
            auth=auth,
            db=db,
            q=q,
            page=page,
            page_size=page_size,
            include_content=include_content,
            project_id=project_id,
            if_none_match=if_none_match,
            skill_sync_protocol=skill_sync_protocol,
        )


async def _list_skills_with_db(
    *,
    auth: AuthContext,
    db: AsyncSession,
    q: str | None,
    page: int,
    page_size: int,
    include_content: bool,
    project_id: UUID | None,
    if_none_match: str | None,
    skill_sync_protocol: str | None,
) -> Paginated[SkillSummaryResponse] | Response:
    # Keep every query that contributes to the strong collection ETag and its
    # response body in one snapshot. Cross-page consistency remains fenced by
    # the shared collection revision because released CLI 0.13.13 performs a
    # separate request for each page.
    await db.connection(
        execution_options={
            "isolation_level": "REPEATABLE READ",
            "postgresql_readonly": True,
        }
    )

    # Collection-level ETag short-circuit: when the daemon's last-seen
    # revision matches current, return 304 with no body so periodic complete
    # Agent-Project inventory catch-up costs nothing on quiet accounts.
    #
    # ETag binds (caller revision, project filter, EFFECTIVE
    # visible project set, and visible owners' revisions) so a
    # caller's representation changes whenever any of those does.
    # The owner-revision component is required for shared projects:
    # owner writes bump the owner's `skills_revision`, not the
    # recipient's. Round 32 covered (revision, project_id); this also
    # folds in the visible-project hash so an
    # Agent API key whose `default_project_id` is reassigned
    # to a different Project gets a new ETag — and a 200 with the
    # new effective listing — even though `skills_revision`
    # didn't bump (the reassignment lives on
    # `agent_environments`, not `skills`).
    #
    # Project-filtered read. JWT auth → all user's projects
    # (dashboard sees full inventory). api_key auth → only the
    # bound Agent Project (daemon doesn't see other projects' skills
    # it can't write to). When the caller pins `project_id`,
    # intersect with what they're allowed to see — an ID
    # outside that set yields a deliberately-empty listing.
    selected_project_id = project_id
    if selected_project_id is not None:
        if auth.api_key_project_id is not None:
            visible_project_ids = (
                [selected_project_id] if selected_project_id == auth.api_key_project_id else []
            )
        elif auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
            bound_project_id = await resolve_default_write_project(db, auth)
            visible_project_ids = (
                [selected_project_id] if selected_project_id == bound_project_id else []
            )
        else:
            visible_project_ids = await _selected_project_visibility(
                db,
                auth,
                selected_project_id,
            )
    else:
        # Unscoped read: full inventory across owned + shared projects.
        visible_project_ids = await project_ids_visible_to(db, auth)

    # Do not trust `auth.skills_revision` here. API-key authentication caches
    # that snapshot for longer than the daemon polling interval, so it can lag
    # a committed Skill mutation. Both the caller revision (kept as the first
    # ETag segment for CLI 0.13.13) and every visible owner's revision come
    # from this database snapshot before a 304 is considered.
    revision = await get_skills_revision(db, auth.user_id)
    (
        visible_revision_fingerprint,
        metadata_fingerprint,
        project_meta,
    ) = await _visible_skills_etag_state(db, visible_project_ids)
    if (auth.is_cli or auth.oauth_cli) and visible_project_ids:
        has_agent_project = any(
            meta["kind"] == PROJECT_KIND_ENVIRONMENT for meta in project_meta.values()
        )
        if has_agent_project:
            resolve_skill_sync_protocol(skill_sync_protocol)
    etag = _skills_collection_etag(
        revision=revision,
        selected_project_id=selected_project_id,
        visible_project_ids=visible_project_ids,
        visible_revision_fingerprint=visible_revision_fingerprint,
        metadata_fingerprint=metadata_fingerprint,
        q=q,
        page_size=page_size,
        include_content=include_content,
    )
    # Inline content depends on object storage after the DB snapshot closes.
    # Always render that shape so a transient prior failure cannot turn its
    # partial `content=None` body into a reusable 304 validator.
    if page == 1 and not include_content and if_none_match_contains(if_none_match, etag):
        await db.commit()
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={"ETag": etag, "Cache-Control": _SKILLS_LIST_CACHE_CONTROL},
        )

    # Drop the `Skill.user_id == auth.user_id` filter that was here
    # pre-sharing: that would have blocked viewer members from seeing
    # skills in projects they joined as recipients. Project-id-in-visible
    # already gates access correctly; the membership row earned the
    # project its slot in `visible_project_ids`.
    base = (
        select(Skill)
        .where(
            Skill.is_active,
            Skill.project_id.in_(visible_project_ids),
        )
        .order_by(Skill.skill_key, Skill.project_id, Skill.id)
    )
    if q:
        needle = like_needle(q)
        base = base.where(
            or_(
                Skill.skill_key.ilike(needle, escape="\\"),
                Skill.name.ilike(needle, escape="\\"),
                Skill.description.ilike(needle, escape="\\"),
            )
        )

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    skills = (
        (await db.execute(base.limit(page_size).offset((page - 1) * page_size))).scalars().all()
    )

    items: list[SkillSummaryResponse] = []
    content_fetches: list[tuple[int, UUID, str]] = []
    for s in skills:
        meta = project_meta.get(s.project_id) if s.project_id else None
        items.append(
            SkillSummaryResponse(
                id=str(s.id),
                skill_key=s.skill_key,
                name=s.name,
                description=s.description,
                version=s.version,
                source=s.source,
                authority=_persisted_skill_authority(s.authority),
                source_repo=s.source_repo,
                agent_types=s.agent_types,
                file_count=s.file_count,
                content_hash=s.content_hash,
                is_active=s.is_active,
                created_at=s.created_at,
                updated_at=s.updated_at,
                content=None,
                project_id=str(s.project_id) if s.project_id else None,
                project_name=meta["name"] if meta else None,
                project_kind=meta["kind"] if meta else None,
                machine_name=meta["machine_name"] if meta else None,
                environment_id=str(meta["environment_id"])
                if meta and meta["environment_id"]
                else None,
            )
        )
        if include_content and s.file_key:
            content_fetches.append((len(items) - 1, s.user_id, s.file_key))

    # Release the read transaction before response serialization or
    # object-storage I/O. Daemon reconcile can ask for inline content; holding
    # a DB connection while each S3/R2 GET runs turns slow storage into
    # idle-in-transaction pool pressure.
    await db.commit()

    if content_fetches:
        for item_index, user_id, file_key in content_fetches:
            try:
                tar_bytes = await file_store.get(file_key)
                items[item_index].content = extract_skill_md(tar_bytes)
            except Exception as e:
                # Don't fail the whole list on a single bad file_key —
                # return content=None for this row. But log so a
                # misconfigured S3 / rotated credentials / permission
                # error doesn't disappear silently into 200 OKs with
                # null content.
                log.warning(
                    "skill_list_content_fetch_failed user=%s file_key=%s error=%s",
                    user_id,
                    file_key,
                    _sanitize_log(e),
                )

    response = Paginated[SkillSummaryResponse](
        items=items, total=total, page=page, page_size=page_size
    )
    headers = {"Cache-Control": _SKILLS_LIST_CACHE_CONTROL}
    if not include_content:
        # Metadata-only pages expose one shared collection fence. Inline
        # content depends on fallible object storage and deliberately has no
        # reusable strong validator, whether every fetch succeeded or not.
        headers["ETag"] = etag
    return Response(
        content=response.model_dump_json(),
        media_type="application/json",
        headers=headers,
    )


def _skills_collection_etag(
    *,
    revision: int,
    selected_project_id: UUID | None,
    visible_project_ids: list[UUID],
    visible_revision_fingerprint: str,
    metadata_fingerprint: str,
    q: str | None,
    page_size: int,
    include_content: bool,
) -> str:
    project_tag = str(selected_project_id) if selected_project_id is not None else "all"
    visible_fingerprint = _visible_project_fingerprint(visible_project_ids)
    representation_fingerprint = _skills_representation_fingerprint(
        q=q,
        page_size=page_size,
        include_content=include_content,
    )
    return (
        f'"{revision}:{_SKILLS_ETAG_VERSION}:{project_tag}:{visible_fingerprint}:'
        f"{visible_revision_fingerprint}:{metadata_fingerprint}:"
        f'{representation_fingerprint}"'
    )


def _skills_representation_fingerprint(
    *,
    q: str | None,
    page_size: int,
    include_content: bool,
) -> str:
    """Bind representation-changing list options without breaking page fences.

    CLI 0.13.13 requires every page in one complete inventory read to expose
    the same strong collection ETag. Keep `page` out of this fingerprint until
    that released cross-page contract can be versioned; conditional requests
    are limited to page 1 separately so a page-1 validator cannot suppress a
    page-2 body.
    """
    normalized_q = q or ""
    value = f"{normalized_q}\0{page_size}\0{int(include_content)}"
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def _visible_project_fingerprint(visible_project_ids: list[UUID]) -> str:
    # Short fingerprint of the visible-project set (sorted for determinism).
    # 16 hex chars = 64 bits of collision space, well past the realistic
    # distinct-set count for any account.
    return hashlib.sha256(
        ":".join(sorted(str(s) for s in visible_project_ids)).encode()
    ).hexdigest()[:16]


async def _selected_project_visibility(
    db: AsyncSession,
    auth: AuthContext,
    selected_project_id: UUID,
) -> list[UUID]:
    """Validate one selected project without loading the full visible set.

    The daemon always calls `/v1/skills?project_id=<env-project>`. For unbound
    CLI keys and dashboard JWTs this keeps the same read policy (owned OR
    shared membership) with one indexed lookup. Current owner revisions and
    response-visible metadata are loaded separately for every caller shape.
    """
    project = (
        await db.execute(
            select(Project.id)
            .outerjoin(
                ProjectMembership,
                and_(
                    ProjectMembership.project_id == Project.id,
                    ProjectMembership.member_user_id == auth.user_id,
                ),
            )
            .where(
                Project.id == selected_project_id,
                Project.archived_at.is_(None),
                or_(
                    Project.user_id == auth.user_id,
                    ProjectMembership.member_user_id.is_not(None),
                ),
            )
        )
    ).scalar_one_or_none()
    return [project] if project is not None else []


async def _resolve_legacy_skill(
    db: AsyncSession,
    auth: AuthContext,
    visible_project_ids: list[UUID],
    skill_key: str,
) -> Skill:
    """Phase-1 multi-project disambiguation: pick the most-recently-
    updated row across all projects the caller can read. `LIMIT 1`
    keeps `scalar_one_or_none()` from raising MultipleResultsFound
    when the same skill_key exists in 2+ projects."""
    result = await db.execute(
        select(Skill)
        .where(
            Skill.project_id.in_(visible_project_ids),
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
        .order_by(Skill.updated_at.desc(), Skill.id.desc())
        .limit(1)
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return skill


async def _visible_skills_etag_state(
    db: AsyncSession,
    visible_project_ids: list[UUID],
) -> tuple[str, str, dict[UUID, _ProjectSkillMetadata]]:
    """Load current owner revisions and all response-visible metadata.

    `users.skills_revision` is bumped on the owner account when a skill
    changes. For shared projects, the recipient's own revision does not
    move. Project and Agent metadata have no shared revision counter, so hash
    their actual projected values. Both fingerprints cover the full visible
    set and therefore remain identical across pages.
    """
    if not visible_project_ids:
        return "none", "none", {}

    rows = (
        await db.execute(
            select(
                Project.id,
                Project.user_id,
                User.skills_revision,
                Project.name,
                Project.kind,
                Project.origin_environment_id,
                AgentEnvironment.machine_name,
            )
            .join(User, User.id == Project.user_id)
            .outerjoin(
                AgentEnvironment,
                AgentEnvironment.id == Project.origin_environment_id,
            )
            .where(Project.id.in_(visible_project_ids))
        )
    ).all()
    owner_revisions = {row.user_id: int(row.skills_revision or 0) for row in rows}
    owner_parts = sorted(f"{owner_id}:{revision}" for owner_id, revision in owner_revisions.items())
    visible_revision_fingerprint = hashlib.sha256(":".join(owner_parts).encode()).hexdigest()[:16]

    rows_by_project_id = {row.id: row for row in rows}
    metadata_values: list[list[str | None]] = []
    project_meta: dict[UUID, _ProjectSkillMetadata] = {}
    for project_id in sorted(set(visible_project_ids), key=str):
        row = rows_by_project_id.get(project_id)
        if row is None:
            metadata_values.append([str(project_id), None, None, None, None])
            continue
        environment_id = row.origin_environment_id
        metadata_values.append(
            [
                str(project_id),
                row.name,
                row.kind,
                str(environment_id) if environment_id is not None else None,
                row.machine_name,
            ]
        )
        project_meta[project_id] = {
            "name": row.name,
            "kind": _persisted_project_kind(row.kind),
            "environment_id": environment_id,
            "machine_name": row.machine_name,
        }
    metadata_fingerprint = hashlib.sha256(
        json.dumps(
            metadata_values,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()[:16]
    return visible_revision_fingerprint, metadata_fingerprint, project_meta


async def _build_skill_detail(skill: Skill, db: AsyncSession | None = None) -> SkillDetailResponse:
    skill_id = str(skill.id)
    skill_key = skill.skill_key
    name = skill.name
    description = skill.description
    version = skill.version
    source = skill.source
    authority = _persisted_skill_authority(skill.authority)
    source_repo = skill.source_repo
    file_count = skill.file_count
    agent_types = skill.agent_types
    created_at = skill.created_at
    content_hash = skill.content_hash
    updated_at = skill.updated_at
    file_key = skill.file_key
    user_id = skill.user_id
    project_id = skill.project_id

    # Project + machine context. The dashboard editor uses project_id
    # to build the upload URL; multi-machine users see machine_name
    # in the page caption ("on my-mac") so they're sure which copy
    # they're editing.
    project_id_str = str(project_id)
    project_name: str | None = None
    project_kind: str | None = None
    machine_name: str | None = None
    environment_id: str | None = None
    if db is not None:
        project_row = (
            await db.execute(
                select(Project.name, Project.kind, Project.origin_environment_id).where(
                    Project.id == project_id
                )
            )
        ).first()
        if project_row is not None:
            project_name = project_row.name
            project_kind = _persisted_project_kind(project_row.kind)
            if project_row.origin_environment_id is not None:
                environment_id = str(project_row.origin_environment_id)
                env_row = (
                    await db.execute(
                        select(AgentEnvironment.machine_name).where(
                            AgentEnvironment.id == project_row.origin_environment_id
                        )
                    )
                ).first()
                if env_row is not None:
                    machine_name = env_row.machine_name

    if db is not None:
        # Detail responses read S3/R2 content after metadata lookup. End the
        # DB transaction first so storage latency or response serialization
        # cannot pin a pool connection.
        await db.commit()

    content = None
    if file_key:
        try:
            tar_bytes = await file_store.get(file_key)
            content = extract_skill_md(tar_bytes)
        except Exception as e:
            # Detail page falls back to no-content rendering, but
            # surface storage errors in logs so silent S3/permission
            # issues are visible to the operator.
            log.warning(
                "skill_detail_content_fetch_failed user=%s file_key=%s error=%s",
                user_id,
                file_key,
                _sanitize_log(e),
            )

    return SkillDetailResponse(
        id=skill_id,
        skill_key=skill_key,
        name=name,
        description=description,
        version=version,
        source=source,
        authority=authority,
        source_repo=source_repo,
        file_count=file_count,
        content=content,
        agent_types=agent_types,
        created_at=created_at,
        content_hash=content_hash,
        updated_at=updated_at,
        project_id=project_id_str,
        project_name=project_name,
        project_kind=project_kind,
        machine_name=machine_name,
        environment_id=environment_id,
    )


# ---------------------------------------------------------------------------
# Upload (tar.gz)
# ---------------------------------------------------------------------------


@router.post("/upload")
async def upload_skill_legacy(
    response: Response,
    skill_key: str = Form(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    file: UploadFile = File(...),
    content_hash: str | None = Form(
        None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    ),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Back-compat shim for pre-PR-66 CLI binaries. Resolves the
    target project via `resolve_default_write_project` (every user
    has a deterministic default after the projects migration:
    Agent API key → its Agent Project; unbound key with Agents →
    most-recently-active Agent Project; zero Agents → Personal),
    then runs the same upload pipeline as the project-explicit
    route. New CLIs and the dashboard call
    `POST /v1/projects/{project_id}/skills/upload` directly.

    Asymmetric with `delete_skill_legacy` (which only accepts an env-bound
    API key) by design:
    a wrong-project upload creates a stray row visible in the
    dashboard listing, recoverable in 30s by re-uploading to the
    correct project. A wrong-project DELETE is permanent data loss.
    """
    project_id = await resolve_default_write_project(db, auth)
    authority, authority_agent_id = await _project_upload_authority(
        db,
        auth,
        project_id,
        allow_agent_alias=True,
        skill_sync_protocol=skill_sync_protocol,
    )
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "Wed, 31 Dec 2026 00:00:00 GMT"
    response.headers["Link"] = '</v1/projects/{project_id}/skills/upload>; rel="successor-version"'
    await db.commit()

    # Same chunked-read body bound as the project-explicit route —
    # the global BodySizeLimitMiddleware only catches requests
    # declaring Content-Length, so chunked-transfer clients
    # bypass it.
    chunks: list[bytes] = []
    total = 0
    chunk_size = 1024 * 1024  # 1 MB
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_SKILL_TAR_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"Skill tarball exceeds {_MAX_SKILL_TAR_BYTES} bytes",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    return await _do_upload_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        data=data,
        content_hash=content_hash,
        authority=authority,
        authority_agent_id=authority_agent_id,
    )


# Hard cap on skill tarball size. Skills are tiny in practice
# (SKILL.md + a handful of references); 25 MB is generous and
# tighter than the global `BodySizeLimitMiddleware` cap so the
# tighter route-specific limit applies on top. Defense-in-depth
# for chunked uploads (no Content-Length) where the middleware
# can't reject early.
_MAX_SKILL_TAR_BYTES = 25 * 1024 * 1024


async def _read_bounded_skill_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    chunk_size = 1024 * 1024
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_SKILL_TAR_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"Skill tarball exceeds {_MAX_SKILL_TAR_BYTES} bytes",
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def _agent_sync_project(
    db: AsyncSession,
    auth: AuthContext,
    agent_id: UUID,
    *,
    lock_agent: bool = False,
) -> UUID:
    """Resolve Agent Project from a CLI principal and owned Agent identity."""
    key = auth.api_key
    if not auth.is_cli and not auth.oauth_cli:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={
                "code": "agent_sync_auth_required",
                "message": "Agent Skill sync requires CLI authentication.",
            },
        )
    if key is not None and key.environment_id is not None and key.environment_id != agent_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    statement = (
        select(AgentEnvironment.default_project_id)
        .join(Project, Project.id == AgentEnvironment.default_project_id)
        .where(
            AgentEnvironment.id == agent_id,
            AgentEnvironment.user_id == auth.user_id,
            AgentEnvironment.archived_at.is_(None),
            Project.user_id == auth.user_id,
            Project.kind == PROJECT_KIND_ENVIRONMENT,
            Project.origin_environment_id == agent_id,
        )
    )
    if lock_agent:
        statement = statement.with_for_update(of=AgentEnvironment)
    project_id = (await db.execute(statement)).scalar_one_or_none()
    if project_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    return project_id


async def _project_upload_authority(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    *,
    allow_agent_alias: bool,
    skill_sync_protocol: str | None = None,
) -> tuple[str, UUID | None]:
    """Resolve a Project write to Cloud or a proven Agent-sync alias."""
    await validate_project_for_caller(db, auth, project_id)
    project = (
        await db.execute(
            select(Project.kind, Project.origin_environment_id).where(Project.id == project_id)
        )
    ).first()
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.kind != PROJECT_KIND_ENVIRONMENT:
        return SKILL_AUTHORITY_CLOUD, None
    if not auth.is_cli and not auth.oauth_cli:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_project_skills_read_only",
                "message": (
                    "Agent Project Skills are filesystem projections and cannot be changed "
                    "from the dashboard."
                ),
            },
        )
    if not allow_agent_alias:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_project_filesystem_required",
                "message": "Change this Skill in the Agent filesystem and sync it.",
            },
        )
    resolve_skill_sync_protocol(skill_sync_protocol)
    agent_id = project.origin_environment_id
    if agent_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_project_orphaned",
                "message": "The Agent Project has no live Agent identity.",
            },
        )
    resolved_project_id = await _agent_sync_project(db, auth, agent_id)
    if resolved_project_id != project_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_project_identity_mismatch",
                "message": "The Agent no longer owns this Project.",
            },
        )
    return SKILL_AUTHORITY_AGENT_SYNC, agent_id


@agent_router.post("/sync/upload")
async def upload_agent_synced_skill(
    agent_id: UUID,
    skill_key: str = Form(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    file: UploadFile = File(...),
    content_hash: str | None = Form(
        None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    ),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    project_id = await _agent_sync_project(db, auth, agent_id)
    # Do not hold an idle transaction while reading a bounded multipart body.
    # The authority and project fence are re-validated under the per-Skill
    # advisory lock inside `_do_upload_skill` before any row mutation.
    await db.commit()
    data = await _read_bounded_skill_upload(file)
    return await _do_upload_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        data=data,
        content_hash=content_hash,
        authority=SKILL_AUTHORITY_AGENT_SYNC,
        authority_agent_id=agent_id,
    )


@project_router.post("/upload")
async def upload_skill_project(
    project_id: UUID = Path(...),
    skill_key: str = Form(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    file: UploadFile = File(...),
    create_only: bool = Form(
        False,
        description="Reject the upload if this Project already has an active Skill with this key.",
    ),
    content_hash: str | None = Form(
        None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    ),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Project-explicit tar.gz skill upload.

    The URL carries the target Project. Workspace and Personal Projects remain
    Cloud-owned; a released CLI targeting a live Agent Project is treated as a
    compatibility alias for the authenticated filesystem projection. Both use
    `_do_upload_skill`, which serializes mutations with a per-Skill advisory
    lock. SSE is an invalidation hint only for Agent projections.
    """
    authority, authority_agent_id = await _project_upload_authority(
        db,
        auth,
        project_id,
        allow_agent_alias=True,
        skill_sync_protocol=skill_sync_protocol,
    )
    await db.commit()
    # Stream the upload in bounded chunks, refusing once we cross
    # the cap. `await file.read()` would otherwise pull the whole
    # body into memory before any check fires — the global
    # `BodySizeLimitMiddleware` only catches requests that declare
    # Content-Length, so chunked-transfer clients (HTTP/1.1 +
    # `Transfer-Encoding: chunked`, HTTP/2 streamed) bypass it.
    chunks: list[bytes] = []
    total = 0
    chunk_size = 1024 * 1024  # 1 MB
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_SKILL_TAR_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"Skill tarball exceeds {_MAX_SKILL_TAR_BYTES} bytes",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    return await _do_upload_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        data=data,
        content_hash=content_hash,
        create_only=create_only,
        authority=authority,
        authority_agent_id=authority_agent_id,
    )


# Cloud-owned Skill editor entry point. The browser sends user-facing fields;
# the backend renders SKILL.md and runs the shared integrity/persistence path.
# Agent Workspace projections are rejected because their filesystem is
# authoritative.
def _native_skill_key(name: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")[:64].rstrip("-")
    if not key:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Use a Skill name containing letters or numbers.",
        )
    try:
        return validate_derived_skill_key(key)
    except SkillKeyValidationError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Use a shorter Skill name with letters or numbers.",
        ) from exc


@project_router.post("")
async def create_skill(
    payload: SkillCreateRequest,
    project_id: UUID = Path(...),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
    await db.commit()
    skill_key = _native_skill_key(payload.name)
    data, _ = tar_from_content(
        skill_key,
        skill_document(payload.name, payload.description, payload.instructions),
    )
    return await _do_upload_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        data=data,
        content_hash=None,
        create_only=True,
    )


@project_router.put("/{skill_key:path}/content")
async def update_skill_content(
    payload: SkillContentUpdateRequest,
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Edit a Skill's user-facing fields while preserving its support files.

    The server renders SKILL.md and dispatches the resulting archive through
    the shared `_do_upload_skill` integrity path. Agent Workspace projections
    remain read-only here.

    `content_hash` is interpreted as an If-Match precondition (the
    hash the editor saw when it loaded the skill, NOT the hash of
    the bytes it's submitting). When set, we 412 if it doesn't
    match the row's current hash so the editor can re-fetch
    instead of overwriting a sibling edit. Empty / null = legacy
    last-write-wins behaviour. The new tar's hash is always
    computed server-side from the bytes — passing the editor's
    "expected" hash through to `_do_upload_skill` would have made
    the upload short-circuit as `unchanged` (silent edit drop) or
    persist a hash that didn't match the bytes.
    """
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
    existing = (
        await db.execute(
            select(Skill).where(
                Skill.user_id == auth.user_id,
                Skill.project_id == project_id,
                Skill.skill_key == skill_key,
                Skill.is_active,
                Skill.authority == SKILL_AUTHORITY_CLOUD,
            )
        )
    ).scalar_one_or_none()
    if existing is None or not existing.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    file_key = existing.file_key
    await db.commit()
    try:
        previous = await file_store.get(file_key)
    except Exception:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This Skill's files are unavailable. Retry before editing it.",
        ) from None
    try:
        if file_key.endswith(".md"):
            previous, _ = tar_from_content(skill_key, previous.decode("utf-8"))
        existing_skill_md = extract_skill_md(previous, skill_key)
        if existing_skill_md is None:
            raise TarValidationError("Archive is missing its exact root SKILL.md")
        data, _ = replace_skill_md(
            previous,
            skill_key,
            skill_document(
                payload.name,
                payload.description,
                payload.instructions,
                existing_content=existing_skill_md,
            ),
        )
    except (SkillTextValidationError, TarValidationError, UnicodeDecodeError):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This Skill's files could not be preserved. Retry or import it again.",
        ) from None
    if len(data) > _MAX_SKILL_TAR_BYTES:
        # `content` is already capped at 200 KB by the schema, so the
        # post-tar size is effectively bounded. The check stays as a
        # defense-in-depth in case the cap ever loosens.
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"Skill tarball exceeds {_MAX_SKILL_TAR_BYTES} bytes",
        )
    # The If-Match precondition is checked INSIDE `_do_upload_skill`
    # under the same advisory lock as the upsert. Doing it here in
    # the route body would race: two concurrent saves submitting the
    # same `expected_content_hash` could both read the old row,
    # both pass the check, then sequence into the lock and the
    # second save would clobber the first instead of returning 412.
    return await _do_upload_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        data=data,
        content_hash=None,
        expected_content_hash=payload.content_hash,
    )


async def _do_upload_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    skill_key: str,
    data: bytes,
    content_hash: str | None,
    expected_content_hash: str | None = None,
    create_only: bool = False,
    authority: str = SKILL_AUTHORITY_CLOUD,
    authority_agent_id: UUID | None = None,
) -> SkillUploadResponse:
    """Validate and persist a Cloud row or Agent filesystem projection.

    Authority and Agent/Project identity are revalidated inside the write
    transaction. A hash short-circuit avoids cosmetic version bumps on
    byte-identical re-uploads, while an authenticated same-byte Agent claim
    still updates durable provenance.
    """
    # Reserved-suffix guard: refuse keys whose last segment
    # collides with a routing suffix (`download`, `content`,
    # `install`). Pre-fix a key like `team/download` was
    # writeable but unreachable at GET time — Starlette
    # matched the `/{skill_key:path}/download` route first
    # with `skill_key="team"` and the bare detail handler
    # never saw the real key. Path/Form validators don't
    # express this constraint cleanly so we re-check here.
    if has_reserved_skill_key_suffix(skill_key):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"skill_key cannot end with reserved suffix "
            f"({', '.join(sorted(RESERVED_SKILL_KEY_SUFFIXES))})",
        )
    try:
        file_count = validate_tar(data)
    except TarValidationError as e:
        # `str(e)` echoes raw tar member names (attacker-controlled)
        # back to the client. Log internally, return a fixed message.
        log.warning(
            "skill_upload_validation_failed user=%s skill_key=%s error=%s",
            auth.user_id,
            skill_key,
            _sanitize_log(e),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "archive validation failed") from None

    # The archive's directory layout MUST be rooted at the
    # declared skill_key. For a nested key `category/foo` we
    # require every tar entry to start with `category/foo/`. Pre-
    # fix the upload silently accepted an archive rooted at
    # `foo/...` for `skill_key=category/foo`: the hash stripped 2
    # leading components leaving an empty / wrong tree, the bytes
    # were stored as-is, and a later download/extract on another
    # machine plopped `foo/` at the skills root instead of
    # `category/foo/` — breaking restore.
    expected_prefix = f"{skill_key}/"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        for member in tf.getmembers():
            # Pure directory entries (no slash, member.name == skill_key)
            # are also accepted — the actual files always carry the
            # full prefix.
            if member.name == skill_key:
                continue
            if not member.name.startswith(expected_prefix):
                log.warning(
                    "skill_upload_root_mismatch user=%s skill_key=%s offending=%s",
                    auth.user_id,
                    skill_key,
                    _sanitize_log(member.name),
                )
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "archive root does not match skill_key",
                )

    skill_md = extract_skill_md(data)
    if not skill_md:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Archive must contain a SKILL.md")

    try:
        fm = parse_frontmatter(skill_md)
    except SkillTextValidationError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_skill_text",
                "message": "SKILL.md must not contain NUL characters.",
            },
        ) from None
    name = fm.get("name", skill_key)
    description = fm.get("description", "")

    # The server is the integrity boundary. A caller-supplied hash is useful
    # for catching client bugs but never becomes evidence by itself: an Agent
    # claim must prove that the validated archive bytes equal the claimed
    # content or a forged existing hash could claim without storing new bytes.
    computed_content_hash = _compute_file_tree_hash(data, skill_key)
    if content_hash is not None and content_hash != computed_content_hash:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "skill_content_hash_mismatch",
                "message": "content_hash does not match the uploaded Skill archive.",
            },
        )
    content_hash = computed_content_hash

    async def assert_write_boundary() -> None:
        if authority == SKILL_AUTHORITY_AGENT_SYNC:
            if authority_agent_id is None:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "Agent sync authority is missing",
                )
            current_project_id = await _agent_sync_project(
                db,
                auth,
                authority_agent_id,
                lock_agent=True,
            )
            if current_project_id != project_id:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail={
                        "code": "agent_project_changed",
                        "message": (
                            "The Agent Project changed while this Skill was uploading; retry."
                        ),
                    },
                )
            await assert_agent_workspace_skill_write_compatible(
                db,
                agent_id=authority_agent_id,
                skill_keys={skill_key},
            )
            return
        await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
        await assert_project_skill_write_compatible(
            db,
            project_id=project_id,
            skill_key=skill_key,
        )
        # Project archive can cross the initial authorization read while the
        # archive is being validated. Re-check after the Project graph lock.
        await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)

    # Reject known authority/collision failures before creating even an
    # unreachable object, then release Project/Agent/row locks before storage
    # I/O. The immutable key makes a race-loser orphan safe and reusable.
    await assert_write_boundary()
    await db.commit()
    fk = _file_key(auth.user_id, project_id, skill_key, content_hash)
    await file_store.put(fk, data)

    # The graph may change while object storage is in flight. Re-acquire the
    # canonical Project -> Agent lock order and fail before any row mutation.
    await assert_write_boundary()

    # Serialize concurrent writes for this (user, project, skill_key)
    # via a Postgres advisory lock keyed on the same identity as
    # the partial unique index. Two projects can hold the same
    # skill_key in parallel; the lock is per-(user,project,key) so
    # they don't block each other.
    lock_key = project_skill_advisory_lock_key(auth.user_id, project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})
    await assert_project_skill_not_runtime_managed(
        db, user_id=auth.user_id, project_id=project_id, skill_key=skill_key
    )

    # Pre-fetch the existing row so we can skip the upsert when the immutable
    # object identity is unchanged and prevent a cosmetic version+1 bump.
    #
    # `is_active` filter is load-bearing: the duplicate-cleanup
    # migration soft-deletes legacy rows for the same
    # (user, project, skill_key) instead of hard-deleting them.
    # `scalar_one_or_none()` on the unfiltered query would raise
    # MultipleResultsFound for any user who survived the migration
    # with inactive duplicates — every subsequent upload would 500.
    # Order by `created_at DESC` for tie-stability if multiple active
    # rows ever slip past the partial unique index.
    existing_result = await db.execute(
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.project_id == project_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
        .order_by(Skill.created_at.desc())
        .limit(1)
    )
    existing = existing_result.scalar_one_or_none()

    if create_only and existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "skill_name_conflict",
                "message": f'A Skill named "{skill_key}" already exists in this Project.',
            },
        )

    if existing is not None:
        if authority == SKILL_AUTHORITY_CLOUD and existing.authority != SKILL_AUTHORITY_CLOUD:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "agent_synced_skill_read_only",
                    "message": (
                        "This Skill is owned by an Agent filesystem and cannot be changed "
                        "through Cloud mutation routes."
                    ),
                },
            )
        if (
            authority == SKILL_AUTHORITY_AGENT_SYNC
            and existing.authority == SKILL_AUTHORITY_AGENT_SYNC
            and existing.authority_agent_id != authority_agent_id
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "agent_sync_owner_conflict",
                    "message": "Another Agent owns this Skill projection.",
                },
            )

    # If-Match precondition (dashboard editor passes the hash it
    # saw when it loaded the skill). Done HERE under the advisory
    # lock so two concurrent saves with the same expected hash
    # serialise — second writer compares against the first
    # writer's committed row and 412s instead of clobbering.
    if (
        expected_content_hash
        and existing is not None
        and existing.content_hash != expected_content_hash
    ):
        raise HTTPException(
            status.HTTP_412_PRECONDITION_FAILED,
            detail={
                "code": "stale_content",
                "message": (
                    "Skill content changed since the editor opened. "
                    "Reload to pick up the latest version, then re-apply "
                    "your edits."
                ),
                "current_content_hash": existing.content_hash,
            },
        )

    if existing and existing.content_hash == content_hash and existing.is_active:
        # Mirror the guard in `_upsert_skill` (line ~547). Without
        # `is_active`, a daemon re-uploading byte-identical bytes
        # into a soft-deleted row would short-circuit here, return
        # 200, and the row would stay invisible to /v1/skills
        # forever — silent reactivation failure. The full upsert
        # path below correctly flips is_active back on, but only
        # if we let it run.
        projection_changed = (
            existing.authority != authority
            or existing.authority_agent_id != authority_agent_id
            or (
                authority == SKILL_AUTHORITY_AGENT_SYNC
                and (
                    existing.name != name
                    or existing.description != description
                    or existing.file_count != file_count
                    or existing.source != SKILL_AUTHORITY_AGENT_SYNC
                    or existing.source_repo is not None
                )
            )
        )
        if projection_changed:
            # An authenticated Agent report is ownership evidence even when
            # the bytes did not change. Persist the claim and revision under
            # the same advisory lock; otherwise legacy cloud rows could never
            # transition to the fail-closed agent-authoritative model.
            existing.authority = authority
            existing.authority_agent_id = authority_agent_id
            if authority == SKILL_AUTHORITY_AGENT_SYNC:
                existing.name = name
                existing.description = description
                existing.file_count = file_count
                existing.source = SKILL_AUTHORITY_AGENT_SYNC
                existing.source_repo = None
            await bump_skills_revision(
                db,
                auth.user_id,
                skill_key=skill_key,
                project_id=project_id,
                event_type=(
                    AGENT_SKILL_CHANGED_EVENT
                    if authority == SKILL_AUTHORITY_AGENT_SYNC
                    else "skill_changed"
                ),
                content_hash=content_hash,
            )
            await db.commit()
        return SkillUploadResponse(
            skill_key=existing.skill_key,
            name=existing.name,
            version=existing.version,
            file_count=file_count,
            content_hash=existing.content_hash,
        )

    skill = await _upsert_skill(
        db,
        user_id=auth.user_id,
        project_id=project_id,
        skill_key=skill_key,
        name=name,
        description=description,
        content_hash=content_hash,
        file_key=fk,
        file_count=file_count,
        source=(SKILL_AUTHORITY_AGENT_SYNC if authority == SKILL_AUTHORITY_AGENT_SYNC else "local"),
        source_repo=None,
        authority=authority,
        authority_agent_id=authority_agent_id,
    )
    # Single commit at the route boundary — _upsert_skill now
    # only flushes, so the advisory lock acquired at line 317
    # holds across the upsert + revision bump and is released
    # only when this commit lands.
    await db.commit()

    return SkillUploadResponse(
        skill_key=skill.skill_key,
        name=skill.name,
        version=skill.version,
        file_count=file_count,
        content_hash=skill.content_hash,
    )


# ---------------------------------------------------------------------------
# Download (tar.gz)
# ---------------------------------------------------------------------------


@router.get("/{skill_key:path}/download")
async def download_skill_legacy(
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    """Phase-1 compat download — multi-project disambiguation by
    most-recently-updated. Replaced by
    `/v1/projects/{project_id}/skills/{skill_key}/download`."""
    visible_project_ids = await project_ids_visible_to(db, auth)
    skill = await _resolve_legacy_skill(db, auth, visible_project_ids, skill_key)
    await _enforce_agent_project_download_protocol(
        db,
        auth,
        skill.project_id,
        skill_sync_protocol,
    )
    return await _build_skill_download(skill, skill_key, db)


@project_router.get("/{skill_key:path}/download")
async def download_skill_project(
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    """Phase-2 project-explicit download — exact (`project_id`, `skill_key`)
    lookup, no disambiguation.

    Reads are permitted to viewer members (recipients) — the validator
    accepts any project in `project_ids_visible_to(auth)`, which now
    includes ProjectMembership rows. The Skill row lookup no longer
    filters by `user_id` since membership-granted reads pull from
    the owner's skills, not the caller's. Write paths (upload,
    delete) still gate on `validate_project_for_caller`, which stays
    owner-only.
    """
    return await _get_project_skill_download(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        skill_sync_protocol=skill_sync_protocol,
    )


@scope_router.get("/{skill_key:path}/download")
async def download_skill_scope_compat(
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    return await _get_project_skill_download(
        db=db,
        auth=auth,
        project_id=scope_id,
        skill_key=skill_key,
        skill_sync_protocol=skill_sync_protocol,
    )


# NOTE: bare-key GETs declared AFTER `/{skill_key:path}/download` so
# the download route's regex `^/(?P<skill_key>.*)/download$` is tried
# first. Without this ordering a URL like `/foo/bar/download` would
# greedy-match the bare GET as `skill_key="foo/bar/download"`, then
# the bare handler would 404 (no such skill) instead of fanning out
# to download_skill_legacy. FastAPI/Starlette does NOT reorder by
# specificity — declaration order is the contract.
@router.get("/{skill_key:path}")
async def get_skill_legacy(
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    """Phase-1 compat detail — multi-project disambiguation by
    most-recently-updated. Replaced by
    `/v1/projects/{project_id}/skills/{skill_key}` in phase 2 for
    callers that know which project they want."""
    visible_project_ids = await project_ids_visible_to(db, auth)
    skill = await _resolve_legacy_skill(db, auth, visible_project_ids, skill_key)
    return await _build_skill_detail(skill, db)


@project_router.get("/{skill_key:path}")
async def get_skill_project(
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    """Phase-2 project-explicit detail. Returns exactly the row at
    (`project_id`, `skill_key`) — no multi-project disambiguation needed
    because the URL pins the project.

    Like download, detail is a read path: viewer members may read
    shared-project skill metadata/content, while write paths stay
    owner-only via `validate_project_for_caller`.
    """
    return await _get_project_skill_detail(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
    )


@scope_router.get("/{skill_key:path}")
async def get_skill_scope_compat(
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    return await _get_project_skill_detail(
        db=db,
        auth=auth,
        project_id=scope_id,
        skill_key=skill_key,
    )


async def _get_project_skill_download(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    skill_key: str,
    skill_sync_protocol: str | None,
) -> Response:
    await _enforce_agent_project_download_protocol(
        db,
        auth,
        project_id,
        skill_sync_protocol,
    )
    skill = await _get_project_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
    )
    return await _build_skill_download(skill, skill_key, db)


async def _enforce_agent_project_download_protocol(
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    skill_sync_protocol: str | None,
) -> None:
    if not auth.is_cli and not auth.oauth_cli:
        return
    project_kind = (
        await db.execute(select(Project.kind).where(Project.id == project_id))
    ).scalar_one_or_none()
    if (
        project_kind == PROJECT_KIND_ENVIRONMENT
        and resolve_skill_sync_protocol(skill_sync_protocol)
        == SkillSyncProtocol.AGENT_AUTHORITATIVE_V1
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_project_download_forbidden",
                "message": (
                    "Agent Project Skills are filesystem-authoritative and cannot be "
                    "downloaded into an Agent by Cloud sync."
                ),
            },
        )


async def _get_project_skill_detail(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    skill_key: str,
) -> SkillDetailResponse:
    skill = await _get_project_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
    )
    return await _build_skill_detail(skill, db)


async def _get_project_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    skill_key: str,
) -> Skill:
    await validate_project_read_for_caller(db, auth, project_id)
    result = await db.execute(
        select(Skill).where(
            Skill.project_id == project_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return skill


async def _build_skill_download(
    skill: Skill,
    skill_key: str,
    db: AsyncSession | None = None,
) -> Response:
    file_key = skill.file_key
    if not file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    if db is not None:
        await db.commit()
    try:
        data = await file_store.get(file_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found") from None

    # If stored as old .md format, wrap into tar.gz on the fly
    if file_key.endswith(".md"):
        content = data.decode("utf-8")
        data, _ = tar_from_content(skill_key, content)

    return Response(
        content=data,
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{skill_key}.tar.gz"'},
    )


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


@agent_router.delete(
    "/sync/{skill_key:path}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_agent_synced_skill(
    agent_id: UUID,
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    project_id: UUID | None = Query(
        default=None,
        description=(
            "Project fence recorded when the Agent projection was claimed. "
            "Omit only for legacy clients deleting from the current Agent Project."
        ),
    ),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> Response:
    await _do_delete_agent_synced_skill(
        db=db,
        auth=auth,
        agent_id=agent_id,
        project_id=project_id,
        skill_key=skill_key,
    )
    # The desired projection is absence. Both the first successful delete and
    # a replay after a lost response use the same bodyless success contract;
    # identity failures remain fail-closed 404/409 responses above.
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _do_delete_agent_synced_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    agent_id: UUID,
    project_id: UUID | None,
    skill_key: str,
    expected_content_hash: str | None = None,
) -> SkillDeleteResponse:
    current_project_id = await _agent_sync_project(db, auth, agent_id, lock_agent=True)
    target_project_id = project_id or current_project_id
    lock_key = project_skill_advisory_lock_key(auth.user_id, target_project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})
    skill = (
        await db.execute(
            select(Skill)
            .where(
                Skill.user_id == auth.user_id,
                Skill.project_id == target_project_id,
                Skill.skill_key == skill_key,
                Skill.is_active,
            )
            .order_by(Skill.created_at.desc())
            .limit(1)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if skill is None:
        # Durable delete queues retry after reconnect and may replay an item
        # whose earlier response was lost. Absence is the desired projection.
        await db.commit()
        return SkillDeleteResponse(status="deleted")
    if skill.authority == SKILL_AUTHORITY_AGENT_SYNC:
        if skill.authority_agent_id != agent_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={
                    "code": "agent_sync_owner_conflict",
                    "message": "Another Agent owns this Skill projection.",
                },
            )
    elif target_project_id != current_project_id:
        # Reporting local absence is migration evidence for a legacy Cloud row
        # only while the target remains this Agent's current Project. A stamped
        # old Project fence may clean up rows already claimed by this Agent, but
        # must not become authority to delete arbitrary historical Cloud rows.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_sync_old_project_unclaimed",
                "message": (
                    "The old Project row was not claimed by this Agent and cannot be deleted "
                    "through Agent sync."
                ),
            },
        )
    if expected_content_hash is not None and skill.content_hash != expected_content_hash:
        raise HTTPException(
            status.HTTP_412_PRECONDITION_FAILED,
            detail={
                "code": "stale_content",
                "message": (
                    "Skill content changed since it was loaded. Reload it, then try again."
                ),
                "current_content_hash": skill.content_hash,
            },
        )
    skill.is_active = False
    await bump_skills_revision(
        db,
        auth.user_id,
        skill_key=skill_key,
        project_id=target_project_id,
        event_type=AGENT_SKILL_DELETED_EVENT,
    )
    await db.commit()
    return SkillDeleteResponse(status="deleted")


@router.delete("/{skill_key:path}")
async def delete_skill_legacy(
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    """Safely serve released slug-only clients with an Agent-bound identity.

    Only an env-bound API key identifies exactly one Agent and its current
    Agent Project. User-level API keys, OAuth CLI sessions, and browser sessions
    remain ambiguous and receive the historical 410 instead of resolving a
    most-recently-active Project.
    """
    key = auth.api_key
    if not auth.is_cli or key is None or key.environment_id is None:
        raise HTTPException(
            status.HTTP_410_GONE,
            detail={
                "code": "project_explicit_route_required",
                "message": (
                    "Use DELETE /v1/projects/{project_id}/skills/{skill_key} — "
                    "call GET /v1/skills to find the project_id of the row "
                    "you want to delete."
                ),
            },
        )
    resolve_skill_sync_protocol(skill_sync_protocol)
    return await _do_delete_agent_synced_skill(
        db=db,
        auth=auth,
        agent_id=key.environment_id,
        project_id=None,
        skill_key=skill_key,
    )


@project_router.delete("/{skill_key:path}")
async def delete_skill_project(
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    expected_content_hash: str | None = Query(
        default=None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
        description="Delete only if the active Skill still has this content hash.",
    ),
    skill_sync_protocol: str | None = Header(default=None, alias=SKILL_SYNC_PROTOCOL_HEADER),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    """Phase-2 project-explicit delete — only the named project's copy
    is deleted; the same skill_key in other projects is unaffected."""
    authority, authority_agent_id = await _project_upload_authority(
        db,
        auth,
        project_id,
        allow_agent_alias=True,
        skill_sync_protocol=skill_sync_protocol,
    )
    if authority == SKILL_AUTHORITY_AGENT_SYNC:
        if authority_agent_id is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Agent identity is unavailable")
        return await _do_delete_agent_synced_skill(
            db=db,
            auth=auth,
            agent_id=authority_agent_id,
            project_id=project_id,
            skill_key=skill_key,
            expected_content_hash=expected_content_hash,
        )
    return await _do_delete_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
        expected_content_hash=expected_content_hash,
    )


async def _do_delete_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    skill_key: str,
    expected_content_hash: str | None = None,
) -> SkillDeleteResponse:
    # Advisory lock matches the partial unique index identity, so
    # this delete serializes with any concurrent write to the
    # same (user, project, skill_key).
    await assert_project_skill_write_compatible(
        db,
        project_id=project_id,
        skill_key=skill_key,
        enforce_total_limit=False,
    )
    lock_key = project_skill_advisory_lock_key(auth.user_id, project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)

    # `is_active` filter + ORDER BY + LIMIT 1: third call site of
    # the same migration-survivor pattern. Accounts that came
    # through the duplicate-cleanup migration with soft-deleted
    # rows under the same (user, project, skill_key) would otherwise
    # 500 on uninstall via MultipleResultsFound.
    result = await db.execute(
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.project_id == project_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
        .order_by(Skill.created_at.desc())
        .limit(1)
        .with_for_update()
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    if skill.authority != SKILL_AUTHORITY_CLOUD:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_synced_skill_read_only",
                "message": (
                    "This Skill is owned by an Agent filesystem and cannot be deleted "
                    "through Cloud mutation routes."
                ),
            },
        )

    if expected_content_hash is not None and skill.content_hash != expected_content_hash:
        raise HTTPException(
            status.HTTP_412_PRECONDITION_FAILED,
            detail={
                "code": "stale_content",
                "message": (
                    "Skill content changed since it was loaded. Reload it, then try again."
                ),
                "current_content_hash": skill.content_hash,
            },
        )

    if skill.is_active:
        skill.is_active = False
        # Advance the collection ETag and publish invalidation after commit.
        # Agent Project rows never reach this Cloud-owned path; Agent daemons
        # do not delete filesystem content in response to Cloud events.
        await bump_skills_revision(
            db,
            auth.user_id,
            skill_key=skill_key,
            project_id=project_id,
            event_type="skill_deleted",
        )
    await db.commit()
    return SkillDeleteResponse(status="deleted")


# ---------------------------------------------------------------------------
# Install from GitHub
# ---------------------------------------------------------------------------


@router.post("/install")
async def install_skill_legacy(
    body: SkillInstallRequest,
    response: Response,
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillInstallResponse:
    """Back-compat shim for pre-PR-66 CLI binaries. Resolves
    target project via `resolve_default_write_project` (same
    deterministic default-project policy as `upload_skill_legacy`).
    A wrong-project install adds a stray row to the dashboard
    listing — recoverable, not destructive — so this stays
    soft-deprecated rather than 410'd."""
    project_id = await resolve_default_write_project(db, auth)
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "Wed, 31 Dec 2026 00:00:00 GMT"
    response.headers["Link"] = '</v1/projects/{project_id}/skills/install>; rel="successor-version"'
    return await _do_install_skill(db=db, auth=auth, project_id=project_id, body=body)


@project_router.post("/install")
async def install_skill_project(
    body: SkillInstallRequest,
    project_id: UUID = Path(...),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillInstallResponse:
    """Phase-2 project-explicit install — install lands in the
    URL-named project. Used by the dashboard install picker
    (phase 3) and any caller that knows which project it wants."""
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
    return await _do_install_skill(db=db, auth=auth, project_id=project_id, body=body)


async def _do_install_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id: UUID,
    body: SkillInstallRequest,
) -> SkillInstallResponse:
    from app.services.skill_installer import fetch_skill_from_github

    # Project resolution/validation happens before this helper. Do not keep
    # that read transaction open while waiting on GitHub.
    await db.commit()

    try:
        fetched = await fetch_skill_from_github(body.repo, body.path)
    except ValueError as e:
        # Fetcher's ValueError messages can contain raw GitHub URLs
        # or HTTP-status text. Log internally, return a generic
        # message to the client.
        log.warning(
            "skill_install_fetch_failed repo=%s path=%s error=%s",
            _sanitize_log(body.repo),
            _sanitize_log(body.path),
            _sanitize_log(e),
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found in repository") from None

    try:
        validate_tar(fetched.tar_bytes)
    except TarValidationError as e:
        log.warning(
            "skill_install_validation_failed repo=%s path=%s error=%s",
            _sanitize_log(body.repo),
            _sanitize_log(body.path),
            _sanitize_log(e),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "archive validation failed") from None

    content_hash = _compute_file_tree_hash(fetched.tar_bytes)
    # The `name` comes from the marketplace SKILL.md frontmatter
    # which the user controls. A malicious `name: "../etc/passwd"`
    # would otherwise traverse the file store. Validate the derived
    # key against the same pattern the upload route enforces.
    try:
        skill_key = validate_derived_skill_key(fetched.name.lower().replace(" ", "-"))
    except SkillKeyValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from None
    fk = _file_key(auth.user_id, project_id, skill_key, content_hash)

    # Fail predictable graph conflicts before object I/O, then release the
    # Project/Agent locks. The second check below closes races after the
    # immutable object has been written.
    await assert_project_skill_write_compatible(
        db,
        project_id=project_id,
        skill_key=skill_key,
    )
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
    await db.commit()
    await file_store.put(fk, fetched.tar_bytes)

    # Same advisory lock pattern as upload_skill. Lock identity
    # (user, project, key) matches the partial unique index, so the
    # serialization is precisely scoped — different projects don't
    # block each other.
    await assert_project_skill_write_compatible(
        db,
        project_id=project_id,
        skill_key=skill_key,
    )
    lock_key = project_skill_advisory_lock_key(auth.user_id, project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})
    # Project ownership/kind can change while GitHub is fetched. Re-check at
    # the write boundary under the same per-Skill lock used by uploads.
    await _project_upload_authority(db, auth, project_id, allow_agent_alias=False)
    await assert_project_skill_not_runtime_managed(
        db, user_id=auth.user_id, project_id=project_id, skill_key=skill_key
    )

    existing = (
        await db.execute(
            select(Skill)
            .where(
                Skill.user_id == auth.user_id,
                Skill.project_id == project_id,
                Skill.skill_key == skill_key,
                Skill.is_active,
            )
            .order_by(Skill.created_at.desc())
            .limit(1)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if existing is not None and existing.authority != SKILL_AUTHORITY_CLOUD:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "agent_synced_skill_read_only",
                "message": (
                    "This Skill is owned by an Agent filesystem and cannot be changed "
                    "through Cloud mutation routes."
                ),
            },
        )

    skill = await _upsert_skill(
        db,
        user_id=auth.user_id,
        project_id=project_id,
        skill_key=skill_key,
        name=fetched.name,
        description=fetched.description,
        content_hash=content_hash,
        file_key=fk,
        file_count=fetched.file_count,
        source="marketplace",
        source_repo=body.repo,
    )
    # Single commit at the route boundary — see upload_skill.
    await db.commit()

    return SkillInstallResponse(
        skill_key=skill_key,
        name=fetched.name,
        description=fetched.description,
        version=skill.version,
        file_count=fetched.file_count,
        repo=body.repo,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _upsert_skill(
    db: AsyncSession,
    *,
    user_id: UUID,
    project_id: UUID,
    skill_key: str,
    name: str,
    description: str,
    content_hash: str,
    file_key: str,
    file_count: int,
    source: str,
    source_repo: str | None,
    authority: str = SKILL_AUTHORITY_CLOUD,
    authority_agent_id: UUID | None = None,
) -> Skill:
    """Upsert the Skill row + bump revision. Caller commits.

    Previously committed internally; that broke the conflict-resolve
    flow because the commit released the advisory lock and the
    SELECT FOR UPDATE row-lock before `conflict.resolved_at` was
    written. Two parallel "use mine" clicks could both pass the
    `resolved_at IS NULL` guard and double-write file_store.
    Lifting the commit to the route lets every helper write land
    in a single atomic transaction under the same lock.

    Reads `existing` with SELECT FOR UPDATE so concurrent writes to
    the same (user_id, skill_key) serialize on the row even if a
    caller forgets the advisory lock — defense in depth.
    """
    # Identity is (user_id, project_id, skill_key) — same shape as
    # the partial unique index. Two projects can hold the same
    # skill_key without conflict; the lookup must filter by all
    # three. `is_active` filter + ORDER BY + LIMIT 1 prevents
    # MultipleResultsFound for accounts that came through the
    # duplicate-cleanup migration with soft-deleted siblings under
    # the same identity (the route-level pre-fetch was hardened
    # earlier for the same reason; this is the upsert path).
    result = await db.execute(
        select(Skill)
        .where(
            Skill.user_id == user_id,
            Skill.project_id == project_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
        .order_by(Skill.created_at.desc())
        .limit(1)
        .with_for_update()
    )
    skill = result.scalar_one_or_none()

    if skill:
        if (
            skill.content_hash == content_hash
            and skill.is_active
            and skill.authority == authority
            and skill.authority_agent_id == authority_agent_id
        ):
            # Defense in depth — even if the upload endpoint's pre-fetch
            # gets bypassed by a future caller, the upsert won't bump
            # `version + 1` or refresh fields when nothing changed.
            # `updated_at` only advances on actual UPDATE statements
            # (TimestampMixin's `onupdate`), so an early return preserves
            # the original timestamp too.
            #
            # The `is_active` guard catches re-uploads of byte-identical
            # content into a soft-deleted row. For Agent projections this
            # is the local delete-then-recreate lifecycle; Cloud-owned rows
            # can likewise be explicitly re-uploaded. Treat either as a true
            # reactivation instead of leaving the listing stale.
            return skill
        skill.name = name
        skill.description = description
        skill.content_hash = content_hash
        skill.file_key = file_key
        skill.file_count = file_count
        skill.source = source
        skill.source_repo = source_repo
        skill.authority = authority
        skill.authority_agent_id = authority_agent_id
        skill.is_active = True
        skill.version = skill.version + 1
    else:
        skill = Skill(
            user_id=user_id,
            project_id=project_id,
            skill_key=skill_key,
            name=name,
            description=description,
            content_hash=content_hash,
            file_key=file_key,
            file_count=file_count,
            source=source,
            source_repo=source_repo,
            authority=authority,
            authority_agent_id=authority_agent_id,
        )
        db.add(skill)

    # Bump collection ETag + queue SSE fan-out in the same
    # transaction so a rollback unwinds both. Caller commits.
    # `project_id` rides on the event so the broker can filter
    # subscribers to only those with read access to this project.
    # `content_hash` remains on the event for released-client diagnostics.
    # Agent-authoritative daemons treat the event only as an invalidation,
    # rescan local bytes, and update the Cloud projection if needed.
    await bump_skills_revision(
        db,
        user_id,
        skill_key=skill_key,
        project_id=project_id,
        event_type=(
            AGENT_SKILL_CHANGED_EVENT
            if authority == SKILL_AUTHORITY_AGENT_SYNC
            else "skill_changed"
        ),
        content_hash=content_hash,
    )
    await db.flush()
    return skill
