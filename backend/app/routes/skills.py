import hashlib
import io
import tarfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.core.query_utils import like_needle
from app.models.skill import Skill
from app.schemas.common import Paginated
from app.schemas.skill import (
    SkillDeleteResponse,
    SkillDetailResponse,
    SkillInstallRequest,
    SkillInstallResponse,
    SkillSummaryResponse,
    SkillUploadResponse,
)
from app.services.file_store import get_file_store
from app.services.tar_utils import (
    TarValidationError,
    extract_skill_md,
    parse_frontmatter,
    tar_from_content,
    validate_tar,
)

router = APIRouter(prefix="/api/skills", tags=["skills"])

file_store = get_file_store()


def _file_key(user_id, skill_key: str) -> str:
    return f"skills/{user_id}/{skill_key}.tar.gz"


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


def _compute_file_tree_hash(tar_bytes: bytes) -> str:
    """File-tree content hash of a skill tar.gz.

    Walks each file in the archive (skipping directories and any path
    whose segments include the exclude set above), sorts by relative
    path, then sha256 over `path + content` per file. Mirrors the TS
    `computeSkillFolderHash` in `packages/cli/src/lib/skills-lock.ts` so
    server-side and client-side hashes are identical for the same tar.

    Used in two places:
    - `upload_skill` fallback when the client (CLI <= 0.3.3) doesn't send
      `content_hash`.
    - `install_skill` for marketplace tars fetched from GitHub.
    """
    files: list[tuple[str, bytes]] = []
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            # Names are like "<skill_key>/foo/bar.txt" — drop the first
            # segment (the skill dir itself), then check remaining
            # segments against the exclude set. Same shape as tar.ts's
            # filter.
            parts = member.name.split("/")
            if any(p in _SKILL_HASH_EXCLUDE for p in parts[1:]):
                continue
            extracted = tf.extractfile(member)
            if extracted is None:
                continue
            files.append((member.name, extracted.read()))

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
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    q: str | None = Query(default=None, description="Search name / description / skill_key"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    include_content: bool = Query(default=False),
) -> Paginated[SkillSummaryResponse]:
    base = (
        select(Skill)
        .where(Skill.user_id == auth.user_id, Skill.is_active)
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

    items: list[SkillSummaryResponse] = []
    for s in skills:
        content = None
        if include_content and s.file_key:
            try:
                tar_bytes = await file_store.get(s.file_key)
                content = extract_skill_md(tar_bytes)
            except Exception:
                content = None
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
            )
        )

    return Paginated[SkillSummaryResponse](items=items, total=total, page=page, page_size=page_size)


@router.get("/{skill_key}")
async def get_skill(
    skill_key: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SkillDetailResponse:
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")

    content = None
    if skill.file_key:
        try:
            tar_bytes = await file_store.get(skill.file_key)
            content = extract_skill_md(tar_bytes)
        except Exception:
            pass

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
    )


# ---------------------------------------------------------------------------
# Upload (tar.gz)
# ---------------------------------------------------------------------------


@router.post("/upload")
async def upload_skill(
    skill_key: str = Form(...),
    file: UploadFile = File(...),
    # Optional for backwards compat with CLI <= 0.3.3 that doesn't send
    # this field. New clients (>= 0.3.4) compute the file-tree hash and
    # send it; the server trusts it (sync optimization, not a security
    # boundary). When absent, server falls back to computing it from the
    # uploaded tar so the rest of the flow still gates on a real hash.
    content_hash: str | None = Form(
        None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    ),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SkillUploadResponse:
    """Upload a skill as a tar.gz archive."""
    data = await file.read()

    try:
        file_count = validate_tar(data)
    except TarValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    skill_md = extract_skill_md(data)
    if not skill_md:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Archive must contain a SKILL.md")

    fm = parse_frontmatter(skill_md)
    name = fm.get("name", skill_key)
    description = fm.get("description", "")

    if content_hash is None:
        content_hash = _compute_file_tree_hash(data)

    # Pre-fetch existing row so we can skip both file_store.put AND the
    # upsert when the bytes are identical to what's already stored. Saves
    # an R2/S3 PUT and prevents the cosmetic version+1 bump.
    existing_result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id,
            Skill.skill_key == skill_key,
        )
    )
    existing = existing_result.scalar_one_or_none()

    if existing and existing.content_hash == content_hash:
        return SkillUploadResponse(
            skill_key=existing.skill_key,
            name=existing.name,
            version=existing.version,
            file_count=file_count,
        )

    fk = _file_key(auth.user_id, skill_key)
    await file_store.put(fk, data)

    skill = await _upsert_skill(
        db,
        user_id=auth.user_id,
        skill_key=skill_key,
        name=name,
        description=description,
        content_hash=content_hash,
        file_key=fk,
        file_count=file_count,
        source="local",
        source_repo=None,
    )

    return SkillUploadResponse(
        skill_key=skill.skill_key,
        name=skill.name,
        version=skill.version,
        file_count=file_count,
    )


# ---------------------------------------------------------------------------
# Download (tar.gz)
# ---------------------------------------------------------------------------


@router.get("/{skill_key}/download")
async def download_skill(
    skill_key: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    """Download skill as tar.gz archive."""
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id,
            Skill.skill_key == skill_key,
            Skill.is_active,
        )
    )
    skill = result.scalar_one_or_none()
    if not skill or not skill.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")

    try:
        data = await file_store.get(skill.file_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found")

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


@router.delete("/{skill_key}")
async def delete_skill(
    skill_key: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SkillDeleteResponse:
    result = await db.execute(
        select(Skill).where(Skill.user_id == auth.user_id, Skill.skill_key == skill_key)
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")

    skill.is_active = False
    await db.commit()
    return SkillDeleteResponse(status="deleted")


# ---------------------------------------------------------------------------
# Install from GitHub
# ---------------------------------------------------------------------------


@router.post("/install")
async def install_skill(
    body: SkillInstallRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> SkillInstallResponse:
    from app.services.skill_installer import fetch_skill_from_github

    try:
        fetched = await fetch_skill_from_github(body.repo, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))

    content_hash = _compute_file_tree_hash(fetched.tar_bytes)
    skill_key = fetched.name.lower().replace(" ", "-")
    fk = _file_key(auth.user_id, skill_key)
    await file_store.put(fk, fetched.tar_bytes)

    skill = await _upsert_skill(
        db,
        user_id=auth.user_id,
        skill_key=skill_key,
        name=fetched.name,
        description=fetched.description,
        content_hash=content_hash,
        file_key=fk,
        file_count=fetched.file_count,
        source="marketplace",
        source_repo=body.repo,
    )

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
    skill_key: str,
    name: str,
    description: str,
    content_hash: str,
    file_key: str,
    file_count: int,
    source: str,
    source_repo: str | None,
) -> Skill:
    result = await db.execute(
        select(Skill).where(Skill.user_id == user_id, Skill.skill_key == skill_key)
    )
    skill = result.scalar_one_or_none()

    if skill:
        if skill.content_hash == content_hash:
            # Defense in depth — even if the upload endpoint's pre-fetch
            # gets bypassed by a future caller, the upsert won't bump
            # `version + 1` or refresh fields when nothing changed.
            # `updated_at` only advances on actual UPDATE statements
            # (TimestampMixin's `onupdate`), so an early return preserves
            # the original timestamp too.
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

    await db.commit()
    return skill
