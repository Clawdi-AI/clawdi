import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
from app.services.memory_provider import BuiltinProvider, get_memory_provider, memory_to_dict


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
    sids: set[UUID] = set()
    for d in items:
        raw = d.get("source_session_id")
        if not raw:
            continue
        try:
            sids.add(UUID(str(raw)))
        except (TypeError, ValueError):
            continue
    if not sids:
        return items
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

router = APIRouter(prefix="/api/memories", tags=["memories"])


async def _scope_filter_memories(
    db: AsyncSession, auth: AuthContext, items: list[dict]
) -> list[dict]:
    """For env-bound api keys (deploy keys), drop memories whose
    source session lives in an env outside the key's binding.

    Manual memories (`source_session_id is None`) have no env
    attribution and would otherwise leak across a deploy key's
    binding boundary; we drop those too.

    Gate is `_is_env_bound_api_key` (presence of `environment_id`),
    NOT `_is_scoped_api_key` (presence of explicit `scopes` list).
    Default deploy keys mint with `scopes=None` (full capability,
    matching the "deploy key behaves like user-installed clawdi"
    policy), so the scope-list gate let them bypass the env
    filter — a leaked env-A deploy key could read env-B's
    memories. Personal CLI keys and Clerk JWT have no env
    binding and see everything user-owned.
    """
    if not _is_env_bound_api_key(auth):
        return items
    if auth.api_key is None or auth.api_key.environment_id is None:
        # Defensive: `_is_env_bound_api_key` already checked, but
        # the type narrower can't see through the helper. Bail
        # out as "no memories" rather than crash.
        return []
    bound_env_id = auth.api_key.environment_id
    sids: set[UUID] = set()
    for d in items:
        raw = d.get("source_session_id")
        if not raw:
            continue
        try:
            sids.add(UUID(str(raw)))
        except (TypeError, ValueError):
            continue
    if not sids:
        return []
    rows = (
        await db.execute(
            select(Session.id, Session.environment_id).where(
                Session.id.in_(sids),
                Session.user_id == auth.user_id,
            )
        )
    ).all()
    in_bound = {sid for (sid, env_id) in rows if env_id == bound_env_id}
    out: list[dict] = []
    for d in items:
        raw = d.get("source_session_id")
        if not raw:
            continue  # manual memories dropped for scoped keys
        try:
            sid_u = UUID(str(raw))
        except (TypeError, ValueError):
            continue
        if sid_u in in_bound:
            out.append(d)
    return out


