import hashlib
import io
import logging
import tarfile
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
from app.models.skill import Skill
from app.schemas.common import Paginated
from app.schemas.skill import (
    SkillContentUpdateRequest,
    SkillDeleteResponse,
    SkillDetailResponse,
    SkillInstallRequest,
    SkillInstallResponse,
    SkillSummaryResponse,
    SkillUploadResponse,
)
from app.services.file_store import get_file_store
from app.services.sync_events import bump_skills_revision
from app.services.tar_utils import (
    TarValidationError,
    extract_skill_md,
    parse_frontmatter,
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


def _file_key(user_id, project_id, skill_key: str) -> str:
    """Storage path for a skill tarball. Includes project_id so
    different projects' same-named skills don't clobber each other
    in object storage. Migration 8a3e5f7b2c1d rewrote pre-existing
    paths to this shape; new uploads use it directly.
    """
    return f"skills/{user_id}/{project_id}/{skill_key}.tar.gz"


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


def _advisory_lock_key(user_id, project_id, skill_key: str) -> int:
    """Stable 64-bit signed int derived from (user_id, project_id,
    skill_key) for `pg_advisory_xact_lock`. Postgres takes a
    bigint (signed int64) so we mask the SHA digest into that
    range.

    Lock identity matches the partial unique constraint
    (`uq_skills_active_user_project_skill_key`) so the lock
    serializes exactly the same logical resource the constraint
    enforces.
    """
    h = hashlib.sha256(f"skill:{user_id}:{project_id}:{skill_key}".encode()).digest()
    n = int.from_bytes(h[:8], "big", signed=False)
    # Map to signed int64 via two's-complement wrap. PG accepts
    # any int64; this keeps the cast deterministic.
    if n >= 1 << 63:
        n -= 1 << 64
    return n


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
    this divergence broke nested-key dashboard edits: the stored
    `content_hash` never matched the CLI's local hash, so every
    reconcile re-pulled the same bytes and echo suppression on SSE
    failed. Passing `skill_key=None` (legacy callers / marketplace
    install on flat keys) keeps the strip-one behavior.

    Used in two places:
    - `upload_skill` fallback when the client (CLI <= 0.3.3) doesn't send
      `content_hash`.
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


@router.get("")
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
            "CLI key + an explicit --environment-id, so reconcile pulls the "
            "right Project instead of the most-recently-active one."
        ),
    ),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Paginated[SkillSummaryResponse]:
    fast_response = _bound_api_key_skills_304_response(
        auth=auth,
        selected_project_id=project_id,
        if_none_match=if_none_match,
    )
    if fast_response is not None:
        return fast_response

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
) -> Paginated[SkillSummaryResponse]:
    # Collection-level ETag short-circuit: when the daemon's
    # last-seen revision matches current, return 304 with no body
    # so the 60s poll cycle costs nothing on quiet accounts.
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
    revision = auth.skills_revision
    selected_project_id = project_id
    if selected_project_id is not None:
        if auth.api_key_project_id is not None:
            visible_project_ids = (
                [selected_project_id] if selected_project_id == auth.api_key_project_id else []
            )
            visible_revision_fingerprint = await _visible_skills_revision_fingerprint(
                db,
                auth,
                visible_project_ids,
            )
        elif auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
            bound_project_id = await resolve_default_write_project(db, auth)
            visible_project_ids = (
                [selected_project_id] if selected_project_id == bound_project_id else []
            )
            visible_revision_fingerprint = await _visible_skills_revision_fingerprint(
                db,
                auth,
                visible_project_ids,
            )
        else:
            (
                visible_project_ids,
                visible_revision_fingerprint,
            ) = await _selected_project_visibility_and_revision_fingerprint(
                db,
                auth,
                selected_project_id,
            )
    else:
        # Unscoped read: full inventory across owned + shared projects.
        visible_project_ids = await project_ids_visible_to(db, auth)
        visible_revision_fingerprint = await _visible_skills_revision_fingerprint(
            db,
            auth,
            visible_project_ids,
        )
    etag = _skills_collection_etag(
        revision=revision,
        selected_project_id=selected_project_id,
        visible_project_ids=visible_project_ids,
        visible_revision_fingerprint=visible_revision_fingerprint,
    )
    if if_none_match is not None and if_none_match.strip() == etag:
        await db.commit()
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})

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
        .order_by(Skill.skill_key)
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

    # Bulk-fetch the project + machine metadata for the visible
    # skills in one query each (vs N+1). Two indexed lookups
    # against `projects.id` and `agent_environments.id`.
    from app.models.project import Project
    from app.models.session import AgentEnvironment

    project_ids_in_listing = {s.project_id for s in skills if s.project_id is not None}
    project_meta: dict = {}
    if project_ids_in_listing:
        project_rows = (
            await db.execute(
                select(Project.id, Project.name, Project.origin_environment_id).where(
                    Project.id.in_(project_ids_in_listing)
                )
            )
        ).all()
        env_ids_in_listing = {
            sid_row.origin_environment_id
            for sid_row in project_rows
            if sid_row.origin_environment_id is not None
        }
        env_meta: dict = {}
        if env_ids_in_listing:
            env_rows = (
                await db.execute(
                    select(AgentEnvironment.id, AgentEnvironment.machine_name).where(
                        AgentEnvironment.id.in_(env_ids_in_listing)
                    )
                )
            ).all()
            env_meta = {row.id: row.machine_name for row in env_rows}
        for sid_row in project_rows:
            project_meta[sid_row.id] = {
                "name": sid_row.name,
                "environment_id": sid_row.origin_environment_id,
                "machine_name": env_meta.get(sid_row.origin_environment_id),
            }

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
    # Attach the same project-bound ETag the 304 path would have
    # echoed; daemons cache the full string and replay it on the
    # next request.
    return Response(
        content=response.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag},
    )


