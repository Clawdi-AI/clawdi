"""Seed local dashboard data for browser testing with DEV_AUTH_BYPASS.

Run from ``backend/`` after migrations:

    DEV_AUTH_BYPASS=true uv run python scripts/seed_dashboard_dev.py

The script is idempotent for the configured dev clerk id: it deletes the
previous synthetic users first, then recreates a dashboard-ready graph with
owned projects, a shared project, an agent environment, sessions, skills,
vaults, and memories.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import secrets
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Allow `python scripts/seed_dashboard_dev.py` from backend/ without
# packaging scripts as a module.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings  # noqa: E402
from app.models.agent_project_binding import AgentProjectBinding  # noqa: E402
from app.models.memory import Memory  # noqa: E402
from app.models.project import (  # noqa: E402
    PROJECT_KIND_ENVIRONMENT,
    PROJECT_KIND_PERSONAL,
    PROJECT_KIND_WORKSPACE,
    Project,
)
from app.models.project_membership import ProjectMembership  # noqa: E402
from app.models.session import AgentEnvironment, Session  # noqa: E402
from app.models.skill import Skill  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.vault import Vault, VaultItem  # noqa: E402
from app.services.vault_crypto import encrypt  # noqa: E402


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


async def _delete_user_by_clerk_id(db: AsyncSession, clerk_id: str) -> None:
    existing = (
        await db.execute(select(User).where(User.clerk_id == clerk_id))
    ).scalar_one_or_none()
    if existing is not None:
        await db.delete(existing)
        await db.commit()
        print(f"removed user {clerk_id}", file=sys.stderr)


async def teardown(clerk_id: str) -> None:
    owner_clerk_id = f"{clerk_id}_shared_owner"
    engine = create_async_engine(settings.database_url, echo=False, future=True)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as db:
        await _delete_user_by_clerk_id(db, clerk_id)
        await _delete_user_by_clerk_id(db, owner_clerk_id)
    await engine.dispose()


def _user(*, clerk_id: str, email: str, name: str) -> User:
    return User(clerk_id=clerk_id, email=email, name=name)


def _personal_project(user: User) -> Project:
    return Project(
        user_id=user.id,
        name="Personal",
        slug="personal",
        kind=PROJECT_KIND_PERSONAL,
    )


async def _create_agent_project_graph(
    db: AsyncSession,
    *,
    user: User,
    workspace: Project,
    now: datetime,
    agent_type: str,
) -> tuple[Project, AgentEnvironment]:
    env_project = Project(
        user_id=user.id,
        name="Local Mac (Claude Code)",
        slug="local-mac",
        kind=PROJECT_KIND_ENVIRONMENT,
        description="Auto-managed project for the local development agent.",
    )
    db.add(env_project)
    await db.flush()

    env = AgentEnvironment(
        user_id=user.id,
        machine_id="dev-local-mac",
        machine_name="Local Mac",
        agent_type=agent_type,
        agent_version="dev",
        os="darwin",
        last_seen_at=now - timedelta(minutes=4),
        last_sync_at=now - timedelta(minutes=6),
        last_revision_seen=3,
        sync_enabled=True,
        default_project_id=env_project.id,
    )
    db.add(env)
    await db.flush()

    env_project.origin_environment_id = env.id
    db.add_all(
        [
            AgentProjectBinding(
                agent_id=env.id,
                project_id=env_project.id,
                binding_type="primary",
                priority=0,
                default_write_enabled=True,
                created_by_user_id=user.id,
            ),
            AgentProjectBinding(
                agent_id=env.id,
                project_id=workspace.id,
                binding_type="context",
                priority=1,
                default_write_enabled=False,
                created_by_user_id=user.id,
            ),
        ]
    )
    await db.flush()
    return env_project, env


def _skill(
    *,
    user_id,
    project_id,
    skill_key: str,
    name: str,
    description: str,
    source_repo: str = "Clawdi-AI/clawdi",
) -> Skill:
    return Skill(
        user_id=user_id,
        project_id=project_id,
        skill_key=skill_key,
        name=name,
        description=description,
        version=1,
        source="local",
        agent_types=["claude_code", "codex"],
        content_hash=_hash(skill_key),
        source_repo=source_repo,
        file_count=1,
        is_active=True,
    )


def _vault(*, user_id, project_id, slug: str, name: str) -> Vault:
    return Vault(user_id=user_id, project_id=project_id, slug=slug, name=name)


def _memory(*, user_id, content: str, category: str, tags: list[str]) -> Memory:
    return Memory(
        user_id=user_id,
        content=content,
        category=category,
        source="manual",
        tags=tags,
        metadata_={"seed": "dashboard-dev"},
    )


def _session(
    *,
    user_id,
    environment_id,
    local_session_id: str,
    project_path: str,
    started_at: datetime,
    minutes: int,
    summary: str,
    message_count: int,
    model: str,
    tags: list[str],
) -> Session:
    ended_at = started_at + timedelta(minutes=minutes)
    return Session(
        user_id=user_id,
        environment_id=environment_id,
        local_session_id=local_session_id,
        project_path=project_path,
        started_at=started_at,
        ended_at=ended_at,
        last_activity_at=ended_at,
        duration_seconds=minutes * 60,
        message_count=message_count,
        input_tokens=18_500 + message_count * 231,
        output_tokens=6_200 + message_count * 97,
        cache_read_tokens=32_000,
        model=model,
        models_used=[model, "gpt-5.4"],
        summary=summary,
        tags=tags,
        status="completed",
        related_refs={
            "prs": ["Clawdi-AI/clawdi#100"],
            "repos": ["Clawdi-AI/clawdi"],
            "branches": ["split/project-sharing-web-pr"],
        },
        content_hash=_hash(local_session_id),
        content_uploaded_at=ended_at,
    )


def _try_add_vault_items(vault: Vault, names: list[str]) -> list[VaultItem]:
    items: list[VaultItem] = []
    for name in names:
        ciphertext, nonce = encrypt(f"dev-{secrets.token_urlsafe(12)}")
        items.append(
            VaultItem(
                vault_id=vault.id,
                section="",
                item_name=name,
                encrypted_value=ciphertext,
                nonce=nonce,
            )
        )
    return items


async def seed(clerk_id: str, agent_type: str) -> None:
    owner_clerk_id = f"{clerk_id}_shared_owner"
    engine = create_async_engine(settings.database_url, echo=False, future=True)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async with sessionmaker() as db:
        await _delete_user_by_clerk_id(db, clerk_id)
        await _delete_user_by_clerk_id(db, owner_clerk_id)

        now = datetime.now(UTC)
        user = _user(
            clerk_id=clerk_id,
            email=settings.dev_auth_email,
            name=settings.dev_auth_name,
        )
        owner = _user(
            clerk_id=owner_clerk_id,
            email="design.partner@clawdi.local",
            name="Design Partner",
        )
        db.add_all([user, owner])
        await db.flush()

        personal = _personal_project(user)
        owner_personal = _personal_project(owner)
        workspace = Project(
            user_id=user.id,
            name="Engineering Launch",
            slug="engineering-launch",
            kind=PROJECT_KIND_WORKSPACE,
            description="Reusable launch context shared across local and hosted agents.",
        )
        shared_project = Project(
            user_id=owner.id,
            name="Design Partner",
            slug="design-partner",
            kind=PROJECT_KIND_WORKSPACE,
            description="Read-only project shared into the dev account.",
        )
        db.add_all([personal, owner_personal, workspace, shared_project])
        await db.flush()

        env_project, env = await _create_agent_project_graph(
            db,
            user=user,
            workspace=workspace,
            now=now,
            agent_type=agent_type,
        )

        db.add(
            ProjectMembership(
                project_id=shared_project.id,
                member_user_id=user.id,
                role="viewer",
                joined_via="link",
                joined_at=now - timedelta(days=1),
                resolved_owner_handle="design-partner",
            )
        )

        db.add_all(
            [
                _skill(
                    user_id=user.id,
                    project_id=workspace.id,
                    skill_key="planning/review-brief",
                    name="Review Brief",
                    description=(
                        "Summarize a product review into decisions, risks, and follow-up work."
                    ),
                ),
                _skill(
                    user_id=user.id,
                    project_id=env_project.id,
                    skill_key="local/runbook",
                    name="Local Runbook",
                    description="Local commands and checks for the development machine.",
                ),
                _skill(
                    user_id=owner.id,
                    project_id=shared_project.id,
                    skill_key="design/ui-critique",
                    name="UI Critique",
                    description="Review flows for hierarchy, consistency, and interaction clarity.",
                ),
            ]
        )

        github_vault = _vault(
            user_id=user.id,
            project_id=workspace.id,
            slug="github",
            name="GitHub",
        )
        deploy_vault = _vault(
            user_id=user.id,
            project_id=env_project.id,
            slug="deploy",
            name="Deploy",
        )
        design_vault = _vault(
            user_id=owner.id,
            project_id=shared_project.id,
            slug="figma",
            name="Figma",
        )
        db.add_all([github_vault, deploy_vault, design_vault])
        await db.flush()

        try:
            db.add_all(_try_add_vault_items(github_vault, ["GITHUB_TOKEN", "GH_ORG"]))
            db.add_all(_try_add_vault_items(deploy_vault, ["VERCEL_TOKEN", "SENTRY_DSN"]))
            db.add_all(_try_add_vault_items(design_vault, ["FIGMA_TOKEN"]))
        except (RuntimeError, ValueError) as exc:
            print(f"skipped vault items: {exc}", file=sys.stderr)

        db.add_all(
            [
                _memory(
                    user_id=user.id,
                    content=(
                        "Project resources are scoped by Project first, "
                        "then filtered by agent binding."
                    ),
                    category="decision",
                    tags=["projects", "resources"],
                ),
                _memory(
                    user_id=user.id,
                    content=(
                        "Keep project metadata components visually identical "
                        "across Skills and Vault."
                    ),
                    category="preference",
                    tags=["ui", "metadata"],
                ),
                _memory(
                    user_id=user.id,
                    content=(
                        "Shared projects are readable context and should never "
                        "become an agent Home project."
                    ),
                    category="decision",
                    tags=["sharing", "agents"],
                ),
            ]
        )

        db.add_all(
            [
                _session(
                    user_id=user.id,
                    environment_id=env.id,
                    local_session_id="dev-resource-review",
                    project_path="/Users/dev/clawdi",
                    started_at=now - timedelta(hours=2, minutes=20),
                    minutes=42,
                    summary="Reviewed project resource paths and simplified metadata usage.",
                    message_count=38,
                    model="claude-sonnet-4.5",
                    tags=["review", "projects"],
                ),
                _session(
                    user_id=user.id,
                    environment_id=env.id,
                    local_session_id="dev-ui-pass",
                    project_path="/Users/dev/clawdi/apps/web",
                    started_at=now - timedelta(days=1, hours=1),
                    minutes=67,
                    summary=(
                        "Aligned Skills, Vault, and Projects surfaces around "
                        "the same project model."
                    ),
                    message_count=54,
                    model="gpt-5.4",
                    tags=["ui", "resources"],
                ),
                _session(
                    user_id=user.id,
                    environment_id=env.id,
                    local_session_id="dev-seed-check",
                    project_path="/Users/dev/clawdi/backend",
                    started_at=now - timedelta(days=3, hours=4),
                    minutes=18,
                    summary="Seeded local data to verify dashboard browsing without Clerk.",
                    message_count=16,
                    model="gpt-5.4",
                    tags=["local-dev"],
                ),
            ]
        )

        await db.commit()

        print(f"DEV_CLERK_ID={clerk_id}")
        print(f"DEV_AUTH_HEADER='Authorization: Bearer {settings.dev_auth_token}'")
        print(f"DASHBOARD_URL={settings.web_origin}")
        print(f"USER_ID={user.id}")
        print(f"PROJECT_ID={workspace.id}")
        print(f"ENVIRONMENT_ID={env.id}")
        print(f"SHARED_PROJECT_ID={shared_project.id}")

    await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--clerk-id",
        default=settings.dev_auth_clerk_id,
        help="Synthetic Clerk id to seed; defaults to DEV_AUTH_CLERK_ID.",
    )
    parser.add_argument("--agent-type", default="claude_code")
    parser.add_argument(
        "--teardown",
        action="store_true",
        help="Delete the seeded dev users instead of creating them.",
    )
    args = parser.parse_args()

    if args.teardown:
        asyncio.run(teardown(args.clerk_id))
    else:
        asyncio.run(seed(args.clerk_id, args.agent_type))
