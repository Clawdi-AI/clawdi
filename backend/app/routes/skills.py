import hashlib
import io
import logging
import re
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
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, require_scope
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.core.scope import (
    resolve_default_write_scope,
    scope_ids_visible_to,
    validate_scope_for_caller,
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
from app.services.sync_events import bump_skills_revision, get_skills_revision
from app.services.tar_utils import (
    TarValidationError,
    extract_skill_md,
    parse_frontmatter,
    tar_from_content,
    validate_tar,
)

router = APIRouter(prefix="/api/skills", tags=["skills"])

# Phase-2 router: scope-explicit skill routes. Same handlers as the
# legacy router; the only difference is where `scope_id` comes from
# (URL path here vs caller-resolved in the legacy router).
# Mounted in `app/main.py` alongside the legacy router. After all
# callers migrate, the legacy write paths return 410 (see step 3
# of phase 2).
scope_router = APIRouter(prefix="/api/scopes/{scope_id}/skills", tags=["skills"])

log = logging.getLogger(__name__)

file_store = get_file_store()


# `skill_key` is concatenated into a file-store path, so any '..'
# segment or empty / hidden component would let a caller escape the
# user's prefix. The pattern allows up to 4 nested path components
# joined by '/' (Hermes layouts like `category/foo/SKILL.md` need
# this — pre-fix the flat-key validator rejected nested keys with
# 422 and silently dropped them from sync). Each component:
#   - starts with [A-Za-z0-9] (rejects '.' / '..' as a component,
#     and leading-dot hidden segments)
#   - then [A-Za-z0-9._-]{0,199} (so per-component max is 200
#     chars, preserving the pre-Hermes flat-key length cap so an
#     existing skill_key longer than 100 chars doesn't suddenly
#     422)
# The leading-alphanum requirement on every component is the
# path-traversal guard — '..' as a component, or `.foo` hidden
# segments, are both rejected at the first character.
#
# TOTAL LENGTH is capped separately at `MAX_SKILL_KEY_LEN` (200,
# matching the `Skill.skill_key` column's `String(200)` width).
# Without that cap, a 4-component key could reach ~803 chars and
# pass FastAPI's `pattern` check, then fail at INSERT with a
# truncation error — accepted at validation, dead at persistence.
# Every Path/Form/Query param that captures a skill_key combines
# both `pattern=SKILL_KEY_PATTERN` AND `max_length=MAX_SKILL_KEY_LEN`
# so the 422 fires at request time, not at the DB.
SKILL_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}(/[A-Za-z0-9][A-Za-z0-9._\-]{0,199}){0,3}$"
_SKILL_KEY_RE = re.compile(SKILL_KEY_PATTERN)
MAX_SKILL_KEY_LEN = 200

# Terminal path components that conflict with route suffixes on
# `/api/skills/{skill_key:path}/*` and
# `/api/scopes/{scope_id}/skills/{skill_key:path}/*`. Starlette
# matches routes in declaration order, so `/skills/team/download`
# (a key literally named `team/download`) would resolve to the
# `/{skill_key:path}/download` GET with `skill_key="team"` — the
# bare-detail route never gets a chance to see the real key.
# Reserving these suffixes keeps the routing tree unambiguous.
# Reupping is a no-op for legitimate users; a skill named
# `notes/download` is unusual and the 400 explains how to rename.
_RESERVED_SKILL_KEY_SUFFIXES = frozenset({"download", "content", "install"})


def _has_reserved_suffix(skill_key: str) -> bool:
    """True iff the skill_key's last `/`-separated component is a
    URL suffix the routing tree owns. Always false for flat keys
    that happen to BE a reserved word (e.g. `download`) — the
    one-segment route shape can't collide with a deeper suffix.
    """
    parts = skill_key.split("/")
    return len(parts) > 1 and parts[-1] in _RESERVED_SKILL_KEY_SUFFIXES


