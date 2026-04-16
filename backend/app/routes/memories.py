from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.services.memory_provider import get_memory_provider

router = APIRouter(prefix="/api/memories", tags=["memories"])


class MemoryCreate(BaseModel):
    content: str
    category: str = "fact"
    source: str = "manual"
    tags: list[str] | None = None


class MemoryBatchRequest(BaseModel):
    memories: list[MemoryCreate]


@router.get("")
async def list_memories(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0),
    category: str | None = Query(default=None),
    q: str | None = Query(default=None),
):
    provider = await get_memory_provider(str(auth.user_id), db)

    if q:
        return await provider.search(str(auth.user_id), q, limit=limit)

    return await provider.list_all(str(auth.user_id), limit=limit, offset=offset, category=category)


@router.post("")
async def create_memory(
    body: MemoryCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    provider = await get_memory_provider(str(auth.user_id), db)
    return await provider.add(
        str(auth.user_id), body.content,
        category=body.category, source=body.source, tags=body.tags,
    )


@router.post("/batch")
async def batch_create_memories(
    body: MemoryBatchRequest,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    provider = await get_memory_provider(str(auth.user_id), db)
    synced = 0
    for m in body.memories:
        await provider.add(
            str(auth.user_id), m.content,
            category=m.category, source=m.source, tags=m.tags,
        )
        synced += 1
    return {"synced": synced}


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: str,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
):
    provider = await get_memory_provider(str(auth.user_id), db)
    await provider.delete(str(auth.user_id), memory_id)
    return {"status": "deleted"}