def _bound_api_key_skills_304_response(
    *,
    auth: AuthContext,
    selected_project_id: UUID | None,
    if_none_match: str | None,
) -> Response | None:
    """Serve the hot daemon conditional-GET path without opening a DB session.

    Env-bound API keys are already narrowed by the auth snapshot to exactly one
    Agent Project (`auth.api_key_project_id`) and never see shared projects.
    Their visible-owner revision is therefore the authenticated user's cached
    `skills_revision`. That makes the 304 ETag fully derivable from the auth
    context and query parameters.

    Dashboard JWTs and unbound CLI keys still go through the DB-backed path so
    shared-project owner revisions stay part of the ETag.
    """
    if if_none_match is None or auth.api_key_project_id is None:
        return None

    if selected_project_id is not None:
        visible_project_ids = (
            [selected_project_id] if selected_project_id == auth.api_key_project_id else []
        )
    else:
        visible_project_ids = [auth.api_key_project_id]

    visible_revision_fingerprint = (
        _auth_user_skills_revision_fingerprint(auth) if visible_project_ids else "none"
    )
    etag = _skills_collection_etag(
        revision=auth.skills_revision,
        selected_project_id=selected_project_id,
        visible_project_ids=visible_project_ids,
        visible_revision_fingerprint=visible_revision_fingerprint,
    )
    if if_none_match.strip() != etag:
        return None
    return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})


def _skills_collection_etag(
    *,
    revision: int,
    selected_project_id: UUID | None,
    visible_project_ids: list[UUID],
    visible_revision_fingerprint: str,
) -> str:
    project_tag = str(selected_project_id) if selected_project_id is not None else "all"
    visible_fingerprint = _visible_project_fingerprint(visible_project_ids)
    return f'"{revision}:{project_tag}:{visible_fingerprint}:{visible_revision_fingerprint}"'


def _visible_project_fingerprint(visible_project_ids: list[UUID]) -> str:
    # Short fingerprint of the visible-project set (sorted for determinism).
    # 16 hex chars = 64 bits of collision space, well past the realistic
    # distinct-set count for any account.
    return hashlib.sha256(
        ":".join(sorted(str(s) for s in visible_project_ids)).encode()
    ).hexdigest()[:16]


def _auth_user_skills_revision_fingerprint(auth: AuthContext) -> str:
    return hashlib.sha256(f"{auth.user_id}:{auth.skills_revision}".encode()).hexdigest()[:16]


