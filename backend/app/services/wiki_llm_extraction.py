"""LLM-driven wiki extraction (replaces the heuristic regex extractor).

Mirrors nashsu/llm_wiki's two-step Chain-of-Thought ingest, but compressed
into a single LLM call per atom for the personal-data scale we're at:

  Per atom (memory | session | skill | vault scope):
    - Build a prompt that includes the atom text + a short list of existing
      entity slugs (so the LLM can reuse instead of duplicating).
    - LLM returns JSON: a list of entities mentioned in this atom, each
      with slug / title / type / key_facts / confidence.
    - Persist as wiki_pages (upsert) + wiki_links (atom → entity).
    - The existing wiki_synthesis pipeline reads accumulated source links
      per page and rewrites compiled_truth from them.

Why one call instead of two: the analyze-then-generate split in llm_wiki
gives the LLM space to reason before writing files. We don't write files
— we write structured DB rows that the synthesis step turns into
compiled_truth. So the analysis step IS our extraction step. Synthesis
is the equivalent of llm_wiki's generation step, run lazily when there's
new evidence.

Quality controls that fix the "697 garbage entities" problem from the
heuristic extractor:
  - Hard guidance in the system prompt: "real-world things you actively
    work with", not generic nouns or actions.
  - Confidence threshold: links below 0.5 are dropped.
  - Per-atom cap: 0–6 entities (LLM is told quality > quantity).
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.memory import Memory
from app.models.session import Session as SessionModel
from app.models.skill import Skill
from app.models.vault import Vault
from app.models.wiki import WikiLink, WikiLogEntry, WikiPage
from app.services.slug_resolver import SlugResolver

log = logging.getLogger(__name__)

# Hard cap on atom text included in the prompt — keeps cost predictable.
# Most real atoms fit; oversized ones are truncated with a marker.
MAX_ATOM_CHARS = 4_000

# Top-N existing entity slugs to surface to the LLM as deduplication hints.
# Selected by simple keyword overlap with the atom text.
INDEX_HINT_SIZE = 25

# Drop entities the LLM extracts with confidence below this. Tunable —
# raise if we see noisy entries leak through, lower if we miss real ones.
MIN_LINK_CONFIDENCE = 0.5

# Hard cap per atom regardless of LLM output. Defensive — prevents one
# noisy atom from spawning 50 entities.
MAX_ENTITIES_PER_ATOM = 8


SYSTEM_PROMPT = """\
You are extracting a personal knowledge graph from one source atom from a user's data store.

A source atom is one of: memory, session summary, skill, vault scope name.

Your job: identify the KEY ENTITIES this atom is about. An entity is a real-world named \
thing the user actively works with — a project, tool, service, person, place, or named \
concept. Examples: "Polymarket", "Twilio", "Saad De Rycker", "phala-cloud", "OpenClaw".

NOT entities:
- Generic nouns: "server", "memory", "system", "config", "status", "knowledge"
- Actions: "deploy", "monitor", "fetch"
- Adjectives or stopwords
- Things mentioned only in passing without substantive content

For each entity, output:
- slug: lowercase-kebab-case canonical id (e.g. "twilio", "voice-agent", "marvin-claw")
- title: display name with original casing (e.g. "Twilio", "Voice Agent", "marvin-claw")
- type: one of project, tool, service, person, concept, place
- key_facts: 1-2 sentence factual summary of what THIS atom contributes about THIS entity \
(NOT a generic description — what does THIS atom say specifically?)
- confidence: 0.0-1.0; lower if you're guessing, ≥0.8 if the atom names the entity \
explicitly multiple times

If an existing slug from the index hint matches the entity, REUSE it exactly. Slugs are \
case-sensitive identifiers — don't invent variants of an existing one.

Quality over quantity. 0-5 entities is typical. 6+ only when the atom genuinely surveys \
many things. NEVER include credential values, API keys, or vault VALUES — vault scope \
NAMES are fine.

