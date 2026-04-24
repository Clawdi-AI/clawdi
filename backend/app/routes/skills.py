import hashlib

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
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


def _content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_key(user_id, skill_key: str) -> str:
    return f"skills/{user_id}/{skill_key}.tar.gz"


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
        needle = f"%{q}%"
        base = base.where(
            or_(
                Skill.skill_key.ilike(needle),
                Skill.name.ilike(needle),
                Skill.description.ilike(needle),
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

    return Paginated[SkillSummaryResponse](
        items=items, total=total, page=page, page_size=page_size
    )


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

    content_hash = _content_hash(data)
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

    content_hash = _content_hash(fetched.tar_bytes)
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
