import hashlib

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.models.skill import Skill
from app.schemas.skill import SkillBatchRequest, SkillCreate, SkillInstallRequest
from app.services.file_store import LocalFileStore

router = APIRouter(prefix="/api/skills", tags=["skills"])

file_store = LocalFileStore(settings.file_store_local_path)


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


@router.get("")
async def list_skills(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    include_content: bool = Query(default=False),
):
    result = await db.execute(
        select(Skill)
        .where(Skill.user_id == auth.user_id, Skill.is_active == True)
        .order_by(Skill.skill_key)
    )
    skills = result.scalars().all()

    items = []
    for s in skills:
        item = {
            "id": str(s.id),
            "skill_key": s.skill_key,
            "name": s.name,
            "description": s.description,
            "version": s.version,
            "source": s.source,
            "agent_types": s.agent_types,
            "content_hash": s.content_hash,
            "is_active": s.is_active,
            "created_at": s.created_at.isoformat(),
            "updated_at": s.updated_at.isoformat(),
        }
        if include_content and s.file_key:
            try:
                content = await file_store.get(s.file_key)
                item["content"] = content.decode("utf-8")
            except Exception:
                item["content"] = None
        items.append(item)

    return items


@router.get("/{skill_key}")
async def get_skill(
    skill_key: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id,
            Skill.skill_key == skill_key,
            Skill.is_active == True,
        )
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")

    content = None
    if skill.file_key:
        try:
            content = (await file_store.get(skill.file_key)).decode("utf-8")
        except Exception:
            pass

    return {
        "id": str(skill.id),
        "skill_key": skill.skill_key,
        "name": skill.name,
        "description": skill.description,
        "version": skill.version,
        "content": content,
        "agent_types": skill.agent_types,
        "created_at": skill.created_at.isoformat(),
    }


@router.post("")
async def create_skill(
    body: SkillCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    content_hash = _content_hash(body.content)
    file_key = f"skills/{auth.user_id}/{body.skill_key}.md"
    await file_store.put(file_key, body.content.encode("utf-8"))

    # Upsert
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id, Skill.skill_key == body.skill_key
        )
    )
    skill = result.scalar_one_or_none()

    if skill:
        skill.name = body.name
        skill.content_hash = content_hash
        skill.file_key = file_key
        skill.agent_types = body.agent_types
        skill.is_active = True
        skill.version = skill.version + 1
    else:
        skill = Skill(
            user_id=auth.user_id,
            skill_key=body.skill_key,
            name=body.name,
            content_hash=content_hash,
            file_key=file_key,
            agent_types=body.agent_types,
            source="local",
        )
        db.add(skill)

    await db.commit()
    return {"id": str(skill.id), "skill_key": skill.skill_key, "version": skill.version}


@router.post("/batch")
async def batch_create_skills(
    body: SkillBatchRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    synced = 0
    for s in body.skills:
        content_hash = _content_hash(s.content)

        # Check if unchanged
        result = await db.execute(
            select(Skill).where(
                Skill.user_id == auth.user_id, Skill.skill_key == s.skill_key
            )
        )
        existing = result.scalar_one_or_none()
        if existing and existing.content_hash == content_hash:
            continue

        file_key = f"skills/{auth.user_id}/{s.skill_key}.md"
        await file_store.put(file_key, s.content.encode("utf-8"))

        if existing:
            existing.name = s.name
            existing.content_hash = content_hash
            existing.file_key = file_key
            existing.agent_types = s.agent_types
            existing.is_active = True
            existing.version = existing.version + 1
        else:
            db.add(Skill(
                user_id=auth.user_id,
                skill_key=s.skill_key,
                name=s.name,
                content_hash=content_hash,
                file_key=file_key,
                agent_types=s.agent_types,
                source="local",
            ))
        synced += 1

    await db.commit()
    return {"synced": synced}


@router.delete("/{skill_key}")
async def delete_skill(
    skill_key: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == auth.user_id, Skill.skill_key == skill_key
        )
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill not found")

    skill.is_active = False
    await db.commit()
    return {"status": "deleted"}


@router.post("/install")
async def install_skill(
    body: SkillInstallRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    from app.services.skill_installer import fetch_skill_from_github

    try:
        fetched = await fetch_skill_from_github(body.repo, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))

    content_hash = _content_hash(fetched.content)
    skill_key = fetched.name.lower().replace(" ", "-")
    file_key = f"skills/{auth.user_id}/{skill_key}.md"
    await file_store.put(file_key, fetched.content.encode("utf-8"))

    # Upsert
    result = await db.execute(
        select(Skill).where(Skill.user_id == auth.user_id, Skill.skill_key == skill_key)
    )
    skill = result.scalar_one_or_none()

    if skill:
        skill.name = fetched.name
        skill.description = fetched.description
        skill.content_hash = content_hash
        skill.file_key = file_key
        skill.source = "marketplace"
        skill.source_repo = body.repo
        skill.is_active = True
        skill.version = skill.version + 1
    else:
        skill = Skill(
            user_id=auth.user_id,
            skill_key=skill_key,
            name=fetched.name,
            description=fetched.description,
            content_hash=content_hash,
            file_key=file_key,
            source="marketplace",
            source_repo=body.repo,
        )
        db.add(skill)

    await db.commit()
    return {
        "skill_key": skill_key,
        "name": fetched.name,
        "description": fetched.description,
        "repo": body.repo,
        "version": skill.version,
    }