Respond with JSON only, no prose:
{"entities": [{"slug":"...","title":"...","type":"project","key_facts":"...","confidence":0.85}]}\
"""


def _shortlist_existing_slugs(text: str, candidate_slugs: list[str], limit: int) -> list[str]:
    """Pick the existing slugs most likely to match this atom by keyword overlap.

    Naive: split atom text into words, count how many of each slug's hyphen
    parts appear. Top-`limit` by overlap. Avoids sending all 697 slugs to
    the LLM (token cost) while still surfacing the relevant ones.
    """
    if not candidate_slugs:
        return []
    words = {w.lower() for w in re.findall(r"[a-zA-Z][a-zA-Z0-9]{2,}", text or "")}
    if not words:
        return candidate_slugs[:limit]
    scored: list[tuple[int, str]] = []
    for slug in candidate_slugs:
        parts = slug.split("-")
        score = sum(1 for p in parts if p in words)
        if score:
            scored.append((score, slug))
    scored.sort(reverse=True)
    return [s for _, s in scored[:limit]]


async def _existing_slug_index(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    rows = (
        (await db.execute(select(WikiPage.slug).where(WikiPage.user_id == user_id))).scalars().all()
    )
    return list(rows)


def _build_user_prompt(
    atom_type: str,
    atom_label: str,
    atom_text: str,
    existing_slugs: list[str],
) -> str:
    text = (atom_text or "").strip()
    if len(text) > MAX_ATOM_CHARS:
        text = text[:MAX_ATOM_CHARS] + "\n\n[…truncated]"
    parts = [
        f"Atom type: {atom_type}",
        f"Atom id/label: {atom_label}",
        "",
        "Atom content:",
        text,
        "",
    ]
    if existing_slugs:
        parts.append("Existing entity slugs in this user's wiki (REUSE if matching):")
        parts.append(", ".join(existing_slugs))
    return "\n".join(parts)


def _parse_entities(raw: str) -> list[dict[str, Any]]:
    """Parse the LLM's JSON output. Returns [] on any malformation."""
    if not raw:
        return []
    # Some models wrap JSON in ```json ... ``` fences despite response_format=json_object;
    # strip if present.
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("LLM returned non-JSON entity output: %r", raw[:200])
        return []
    if not isinstance(data, dict):
        return []
    entities = data.get("entities") or []
    if not isinstance(entities, list):
        return []
    return entities[:MAX_ENTITIES_PER_ATOM]


async def _llm_extract_entities(
    *,
    client: Any,
    model: str,
    atom_type: str,
    atom_label: str,
    atom_text: str,
    existing_slugs_hint: list[str],
) -> list[dict[str, Any]]:
    user_prompt = _build_user_prompt(atom_type, atom_label, atom_text, existing_slugs_hint)
    try:
        # response_format=json_object isn't universally supported; if it fails
        # we still parse defensively. Lower temperature for stable extraction.
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                max_tokens=600,
                temperature=0.1,
                response_format={"type": "json_object"},
            )
        except TypeError:
            # Older clients/models that don't accept response_format
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                max_tokens=600,
                temperature=0.1,
            )
    except Exception as e:
        log.warning("LLM call failed for %s/%s: %s", atom_type, atom_label, e)
        return []
    content = (response.choices[0].message.content or "").strip()
    return _parse_entities(content)


async def _already_processed(
    db: AsyncSession, user_id: uuid.UUID, source_type: str, source_ref: str
) -> bool:
    res = await db.scalar(
        select(func.count(WikiLogEntry.id)).where(
            WikiLogEntry.user_id == user_id,
            WikiLogEntry.action == f"extracted_from_{source_type}",
            WikiLogEntry.source_type == source_type,
            WikiLogEntry.source_ref == source_ref,
        )
    )
    return bool(res and res > 0)


async def _link_already_exists(
    db: AsyncSession,
    user_id: uuid.UUID,
    page_id: uuid.UUID,
    source_type: str,
    source_ref: str,
) -> bool:
    res = await db.scalar(
        select(func.count(WikiLink.id)).where(
            WikiLink.user_id == user_id,
            WikiLink.from_page_id == page_id,
            WikiLink.source_type == source_type,
            WikiLink.source_ref == source_ref,
        )
    )
    return bool(res and res > 0)