def _validate_derived_skill_key(skill_key: str) -> str:
    """Validate a skill_key that was derived server-side (e.g. from
    a marketplace SKILL.md frontmatter). Path-component constraints
    apply to derived keys too — a malicious SKILL.md `name: "../x"`
    would otherwise reach `_file_key` and traverse the file store.
    Total-length cap mirrors `Skill.skill_key` column width
    (`String(200)`); without it a derived key could pass the regex
    check but blow up at INSERT.
    """
    if (
        len(skill_key) > MAX_SKILL_KEY_LEN
        or not _SKILL_KEY_RE.match(skill_key)
        or _has_reserved_suffix(skill_key)
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"derived skill_key {skill_key!r} is not safe for storage",
        )
    return skill_key


def _file_key(user_id, scope_id, skill_key: str) -> str:
    """Storage path for a skill tarball. Includes scope_id so
    different scopes' same-named skills don't clobber each other
    in object storage. Migration 8a3e5f7b2c1d rewrote pre-existing
    paths to this shape; new uploads use it directly.
    """
    return f"skills/{user_id}/{scope_id}/{skill_key}.tar.gz"


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
    ".next",
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
}


def _advisory_lock_key(user_id, scope_id, skill_key: str) -> int:
    """Stable 64-bit signed int derived from (user_id, scope_id,
    skill_key) for `pg_advisory_xact_lock`. Postgres takes a
    bigint (signed int64) so we mask the SHA digest into that
    range.

    Lock identity matches the partial unique constraint
    (`uq_skills_active_user_scope_skill_key`) so the lock
    serializes exactly the same logical resource the constraint
    enforces.
    """
    h = hashlib.sha256(f"skill:{user_id}:{scope_id}:{skill_key}".encode()).digest()
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
    auth: AuthContext = Depends(require_scope("skills:read")),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(default=None, description="Search name / description / skill_key"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    include_content: bool = Query(default=False),
    scope_id: UUID | None = Query(
        default=None,
        description=(
            "Optional explicit scope to list. Without it, results span every "
            "scope the caller can read (env-bound api_keys see only their env, "
            "everyone else sees all scopes). The serve daemon passes its env's "
            "default_scope_id when it boots with an unbound CLI key + an "
            "explicit --environment-id, so reconcile pulls the right scope "
            "instead of the most-recently-active one."
        ),
    ),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
) -> Paginated[SkillSummaryResponse]:
    # Collection-level ETag short-circuit: when the daemon's
    # last-seen revision matches current, return 304 with no body
    # so the 60s poll cycle costs nothing on quiet accounts.
    #
    # ETag binds (revision, scope_id query, EFFECTIVE visible
    # scope set) so a caller's representation changes whenever
    # any of those does. Round 32 covered (revision, scope_id);
    # this also folds in the visible-scope hash so an
    # env-bound key whose env's `default_scope_id` is reassigned
    # to a different scope gets a new ETag — and a 200 with the
    # new effective listing — even though `skills_revision`
    # didn't bump (the reassignment lives on
    # `agent_environments`, not `skills`).
    #
    # Scope-filtered read. JWT auth → all user's scopes
    # (dashboard sees full inventory). api_key auth → only the
    # bound env's scope (daemon doesn't see other scopes' skills
    # it can't write to). When the caller pins `scope_id`,
    # intersect with what they're allowed to see — a scope_id
    # outside that set yields a deliberately-empty listing.
    revision = await get_skills_revision(db, auth.user_id)
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    if scope_id is not None:
        visible_scope_ids = [s for s in visible_scope_ids if s == scope_id]
    scope_tag = str(scope_id) if scope_id is not None else "all"
    # Short fingerprint of the visible-scope set (sorted for
    # determinism). 16 hex chars = 64 bits of collision space —
    # one in ~10^19, well past the realistic distinct-set count
    # for any account.
    visible_fingerprint = hashlib.sha256(
        ":".join(sorted(str(s) for s in visible_scope_ids)).encode()
    ).hexdigest()[:16]
    etag = f'"{revision}:{scope_tag}:{visible_fingerprint}"'
    if if_none_match is not None and if_none_match.strip() == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})

    base = (
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.is_active,
            Skill.scope_id.in_(visible_scope_ids),
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

    # Bulk-fetch the scope + machine metadata for the visible
    # skills in one query each (vs N+1). Two indexed lookups
    # against `scopes.id` and `agent_environments.id`.
    from app.models.scope import Scope
    from app.models.session import AgentEnvironment

    scope_ids_in_listing = {s.scope_id for s in skills if s.scope_id is not None}
    scope_meta: dict = {}
    if scope_ids_in_listing:
        scope_rows = (
            await db.execute(
                select(Scope.id, Scope.name, Scope.origin_environment_id).where(
                    Scope.id.in_(scope_ids_in_listing)
                )
            )
        ).all()
        env_ids_in_listing = {
            sid_row.origin_environment_id
            for sid_row in scope_rows
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
        for sid_row in scope_rows:
            scope_meta[sid_row.id] = {
                "name": sid_row.name,
                "environment_id": sid_row.origin_environment_id,
                "machine_name": env_meta.get(sid_row.origin_environment_id),
            }

    items: list[SkillSummaryResponse] = []
    for s in skills:
        content = None
        if include_content and s.file_key:
            try:
                tar_bytes = await file_store.get(s.file_key)
                content = extract_skill_md(tar_bytes)
            except Exception as e:
                # Don't fail the whole list on a single bad file_key —
                # return content=None for this row. But log so a
                # misconfigured S3 / rotated credentials / permission
                # error doesn't disappear silently into 200 OKs with
                # null content.
                log.warning(
                    "skill_list_content_fetch_failed user=%s file_key=%s error=%s",
                    s.user_id,
                    s.file_key,
                    _sanitize_log(e),
                )
                content = None
        meta = scope_meta.get(s.scope_id) if s.scope_id else None
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
                content=content,
                scope_id=str(s.scope_id) if s.scope_id else None,
                scope_name=meta["name"] if meta else None,
                machine_name=meta["machine_name"] if meta else None,
                environment_id=str(meta["environment_id"])
                if meta and meta["environment_id"]
                else None,
            )
        )

    response = Paginated[SkillSummaryResponse](
        items=items, total=total, page=page, page_size=page_size
    )
    # Attach the same scope-bound ETag the 304 path would have
    # echoed; daemons cache the full string and replay it on the
    # next request.
    return Response(
        content=response.model_dump_json(),
        media_type="application/json",
        headers={"ETag": etag},
    )


