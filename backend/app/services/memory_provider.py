"""Memory provider interface with Built-in (PG) and Mem0 implementations."""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.memory import Memory
from app.services.embedding import Embedder, resolve_embedder
from app.services.vault_crypto import decrypt_field

log = logging.getLogger(__name__)


class MemoryProvider(Protocol):
    async def add(
        self,
        user_id: str,
        content: str,
        category: str = "fact",
        source: str = "manual",
        tags: list[str] | None = None,
        source_session_id: uuid.UUID | None = None,
    ) -> dict: ...

    async def search(
        self, user_id: str, query: str, limit: int = 50, category: str | None = None
    ) -> list[dict]: ...

    async def list_all(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
        category: str | None = None,
        order: str = "desc",
    ) -> list[dict]: ...

    async def count(self, user_id: str, category: str | None = None) -> int: ...

    async def delete(self, user_id: str, memory_id: str) -> None: ...


class BuiltinProvider:
    """Memory provider backed by PostgreSQL.

    Adaptive: FTS (tsvector + ts_rank) + pg_trgm fuzzy is always on.
    When an `Embedder` is supplied, also does pgvector similarity search
    and merges results with temporal decay and MMR-style diversity rerank.
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
    ) -> dict:
        vec: list[float] | None = None
        if self.embedder is not None:
            try:
                vec = await self.embedder.embed(content)
            except Exception as e:
                # Embedding is a nice-to-have on the write path — if the
                # embedder fails, store the memory anyway so the user's
                # write isn't silently dropped. Future search will fall
                # back to FTS/trigram for this row.
                log.warning("embedder failed at add-time, storing without: %s", e)
        memory = Memory(
            user_id=uuid.UUID(user_id),
            content=content,
            category=category,
            source=source,
            tags=tags,
            source_session_id=source_session_id,
            embedding=vec,
        )
        self.db.add(memory)
        await self.db.commit()
        await self.db.refresh(memory)
        return {"id": str(memory.id)}

    async def search(
        self, user_id: str, query: str, limit: int = 50, category: str | None = None
    ) -> list[dict]:
        fts_rows = await self._search_fts(user_id, query, limit, category)
        if self.embedder is None:
            return [_strip_scores(r) for r in fts_rows]

        try:
            vec_rows = await self._search_vector(user_id, query, limit, category)
        except Exception as e:
            log.warning("vector search failed, using FTS-only: %s", e)
            return [_strip_scores(r) for r in fts_rows]

        merged = _merge_hybrid(vec_rows, fts_rows, limit)
        return [_strip_scores(r) for r in merged]

    async def _search_fts(
        self, user_id: str, query: str, limit: int, category: str | None
    ) -> list[dict]:
        """FTS + trigram hybrid with strict/relaxed score floor.

        Internal rows keep `combined_score` for downstream merge.
        """
        params = {
            "uid": uuid.UUID(user_id),
            "q": query,
            "pattern": f"%{query}%",
            "cat": category,
            "lim": limit,
        }
        sql = text("""
            WITH candidates AS (
              SELECT m.*,
                     ts_rank_cd(content_tsv, websearch_to_tsquery('simple', :q)) AS fts_score,
                     similarity(content, :q) AS trg_score
              FROM memories m
              WHERE user_id = :uid
                AND (CAST(:cat AS text) IS NULL OR category = :cat)
                AND (
                  content_tsv @@ websearch_to_tsquery('simple', :q)
                  OR similarity(content, :q) > 0.1
                  OR content ILIKE :pattern
                )
            )
            SELECT *,
                   (COALESCE(fts_score, 0) * 1.0
                    + COALESCE(trg_score, 0) * 0.5) AS combined_score
            FROM candidates
            WHERE (COALESCE(fts_score, 0) * 1.0 + COALESCE(trg_score, 0) * 0.5) >= :min_score
            ORDER BY combined_score DESC, created_at DESC
            LIMIT :lim
        """)
        rows = (await self.db.execute(sql, {**params, "min_score": 0.05})).mappings().all()
        if not rows:
            rows = (await self.db.execute(sql, {**params, "min_score": 0.0})).mappings().all()
        return [_row_to_search_dict(r, score_key="combined_score") for r in rows]

    # Cosine-distance thresholds for vector search. Empirically on
    # `paraphrase-multilingual-mpnet-base-v2`, the legitimate-match band
    # (sim 0.22 – 0.55) overlaps the noise band (sim 0.06 – 0.29) for
    # short abstract queries paired with narrowly-phrased memories —
    # there is no single threshold that cleanly separates them.
    #
    # Mirroring the FTS strict/relaxed pattern: try the strict floor
    # first; if that returns nothing, fall back to a permissive floor
    # so the user sees "kinda related" rather than nothing. MMR +
    # temporal-decay ranking in _merge_hybrid put noise at the bottom
    # when legitimate matches also exist, so the relaxed pass doesn't
    # pollute common cases.
    VECTOR_DISTANCE_STRICT = 0.70  # sim ≥ 0.30 — high-confidence matches
    VECTOR_DISTANCE_RELAXED = 0.80  # sim ≥ 0.20 — fallback when strict empty

    async def _search_vector(
        self, user_id: str, query: str, limit: int, category: str | None
    ) -> list[dict]:
        """pgvector cosine-distance nearest neighbors among rows with embeddings.

        Strict threshold first; if empty, retry with a relaxed threshold
        so abstract queries against narrowly-phrased memories still surface
        something rather than a pure "not found".
        """
        q_vec = await self.embedder.embed(query)
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
        out: list[dict] = []
        for mem, dist in rows:
            d = memory_to_dict(mem)
            # cosine distance ∈ [0, 2]; convert to similarity ∈ [0, 1].
            sim = max(0.0, 1.0 - float(dist))
            d["vector_score"] = sim
            out.append(d)
        return out

    async def _run_vector_search(
        self,
        user_id: str,
        q_vec: list[float],
        limit: int,
        category: str | None,
        max_distance: float,
    ):
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
    ) -> list[dict]:
        q = select(Memory).where(Memory.user_id == uuid.UUID(user_id))
        if category:
            q = q.where(Memory.category == category)
        order_col = Memory.created_at.asc() if order == "asc" else Memory.created_at.desc()
        q = q.order_by(order_col).limit(limit).offset(offset)
        result = await self.db.execute(q)
        return [memory_to_dict(m) for m in result.scalars().all()]

    async def count(self, user_id: str, category: str | None = None) -> int:
        from sqlalchemy import func as sqlfunc

        q = select(sqlfunc.count()).select_from(Memory).where(Memory.user_id == uuid.UUID(user_id))
        if category:
            q = q.where(Memory.category == category)
        return (await self.db.execute(q)).scalar_one()

    async def delete(self, user_id: str, memory_id: str) -> None:
        result = await self.db.execute(
            select(Memory).where(
                Memory.id == uuid.UUID(memory_id),
                Memory.user_id == uuid.UUID(user_id),
            )
        )
        memory = result.scalar_one_or_none()
        if memory:
            await self.db.delete(memory)
            await self.db.commit()


class Mem0Provider:
    """Memory provider backed by Mem0 API."""

    def __init__(self, api_key: str):
        from mem0 import MemoryClient

        self.client = MemoryClient(api_key=api_key)

    async def add(
        self,
        user_id: str,
        content: str,
        category: str = "fact",
        source: str = "manual",
        tags: list[str] | None = None,
        source_session_id: uuid.UUID | None = None,
    ) -> dict:
        # Mem0 has no native column for `source_session_id`; persist it in
        # metadata so the linkage isn't lost across providers.
        metadata: dict = {"category": category, "source": source, "tags": tags or []}
        if source_session_id is not None:
            metadata["source_session_id"] = str(source_session_id)
        result = self.client.add(
            [{"role": "user", "content": content}],
            user_id=user_id,
            metadata=metadata,
        )
        mem_id = result[0]["id"] if result else str(uuid.uuid4())
        return {"id": mem_id}

    async def search(
        self, user_id: str, query: str, limit: int = 50, category: str | None = None
    ) -> list[dict]:
        results = self.client.search(query, user_id=user_id, limit=limit)
        items = results.get("results", results) if isinstance(results, dict) else results
        out = []
        for r in items:
            if not isinstance(r, dict):
                continue
            meta = r.get("metadata", {}) or {}
            if category and meta.get("category") != category:
                continue
            out.append(
                {
                    "id": r.get("id", ""),
                    "content": r.get("memory", ""),
                    "category": meta.get("category", "fact"),
                    "source": "mem0",
                    "tags": meta.get("tags"),
                    "created_at": r.get("created_at", ""),
                    "source_session_id": meta.get("source_session_id"),
                }
            )
        return out

    async def list_all(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
        category: str | None = None,
        order: str = "desc",  # mem0 returns in insertion order; accepted for
        # Protocol compatibility but ignored here.
    ) -> list[dict]:
        del order  # intentionally unused for mem0 provider
        results = self.client.get_all(user_id=user_id)
        items = results if isinstance(results, list) else results.get("results", [])
        if category:
            items = [i for i in items if i.get("metadata", {}).get("category") == category]
        return [
            {
                "id": r.get("id", ""),
                "content": r.get("memory", ""),
                "category": r.get("metadata", {}).get("category", "fact"),
                "source": "mem0",
                "tags": r.get("metadata", {}).get("tags"),
                "created_at": r.get("created_at", ""),
                "source_session_id": r.get("metadata", {}).get("source_session_id"),
            }
            for r in items[offset : offset + limit]
        ]

    async def count(self, user_id: str, category: str | None = None) -> int:
        results = self.client.get_all(user_id=user_id)
        items = results if isinstance(results, list) else results.get("results", [])
        if category:
            items = [i for i in items if i.get("metadata", {}).get("category") == category]
        return len(items)

    async def delete(self, user_id: str, memory_id: str) -> None:
        self.client.delete(memory_id)


# ---------- helpers ----------


def memory_to_dict(m: Memory) -> dict:
    return {
        "id": str(m.id),
        "content": m.content,
        "category": m.category,
        "source": m.source,
        "tags": m.tags,
        "access_count": m.access_count,
        "created_at": m.created_at.isoformat(),
        # Session linkage so the route layer can JOIN through to the
        # source machine in one bulk query. None when the memory was
        # added manually.
        "source_session_id": str(m.source_session_id) if m.source_session_id else None,
    }


def _row_to_dict(r) -> dict:
    """Serialize a raw SQL row (SQLAlchemy RowMapping) to the API shape."""
    created_at = r["created_at"]
    sid = r.get("source_session_id") if hasattr(r, "get") else None
    return {
        "id": str(r["id"]),
        "content": r["content"],
        "category": r["category"],
        "source": r["source"],
        "tags": r["tags"],
        "access_count": r["access_count"],
        "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
        "source_session_id": str(sid) if sid else None,
    }


def _row_to_search_dict(r, score_key: str) -> dict:
    """Like `_row_to_dict` but preserves an internal score field for merging."""
    d = _row_to_dict(r)
    val = r.get(score_key) if hasattr(r, "get") else None
    if val is not None:
        d[score_key] = float(val)
    return d


def _strip_scores(d: dict) -> dict:
    """Remove internal score fields before returning to the client."""
    return {k: v for k, v in d.items() if k not in ("combined_score", "vector_score")}


# --- hybrid merge: vector + FTS, with temporal decay and MMR rerank ---


def _tokenize(s: str) -> set[str]:
    return {t for t in re.split(r"\W+", (s or "").lower()) if len(t) > 2}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _parse_iso_ts(v: object) -> datetime | None:
    """Parse the ISO-formatted `created_at` string produced by the _*_to_dict
    helpers. Returns None if the value isn't an ISO string we can parse."""
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def _apply_temporal_decay(
    scores: dict,
    rows_by_id: dict,
    half_life_days: float = 30.0,
) -> None:
    """Halve each score every `half_life_days`. In-place mutation.

    OpenClaw's `temporal-decay.ts` formula: e^(-ln(2)/halflife * age).
    """
    now = datetime.now(UTC)
    for rid, r in rows_by_id.items():
        created_at = _parse_iso_ts(r.get("created_at"))
        if created_at is None:
            continue
        age_days = max(0.0, (now - created_at).total_seconds() / 86400.0)
        scores[rid] *= 0.5 ** (age_days / half_life_days)