async def _process_atom_llm(
    *,
    db: AsyncSession,
    user_id: uuid.UUID,
    resolver: SlugResolver,
    client: Any,
    model: str,
    source_type: str,
    source_ref: str,
    atom_label: str,
    atom_text: str,
    existing_slugs_hint: list[str],
) -> dict:
    entities = await _llm_extract_entities(
        client=client,
        model=model,
        atom_type=source_type,
        atom_label=atom_label,
        atom_text=atom_text,
        existing_slugs_hint=existing_slugs_hint,
    )

    pages_touched = 0
    links_added = 0
    accepted: list[dict[str, Any]] = []
    # Track all page IDs touched in this atom so we can wire up page→page
    # co-occurrence edges below. Two entities mentioned in the same atom
    # are evidence the user uses them together.
    co_occurring_page_ids: list[uuid.UUID] = []

    for ent in entities:
        try:
            confidence = float(ent.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < MIN_LINK_CONFIDENCE:
            continue
        candidate = (ent.get("slug") or ent.get("title") or "").strip()
        if not candidate:
            continue
        try:
            slug, exists = await resolver.resolve(candidate)
        except ValueError:
            continue

        if exists:
            page = await db.scalar(
                select(WikiPage).where(WikiPage.user_id == user_id, WikiPage.slug == slug)
            )
            if page is None:
                page = WikiPage(
                    user_id=user_id,
                    slug=slug,
                    title=ent.get("title") or candidate,
                    kind="entity",
                )
                db.add(page)
                await db.flush()
                pages_touched += 1
        else:
            page = WikiPage(
                user_id=user_id,
                slug=slug,
                title=ent.get("title") or candidate,
                kind="entity",
                frontmatter={"type": ent.get("type", "concept")},
            )
            db.add(page)
            await db.flush()
            pages_touched += 1

        already = await _link_already_exists(db, user_id, page.id, source_type, source_ref)
        if already:
            continue

        # link_type: keep "mentions" for compatibility; richer types could be
        # derived from ent.type later (e.g. uses, references, defines).
        db.add(
            WikiLink(
                user_id=user_id,
                from_page_id=page.id,
                to_page_id=None,
                source_type=source_type,
                source_ref=source_ref,
                link_type="mentions",
                confidence=confidence,
                created_at=datetime.now(UTC),
            )
        )
        links_added += 1
        page.source_count = (page.source_count or 0) + 1
        accepted.append({"slug": slug, "title": page.title, "confidence": confidence})
        co_occurring_page_ids.append(page.id)

    # Page→page co-occurrence edges: any two entities the LLM extracted from
    # the same atom get linked with link_type="co-occurs". The schema's
    # CHECK constraint requires `to_page_id IS NOT NULL AND source_type IS NULL`
    # for page→page edges, so we don't pass source_type/source_ref here.
    # Idempotent via _page_link_already_exists.
    pp_edges_added = 0
    if len(co_occurring_page_ids) >= 2:
        for i, src_id in enumerate(co_occurring_page_ids):
            for dst_id in co_occurring_page_ids[i + 1 :]:
                if src_id == dst_id:
                    continue
                exists = await db.scalar(
                    select(func.count(WikiLink.id)).where(
                        WikiLink.user_id == user_id,
                        WikiLink.from_page_id == src_id,
                        WikiLink.to_page_id == dst_id,
                    )
                )
                if exists:
                    continue
                db.add(
                    WikiLink(
                        user_id=user_id,
                        from_page_id=src_id,
                        to_page_id=dst_id,
                        source_type=None,
                        source_ref=None,
                        link_type="co-occurs",
                        confidence=0.6,  # heuristic — same-atom co-occurrence
                        created_at=datetime.now(UTC),
                    )
                )
                pp_edges_added += 1
                # And the reverse direction so backlinks work both ways.
                exists_rev = await db.scalar(
                    select(func.count(WikiLink.id)).where(
                        WikiLink.user_id == user_id,
                        WikiLink.from_page_id == dst_id,
                        WikiLink.to_page_id == src_id,
                    )
                )
                if not exists_rev:
                    db.add(
                        WikiLink(
                            user_id=user_id,
                            from_page_id=dst_id,
                            to_page_id=src_id,
                            source_type=None,
                            source_ref=None,
                            link_type="co-occurs",
                            confidence=0.6,
                            created_at=datetime.now(UTC),
                        )
                    )
                    pp_edges_added += 1

    db.add(
        WikiLogEntry(
            user_id=user_id,
            action=f"extracted_from_{source_type}",
            source_type=source_type,
            source_ref=source_ref,
            metadata_={
                "extractor": "llm",
                "model": model,
                "entities_proposed": len(entities),
                "entities_accepted": len(accepted),
                "links_added": links_added,
                "page_to_page_edges_added": pp_edges_added,
                "pages_touched": pages_touched,
            },
            ts=datetime.now(UTC),
        )
    )

    return {"pages_touched": pages_touched, "links_added": links_added, "entities": accepted}


# ---------------------------------------------------------------------------
# Per-atom-type loops
# ---------------------------------------------------------------------------


async def _extract_memories(db, user_id, resolver, client, model, *, limit: int) -> dict:
    total = {"atoms": 0, "links_added": 0, "pages_created": 0, "skipped_processed": 0}
    rows = (
        (
            await db.execute(
                select(Memory)
                .where(Memory.user_id == user_id)
                .order_by(Memory.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    existing_slugs = await _existing_slug_index(db, user_id)
    for mem in rows:
        if await _already_processed(db, user_id, "memory", str(mem.id)):
            total["skipped_processed"] += 1
            continue
        hint = _shortlist_existing_slugs(mem.content, existing_slugs, INDEX_HINT_SIZE)
        result = await _process_atom_llm(
            db=db,
            user_id=user_id,
            resolver=resolver,
            client=client,
            model=model,
            source_type="memory",
            source_ref=str(mem.id),
            atom_label=str(mem.id)[:8],
            atom_text=mem.content,
            existing_slugs_hint=hint,
        )
        total["atoms"] += 1
        total["links_added"] += result["links_added"]
        total["pages_created"] += result["pages_touched"]
        await db.commit()
        # Refresh slug index after each atom so cross-atom dedup works.
        existing_slugs = await _existing_slug_index(db, user_id)
    return total


async def _extract_skills(db, user_id, resolver, client, model, *, limit: int) -> dict:
    total = {"atoms": 0, "links_added": 0, "pages_created": 0, "skipped_processed": 0}
    rows = (
        (
            await db.execute(
                select(Skill)
                .where(Skill.user_id == user_id, Skill.is_active.is_(True))
                .order_by(Skill.updated_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    existing_slugs = await _existing_slug_index(db, user_id)
    for sk in rows:
        if await _already_processed(db, user_id, "skill", sk.skill_key):
            total["skipped_processed"] += 1
            continue
        text = f"# Skill: {sk.name}\nKey: {sk.skill_key}\n\n{sk.description or ''}"
        hint = _shortlist_existing_slugs(text, existing_slugs, INDEX_HINT_SIZE)
        result = await _process_atom_llm(
            db=db,
            user_id=user_id,
            resolver=resolver,
            client=client,
            model=model,
            source_type="skill",
            source_ref=sk.skill_key,
            atom_label=sk.skill_key,
            atom_text=text,
            existing_slugs_hint=hint,
        )
        total["atoms"] += 1
        total["links_added"] += result["links_added"]
        total["pages_created"] += result["pages_touched"]
        await db.commit()
        existing_slugs = await _existing_slug_index(db, user_id)
    return total


async def _extract_sessions(db, user_id, resolver, client, model, *, limit: int) -> dict:
    total = {"atoms": 0, "links_added": 0, "pages_created": 0, "skipped_processed": 0}
    rows = (
        (
            await db.execute(
                select(SessionModel)
                .where(SessionModel.user_id == user_id)
                .order_by(SessionModel.updated_at.desc().nullslast())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    existing_slugs = await _existing_slug_index(db, user_id)
    for s in rows:
        if not s.summary:
            continue
        if await _already_processed(db, user_id, "session", str(s.id)):
            total["skipped_processed"] += 1
            continue
        label = s.local_session_id or str(s.id)[:8]
        text = f"# Session: {label}\n\n{s.summary}"
        hint = _shortlist_existing_slugs(text, existing_slugs, INDEX_HINT_SIZE)
        result = await _process_atom_llm(
            db=db,
            user_id=user_id,
            resolver=resolver,
            client=client,
            model=model,
            source_type="session",
            source_ref=str(s.id),
            atom_label=s.local_session_id or str(s.id)[:8],
            atom_text=text,
            existing_slugs_hint=hint,
        )
        total["atoms"] += 1
        total["links_added"] += result["links_added"]
        total["pages_created"] += result["pages_touched"]
        await db.commit()
        existing_slugs = await _existing_slug_index(db, user_id)
    return total


async def _extract_vault_scopes(db, user_id, resolver, client, model) -> dict:
    """Vault: one atom per scope. Body lists scope name + member key NAMES.

    NEVER reads vault values. Only the slug + name + key list (which
    is non-secret; the values are the secrets).
    """
    total = {"atoms": 0, "links_added": 0, "pages_created": 0, "skipped_processed": 0}
    vaults = (await db.execute(select(Vault).where(Vault.user_id == user_id))).scalars().all()
    existing_slugs = await _existing_slug_index(db, user_id)
    for v in vaults:
        if await _already_processed(db, user_id, "vault", v.slug):
            total["skipped_processed"] += 1
            continue
        # Listing item NAMES is safe; values are encrypted and never read here.
        # Defer item listing to the body of the synthesis if needed.
        text = f"# Vault scope: {v.name}\nSlug: {v.slug}"
        hint = _shortlist_existing_slugs(text, existing_slugs, INDEX_HINT_SIZE)
        result = await _process_atom_llm(
            db=db,
            user_id=user_id,
            resolver=resolver,
            client=client,
            model=model,
            source_type="vault",
            source_ref=v.slug,
            atom_label=v.slug,
            atom_text=text,
            existing_slugs_hint=hint,
        )
        total["atoms"] += 1
        total["links_added"] += result["links_added"]
        total["pages_created"] += result["pages_touched"]
        await db.commit()
        existing_slugs = await _existing_slug_index(db, user_id)
    return total


async def llm_extract_for_user(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    memory_limit: int = 200,
    skill_limit: int = 200,
    session_limit: int = 200,
) -> dict:
    """Run LLM-driven entity extraction across all 4 atom types.

    Returns 503-shaped dict if LLM isn't configured. Idempotent: only
    processes atoms that don't have an `extracted_from_<type>` log entry yet.
    """
    if not settings.llm_api_key:
        return {
            "status": "disabled",
            "reason": "llm_api_key empty; cannot run LLM extraction",
        }

    # Lazy import — keeps openai out of cold-start when not configured.
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )
    model = settings.llm_model

    resolver = SlugResolver(db, user_id)

    memories = await _extract_memories(db, user_id, resolver, client, model, limit=memory_limit)
    skills = await _extract_skills(db, user_id, resolver, client, model, limit=skill_limit)
    sessions = await _extract_sessions(db, user_id, resolver, client, model, limit=session_limit)
    vaults = await _extract_vault_scopes(db, user_id, resolver, client, model)

    return {
        "extractor": "llm",
        "model": model,
        "memories": memories,
        "skills": skills,
        "sessions": sessions,
        "vault": vaults,
    }


async def llm_extract_for_memory(
    db: AsyncSession,
    user_id: uuid.UUID,
    memory_id: uuid.UUID,
) -> dict:
    """Run LLM extraction on a single newly-written memory.

    Used by the live-wiki webhook in `routes/memories.py::create_memory`:
    after a memory is persisted, schedule this in BackgroundTasks so the
    wiki picks up new entities without waiting for the next cron sweep.

    Idempotent — if a `extracted_from_memory` log entry already exists for
    this memory id, this is a no-op. That makes it safe to retry, and safe
    to run alongside the batch extractor.
    """
    if not settings.llm_api_key:
        return {"status": "disabled"}

    mem = await db.scalar(
        select(Memory).where(Memory.id == memory_id, Memory.user_id == user_id)
    )
    if mem is None:
        return {"status": "not_found"}

    if await _already_processed(db, user_id, "memory", str(mem.id)):
        return {"status": "already_processed"}

    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )
    model = settings.llm_model
    resolver = SlugResolver(db, user_id)
    existing_slugs = await _existing_slug_index(db, user_id)
    hint = _shortlist_existing_slugs(mem.content, existing_slugs, INDEX_HINT_SIZE)

    result = await _process_atom_llm(
        db=db,
        user_id=user_id,
        resolver=resolver,
        client=client,
        model=model,
        source_type="memory",
        source_ref=str(mem.id),
        atom_label=str(mem.id)[:8],
        atom_text=mem.content,
        existing_slugs_hint=hint,
    )
    await db.commit()
    return {"status": "extracted", **result}


__all__ = ["llm_extract_for_user", "llm_extract_for_memory"]
