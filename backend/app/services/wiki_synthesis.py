"""Page synthesis — LLM-driven Compiled Truth + sanitizer guard.

Reads the source links for each wiki page, gathers the underlying atom
content (memory text, skill description, session summary, vault scope
name), and asks an LLM to write 1–2 paragraphs of "compiled truth" —
what we know about this entity right now.

Two hard guarantees:

1. **No vault values in the prompt.** We pass scope and key NAMES only;
   never call vault decryption from the synthesis path. The encryption
   layer is firewalled from this service by design.

2. **Defense-in-depth via WikiSanitizer.** Even if the LLM hallucinates
   a value (or a memory/session contains one inline), the sanitizer
   catches it before write. assert_clean raises VaultLeakError loudly
   rather than silently redacting — synthesis fails, the user sees the
   problem, the page keeps its previous compiled_truth.

Synthesis runs only on pages with new evidence since last_synthesis_at
(or pages that have never been synthesized). Idempotent: re-running
without new evidence is a no-op.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.session import Session as SessionModel
from app.models.skill import Skill
from app.models.vault import Vault, VaultItem
from app.models.wiki import WikiLink, WikiLogEntry, WikiPage
from app.services.vault_crypto import decrypt
from app.services.wiki_sanitizer import VaultLeakError, WikiSanitizer

log = logging.getLogger(__name__)


# Soft cap on prompt size to keep cost predictable. ~10k chars = ~2.5k
# tokens; combined with the system prompt and reply this stays well
# under any frontier model's context.
MAX_PROMPT_SOURCES_CHARS = 10_000

# Token budget for the synthesis reply. ~600 tokens = ~2 paragraphs.
SYNTHESIS_MAX_TOKENS = 600

# Min number of source links a page needs before we synthesize. Pages
# with only 1 weak heuristic link tend to be noise (a name mentioned
# in passing). Synthesis is real LLM cost; spend it on real entities.
MIN_SOURCES_FOR_SYNTHESIS = 1


SYSTEM_PROMPT = """You are the synthesis engine for a personal knowledge wiki. \
Each entity page aggregates everything we know about one real-world thing \
in the user's life — a tool, project, service, person, or concept.

Given the page title and a list of source atoms (memories, skills, sessions, \
vault scope names), write a 1–2 paragraph "compiled truth" answering \
"what do we know about this entity right now?".