@router.get("")
async def list_memories(
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
        # Scoped key + ranked search has a truncation hazard: if other
        # envs' memories outrank the bound env's, asking for `page_size`
        # hits then post-filtering can leave us with zero results even
        # when the bound env has matching memories. Overfetch by a wide
        # margin so the post-filter has plausible coverage. We can't
        # push the env filter into the provider call generally — Mem0
        # has no scope axis — so this is the cleanest "good enough"
        # fix that keeps both providers working.
        if _is_env_bound_api_key(auth):
            search_limit = max(page_size * 10, 200)
        else:
            search_limit = page_size
        hits = await provider.search(
            str(auth.user_id),
            q,
            limit=search_limit,
            category=category,
        )
        await _attach_source_machines(db, auth, hits)
        hits = await _scope_filter_memories(db, auth, hits)
        # Re-cap to page_size so the response shape stays predictable
        # regardless of how much we overfetched.
        hits = hits[:page_size]
        items = [MemoryResponse.model_validate(m) for m in hits]
        return Paginated[MemoryResponse](
            items=items,
            total=len(items),
            page=1,
            page_size=page_size,
        )

    # Scoped key path: page DIRECTLY against the env-filtered query
    # rather than paging the full Memory set + post-filtering. The
    # post-filter approach was a real pagination bug — page 1 might
    # be 23 out-of-env memories + 2 env-A memories, returning
    # `[2 items], total=2` even though the user has 200 env-A
    # memories on later pages. Client thinks "that's all" and
    # never fetches page 2.
    #
    # Gated on the resolved provider being the Builtin store: Mem0
    # memories live in Mem0's cloud, not the local Memory table.
    # Reading Memory directly for a Mem0-configured user would
    # always return zero rows. For Mem0 users, fall through to the
    # generic provider+post-filter path below — its pagination is
    # imperfect but at least returns the right backing store.
    if _is_env_bound_api_key(auth) and isinstance(provider, BuiltinProvider):
        if auth.api_key is None or auth.api_key.environment_id is None:
            # Future: a scoped key without an env binding has no
            # memories to see (consistent with `_scope_filter_memories`).
            return Paginated[MemoryResponse](items=[], total=0, page=page, page_size=page_size)
        from sqlalchemy import desc, func

        from app.models.memory import Memory

        bound_env = auth.api_key.environment_id
        base = (
            select(Memory)
            .join(Session, Memory.source_session_id == Session.id)
            .where(
                Memory.user_id == auth.user_id,
                Session.user_id == auth.user_id,
                Session.environment_id == bound_env,
            )
        )
        if category:
            base = base.where(Memory.category == category)
        # Match the provider's ordering contract.
        base = base.order_by(desc(Memory.created_at) if order == "desc" else Memory.created_at)
        scoped_total = (
            await db.execute(select(func.count()).select_from(base.subquery()))
        ).scalar_one()
        result = await db.execute(base.limit(page_size).offset((page - 1) * page_size))
        rows = [memory_to_dict(m) for m in result.scalars().all()]
        await _attach_source_machines(db, auth, rows)
        return Paginated[MemoryResponse](
            items=[MemoryResponse.model_validate(m) for m in rows],
            total=scoped_total,
            page=page,
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
    # Fallback path for scoped key + non-Builtin provider (Mem0 today).
    # Same env filter the deleted-pre-fix unscoped path used to apply.
    # Pagination total is `len(rows)` after filter — not perfect, but
    # the alternative is leaking cross-env memories to a deploy key.
    # If Mem0 grows scope-awareness later, push the filter into the
    # provider call instead of post-filtering.
    if _is_env_bound_api_key(auth):
        rows = await _scope_filter_memories(db, auth, rows)
        return Paginated[MemoryResponse](
            items=[MemoryResponse.model_validate(m) for m in rows],
            total=len(rows),
            page=page,
            page_size=page_size,
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
    # Apply the same scope filter as list_memories: a deploy key
    # bound to env-A can read its own memories by ID but is 404'd
    # on memories whose source session lives in env-B (or manual
    # adds with no env attribution). Without this guard a deploy
    # key with memories:read could enumerate IDs and read the
    # entire user's memory store.
    filtered = await _scope_filter_memories(db, auth, [payload])
    if not filtered:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
    return MemoryResponse.model_validate(filtered[0])


@router.post("")
async def create_memory(
    body: MemoryCreate,
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
) -> MemoryCreatedResponse:
    # Refuse env-bound scoped keys: the memory created here would
    # have no `source_session_id`, so `_scope_filter_memories`
    # would drop it on every read by the same key — the row
    # exists but is invisible to its creator (and visible to
    # unscoped/JWT callers, which is the wrong direction for a
    # scoped key's blast radius). Memories that should be visible
    # to env-A's deploy key need to be created via a session
    # write under env-A; surface that intent explicitly.
    if _is_env_bound_api_key(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Env-bound api keys cannot create manual memories. "
            "Memories without a source session aren't visible to scoped reads.",
        )
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
    auth: AuthContext = Depends(require_scope("memories:write")),
    db: AsyncSession = Depends(get_session),
) -> MemoryDeleteResponse:
    # Same scope guard as the read path: a scoped api_key bound
    # to env-A must not be able to delete a memory sourced from
    # env-B. The pre-delete check is gated on the resolved
    # provider being the Builtin store: Mem0 memories live in
    # Mem0's cloud, not the PG `memories` table. Pre-fix this
    # path always queried PG, which 404'd every Mem0-backed
    # delete (the row simply isn't there) — Mem0 users couldn't
    # delete any memory through the API.
    provider = await get_memory_provider(str(auth.user_id), db)
    if isinstance(provider, BuiltinProvider):
        result = await db.execute(
            select(Memory).where(
                Memory.id == memory_id,
                Memory.user_id == auth.user_id,
            )
        )
        target = result.scalar_one_or_none()
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
        payload = memory_to_dict(target)
        filtered = await _scope_filter_memories(db, auth, [payload])
        if not filtered:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
    elif _is_env_bound_api_key(auth):
        # Mem0 + scoped key: provider can't filter by env scope,
        # and we can't easily pre-check ownership here. Refuse
        # rather than allow a deploy key to delete out-of-env
        # memories. Future: query Mem0 by id and check metadata
        # for source_session_id ↔ env mapping.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Scoped api keys cannot delete Mem0-backed memories yet.",
        )
    await provider.delete(str(auth.user_id), str(memory_id))
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

    Env-bound api keys are rejected: this is a maintenance/admin
    operation that touches every memory the user owns, including
    cross-env memories the bound key isn't allowed to read. Pre-fix
    a leaked env-A deploy key with `scopes=None` could call this
    endpoint and feed every env's content to the embedder as a side
    channel.
    """
    if _is_env_bound_api_key(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Embed backfill is a user-level maintenance op; env-bound api keys cannot run it.",
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
