import logging
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    _is_env_bound_api_key,
    require_scope,
)
from app.core.database import get_session
from app.models.memory import Memory
from app.models.session import AgentEnvironment, Session
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
from app.services.memory_recall import (
    bump_recall_counts,
    recall_counting_enabled,
    recall_ids_from_hits,
)
from app.services.secret_detection import find_likely_secret, secret_memory_warning


async def _attach_source_machines(
    db: AsyncSession, auth: AuthContext, items: list[dict]
) -> list[dict]:
    """Bulk-fetch machine_name + environment_id for memories that came
    from a session, mutating each item in place.

    Memories carry `source_session_id` (or None for manual adds). This
    walks Session → AgentEnvironment exactly once and threads the
    machine info back so the dashboard can render "learned from
    session on my-mac". Single query keeps the route's worst-case
    cost at O(1) database round-trips no matter the page size.

    The Session join is constrained to `auth.user_id` so a memory
    whose `source_session_id` happens to match a different user's
    session — possible if a Mem0 metadata field is ever set from
    untrusted input — can never surface that user's machine_name.
    """
    environment_ids: set[UUID] = set()
    sids: set[UUID] = set()
    for d in items:
        raw_environment_id = d.get("source_environment_id")
        if raw_environment_id:
            try:
                environment_ids.add(UUID(str(raw_environment_id)))
            except (TypeError, ValueError):
                pass
        raw = d.get("source_session_id")
        if not raw:
            continue
        try:
            sids.add(UUID(str(raw)))
        except (TypeError, ValueError):
            continue
    if not environment_ids and not sids:
        return items
    machine_by_environment: dict[UUID, str | None] = {}
    if environment_ids:
        environment_rows = (
            await db.execute(
                select(AgentEnvironment.id, AgentEnvironment.machine_name).where(
                    AgentEnvironment.id.in_(environment_ids),
                    AgentEnvironment.user_id == auth.user_id,
                )
            )
        ).all()
        machine_by_environment = {
            environment_id: machine_name for environment_id, machine_name in environment_rows
        }
    rows = []
    if sids:
        rows = (
            await db.execute(
                select(
                    Session.id,
                    Session.environment_id,
                    AgentEnvironment.machine_name,
                )
                .outerjoin(AgentEnvironment, AgentEnvironment.id == Session.environment_id)
                .where(Session.id.in_(sids), Session.user_id == auth.user_id)
            )
        ).all()
    by_session: dict[UUID, tuple[UUID | None, str | None]] = {
        sid: (env_id, machine_name) for (sid, env_id, machine_name) in rows
    }
    for d in items:
        raw_environment_id = d.get("source_environment_id")
        if raw_environment_id:
            try:
                environment_id = UUID(str(raw_environment_id))
            except (TypeError, ValueError):
                environment_id = None
            if environment_id is not None and environment_id in machine_by_environment:
                d["source_environment_id"] = str(environment_id)
                d["source_machine_name"] = machine_by_environment[environment_id]
                continue
        raw = d.get("source_session_id")
        if not raw:
            continue
        try:
            sid_u = UUID(str(raw))
        except (TypeError, ValueError):
            continue
        env_id, mn = by_session.get(sid_u, (None, None))
        d["source_environment_id"] = str(env_id) if env_id else None
        d["source_machine_name"] = mn
    return items


log = logging.getLogger(__name__)

router = APIRouter(prefix="/memories", tags=["memories"])


@router.get("")
async def list_memories(
    background_tasks: BackgroundTasks,
    auth: AuthContext = Depends(require_scope("memories:read")),
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
        #
        hits = await provider.search(
            str(auth.user_id),
            q,
            limit=page_size,
            category=category,
        )
        await _attach_source_machines(db, auth, hits)
        # Re-cap to page_size so the response shape stays predictable
        # regardless of how much we overfetched.
        hits = hits[:page_size]
        # A ranked search from an agent CLI (legacy API key or OAuth) is a recall — count
        # it (background task, own session, zero request latency; see
        # app/services/memory_recall.py). Dashboard/JWT browsing doesn't count.
        if (auth.is_cli or auth.oauth_cli) and hits and recall_counting_enabled():
            background_tasks.add_task(bump_recall_counts, auth.user_id, recall_ids_from_hits(hits))
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
    await _attach_source_machines(db, auth, rows)
    return Paginated[MemoryResponse](
        items=[MemoryResponse.model_validate(m) for m in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{memory_id}")
async def get_memory(
    memory_id: UUID,
    auth: AuthContext = Depends(require_scope("memories:read")),
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
    payload = memory_to_dict(memory)
    await _attach_source_machines(db, auth, [payload])
    return MemoryResponse.model_validate(payload)


@router.post("")
async def create_memory(
    body: MemoryCreate,
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
) -> MemoryCreatedResponse:
    finding = find_likely_secret(body.content)
    if finding is not None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "memory_secret_rejected",
                "message": secret_memory_warning(finding),
                "secret_type": finding.label,
            },
        )
    provider = await get_memory_provider(str(auth.user_id), db)
    source_environment_id = (
        auth.api_key.environment_id
        if _is_env_bound_api_key(auth) and auth.api_key is not None
        else None
    )
    return MemoryCreatedResponse.model_validate(
        await provider.add(
            str(auth.user_id),
            body.content,
            category=body.category,
            source=body.source,
            tags=body.tags,
            source_environment_id=source_environment_id,
        )
    )


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: UUID,
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
) -> MemoryDeleteResponse:
    provider = await get_memory_provider(str(auth.user_id), db)
    if not await provider.delete(str(auth.user_id), str(memory_id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
    return MemoryDeleteResponse(status="deleted")


@router.post("/embed-backfill")
async def embed_backfill(
    force: bool = Query(default=False, description="Re-embed rows that already have an embedding."),
    batch_size: int = Query(default=32, ge=1, le=200),
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
) -> EmbedBackfillResponse:
    """Compute embeddings for the caller's memories that lack one.

    Used after the deployment's embedder becomes available (first-time
    install, or a model change). Uses the deployment-configured embedder
    (env vars; see `app.core.config.Settings.memory_embedding_*`).

    With `force=true`, re-embeds rows that already have embeddings too
    (useful after changing the embedding model).

    Agent API keys are rejected because this bulk maintenance operation is not
    part of ordinary Memory read/write behavior. Environment-bound runtimes may
    recall account Memory but cannot trigger account-wide re-embedding work.
    """
    if _is_env_bound_api_key(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Embed backfill is a user-level maintenance op; Agent API keys cannot run it.",
        )
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