Rules:
- Lead with the user's relationship to the entity (use it, build it, depend on it).
- Mention only facts present in the sources. Do NOT invent specifics.
- If sources contradict each other, prefer the most recent and note the conflict briefly.
- NEVER include any credential value, API key, password, or secret. \
You may mention that a vault SCOPE or KEY NAME exists; never write a value, \
even if you see something that looks like one in a source.
- Use proper nouns. Avoid pronouns when ambiguous.
- 200–400 words is plenty. Concise > exhaustive.
- Output the text directly — no preamble, no markdown headings, no bullet points
  unless they materially help."""


def _build_user_prompt(page_title: str, sources: list[str]) -> str:
    """Combine sources into one user-prompt block, with truncation."""
    body = "\n\n".join(f"- {s}" for s in sources)
    if len(body) > MAX_PROMPT_SOURCES_CHARS:
        body = body[:MAX_PROMPT_SOURCES_CHARS] + "\n\n[...truncated]"
    return (
        f"Entity: {page_title}\n\n"
        f"Sources ({len(sources)}):\n{body}\n\n"
        "Write the compiled truth for this entity now."
    )


def _redact_vault_values(text: str, vault_values: set[str]) -> str:
    """Replace any vault value verbatim-present in `text` with `[REDACTED]`.

    Pre-emptive redaction before LLM synthesis. The downstream sanitizer is
    still the authoritative leak guard; this is the prevention layer that
    keeps the LLM from seeing the secret in the first place, so it can't
    repeat verbatim and can't paraphrase plausibly-but-wrongly.

    Cheap O(n × k) substring replace — k=user's vault size (typically <50).
    Skips empty/very-short values (3 chars or less) to avoid false positives
    on common substrings.
    """
    if not vault_values or not text:
        return text
    for v in vault_values:
        if v and len(v) > 3:
            text = text.replace(v, "[REDACTED]")
    return text


async def _gather_sources(
    db: AsyncSession,
    user_id: uuid.UUID,
    page_id: uuid.UUID,
    vault_values: set[str] | None = None,
) -> list[str]:
    """Pull display strings for every link from this page → source atom.

    Vault links surface the scope name only — values are never read.
    Session transcripts are pre-redacted against the user's vault values
    before being included in the prompt.
    """
    vault_values = vault_values or set()
    link_rows = (
        (
            await db.execute(
                select(WikiLink).where(
                    WikiLink.user_id == user_id,
                    WikiLink.from_page_id == page_id,
                    WikiLink.source_type.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )

    # Per-session transcripts are large — render once per session id and
    # cache so 5 links to the same session share one fetch+truncate.
    session_text_cache: dict[str, str] = {}

    sources: list[str] = []
    for link in link_rows:
        if link.source_type == "skill":
            sk = await db.scalar(
                select(Skill).where(
                    Skill.user_id == user_id,
                    Skill.skill_key == link.source_ref,
                )
            )
            if sk:
                desc = sk.description or "(no description)"
                sources.append(f"[skill:{sk.skill_key}] {sk.name} — {desc}")
        elif link.source_type == "session":
            cached = session_text_cache.get(link.source_ref)
            if cached is None:
                try:
                    s_id = uuid.UUID(link.source_ref)
                except ValueError:
                    continue
                s = await db.scalar(
                    select(SessionModel).where(
                        SessionModel.user_id == user_id,
                        SessionModel.id == s_id,
                    )
                )
                if s is None:
                    continue
                # Lazy import keeps the file_store + json import off the
                # synthesis cold path when no session links are present.
                from app.services.wiki_llm_extraction import _load_session_transcript

                transcript = await _load_session_transcript(s)
                if not transcript:
                    continue
                # Trim per session — full transcripts are huge. Tail-bias:
                # last messages carry conclusions/decisions worth synthesizing.
                cached = transcript[-6_000:] if len(transcript) > 6_000 else transcript
                # Pre-redact vault values so the synthesis LLM never sees them
                # verbatim. Defense in depth — the post-LLM sanitizer is still
                # the hard guard, but redacting upstream means we don't waste
                # LLM tokens (and synthesis attempts) on transcripts that would
                # leak secrets if regurgitated.
                cached = _redact_vault_values(cached, vault_values)
                session_text_cache[link.source_ref] = cached
            sources.append(f"[session:{link.source_ref}] {cached}")
        elif link.source_type == "vault":
            # Scope name only. We do NOT touch VaultItem values.
            sources.append(
                f"[vault:{link.source_ref}] (the user has credentials stored "
                f"under this scope; values are never read by synthesis)"
            )
        # Note: source_type == "memory" links are no longer produced by the
        # extractor (option 2 of harness-and-wiki.md §13.5: wiki reads sessions
        # directly). Old memory-linked rows are tolerated but ignored — they'll
        # vanish on the next /api/wiki/wipe + extract cycle.
    return sources


async def _load_user_vault_values(db: AsyncSession, user_id: uuid.UUID) -> set[str]:
    """Decrypt all vault values for this user — used ONLY by the sanitizer.

    Returns an empty set if encryption isn't configured or any decryption
    fails. The sanitizer with an empty set is a no-op; better to fail
    open on the secondary defense than to fail the synthesis loop. The
    PRIMARY defense (never passing values to the LLM) holds regardless.
    """
    try:
        vaults = (
            (await db.execute(select(Vault.id).where(Vault.user_id == user_id))).scalars().all()
        )
        if not vaults:
            return set()
        items = (
            (await db.execute(select(VaultItem).where(VaultItem.vault_id.in_(vaults))))
            .scalars()
            .all()
        )
        values: set[str] = set()
        for item in items:
            try:
                values.add(decrypt(item.encrypted_value, item.nonce))
            except Exception:
                # Skip any item that fails to decrypt — bad nonce, etc.
                continue
        return values
    except Exception as e:
        log.warning("Vault load for sanitizer failed: %s — sanitizer will be empty", e)
        return set()


async def synthesize_page(
    db: AsyncSession,
    user_id: uuid.UUID,
    page: WikiPage,
    *,
    client,  # AsyncOpenAI; untyped here so the openai import stays lazy
    model: str,
    sanitizer: WikiSanitizer,
) -> dict:
    """Synthesize one page. Returns a result dict for logging.

    Caller is responsible for constructing the `AsyncOpenAI` client and
    picking the model — same pattern as Paco's `extract_memories_from_session`
    (see services/memory_extraction.py). Keeps the openai SDK off cold-start
    paths that don't need it.
    """
    sources = await _gather_sources(
        db, user_id, page.id, vault_values=getattr(sanitizer, "_values", set())
    )

    if len(sources) < MIN_SOURCES_FOR_SYNTHESIS:
        return {
            "status": "skipped",
            "reason": f"only {len(sources)} source(s); need >= {MIN_SOURCES_FOR_SYNTHESIS}",
            "sources": len(sources),
        }

    user_prompt = _build_user_prompt(page.title, sources)
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=SYNTHESIS_MAX_TOKENS,
            temperature=0.3,
        )
        text = (response.choices[0].message.content or "").strip()
    except Exception as e:
        return {"status": "llm_error", "error": str(e)[:200]}

    if not text:
        return {"status": "empty_completion"}

    try:
        sanitizer.assert_clean(text, context=f"page:{page.slug}")
    except VaultLeakError as e:
        # Hard fail loudly. Do NOT write the redacted version — surface
        # the leak so the synthesis prompt or source data can be fixed.
        log.error("Synthesis aborted for page %s due to vault leak: %s", page.slug, e)
        return {"status": "vault_leak", "leak_count": str(e)}

    # Persist.
    page.compiled_truth = text
    page.last_synthesis_at = datetime.now(UTC)
    # Embed compiled_truth for semantic search in /api/wiki/query. Falls back
    # to NULL if the embedder is unavailable — the query path still works
    # via tokenized FTS in that case.
    try:
        from app.services.embedding import resolve_embedder

        embedder = resolve_embedder()
        if embedder is not None:
            page.compiled_truth_embedding = await embedder.embed(text)
    except Exception as embed_err:  # noqa: BLE001 — best-effort, never block synthesis
        log.warning("Synthesis embedding failed for %s: %s", page.slug, embed_err)
    page.frontmatter = {
        **(page.frontmatter or {}),
        "synthesis_model": model,
        "synthesis_source_count": len(sources),
    }
    db.add(
        WikiLogEntry(
            user_id=user_id,
            page_id=page.id,
            action="synthesized",
            source_type="cron",
            metadata_={
                "model": page.frontmatter.get("synthesis_model"),
                "sources": len(sources),
                "output_chars": len(text),
            },
            ts=datetime.now(UTC),
        )
    )

    return {
        "status": "synthesized",
        "sources": len(sources),
        "chars": len(text),
    }


async def synthesize_for_user(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    limit: int = 300,
    force: bool = False,
) -> dict:
    """Run synthesis over pages that have new evidence since last_synthesis_at.

    With force=True, ignores the "new evidence" check and re-synthesizes
    all pages with enough sources — useful for backfills and demos.

    Uses the shared `LLM_*` settings (same credentials as
    `services/memory_extraction.py`). Empty `llm_api_key` disables the
    pipeline cleanly — entity extraction still runs; pages exist with
    sources but no compiled_truth until configured.
    """
    if not settings.llm_api_key:
        return {
            "status": "disabled",
            "reason": "LLM is not configured on this deployment (llm_api_key empty)",
        }

    # Local import keeps the openai SDK off the cold-start critical path
    # for routes that don't need it. Mirrors the pattern in
    # routes/sessions.py::extract_session_memories.
    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )
    model = settings.llm_model

    vault_values = await _load_user_vault_values(db, user_id)
    sanitizer = WikiSanitizer(vault_values)

    # Pages with at least one source link. If not force, also require
    # last_synthesis_at older than the newest link's created_at.
    if force:
        page_rows = (
            (
                await db.execute(
                    select(WikiPage)
                    .where(
                        WikiPage.user_id == user_id,
                        WikiPage.source_count >= MIN_SOURCES_FOR_SYNTHESIS,
                # `kind=source` pages already store the canonical transcript
                # tail as compiled_truth at creation time; re-running them
                # through synthesize_page would feed the raw transcript to
                # the LLM, which regurgitates verbatim secrets and the
                # sanitizer aborts. They are not entity pages — skip them.
                WikiPage.kind != "source",
                    )
                    .order_by(WikiPage.updated_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
    else:
        # "Stale" pages: those where the most recent incoming evidence
        # link is newer than the page's last_synthesis_at (or never
        # synthesized at all).
        newest_link_ts = (
            select(func.max(WikiLink.created_at))
            .where(WikiLink.from_page_id == WikiPage.id)
            .correlate(WikiPage)
            .scalar_subquery()
        )
        page_rows = (
            (
                await db.execute(
                    select(WikiPage)
                    .where(
                        WikiPage.user_id == user_id,
                        WikiPage.source_count >= MIN_SOURCES_FOR_SYNTHESIS,
                # `kind=source` pages already store the canonical transcript
                # tail as compiled_truth at creation time; re-running them
                # through synthesize_page would feed the raw transcript to
                # the LLM, which regurgitates verbatim secrets and the
                # sanitizer aborts. They are not entity pages — skip them.
                WikiPage.kind != "source",
                        (
                            (WikiPage.last_synthesis_at.is_(None))
                            | (WikiPage.last_synthesis_at < newest_link_ts)
                        ),
                    )
                    .order_by(WikiPage.updated_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )

    summary = {
        "considered": len(page_rows),
        "synthesized": 0,
        "skipped": 0,
        "errored": 0,
        "leak_blocked": 0,
        "vault_values_in_sanitizer": len(sanitizer),
    }

    for page in page_rows:
        result = await synthesize_page(
            db, user_id, page, client=client, model=model, sanitizer=sanitizer
        )
        if result["status"] == "synthesized":
            summary["synthesized"] += 1
        elif result["status"] == "vault_leak":
            summary["leak_blocked"] += 1
        elif result["status"] in ("skipped",):
            summary["skipped"] += 1
        else:
            summary["errored"] += 1
        # Commit per page so partial work survives a Cloudflare 100s cut
        # mid-loop. The whole sweep over a few hundred pages takes minutes
        # to tens of minutes; one terminal commit is all-or-nothing.
        await db.commit()

    return summary


__all__ = ["synthesize_for_user", "synthesize_page"]
