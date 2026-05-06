"""One-shot cleanup for Claude Code resume-chain duplicates already in storage.

Background: Claude Code's `--resume` produces a new sessionId file whose jsonl
embeds the original session's full message history (via file-history-snapshot
entries that reuse the original message uuids). The CLI now dedupes these
chains client-side and never uploads the predecessor — but rows uploaded
before that fix landed in production are still around. This script cleans
them up.

Algorithm mirrors the CLI:
    The CLI compares jsonl-line `uuid` sets across files (set subset, no
    ordering required). The R2 blob the server stores is the CLI-processed
    `messages` array with no uuid field, so we substitute a per-message
    fingerprint over (role, content, model). A is a resume predecessor of B
    iff fingerprint(A.messages) is a strict set-subset of fingerprint(B).
    Order is not required — Claude Code's file-history-snapshot may reorder
    or skip the occasional line, but the union of message fingerprints in
    the predecessor must still appear in the leaf.

Safety:
- Dry-run by default; `--apply` is required to actually delete rows + R2 objects.
- Sessions grouped by (user_id, agent_type, project_path); only files within
  the same group are compared. agent_type is inferred from `agent_environments`.
- Predecessor must have >= 5 messages — guards against trivially-short sessions
  being mis-identified.
- R2 deletion is best-effort; logged on failure but DB row is still deleted
  (orphan blob is cheaper to GC later than a row that lies about its content).

Usage:
    # From backend/ — either form works:
    uv run python scripts/dedupe_resume_chains.py                    # dry-run, all users
    uv run python -m scripts.dedupe_resume_chains --user-id <uuid>   # dry-run, one user
    uv run python scripts/dedupe_resume_chains.py --apply            # actually delete
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import sys
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any

# Make `app.*` importable when invoked directly as `python scripts/X.py` —
# in that mode sys.path[0] is the scripts/ dir, which doesn't see the
# sibling app/ package. The `python -m scripts.X` form doesn't need this
# (sys.path[0] is the parent), but keeping both forms working is friendlier.
_REPO_BACKEND = Path(__file__).resolve().parent.parent
if str(_REPO_BACKEND) not in sys.path:
    sys.path.insert(0, str(_REPO_BACKEND))

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker  # noqa: E402

from app.core.database import engine  # noqa: E402
from app.models.session import AgentEnvironment, Session  # noqa: E402
from app.services.file_store import get_file_store  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dedupe-resume-chains")

# A predecessor must have at least this many messages. The fingerprint
# below already excludes coincidental matches via assistant output
# variance (LLM replies are never byte-identical across independent runs),
# but a higher floor is a free extra safety net.
MIN_PREDECESSOR_MESSAGES = 10


def fingerprint_messages(messages: list[dict[str, Any]]) -> list[str]:
    """Stable per-message fingerprint based on role+content+model.

    Does NOT include timestamp. Reasoning: timestamp was originally added
    to guard against two independent sessions with identical prompt
    sequences false-positiving as a resume chain. But assistant replies
    are non-deterministic across runs — even with the exact same user
    prompt, the second message in two independent sessions will differ
    in some character, breaking any false-positive prefix at length 2.
    Meanwhile, including timestamp in the fingerprint risked false
    negatives if Claude Code's file-history-snapshot rewrites timestamps
    on resume rather than preserving the original. Empirically (1427
    sessions / 137 groups in production) the timestamp variant found 3
    predecessors; without it, expect significantly more.

    Includes model on assistant messages so semantically different
    replies from different models don't fingerprint identically.
    """
    out: list[str] = []
    for m in messages:
        role = m.get("role", "")
        content = m.get("content", "")
        model = m.get("model", "") if role == "assistant" else ""
        h = hashlib.sha256(f"{role}\x00{model}\x00{content}".encode()).hexdigest()
        out.append(h)
    return out


def is_strict_subset(small: set[str], large: set[str]) -> bool:
    """True iff `small` is a strict subset of `large` (set semantics, no order).

    Mirrors the CLI's `dedupeResumeChains` logic. Resume snapshots may
    reorder or selectively replay lines on resume — what stays invariant
    is the union of distinct message fingerprints, which appears in every
    descendant.
    """
    return len(small) < len(large) and small.issubset(large)


async def find_predecessors_in_group(
    rows: list[Session],
    file_store: Any,
) -> list[tuple[Session, Session]]:
    """Within one (user, env, project) group, return list of (predecessor, leaf) pairs.

    Each predecessor links to its LARGEST proper-prefix superset, mirroring
    the CLI's `dedupeResumeChains` behavior for A⊂B⊂C cases.
    """
    if len(rows) < 2:
        return []

    # Pull each session's messages from the file store. Skip rows we can't read.
    # Store as fingerprint *sets* — set semantics mirror the CLI's uuid-set
    # subset check (`for u of aSet if !bSet.has(u)`).
    fp_sets_by_id: dict[uuid.UUID, set[str]] = {}
    for row in rows:
        if not row.file_key:
            continue
        try:
            data = await file_store.get(row.file_key)
        except Exception as e:
            log.warning("file_store.get failed for session %s (%s): %s", row.id, row.file_key, e)
            continue
        try:
            messages = json.loads(data)
        except Exception as e:
            log.warning("malformed JSON in %s: %s", row.file_key, e)
            continue
        if not isinstance(messages, list):
            continue
        fp_sets_by_id[row.id] = set(fingerprint_messages(messages))

    # Sort candidates ascending by set size so smaller checks come first.
    candidates = sorted(
        (
            r
            for r in rows
            if r.id in fp_sets_by_id and len(fp_sets_by_id[r.id]) >= MIN_PREDECESSOR_MESSAGES
        ),
        key=lambda r: len(fp_sets_by_id[r.id]),
    )

    pairs: list[tuple[Session, Session]] = []
    for i, a in enumerate(candidates):
        a_set = fp_sets_by_id[a.id]
        # Find the LARGEST b that strictly contains a — handles A⊂B⊂C by
        # linking both A and B to C in a single pass.
        best_leaf: Session | None = None
        best_size = 0
        for j in range(i + 1, len(candidates)):
            b = candidates[j]
            b_set = fp_sets_by_id[b.id]
            if len(b_set) <= len(a_set):
                continue
            if is_strict_subset(a_set, b_set) and len(b_set) > best_size:
                best_leaf = b
                best_size = len(b_set)
        if best_leaf is not None:
            pairs.append((a, best_leaf))

    return pairs


async def run(user_id: uuid.UUID | None, apply: bool) -> None:
    file_store = get_file_store()
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async with SessionLocal() as db:
        # Load environments so we can group by (user, agent_type, project_path).
        # Sessions with NULL environment_id (orphaned by env deletion) are
        # excluded from grouping — we don't have agent_type for them, and
        # cross-agent dedupe would be wrong.
        envs_q = select(AgentEnvironment.id, AgentEnvironment.agent_type)
        env_rows = (await db.execute(envs_q)).all()
        agent_type_by_env: dict[uuid.UUID, str] = {row.id: row.agent_type for row in env_rows}

        # Load all sessions (filtered by user if requested).
        s_query = select(Session).where(Session.environment_id.is_not(None))
        if user_id is not None:
            s_query = s_query.where(Session.user_id == user_id)
        all_sessions = (await db.execute(s_query)).scalars().all()

    # Group by (user_id, agent_type, project_path).
    groups: dict[tuple[uuid.UUID, str, str | None], list[Session]] = defaultdict(list)
    for s in all_sessions:
        env = s.environment_id
        if env is None:
            continue
        agent = agent_type_by_env.get(env)
        # Only Claude Code is known to produce resume-chain duplication.
        # Codex/openclaw/hermes use different storage schemes that don't
        # fan out across files, so dedupe-by-prefix would be a no-op at best.
        if agent != "claude_code":
            continue
        groups[(s.user_id, agent, s.project_path)].append(s)

    log.info(
        "scanning %d session(s) across %d group(s) (claude_code only)",
        sum(len(v) for v in groups.values()),
        len(groups),
    )

    # Detect predecessor pairs.
    all_pairs: list[tuple[Session, Session]] = []
    for group in groups.values():
        if len(group) < 2:
            continue
        pairs = await find_predecessors_in_group(group, file_store)
        all_pairs.extend(pairs)

    log.info("found %d predecessor session(s) to dedupe", len(all_pairs))

    if not all_pairs:
        return

    # Group by user for the report.
    by_user: dict[uuid.UUID, list[tuple[Session, Session]]] = defaultdict(list)
    for pred, leaf in all_pairs:
        by_user[pred.user_id].append((pred, leaf))

    for uid, pairs in by_user.items():
        log.info("user %s: %d predecessor(s)", uid, len(pairs))
        for pred, leaf in pairs:
            log.info(
                "  predecessor %s (msgs ~ unknown, file_key=%s) → leaf %s",
                pred.local_session_id,
                pred.file_key,
                leaf.local_session_id,
            )

    if not apply:
        log.info("dry-run: no rows or files were touched. Re-run with --apply to delete.")
        return

    # Execute deletions in chunks per user to keep transactions small.
    deleted_rows = 0
    deleted_files = 0
    failed_files = 0

    async with SessionLocal() as db:
        for uid, pairs in by_user.items():
            pred_ids = [pred.id for pred, _ in pairs]
            file_keys = [pred.file_key for pred, _ in pairs if pred.file_key]
            await db.execute(delete(Session).where(Session.id.in_(pred_ids)))
            await db.commit()
            deleted_rows += len(pred_ids)
            log.info("user %s: deleted %d row(s)", uid, len(pred_ids))
            for key in file_keys:
                try:
                    await file_store.delete(key)
                    deleted_files += 1
                except Exception as e:
                    failed_files += 1
                    log.warning("file_store.delete failed for %s: %s", key, e)

    log.info(
        "done: deleted_rows=%d deleted_files=%d failed_files=%d",
        deleted_rows,
        deleted_files,
        failed_files,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--user-id",
        type=str,
        help="Limit to a single user (UUID). Default: all users.",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete rows and R2 objects. Default is dry-run.",
    )
    args = ap.parse_args()

    user_id: uuid.UUID | None = None
    if args.user_id:
        try:
            user_id = uuid.UUID(args.user_id)
        except ValueError:
            log.error("invalid --user-id; expected a UUID")
            sys.exit(2)

    asyncio.run(run(user_id=user_id, apply=args.apply))


if __name__ == "__main__":
    main()