async def _resolve_legacy_skill(
    db: AsyncSession,
    auth: AuthContext,
    visible_scope_ids: list,
    skill_key: str,
) -> Skill:
    """Phase-1 multi-scope disambiguation: pick the most-recently-
    updated row across all scopes the caller can read. `LIMIT 1`
    keeps `scalar_one_or_none()` from raising MultipleResultsFound
    when the same skill_key exists in 2+ scopes."""
    result = await db.execute(
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.scope_id.in_(visible_scope_ids),
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


async def _build_skill_detail(skill: Skill, db: AsyncSession | None = None) -> SkillDetailResponse:
    content = None
    if skill.file_key:
        try:
            tar_bytes = await file_store.get(skill.file_key)
            content = extract_skill_md(tar_bytes)
        except Exception as e:
            # Detail page falls back to no-content rendering, but
            # surface storage errors in logs so silent S3/permission
            # issues are visible to the operator.
            log.warning(
                "skill_detail_content_fetch_failed user=%s file_key=%s error=%s",
                skill.user_id,
                skill.file_key,
                _sanitize_log(e),
            )

    # Scope + machine context. The dashboard editor uses scope_id
    # to build the upload URL; multi-machine users see machine_name
    # in the page caption ("on my-mac") so they're sure which copy
    # they're editing.
    scope_id_str: str | None = str(skill.scope_id) if skill.scope_id else None
    scope_name: str | None = None
    machine_name: str | None = None
    environment_id: str | None = None
    if db is not None and skill.scope_id is not None:
        from app.models.scope import Scope
        from app.models.session import AgentEnvironment

        scope_row = (
            await db.execute(
                select(Scope.name, Scope.origin_environment_id).where(Scope.id == skill.scope_id)
            )
        ).first()
        if scope_row is not None:
            scope_name = scope_row.name
            if scope_row.origin_environment_id is not None:
                environment_id = str(scope_row.origin_environment_id)
                env_row = (
                    await db.execute(
                        select(AgentEnvironment.machine_name).where(
                            AgentEnvironment.id == scope_row.origin_environment_id
                        )
                    )
                ).first()
                if env_row is not None:
                    machine_name = env_row.machine_name

    return SkillDetailResponse(
        id=str(skill.id),
        skill_key=skill.skill_key,
        name=skill.name,
        description=skill.description,
        version=skill.version,
        source=skill.source,
        source_repo=skill.source_repo,
        file_count=skill.file_count,
        content=content,
        agent_types=skill.agent_types,
        created_at=skill.created_at,
        content_hash=skill.content_hash,
        updated_at=skill.updated_at,
        scope_id=scope_id_str,
        scope_name=scope_name,
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
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Back-compat shim for pre-PR-66 CLI binaries. Resolves the
    target scope via `resolve_default_write_scope` (every user
    has a deterministic default after the scopes migration:
    env-bound key → its env's scope; unbound key with envs →
    most-recently-active env's scope; zero envs → Personal),
    then runs the same upload pipeline as the scope-explicit
    route. New CLIs and the dashboard call
    `POST /api/scopes/{scope_id}/skills/upload` directly.

    Asymmetric with `delete_skill_legacy` (which 410s) by design:
    a wrong-scope upload creates a stray row visible in the
    dashboard listing, recoverable in 30s by re-uploading to the
    correct scope. A wrong-scope DELETE is permanent data loss.
    """
    scope_id = await resolve_default_write_scope(db, auth)
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "Wed, 31 Dec 2026 00:00:00 GMT"
    response.headers["Link"] = '</api/scopes/{scope_id}/skills/upload>; rel="successor-version"'

    # Same chunked-read body bound as the scope-explicit route —
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
        scope_id=scope_id,
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


@scope_router.post("/upload")
async def upload_skill_scoped(
    scope_id: UUID = Path(...),
    skill_key: str = Form(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    file: UploadFile = File(...),
    content_hash: str | None = Form(
        None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    ),
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Scope-explicit tar.gz skill upload.

    The URL carries the target scope; one env binds to one scope,
    so a daemon's writes always land in its own env's scope. The
    dashboard's content editor uses `PUT /skills/{key}/content`
    instead (raw markdown, server-side tar). Both converge on
    `_do_upload_skill`, which serializes via a Postgres advisory
    lock keyed on (user, scope, skill_key); concurrent writes are
    last-write-wins. SSE then fans out to subscribed daemons.
    """
    await validate_scope_for_caller(db, auth, scope_id)
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
        scope_id=scope_id,
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
@scope_router.put("/{skill_key:path}/content")
async def update_skill_content(
    payload: SkillContentUpdateRequest,
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope("skills:write")),
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
    await validate_scope_for_caller(db, auth, scope_id)
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
        scope_id=scope_id,
        skill_key=skill_key,
        data=data,
        content_hash=None,
        expected_content_hash=payload.content_hash,
    )


async def _do_upload_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    scope_id,
    skill_key: str,
    data: bytes,
    content_hash: str | None,
    expected_content_hash: str | None = None,
) -> SkillUploadResponse:
    """Core upload logic for `POST /api/scopes/{scope_id}/skills/upload`.

    One env = one scope, so a daemon always writes to its own env's
    scope. Single writer means no cross-machine race; no If-Match,
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
    if _has_reserved_suffix(skill_key):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"skill_key cannot end with reserved suffix "
            f"({', '.join(sorted(_RESERVED_SKILL_KEY_SUFFIXES))})",
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

    # Serialize concurrent writes for this (user, scope, skill_key)
    # via a Postgres advisory lock keyed on the same identity as
    # the partial unique index. Two scopes can hold the same
    # skill_key in parallel; the lock is per-(user,scope,key) so
    # they don't block each other.
    lock_key = _advisory_lock_key(auth.user_id, scope_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    # Pre-fetch existing row so we can skip both file_store.put AND the
    # upsert when the bytes are identical to what's already stored. Saves
    # an R2/S3 PUT and prevents the cosmetic version+1 bump.
    #
    # `is_active` filter is load-bearing: the duplicate-cleanup
    # migration soft-deletes legacy rows for the same
    # (user, scope, skill_key) instead of hard-deleting them.
    # `scalar_one_or_none()` on the unfiltered query would raise
    # MultipleResultsFound for any user who survived the migration
    # with inactive duplicates — every subsequent upload would 500.
    # Order by `created_at DESC` for tie-stability if multiple active
    # rows ever slip past the partial unique index.
    existing_result = await db.execute(
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.scope_id == scope_id,
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
        # 200, and the row would stay invisible to /api/skills
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

    fk = _file_key(auth.user_id, scope_id, skill_key)
    await file_store.put(fk, data)

    skill = await _upsert_skill(
        db,
        user_id=auth.user_id,
        scope_id=scope_id,
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
    auth: AuthContext = Depends(require_scope("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    """Phase-1 compat download — multi-scope disambiguation by
    most-recently-updated. Replaced by
    `/api/scopes/{scope_id}/skills/{skill_key}/download`."""
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    skill = await _resolve_legacy_skill(db, auth, visible_scope_ids, skill_key)
    return await _build_skill_download(skill, skill_key)


@scope_router.get("/{skill_key:path}/download")
async def download_skill_scoped(
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope("skills:read")),
    db: AsyncSession = Depends(get_session),
):
    """Phase-2 scope-explicit download — exact (scope_id, skill_key)
    lookup, no disambiguation."""
    await validate_scope_for_caller(db, auth, scope_id)
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id,
            Skill.scope_id == scope_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return await _build_skill_download(skill, skill_key)


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
    auth: AuthContext = Depends(require_scope("skills:read")),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    """Phase-1 compat detail — multi-scope disambiguation by
    most-recently-updated. Replaced by
    `/api/scopes/{scope_id}/skills/{skill_key}` in phase 2 for
    callers that know which scope they want."""
    visible_scope_ids = await scope_ids_visible_to(db, auth)
    skill = await _resolve_legacy_skill(db, auth, visible_scope_ids, skill_key)
    return await _build_skill_detail(skill, db)


@scope_router.get("/{skill_key:path}")
async def get_skill_scoped(
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope("skills:read")),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    """Phase-2 scope-explicit detail. Returns exactly the row at
    `(scope_id, skill_key)` — no multi-scope disambiguation needed
    because the URL pins the scope."""
    await validate_scope_for_caller(db, auth, scope_id)
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id,
            Skill.scope_id == scope_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    return await _build_skill_detail(skill, db)


async def _build_skill_download(skill: Skill, skill_key: str) -> Response:
    if not skill.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")
    try:
        data = await file_store.get(skill.file_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found") from None

    # If stored as old .md format, wrap into tar.gz on the fly
    if skill.file_key.endswith(".md"):
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
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    """Legacy delete by slug-only is gone in phase 2. Resolving
    via `resolve_default_write_scope` would silently delete
    the wrong scope's copy when the caller's account holds the
    same `skill_key` in multiple scopes (which the cross-scope
    listing now exposes), or 404 with no useful hint when
    their default scope doesn't have that key. The CLI and
    dashboard both migrated to
    `DELETE /api/scopes/{scope_id}/skills/{skill_key}` and
    pass the row's own scope_id; force any stale client onto
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
            "code": "scope_explicit_route_required",
            "message": (
                "Use DELETE /api/scopes/{scope_id}/skills/{skill_key} — "
                "call GET /api/skills to find the scope_id of the row "
                "you want to delete."
            ),
        },
    )