def _mmr_rerank(
    candidates: list[dict],
    scores: dict,
    limit: int,
    lam: float = 0.7,
) -> list[dict]:
    """Greedy MMR (Carbonell & Goldstein, 1998) on Jaccard token similarity.

    λ=0.7 relevance / 0.3 diversity. Uses content tokens so no extra
    embedding calls are needed to compute diversity.
    """
    picked: list[dict] = []
    picked_tokens: list[set[str]] = []
    rest = [(c, _tokenize(c.get("content", ""))) for c in candidates]
    while rest and len(picked) < limit:
        best_idx, best_mmr = 0, -1e9
        for i, (c, toks) in enumerate(rest):
            max_sim = max(
                (_jaccard(toks, pt) for pt in picked_tokens),
                default=0.0,
            )
            mmr = lam * scores.get(c["id"], 0.0) - (1 - lam) * max_sim
            if mmr > best_mmr:
                best_mmr, best_idx = mmr, i
        c, toks = rest.pop(best_idx)
        picked.append(c)
        picked_tokens.append(toks)
    return picked


def _merge_hybrid(
    vec_rows: list[dict],
    fts_rows: list[dict],
    limit: int,
    vector_weight: float = 0.7,
    text_weight: float = 0.3,
) -> list[dict]:
    """Merge vector + FTS results by weighted score, decay, then MMR rerank."""
    vec_max = max((r.get("vector_score", 0.0) for r in vec_rows), default=0.0) or 1.0
    fts_max = max((r.get("combined_score", 0.0) for r in fts_rows), default=0.0) or 1.0

    by_id: dict = {}
    vec_norm: dict = {}
    fts_norm: dict = {}
    for r in vec_rows:
        by_id[r["id"]] = r
        vec_norm[r["id"]] = (r.get("vector_score") or 0.0) / vec_max
    for r in fts_rows:
        by_id.setdefault(r["id"], r)
        fts_norm[r["id"]] = (r.get("combined_score") or 0.0) / fts_max

    scores: dict = {}
    for rid in by_id:
        scores[rid] = vector_weight * vec_norm.get(rid, 0.0) + text_weight * fts_norm.get(rid, 0.0)

    _apply_temporal_decay(scores, by_id)

    ranked = sorted(by_id.values(), key=lambda r: -scores[r["id"]])
    return _mmr_rerank(ranked, scores, limit, lam=0.7)


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
        raw_key = s.get("mem0_api_key", "")
        if not raw_key:
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
        return Mem0Provider(api_key=api_key)

    return BuiltinProvider(db, embedder=resolve_embedder())
