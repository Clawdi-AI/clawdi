import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.models.memory import Memory
from app.schemas.common import Paginated
from app.schemas.memory import (
    EmbedBackfillResponse,
    MemoryCreate,
    MemoryCreatedResponse,
    MemoryDeleteResponse,
    MemoryResponse,
)
from app.services.embedding import resolve_embedder
from app.services.memory_provider import get_memory_provider, memory_to_dict

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/memories", tags=["memories"])


@router.get("")
async def list_memories(
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    category: str | None = Query(default=None),
    q: str | None = Query(default=None),
    order: str = Query(default="desc", pattern=r"^(asc|desc)$"),
) -> Paginated[MemoryResponse]:
    provider = await get_memory_provider(str(auth.user_id), db)

    if q:
        # Search is top-N ranked (FTS + trgm + vector hybrid). Paging through
        # relevance-ordered results doesn't map cleanly to offset — mirror
        # Linear/Notion and return one page worth with total = len(hits).
        hits = await provider.search(
            str(auth.user_id),
            q,
            limit=page_size,
            category=category,
        )
        items = [MemoryResponse.model_validate(m) for m in hits]
        return Paginated[MemoryResponse](
            items=items,
            total=len(items),
            page=1,
            page_size=page_size,
        )

    total = await provider.count(str(auth.user_id), category=category)
    rows = await provider.list_all(
        str(auth.user_id),
        limit=page_size,
        offset=(page - 1) * page_size,
        category=category,
        order=order,
    )
    return Paginated[MemoryResponse](
        items=[MemoryResponse.model_validate(m) for m in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{memory_id}")
async def get_memory(
    memory_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> MemoryResponse:
    result = await db.execute(
        select(Memory).where(
            Memory.id == memory_id,
            Memory.user_id == auth.user_id,
        )
    )
    memory = result.scalar_one_or_none()
    if not memory:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
    return MemoryResponse.model_validate(memory_to_dict(memory))


@router.post("")
async def create_memory(
    body: MemoryCreate,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> MemoryCreatedResponse:
    provider = await get_memory_provider(str(auth.user_id), db)
    return MemoryCreatedResponse.model_validate(
        await provider.add(
            str(auth.user_id),
            body.content,
            category=body.category,
            source=body.source,
            tags=body.tags,
        )
    )


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: UUID,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> MemoryDeleteResponse:
    provider = await get_memory_provider(str(auth.user_id), db)
    await provider.delete(str(auth.user_id), str(memory_id))
    return MemoryDeleteResponse(status="deleted")


@router.post("/embed-backfill")
async def embed_backfill(
    force: bool = Query(default=False, description="Re-embed rows that already have an embedding."),
    batch_size: int = Query(default=32, ge=1, le=200),
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> EmbedBackfillResponse:
    """Compute embeddings for the caller's memories that lack one.

    Used after the deployment's embedder becomes available (first-time
    install, or a model change). Uses the deployment-configured embedder
    (env vars; see `app.core.config.Settings.memory_embedding_*`).

    With `force=true`, re-embeds rows that already have embeddings too
    (useful after changing the embedding model).
    """
    embedder = resolve_embedder()
    if embedder is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "No embedding provider available. "
                "Check MEMORY_EMBEDDING_MODE and related env vars on the backend."
            ),
        )

    # Snapshot the IDs of rows we intend to process. Iterating via offset
    # on the live query is wrong here: when `force=false`, each successful
    # embed removes its row from `WHERE embedding IS NULL`, shifting the
    # result set — incrementing offset would then skip unprocessed rows,
    # while leaving offset at 0 would loop forever on any failed row that
    # stays NULL. UUIDs are ~16 bytes each, so snapshotting even tens of
    # thousands of IDs is cheap.
    id_query = select(Memory.id).where(Memory.user_id == auth.user_id)
    if not force:
        id_query = id_query.where(Memory.embedding.is_(None))
    id_query = id_query.order_by(Memory.created_at.asc())
    target_ids = (await db.execute(id_query)).scalars().all()

    processed = 0
    failed = 0
    for i in range(0, len(target_ids), batch_size):
        chunk_ids = target_ids[i : i + batch_size]
        chunk = (await db.execute(select(Memory).where(Memory.id.in_(chunk_ids)))).scalars().all()
        for mem in chunk:
            try:
                vec = await embedder.embed(mem.content)
                mem.embedding = vec
                processed += 1
            except Exception as e:
                log.warning("backfill embed failed for %s: %s", mem.id, e)
                failed += 1
        await db.commit()
    return EmbedBackfillResponse(processed=processed, failed=failed)