@scope_router.delete("/{skill_key:path}")
async def delete_skill_scoped(
    scope_id: UUID = Path(...),
    skill_key: str = Path(..., pattern=SKILL_KEY_PATTERN, max_length=MAX_SKILL_KEY_LEN),
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    """Phase-2 scope-explicit delete — only the named scope's copy
    is deleted; the same skill_key in other scopes is unaffected."""
    await validate_scope_for_caller(db, auth, scope_id)
    return await _do_delete_skill(db=db, auth=auth, scope_id=scope_id, skill_key=skill_key)


async def _do_delete_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    scope_id,
    skill_key: str,
) -> SkillDeleteResponse:
    # Advisory lock matches the partial unique index identity, so
    # this delete serializes with any concurrent write to the
    # same (user, scope, skill_key).
    lock_key = _advisory_lock_key(auth.user_id, scope_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    # `is_active` filter + ORDER BY + LIMIT 1: third call site of
    # the same migration-survivor pattern. Accounts that came
    # through the duplicate-cleanup migration with soft-deleted
    # rows under the same (user, scope, skill_key) would otherwise
    # 500 on uninstall via MultipleResultsFound.
    result = await db.execute(
        select(Skill)
        .where(
            Skill.user_id == auth.user_id,
            Skill.scope_id == scope_id,
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
        # bound scope receive `skill_deleted` immediately and
        # remove the local directory; the 60s reconcile loop is
        # the safety net for daemons that missed the event
        # (network blip, mid-reconnect).
        await bump_skills_revision(
            db,
            auth.user_id,
            skill_key=skill_key,
            scope_id=scope_id,
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
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillInstallResponse:
    """Back-compat shim for pre-PR-66 CLI binaries. Resolves
    target scope via `resolve_default_write_scope` (same
    deterministic default-scope policy as `upload_skill_legacy`).
    A wrong-scope install adds a stray row to the dashboard
    listing — recoverable, not destructive — so this stays
    soft-deprecated rather than 410'd."""
    scope_id = await resolve_default_write_scope(db, auth)
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "Wed, 31 Dec 2026 00:00:00 GMT"
    response.headers["Link"] = '</api/scopes/{scope_id}/skills/install>; rel="successor-version"'
    return await _do_install_skill(db=db, auth=auth, scope_id=scope_id, body=body)


@scope_router.post("/install")
async def install_skill_scoped(
    body: SkillInstallRequest,
    scope_id: UUID = Path(...),
    auth: AuthContext = Depends(require_scope("skills:write")),
    db: AsyncSession = Depends(get_session),
) -> SkillInstallResponse:
    """Phase-2 scope-explicit install — install lands in the
    URL-named scope. Used by the dashboard install picker
    (phase 3) and any caller that knows which scope it wants."""
    await validate_scope_for_caller(db, auth, scope_id)
    return await _do_install_skill(db=db, auth=auth, scope_id=scope_id, body=body)


async def _do_install_skill(
    *,
    db: AsyncSession,
    auth: AuthContext,
    scope_id,
    body: SkillInstallRequest,
) -> SkillInstallResponse:
    from app.services.skill_installer import fetch_skill_from_github

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
    skill_key = _validate_derived_skill_key(fetched.name.lower().replace(" ", "-"))
    fk = _file_key(auth.user_id, scope_id, skill_key)

    # Same advisory lock pattern as upload_skill. Lock identity
    # (user, scope, key) matches the partial unique index, so the
    # serialization is precisely scoped — different scopes don't
    # block each other.
    lock_key = _advisory_lock_key(auth.user_id, scope_id, skill_key)
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": lock_key})

    await file_store.put(fk, fetched.tar_bytes)

    skill = await _upsert_skill(
        db,
        user_id=auth.user_id,
        scope_id=scope_id,
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
    scope_id,
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
    # Identity is (user_id, scope_id, skill_key) — same shape as
    # the partial unique index. Two scopes can hold the same
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
            Skill.scope_id == scope_id,
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
            scope_id=scope_id,
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
    # `scope_id` rides on the event so the broker can filter
    # subscribers to only those with read access to this scope.
    # `content_hash` rides on the event so the daemon can echo-
    # suppress: a skill_changed whose hash matches the daemon's
    # last-pushed hash for that key is the daemon's own upload
    # bouncing back, NOT a peer change. Pulling it would race
    # the daemon's own next watcher tick.
    await bump_skills_revision(
        db,
        user_id,
        skill_key=skill_key,
        scope_id=scope_id,
        event_type="skill_changed",
        content_hash=content_hash,
    )
    await db.flush()
    return skill