async def _selected_project_visibility_and_revision_fingerprint(
    db: AsyncSession,
    auth: AuthContext,
    selected_project_id: UUID,
) -> tuple[list[UUID], str]:
    """Validate one selected project and fetch its owner revision in one query.

    The daemon always calls `/v1/skills?project_id=<env-project>`. For unbound
    CLI keys and dashboard JWTs, the old path loaded the caller's full visible
    project set and then ran a second owner-revision query even though the
    representation is scoped to one project. This keeps the same read policy
    (owned OR shared membership) but collapses the hot conditional-GET path to
    one indexed lookup.
    """
    from app.models.project import Project
    from app.models.project_membership import ProjectMembership
    from app.models.user import User

    row = (
        await db.execute(
            select(Project.user_id, User.skills_revision)
            .join(User, User.id == Project.user_id)
            .outerjoin(
                ProjectMembership,
                and_(
                    ProjectMembership.project_id == Project.id,
                    ProjectMembership.member_user_id == auth.user_id,
                ),
            )
            .where(
                Project.id == selected_project_id,
                or_(
                    Project.user_id == auth.user_id,
                    ProjectMembership.member_user_id.is_not(None),
                ),
            )
        )
    ).first()
    if row is None:
        return [], "none"
    return [selected_project_id], _owner_skills_revision_fingerprint(
        row.user_id,
        row.skills_revision,
    )


def _owner_skills_revision_fingerprint(owner_id: UUID, skills_revision: int | None) -> str:
    return hashlib.sha256(f"{owner_id}:{int(skills_revision or 0)}".encode()).hexdigest()[:16]


