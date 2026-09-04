"""Memory provider interface with Built-in (PG) and Mem0 implementations."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import datetime

from pydantic import BaseModel, JsonValue
from sqlalchemy import select, text
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.query_utils import like_needle
from app.models.memory import Memory
from app.services.embedding import Embedder, EmbeddingUpstreamError, resolve_embedder
from app.services.memory_provider_mem0 import Mem0Provider
from app.services.memory_types import MemoryItem, MemoryProvider, MemoryProviderUnavailableError
from app.services.vault_crypto import decrypt_field

log = logging.getLogger(__name__)


class _RawMemorySearchRow(BaseModel):
    id: uuid.UUID
    content: str
    category: str
    source: str
    tags: list[str] | None = None
    access_count: int
    created_at: datetime
    source_session_id: uuid.UUID | None = None
    source_environment_id: uuid.UUID | None = None


class BuiltinProvider:
    """Memory provider backed by PostgreSQL.

    FTS and pg_trgm provide lexical recall. When an `Embedder` is supplied,
    pgvector results are merged with the lexical ranking using reciprocal
    rank fusion.
    """

    def __init__(self, db: AsyncSession, embedder: Embedder | None = None):
        self.db = db
        self.embedder = embedder

    async def add(
        self,
        user_id: str,
        content: str,
        category: str = "fact",
        source: str = "manual",
        tags: list[str] | None = None,
        source_session_id: uuid.UUID | None = None,
        source_environment_id: uuid.UUID | None = None,
    ) -> MemoryItem:
        vec: list[float] | None = None
        if self.embedder is not None:
            await self.db.commit()
            try:
                vec = await self.embedder.embed(content)
            except EmbeddingUpstreamError as exc:
                # Embedding is a nice-to-have on the write path — if the
                # embedder fails, store the memory anyway so the user's
                # write isn't silently dropped. Future search will fall
                # back to FTS/trigram for this row.
                log.warning("embedder failed at add-time, storing without: %s", exc)
        memory = Memory(
            user_id=uuid.UUID(user_id),
            content=content,
            category=category,
            source=source,
            tags=tags,
            source_session_id=source_session_id,
            source_environment_id=source_environment_id,
            embedding=vec,
        )
        self.db.add(memory)
        await self.db.commit()
        await self.db.refresh(memory)
        return {"id": str(memory.id)}

    async def search(
        self,
        user_id: str,
        query: str,
        limit: int = 50,
        category: str | None = None,
    ) -> list[MemoryItem]:
        query = query.strip()
        if not query:
            return []
        fts_rows = await self._search_fts(user_id, query, limit, category)
        if self.embedder is None:
            return fts_rows

        await self.db.commit()
        try:
            vec_rows = await self._search_vector(user_id, query, limit, category)
        except Exception as e:
            log.warning("vector search failed, using FTS-only: %s", e)
            return fts_rows

        return _reciprocal_rank_fusion((fts_rows, vec_rows), limit)

    async def _search_fts(
        self,
        user_id: str,
        query: str,
        limit: int,
        category: str | None,
    ) -> list[MemoryItem]:
        """Rank literal phrases first, then FTS and indexed trigram matches."""
        params = {
            "uid": uuid.UUID(user_id),
            "q": query,
            "pattern": like_needle(query),
            "cat": category,
            "lim": limit,
        }
        sql = text("""
            WITH search_query AS (
              SELECT websearch_to_tsquery('simple', :q) AS value
            ), candidates AS (
              SELECT
                m.*,
                m.content ILIKE :pattern ESCAPE '\\' AS literal_match,
                ts_rank_cd(m.content_tsv, search_query.value) AS fts_score,
                word_similarity(:q, m.content) AS trgm_score
              FROM memories m
              CROSS JOIN search_query
              WHERE user_id = :uid
                AND (CAST(:cat AS text) IS NULL OR category = :cat)
                AND (
                  m.content ILIKE :pattern ESCAPE '\\'
                  OR m.content_tsv @@ search_query.value
                  OR :q <% m.content
                )
            )
            SELECT *
            FROM candidates
            ORDER BY
              literal_match DESC,
              fts_score DESC,
              trgm_score DESC,
              created_at DESC,
              id ASC
            LIMIT :lim
        """)
        rows = (await self.db.execute(sql, params)).mappings().all()
        return [_row_to_dict(row) for row in rows]

    # Cosine-distance thresholds for vector search. Empirically on
    # `paraphrase-multilingual-mpnet-base-v2`, the legitimate-match band
    # (sim 0.22 – 0.55) overlaps the noise band (sim 0.06 – 0.29) for
    # short abstract queries paired with narrowly-phrased memories —
    # there is no single threshold that cleanly separates them.
    #
    # Try the strict floor first; only use the relaxed floor when strict
    # semantic recall returns nothing.
    VECTOR_DISTANCE_STRICT = 0.70  # sim ≥ 0.30 — high-confidence matches
    VECTOR_DISTANCE_RELAXED = 0.80  # sim ≥ 0.20 — fallback when strict empty

    async def _search_vector(
        self,
        user_id: str,
        query: str,
        limit: int,
        category: str | None,
    ) -> list[MemoryItem]:
        """pgvector cosine-distance nearest neighbors among rows with embeddings.

        Strict threshold first; if empty, retry with a relaxed threshold
        so abstract queries against narrowly-phrased memories still surface
        something rather than a pure "not found".
        """
        embedder = self.embedder
        if embedder is None:
            return []
        q_vec = await embedder.embed(query)
        rows = await self._run_vector_search(
            user_id,
            q_vec,
            limit,
            category,
            self.VECTOR_DISTANCE_STRICT,
        )
        if not rows:
            rows = await self._run_vector_search(
                user_id,
                q_vec,
                limit,
                category,
                self.VECTOR_DISTANCE_RELAXED,
            )
        out: list[MemoryItem] = []
        for mem, _dist in rows:
            out.append(memory_to_dict(mem))
        return out

    async def _run_vector_search(
        self,
        user_id: str,
        q_vec: list[float],
        limit: int,
        category: str | None,
        max_distance: float,
    ) -> Sequence[Row[tuple[Memory, float]]]:
        # pgvector applies ordinary WHERE filters after an approximate HNSW
        # scan. Iterative scans keep expanding until the tenant/category
        # predicate has enough rows, while preserving exact distance order.
        await self.db.execute(text("SET LOCAL hnsw.iterative_scan = strict_order"))
        distance = Memory.embedding.cosine_distance(q_vec)
        stmt = (
            select(Memory, distance.label("distance"))
            .where(
                Memory.user_id == uuid.UUID(user_id),
                Memory.embedding.is_not(None),
                distance < max_distance,
            )
            .order_by(distance)
            .limit(limit)
        )
        if category:
            stmt = stmt.where(Memory.category == category)
        return (await self.db.execute(stmt)).all()

    async def list_all(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
        category: str | None = None,
        order: str = "desc",
    ) -> list[MemoryItem]:
        q = select(Memory).where(Memory.user_id == uuid.UUID(user_id))
        if category:
            q = q.where(Memory.category == category)
        order_col = Memory.created_at.asc() if order == "asc" else Memory.created_at.desc()
        q = q.order_by(order_col).limit(limit).offset(offset)
        result = await self.db.execute(q)
        return [memory_to_dict(m) for m in result.scalars().all()]

    async def count(
        self,
        user_id: str,
        category: str | None = None,
    ) -> int:
        from sqlalchemy import func as sqlfunc

        q = select(sqlfunc.count()).select_from(Memory).where(Memory.user_id == uuid.UUID(user_id))
        if category:
            q = q.where(Memory.category == category)
        return (await self.db.execute(q)).scalar_one()

    async def update(self, user_id: str, memory_id: str, content: str) -> bool:
        try:
            parsed_memory_id = uuid.UUID(memory_id)
        except ValueError:
            return False
        owner_id = uuid.UUID(user_id)
        exists = (
            await self.db.execute(
                select(Memory.id).where(
                    Memory.id == parsed_memory_id,
                    Memory.user_id == owner_id,
                )
            )
        ).scalar_one_or_none()
        if exists is None:
            return False

        vec: list[float] | None = None
        if self.embedder is not None:
            await self.db.commit()
            try:
                vec = await self.embedder.embed(content)
            except EmbeddingUpstreamError as exc:
                log.warning("embedder failed at update-time, clearing stale embedding: %s", exc)

        memory = (
            await self.db.execute(
                select(Memory)
                .where(
                    Memory.id == parsed_memory_id,
                    Memory.user_id == owner_id,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if memory is None:
            await self.db.rollback()
            return False
        memory.content = content
        memory.embedding = vec
        await self.db.commit()
        return True

    async def delete(self, user_id: str, memory_id: str) -> bool:
        try:
            parsed_memory_id = uuid.UUID(memory_id)
        except ValueError:
            return False
        result = await self.db.execute(
            select(Memory).where(
                Memory.id == parsed_memory_id,
                Memory.user_id == uuid.UUID(user_id),
            )
        )
        memory = result.scalar_one_or_none()
        if memory is None:
            return False
        await self.db.delete(memory)
        await self.db.commit()
        return True


# ---------- helpers ----------


def memory_to_dict(m: Memory) -> MemoryItem:
    tags: list[JsonValue] | None = [tag for tag in m.tags] if m.tags is not None else None
    return {
        "id": str(m.id),
        "content": m.content,
        "category": m.category,
        "source": m.source,
        "tags": tags,
        "access_count": m.access_count,
        "created_at": m.created_at.isoformat(),
        # Session linkage so the route layer can JOIN through to the
        # source machine in one bulk query. None when the memory was
        # added manually.
        "source_session_id": str(m.source_session_id) if m.source_session_id else None,
        "source_environment_id": (
            str(m.source_environment_id) if m.source_environment_id else None
        ),
    }


def _row_to_dict(raw: object) -> MemoryItem:
    """Serialize a raw SQL row (SQLAlchemy RowMapping) to the API shape."""
    row = _RawMemorySearchRow.model_validate(raw)
    tags: list[JsonValue] | None = [tag for tag in row.tags] if row.tags is not None else None
    return {
        "id": str(row.id),
        "content": row.content,
        "category": row.category,
        "source": row.source,
        "tags": tags,
        "access_count": row.access_count,
        "created_at": row.created_at.isoformat(),
        "source_session_id": (
            str(row.source_session_id) if row.source_session_id is not None else None
        ),
        "source_environment_id": (
            str(row.source_environment_id) if row.source_environment_id is not None else None
        ),
    }


def _reciprocal_rank_fusion(
    rankings: Sequence[Sequence[MemoryItem]],
    limit: int,
    *,
    rank_constant: int = 60,
) -> list[MemoryItem]:
    """Fuse independently ranked result sets without comparing score scales."""
    by_id: dict[str, MemoryItem] = {}
    scores: dict[str, float] = {}
    first_seen: dict[str, int] = {}
    for ranking in rankings:
        seen_in_ranking: set[str] = set()
        for rank, row in enumerate(ranking, start=1):
            memory_id = _memory_id(row)
            if memory_id in seen_in_ranking:
                continue
            seen_in_ranking.add(memory_id)
            by_id.setdefault(memory_id, row)
            first_seen.setdefault(memory_id, len(first_seen))
            scores[memory_id] = scores.get(memory_id, 0.0) + 1.0 / (rank_constant + rank)

    ranked_ids = sorted(by_id, key=lambda item_id: (-scores[item_id], first_seen[item_id]))
    return [by_id[item_id] for item_id in ranked_ids[:limit]]


def _memory_id(item: MemoryItem) -> str:
    memory_id = item.get("id")
    if not isinstance(memory_id, str) or not memory_id:
        raise ValueError("memory result is missing an id")
    return memory_id


# ---------- provider selection ----------


async def get_memory_provider(user_id: str, db: AsyncSession) -> MemoryProvider:
    """Resolve the memory provider for a user.

    Per-user choice: `memory_provider == "mem0"` (with a valid `mem0_api_key`)
    routes to Mem0Provider. Everything else goes to BuiltinProvider, whose
    embedder is picked from deployment-level env config (see
    `app.services.embedding.resolve_embedder`).
    """
    from app.models.user import UserSetting

    result = await db.execute(select(UserSetting).where(UserSetting.user_id == uuid.UUID(user_id)))
    setting = result.scalar_one_or_none()
    s = (setting.settings if setting else {}) or {}

    if s.get("memory_provider") == "mem0":
        raw_key = s.get("mem0_api_key")
        if not isinstance(raw_key, str) or not raw_key:
            log.warning("memory_provider=mem0 but mem0_api_key missing; falling back to builtin.")
            return BuiltinProvider(db, embedder=resolve_embedder())
        # Decrypt if stored with enc: prefix; legacy plaintext passes through.
        # Fall back to builtin on any decrypt failure so a single corrupt row
        # (or a misconfigured VAULT_ENCRYPTION_KEY at the process level) doesn't
        # 500 every memory request. decrypt_field raises ValueError on malformed
        # ciphertext and RuntimeError when the key itself is missing/invalid.
        try:
            api_key = decrypt_field(raw_key)
        except (ValueError, RuntimeError, TypeError) as e:
            log.error("failed to decrypt mem0_api_key, falling back to builtin: %s", e)
            return BuiltinProvider(db, embedder=resolve_embedder())
        # Defense-in-depth: even with the [mem0] extra installed, a missing
        # export or incompatible client constructor must not 500 the request.
        # The builtin provider
        # is always functional. Settings save validation also
        # checks `mem0_available()` before allowing the value to
        # land in user_settings, so this branch is the safety net,
        # not the primary gate.
        try:
            provider = Mem0Provider(api_key=api_key)
        except MemoryProviderUnavailableError:
            log.warning(
                "memory_provider=mem0 but the Mem0 SDK boundary is unavailable; "
                "falling back to builtin"
            )
            return BuiltinProvider(db, embedder=resolve_embedder())
        await db.commit()
        return provider

    return BuiltinProvider(db, embedder=resolve_embedder())
