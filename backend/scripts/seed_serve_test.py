"""Seed a synthetic user + agent environment + deploy api_key for
the `clawdi serve` e2e test.

Companion to `scripts/serve-e2e.sh` at the repo root. Creates one
test user, one agent_environment row, AND one api_key bound to
that env, then prints `USER_ID=<uuid>`, `ENV_ID=<uuid>`, and
`RAW_KEY=clawdi_<token>` to stdout. The shell script parses
those out and feeds the raw key directly to `clawdi serve` —
bypasses any HTTP minting endpoint, so the e2e doesn't need a
shared internal secret to operate.

Idempotent: re-running with the same --label drops the previous
test user (cascade-deletes the env, sessions, skills, conflicts
that hung off it) and inserts fresh rows. So an aborted earlier
run doesn't pollute subsequent runs with stale state.

NOT for production. Bypasses Clerk on purpose — the synthetic
user has a fake clerk_id ("test_serve_e2e") that no real Clerk
session would mint, so a hostile login can't impersonate this
account. The teardown at the end of the e2e flow removes the
row anyway.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid
from pathlib import Path

# Allow `python scripts/seed_serve_test.py` from backend/ without
# packaging scripts as a module.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.models.scope import SCOPE_KIND_ENVIRONMENT, SCOPE_KIND_PERSONAL, Scope  # noqa: E402
from app.models.session import AgentEnvironment  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.api_key import mint_api_key  # noqa: E402


async def main(label: str, agent_type: str) -> None:
    engine = create_async_engine(settings.database_url, echo=False, future=True)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async with sessionmaker() as db:
        # Drop any prior seed for this label so a botched earlier
        # run doesn't pile up users / envs. Cascade-delete via the
        # FKs on api_keys / agent_environments / sessions.
        clerk_id = f"test_{label}"
        existing = (
            await db.execute(select(User).where(User.clerk_id == clerk_id))
        ).scalar_one_or_none()
        if existing is not None:
            await db.delete(existing)
            await db.commit()

        user = User(
            clerk_id=clerk_id,
            email=f"{label}@clawdi.local",
            name=f"E2E {label}",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Mirror the runtime path: every user gets a Personal scope
        # (production creates this on first Clerk JWT login). Then
        # mint an env-local scope and bind the env to it. Same
        # mutual-FK shape `register_environment` uses.
        personal = Scope(
            user_id=user.id,
            name="Personal",
            slug="personal",
            kind=SCOPE_KIND_PERSONAL,
        )
        db.add(personal)
        await db.flush()

        env_scope = Scope(
            user_id=user.id,
            name=f"e2e-{label} ({agent_type})",
            slug=f"env-{uuid.uuid4().hex[:12]}",
            kind=SCOPE_KIND_ENVIRONMENT,
        )
        db.add(env_scope)
        await db.flush()

        env = AgentEnvironment(
            user_id=user.id,
            machine_id=f"{label}-{uuid.uuid4().hex[:8]}",
            machine_name=f"e2e-{label}",
            agent_type=agent_type,
            os="darwin",
            sync_enabled=True,
            default_scope_id=env_scope.id,
        )
        db.add(env)
        await db.flush()

        env_scope.origin_environment_id = env.id
        await db.commit()
        await db.refresh(env)

        # Mint a deploy key directly via the service layer. Same
        # function the dashboard's POST /api/auth/keys handler calls,
        # so the persisted row matches a production-minted key
        # exactly (full account access, env-bound).
        minted = await mint_api_key(
            db,
            user_id=user.id,
            label=f"e2e-{label}",
            scopes=None,
            environment_id=env.id,
        )

        # Stdout is the shell-script-parseable contract. Anything
        # else (warnings, sql echo) goes to stderr by convention so
        # the shell can `eval $(python ...)` cleanly without
        # leaking debug noise into the env vars.
        print(f"USER_ID={user.id}")
        print(f"ENV_ID={env.id}")
        print(f"RAW_KEY={minted.raw_key}")

    await engine.dispose()


async def teardown(label: str) -> None:
    """Remove the seeded user (and everything that hangs off it).
    Called by the shell script in the trap so a CI run leaves no
    rows behind even if the daemon crashes mid-test."""
    engine = create_async_engine(settings.database_url, echo=False, future=True)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as db:
        clerk_id = f"test_{label}"
        existing = (
            await db.execute(select(User).where(User.clerk_id == clerk_id))
        ).scalar_one_or_none()
        if existing is not None:
            await db.delete(existing)
            await db.commit()
            print(f"removed user {clerk_id}", file=sys.stderr)
    await engine.dispose()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--label",
        default="serve_e2e",
        help="Slug used in the synthetic clerk_id and machine_id; "
        "lets us scope teardown to one test run.",
    )
    ap.add_argument("--agent-type", default="claude_code")
    ap.add_argument(
        "--teardown",
        action="store_true",
        help="Delete the user (and cascade) instead of seeding.",
    )
    args = ap.parse_args()

    if args.teardown:
        asyncio.run(teardown(args.label))
    else:
        asyncio.run(main(args.label, args.agent_type))