async def _resolve_legacy_skill(
    db: AsyncSession,
    auth: AuthContext,
    visible_project_ids: list,
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


async def _visible_skills_revision_fingerprint(
    db: AsyncSession,
    auth: AuthContext,
    visible_project_ids: list,
) -> str:
    """Fingerprint skill revisions for every owner represented in
    the caller's visible project set.

    `users.skills_revision` is bumped on the owner account when a skill
    changes. For shared projects, the recipient's own revision does not
    move, so an ETag based only on `auth.user_id` would incorrectly 304
    after the owner updated shared content. Hashing the visible projects'
    owner revisions keeps conditional GETs correct without adding a new
    project-level revision table in this PR.
    """
    if not visible_project_ids:
        return "none"

    if auth.api_key_project_id is not None and set(visible_project_ids) == {
        auth.api_key_project_id
    }:
        return _auth_user_skills_revision_fingerprint(auth)

    from app.models.project import Project
    from app.models.user import User

    rows = (
        await db.execute(
            select(Project.user_id, User.skills_revision)
            .join(User, User.id == Project.user_id)
            .where(Project.id.in_(visible_project_ids))
        )
    ).all()
    parts = sorted(f"{owner_id}:{int(revision or 0)}" for owner_id, revision in rows)
    return hashlib.sha256(":".join(parts).encode()).hexdigest()[:16]


async def _build_skill_detail(skill: Skill, db: AsyncSession | None = None) -> SkillDetailResponse:
    skill_id = str(skill.id)
    skill_key = skill.skill_key
    name = skill.name
    description = skill.description
    version = skill.version
    source = skill.source
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
    project_id_str: str | None = str(project_id) if project_id else None
    project_name: str | None = None
    machine_name: str | None = None
    environment_id: str | None = None
    if db is not None and project_id is not None:
        from app.models.project import Project
        from app.models.session import AgentEnvironment

        project_row = (
            await db.execute(
                select(Project.name, Project.origin_environment_id).where(Project.id == project_id)
            )
        ).first()
        if project_row is not None:
            project_name = project_row.name
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
        source_repo=source_repo,
        file_count=file_count,
        content=content,
        agent_types=agent_types,
        created_at=created_at,
        content_hash=content_hash,
        updated_at=updated_at,
        project_id=project_id_str,
        project_name=project_name,
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

    Asymmetric with `delete_skill_legacy` (which 410s) by design:
    a wrong-project upload creates a stray row visible in the
    dashboard listing, recoverable in 30s by re-uploading to the
    correct project. A wrong-project DELETE is permanent data loss.
    """
    project_id = await resolve_default_write_project(db, auth)
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
    )


# Hard cap on skill tarball size. Skills are tiny in practice
# (SKILL.md + a handful of references); 25 MB is generous and
# tighter than the global `BodySizeLimitMiddleware` cap so the
# tighter route-specific limit applies on top. Defense-in-depth
# for chunked uploads (no Content-Length) where the middleware
# can't reject early.
_MAX_SKILL_TAR_BYTES = 25 * 1024 * 1024


@project_router.post("/upload")
async def upload_skill_project(
    project_id: UUID = Path(...),
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
    """Project-explicit tar.gz skill upload.

    The URL carries the target Project; one Agent writes to one Agent Project,
    so daemon writes always land in the expected Project. The
    dashboard's content editor uses `PUT /skills/{key}/content`
    instead (raw markdown, server-side tar). Both converge on
    `_do_upload_skill`, which serializes via a Postgres advisory
    lock keyed on (user, project, skill_key); concurrent writes are
    last-write-wins. SSE then fans out to subscribed daemons.
    """
    await validate_project_for_caller(db, auth, project_id)
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
    )


# Dashboard editor entry point. Takes raw SKILL.md text (the editor
# shows the full file including frontmatter), tars it server-side,
# then runs the same upload pipeline as a daemon push. Sharing
# `_do_upload_skill` means: same advisory lock, same hash short-
# circuit, same SSE fan-out — daemons can't tell whether a push
# came from another machine or from the dashboard.
@project_router.put("/{skill_key:path}/content")
async def update_skill_content(
    payload: SkillContentUpdateRequest,
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Edit a skill's SKILL.md from the dashboard.

    Body is JSON `{content, content_hash?}`. The server wraps the
    text into a one-file tar.gz and dispatches through the same
    `_do_upload_skill` path as `POST /skills/upload`, so daemons
    receiving the resulting SSE event can't distinguish dashboard
    edits from CLI pushes.

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
    await validate_project_for_caller(db, auth, project_id)
    await db.commit()
    data, _ = tar_from_content(skill_key, payload.content)
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
    project_id,
    skill_key: str,
    data: bytes,
    content_hash: str | None,
    expected_content_hash: str | None = None,
) -> SkillUploadResponse:
    """Core upload logic for `POST /v1/projects/{project_id}/skills/upload`.

    One Agent writes to one Agent Project, so daemon writes always land
    in the expected Project. Single writer means no cross-machine race; no If-Match,
    no conflict stash. The pre-fetch / hash short-circuit below
    still saves an R2/S3 PUT and avoids cosmetic version+1 bumps
    on byte-identical re-uploads.
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

    fm = parse_frontmatter(skill_md)
    name = fm.get("name", skill_key)
    description = fm.get("description", "")

    if content_hash is None:
        # Pass skill_key so the hash strips the right number of
        # leading segments — nested Hermes keys (`category/foo`)
        # need TWO segments stripped to land on the CLI-side
        # `SKILL.md` relative path. Without this the dashboard
        # edit's recomputed hash drifts from the CLI's local hash
        # and reconcile loops re-pull forever.
        content_hash = _compute_file_tree_hash(data, skill_key)

    # Serialize concurrent writes for this (user, project, skill_key)
    # via a Postgres advisory lock keyed on the same identity as
    # the partial unique index. Two projects can hold the same
    # skill_key in parallel; the lock is per-(user,project,key) so
    # they don't block each other.
    lock_key = _advisory_lock_key(auth.user_id, project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    # Pre-fetch existing row so we can skip both file_store.put AND the
    # upsert when the bytes are identical to what's already stored. Saves
    # an R2/S3 PUT and prevents the cosmetic version+1 bump.
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
        return SkillUploadResponse(
            skill_key=existing.skill_key,
            name=existing.name,
            version=existing.version,
            file_count=file_count,
            content_hash=existing.content_hash,
        )

    fk = _file_key(auth.user_id, project_id, skill_key)
    await file_store.put(fk, data)

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
        source="local",
        source_repo=None,
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
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    """Phase-1 compat download — multi-project disambiguation by
    most-recently-updated. Replaced by
    `/v1/projects/{project_id}/skills/{skill_key}/download`."""
    visible_project_ids = await project_ids_visible_to(db, auth)
    skill = await _resolve_legacy_skill(db, auth, visible_project_ids, skill_key)
    return await _build_skill_download(skill, skill_key, db)


@project_router.get("/{skill_key:path}/download")
async def download_skill_project(
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
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
    )


@scope_router.get("/{skill_key:path}/download")
async def download_skill_scope_compat(
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    return await _get_project_skill_download(
        db=db,
        auth=auth,
        project_id=scope_id,
        skill_key=skill_key,
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
) -> Response:
    skill = await _get_project_skill(
        db=db,
        auth=auth,
        project_id=project_id,
        skill_key=skill_key,
    )
    return await _build_skill_download(skill, skill_key, db)


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


@router.delete("/{skill_key:path}")
async def delete_skill_legacy(
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    """Legacy delete by slug-only is gone in phase 2. Resolving
    via `resolve_default_write_project` would silently delete
    the wrong project's copy when the caller's account holds the
    same `skill_key` in multiple projects (which the cross-project
    listing now exposes), or 404 with no useful hint when
    their default project doesn't have that key. The CLI and
    dashboard both migrated to
    `DELETE /v1/projects/{project_id}/skills/{skill_key}` and
    pass the row's own project_id; force any stale client onto
    that path with 410 instead of guessing.

    Argument unused — kept so FastAPI still parses the path
    param uniformly with sibling routes.
    """
    del skill_key
    del auth
    del db
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


@project_router.delete("/{skill_key:path}")
async def delete_skill_project(
    project_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope_short_session("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    """Phase-2 project-explicit delete — only the named project's copy
    is deleted; the same skill_key in other projects is unaffected."""
    await validate_project_for_caller(db, auth, project_id)
    return await _do_delete_skill(db=db, auth=auth, project_id=project_id, skill_key=skill_key)


async def _do_delete_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id,
    skill_key: str,
) -> SkillDeleteResponse:
    # Advisory lock matches the partial unique index identity, so
    # this delete serializes with any concurrent write to the
    # same (user, project, skill_key).
    lock_key = _advisory_lock_key(auth.user_id, project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

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

    if skill.is_active:
        skill.is_active = False
        # SSE fan-out + ETag bump in one shot. Daemons holding the
        # bound project receive `skill_deleted` immediately and
        # remove the local directory; the 60s reconcile loop is
        # the safety net for daemons that missed the event
        # (network blip, mid-reconnect).
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
    await validate_project_for_caller(db, auth, project_id)
    return await _do_install_skill(db=db, auth=auth, project_id=project_id, body=body)


async def _do_install_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    project_id,
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

    content_hash = _compute_file_tree_hash(fetched.tar_bytes)
    # The `name` comes from the marketplace SKILL.md frontmatter
    # which the user controls. A malicious `name: "../etc/passwd"`
    # would otherwise traverse the file store. Validate the derived
    # key against the same pattern the upload route enforces.
    try:
        skill_key = validate_derived_skill_key(fetched.name.lower().replace(" ", "-"))
    except SkillKeyValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from None
    fk = _file_key(auth.user_id, project_id, skill_key)

    # Same advisory lock pattern as upload_skill. Lock identity
    # (user, project, key) matches the partial unique index, so the
    # serialization is precisely scoped — different projects don't
    # block each other.
    lock_key = _advisory_lock_key(auth.user_id, project_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    await file_store.put(fk, fetched.tar_bytes)

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
    user_id,
    project_id,
    skill_key: str,
    name: str,
    description: str,
    content_hash: str,
    file_key: str,
    file_count: int,
    source: str,
    source_repo: str | None,
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
        if skill.content_hash == content_hash and skill.is_active:
            # Defense in depth — even if the upload endpoint's pre-fetch
            # gets bypassed by a future caller, the upsert won't bump
            # `version + 1` or refresh fields when nothing changed.
            # `updated_at` only advances on actual UPDATE statements
            # (TimestampMixin's `onupdate`), so an early return preserves
            # the original timestamp too.
            #
            # The `is_active` guard catches re-uploads of byte-identical
            # content into a soft-deleted row — without it, a user who
            # deleted a skill from the dashboard, then a daemon push
            # arrived with the same bytes, would silently keep the row
            # in deleted state and the listing would still hide the
            # skill. Treat that as a true reactivation.
            return skill
        skill.name = name
        skill.description = description
        skill.content_hash = content_hash
        skill.file_key = file_key
        skill.file_count = file_count
        skill.source = source
        if source_repo is not None:
            skill.source_repo = source_repo
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
        )
        db.add(skill)

    # Bump collection ETag + queue SSE fan-out in the same
    # transaction so a rollback unwinds both. Caller commits.
    # `project_id` rides on the event so the broker can filter
    # subscribers to only those with read access to this project.
    # `content_hash` rides on the event so the daemon can echo-
    # suppress: a skill_changed whose hash matches the daemon's
    # last-pushed hash for that key is the daemon's own upload
    # bouncing back, NOT a peer change. Pulling it would race
    # the daemon's own next watcher tick.
    await bump_skills_revision(
        db,
        user_id,
        skill_key=skill_key,
        project_id=project_id,
        event_type="skill_changed",
        content_hash=content_hash,
    )
    await db.flush()
    return skill
