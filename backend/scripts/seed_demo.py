"""Seed demo data into the local backend DB so the dashboard looks populated.

Targets an existing Clerk-mirrored user in the `users` table (that is, sign
in once on the web app first — Clerk auto-creates the row on first request).
Picks the newest `@phala.network` user by default; override with --email.

Running this twice is safe: each run wipes the previous seed for that user
before inserting, so contribution graph stays one coherent year.

Usage:
    cd backend
    uv run python scripts/seed_demo.py                    # newest phala user
    uv run python scripts/seed_demo.py --email foo@bar    # pick a user
    uv run python scripts/seed_demo.py --clerk-id user_X  # by clerk id
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Allow `uv run python scripts/seed_demo.py` from the backend/ dir without
# needing to package `scripts` as a module or prepend PYTHONPATH manually.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, or_, select  # noqa: E402

from app.core.database import async_session_factory  # noqa: E402
from app.models.memory import Memory  # noqa: E402
from app.models.session import AgentEnvironment, Session  # noqa: E402
from app.models.skill import Skill  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vault import Vault, VaultItem  # noqa: E402
from app.services.vault_crypto import encrypt  # noqa: E402

# --- Content pools -----------------------------------------------------------

PROJECTS = [
    "/Users/kingsley/Programs/clawdi-cloud",
    "/Users/kingsley/Programs/clawdi",
    "/Users/kingsley/Programs/redpill-chatgpt",
    "/Users/kingsley/Programs/experiments/mcp-sandbox",
    "/Users/kingsley/Programs/phala-network",
]

MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-5"]

# One environment per agent_type. Last-seen jitter so Overview's "active now"
# badge lights up on one or two of them — makes the Agents card feel alive.
ENVIRONMENTS: list[tuple[str, str, str, str, int]] = [
    # (machine_id, machine_name, agent_type, os, last_seen_minutes_ago)
    ("kingsley-mbp", "kingsley-mbp", "claude_code", "darwin", 2),
    ("kingsley-linux", "kingsley-linux", "codex", "linux", 240),
    ("hermes-prod", "hermes.clawdi.ai", "hermes", "linux", 15),
    ("kingsley-openclaw", "kingsley-openclaw", "openclaw", "linux", 90),
]

SUMMARIES = [
    "Refactor auth middleware — split Clerk and API-key paths",
    "Implement pgvector search for memories",
    "Debug session upload path-traversal vuln",
    "Add rolling-restart logic to deploy.sh",
    "Fix CORS preflight for cloud.clawdi.ai origin",
    "Wire up Composio OAuth for 1Password connector",
    "Port clawdi vault to three-level AES-GCM encryption",
    "Investigate fastembed cold-start penalty",
    "Add Sentry error reporting to FastAPI lifespan",
    "Write alembic migration for memory embedding column",
    "Replace manual CLI types with generated openapi-typescript",
    "Polish Connectors page — flat cards, logo breathing room",
    "Gate dashboard behind ALLOWED_EMAIL_DOMAINS allowlist",
    "Triple-review PR #7 before merge (Codex + code-reviewer)",
    "Deploy backend to redpill via supervisor + nginx + certbot",
    "Seed local DB for demo",
]

MEMORIES: list[tuple[str, str, list[str]]] = [
    ("fact", "Primary dev box is kingsley-mbp on macOS darwin 25.4.0", ["env", "setup"]),
    ("fact", "Backend runs on Python 3.12 with uv; frontend is Next.js 16 + Bun", ["stack"]),
    ("fact", "Prod Postgres has pgvector 0.6 + pg_trgm 1.6", ["infra", "db"]),
    ("fact", "Clerk publishable key lives in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", ["auth"]),
    ("fact", "Redpill box IP is 66.220.6.122, exposed via Cloudflare proxy", ["infra"]),
    ("fact", "pgvector embedding dim is 768 (paraphrase-multilingual-mpnet-base-v2)", ["ml"]),
    ("fact", "MCP proxy signs JWTs with HS256 using ENCRYPTION_KEY", ["security"]),
    ("fact", "Vault data-at-rest uses AES-256-GCM with VAULT_ENCRYPTION_KEY", ["security"]),
    ("preference", "Prefer terse answers; skip the recap at the end of every response", ["style"]),
    ("preference", "Use `bun` instead of `npm`; `uv`/`pdm` for Python", ["tooling"]),
    ("preference", "All code comments in English; chat replies in Chinese", ["lang"]),
    (
        "preference",
        "Single-quote strings in TS, double-quote in Python, match the linter",
        ["style"],
    ),
    ("preference", "Tables over bullet lists when comparing 3+ items", ["style"]),
    (
        "preference",
        "Name React Query keys as arrays not strings: ['sessions', filter]",
        ["frontend"],
    ),
    ("pattern", "Wrap every async mutation in try/except and surface to toast()", ["frontend"]),
    ("pattern", "Store timestamps in UTC in DB; convert to local tz in UI only", ["backend"]),
    ("pattern", "Never commit `.env`; use `.env.example` with placeholder values", ["ops"]),
    ("pattern", "Paginated[T] envelope on list endpoints — frontend reads .items/.total", ["api"]),
    ("pattern", "Server-side search via pg_trgm + ILIKE; client just passes q= param", ["api"]),
    (
        "pattern",
        "Use shadcn Dialog with sm:max-w-* override, default sm:max-w-lg is narrow",
        ["frontend"],
    ),
    (
        "pattern",
        "CORS max_age stays short in dev (30s) so route changes don't cache-lock browsers",
        ["api"],
    ),
    ("decision", "Went with supervisord + uv over Docker for clawdi-cloud backend", ["deploy"]),
    ("decision", "Email-domain allowlist is web-only; backend intentionally unchanged", ["auth"]),
    ("decision", "Use primary-mode Clerk on both clawdi.ai and cloud.clawdi.ai", ["auth"]),
    (
        "decision",
        "Keep VAULT_ENCRYPTION_KEY and ENCRYPTION_KEY separate — data vs JWT scope",
        ["security"],
    ),
    (
        "decision",
        "Tokens column in Sessions table sorts by input+output sum, not a single col",
        ["product"],
    ),
    ("decision", "Cmd+K palette searches server-side (not client-side filter)", ["product"]),
    ("decision", "Default pagination page_size is 25 across all entities", ["api"]),
    ("decision", "Theme = tweakcn 'Claude +' preset, Geist font override", ["design"]),
    (
        "context",
        "clawdi-cloud is OSS; SaaS container orchestration stays in main clawdi",
        ["product"],
    ),
    (
        "context",
        "Main clawdi uses k3s + Traefik; clawdi-cloud piggybacks on redpill nginx",
        ["ops"],
    ),
    ("context", "Phala Network hosts redpill box; kernel 6.8, ~240 days uptime", ["infra"]),
    ("context", "Private beta — only @phala.network emails pass isEmailAllowed()", ["auth"]),
    ("context", "CLI wraps all paginated calls: const {items} = await api.get(...)", ["cli"]),
    ("context", "Memory search is hybrid: FTS + pg_trgm fuzzy + pgvector cosine rerank", ["ml"]),
    (
        "context",
        "dashboard-01 reference pulled from shadcn registry for table patterns",
        ["design"],
    ),
    (
        "context",
        "Openclaw sessions sync less often — client runs as a daemon not a CLI",
        ["product"],
    ),
    ("context", "Hermes is the enterprise agent flavor, runs on self-hosted infra", ["product"]),
]

SKILLS: list[tuple[str, str, str, list[str]]] = [
    (
        "frontend-design",
        "Frontend Design",
        "Create distinctive, production-grade frontend interfaces that reject generic AI looks",
        ["claude_code"],
    ),
    (
        "webapp-testing",
        "Webapp Testing",
        "Test web applications using Playwright with screenshots and browser logs",
        ["claude_code", "codex"],
    ),
    (
        "claude-api",
        "Claude API",
        "Build, debug, and optimize Claude API and Anthropic SDK applications",
        ["claude_code"],
    ),
]

# Vault seed data — multiple vaults to exercise the list view and verify
# section grouping (keys in / default section vs keys scoped to a prefix).
VAULTS: list[tuple[str, str, list[tuple[str, str, str]]]] = [
    (
        "ai-keys",
        "AI API keys",
        [
            ("", "OPENAI_API_KEY", "sk-demo-openai-not-real-abc123"),
            ("", "ANTHROPIC_API_KEY", "sk-ant-demo-not-real-xyz789"),
            ("prod/db", "PASSWORD", "demo-postgres-pw-not-real"),
            ("prod/db", "HOST", "db.example.internal"),
        ],
    ),
    (
        "deploy",
        "Deploy credentials",
        [
            ("", "VERCEL_TOKEN", "demo-vercel-not-real-tok123"),
            ("", "SENTRY_AUTH_TOKEN", "demo-sentry-not-real-tok456"),
            ("cloudflare", "API_TOKEN", "demo-cf-not-real-tok789"),
        ],
    ),
    (
        "local-dev",
        "Local overrides",
        [
            ("", "STRIPE_TEST_KEY", "sk_test_demo_not_real_stripe"),
            ("", "POSTMARK_TOKEN", "demo-postmark-not-real-tok"),
        ],
    ),
]


# --- Seed logic --------------------------------------------------------------


async def _find_user(db, email: str | None, clerk_id: str | None) -> User:
    if clerk_id:
        stmt = select(User).where(User.clerk_id == clerk_id)
    elif email:
        stmt = select(User).where(User.email == email)
    else:
        # Default: newest phala.network user; fall back to any user.
        stmt = (
            select(User)
            .where(or_(User.email.ilike("%@phala.network"), User.email.isnot(None)))
            .order_by(User.email.ilike("%@phala.network").desc(), User.created_at.desc())
            .limit(1)
        )
    user = (await db.execute(stmt)).scalar_one_or_none()
    if not user:
        raise SystemExit(
            "No matching user. Sign in once on the web app (http://localhost:3000)"
            " so Clerk creates the row, then rerun."
        )
    return user


async def _wipe(db, user_id: uuid.UUID) -> None:
    # Delete in FK-safe order. vault_items cascade from vaults.
    await db.execute(
        delete(VaultItem).where(
            VaultItem.vault_id.in_(select(Vault.id).where(Vault.user_id == user_id))
        )
    )
    await db.execute(delete(Vault).where(Vault.user_id == user_id))
    await db.execute(delete(Memory).where(Memory.user_id == user_id))
    await db.execute(delete(Skill).where(Skill.user_id == user_id))
    await db.execute(delete(Session).where(Session.user_id == user_id))
    await db.execute(delete(AgentEnvironment).where(AgentEnvironment.user_id == user_id))


def _random_session(
    rng: random.Random,
    user_id: uuid.UUID,
    environment_id: uuid.UUID,
    days_back: int,
) -> Session:
    now = datetime.now(UTC)
    start = now - timedelta(
        days=days_back,
        hours=rng.randint(0, 23),
        minutes=rng.randint(0, 59),
    )
    duration = rng.randint(2 * 60, 90 * 60)  # 2–90 minutes
    end = start + timedelta(seconds=duration)
    msg_count = rng.randint(2, 40)
    input_tokens = rng.randint(500, 20_000)
    output_tokens = rng.randint(200, 8_000)
    cache_tokens = rng.randint(0, input_tokens // 2)
    model = rng.choice(MODELS)
    return Session(
        user_id=user_id,
        environment_id=environment_id,
        local_session_id=f"demo-{uuid.uuid4().hex[:12]}",
        project_path=rng.choice(PROJECTS),
        started_at=start,
        ended_at=end,
        duration_seconds=duration,
        message_count=msg_count,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_tokens,
        model=model,
        models_used=[model],
        summary=rng.choice(SUMMARIES),
        status="completed",
    )


async def seed(email: str | None, clerk_id: str | None, session_count: int) -> None:
    # Deterministic seed for reproducible demos.
    rng = random.Random(0xC1AD)

    async with async_session_factory() as db:
        user = await _find_user(db, email=email, clerk_id=clerk_id)
        print(f"Seeding for user {user.email or user.clerk_id} ({user.id})")

        await _wipe(db, user.id)
        await db.flush()

        envs: list[AgentEnvironment] = []
        now = datetime.now(UTC)
        for machine_id, machine_name, agent_type, os, seen_ago_min in ENVIRONMENTS:
            envs.append(
                AgentEnvironment(
                    user_id=user.id,
                    machine_id=machine_id,
                    machine_name=machine_name,
                    agent_type=agent_type,
                    agent_version="2.0.1",
                    os=os,
                    last_seen_at=now - timedelta(minutes=seen_ago_min),
                )
            )
        db.add_all(envs)
        await db.flush()

        # Spread sessions across last 365 days with bursts on "working days"
        # so the contribution graph looks like a human's, not uniform noise.
        # Distribute across agents — claude_code takes the bulk (~55%), the
        # others get visible but lighter share.
        def pick_env() -> AgentEnvironment:
            r = rng.random()
            if r < 0.55:
                return envs[0]  # claude_code
            if r < 0.75:
                return envs[1]  # codex
            if r < 0.90:
                return envs[2]  # hermes
            return envs[3]  # openclaw

        sessions: list[Session] = []
        for _ in range(session_count):
            # 70% of sessions in last 60 days; 30% in 60–365.
            if rng.random() < 0.7:
                days = rng.randint(0, 60)
            else:
                days = rng.randint(60, 365)
            sessions.append(_random_session(rng, user.id, pick_env().id, days))
        db.add_all(sessions)

        for category, content, tags in MEMORIES:
            db.add(
                Memory(
                    user_id=user.id,
                    content=content,
                    category=category,
                    source="demo",
                    tags=tags,
                )
            )

        for skill_key, name, description, agent_types in SKILLS:
            db.add(
                Skill(
                    user_id=user.id,
                    skill_key=skill_key,
                    name=name,
                    description=description,
                    version=1,
                    source="marketplace",
                    agent_types=agent_types,
                    content_hash=uuid.uuid4().hex,
                    source_repo=f"anthropics/skills/{skill_key}",
                    file_count=rng.randint(1, 8),
                    is_active=True,
                )
            )

        total_vault_items = 0
        for slug, name, items in VAULTS:
            vault = Vault(user_id=user.id, slug=slug, name=name)
            db.add(vault)
            await db.flush()
            for section, key, value in items:
                ciphertext, nonce = encrypt(value)
                db.add(
                    VaultItem(
                        vault_id=vault.id,
                        item_name=key,
                        section=section,
                        encrypted_value=ciphertext,
                        nonce=nonce,
                    )
                )
                total_vault_items += 1

        await db.commit()

        print(
            f"  ✓ {len(envs)} environments, {len(sessions)} sessions, "
            f"{len(MEMORIES)} memories, {len(SKILLS)} skills, "
            f"{len(VAULTS)} vaults with {total_vault_items} keys"
        )
        print("\nReload http://localhost:3000 to see it populated.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--email", help="Pick user by exact email")
    p.add_argument("--clerk-id", help="Pick user by Clerk user_id")
    p.add_argument(
        "--sessions",
        type=int,
        default=80,
        help="Number of demo sessions to create (default 80)",
    )
    args = p.parse_args()
    asyncio.run(seed(email=args.email, clerk_id=args.clerk_id, session_count=args.sessions))


if __name__ == "__main__":
    main()
