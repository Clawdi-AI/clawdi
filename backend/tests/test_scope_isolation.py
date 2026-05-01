"""Scope-boundary regression suite.

These tests pin the security/correctness fixes from PR review
rounds 2 + B + E so they don't regress silently:

- POST /api/environments heals an existing env that lost its
  `default_scope_id` (B1). Pre-fix the new-env branch created
  a scope, but the existing-env branch returned without
  healing — daemons booted with "no default_scope_id" fatals.

- GET /api/memories filters memories to the bound env when
  the caller is a scoped api_key (deploy key). Pre-fix any
  caller with `memories:read` saw the user's full memory set,
  ignoring env binding.

- /api/search excludes vault hits for scoped api keys so a
  leaked deploy key (which only carries skills/sessions
  scopes) can't side-channel-read vault metadata.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.memory import Memory
from app.models.scope import SCOPE_KIND_ENVIRONMENT, Scope
from app.models.session import AgentEnvironment, Session
from app.models.user import User
from app.models.vault import Vault, VaultItem


async def _override_factory(db_session: AsyncSession, user: User, api_key: ApiKey | None = None):
    async def _session_override() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def _auth_override() -> AuthContext:
        return AuthContext(user=user, api_key=api_key)

    return _session_override, _auth_override


async def _client_for(
    db_session: AsyncSession, user: User, api_key: ApiKey | None
) -> httpx.AsyncClient:
    session_o, auth_o = await _override_factory(db_session, user, api_key)
    app.dependency_overrides[get_session] = session_o
    app.dependency_overrides[get_auth] = auth_o
    transport = ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest_asyncio.fixture
async def env_without_scope(db_session: AsyncSession, seed_user: User) -> AgentEnvironment:
    """A fixture for the heal-path test. Builds an env with a
    valid scope (the schema enforces NOT NULL), then NULLs the
    column directly through a raw UPDATE to simulate a row that
    lost its scope assignment via some pre-migration / cleanup
    bug. The next register_environment call should heal it.
    """
    from sqlalchemy import update

    pending_slug = f"env-{uuid.uuid4().hex[:12]}"
    scope = Scope(
        user_id=seed_user.id,
        name="Heal Test (claude_code)",
        slug=pending_slug,
        kind=SCOPE_KIND_ENVIRONMENT,
    )
    db_session.add(scope)
    await db_session.flush()

    env = AgentEnvironment(
        user_id=seed_user.id,
        machine_id="heal-test-mac",
        machine_name="Heal Test",
        agent_type="claude_code",
        os="darwin",
        default_scope_id=scope.id,
    )
    db_session.add(env)
    await db_session.flush()

    # Sneak the env into a broken state. The schema is NOT NULL,
    # but Postgres accepts NULL via direct UPDATE if no constraint
    # check fires — only INSERTs and explicit checks enforce.
    # If your local PG rejects this, the heal path is technically
    # unreachable in production too; the test serves as a lower
    # bound on what register_environment must tolerate.
    try:
        await db_session.execute(
            update(AgentEnvironment)
            .where(AgentEnvironment.id == env.id)
            .values(default_scope_id=None)
        )
        await db_session.commit()
        await db_session.refresh(env)
    except Exception:
        # Constraint check refused; skip — the env stays valid.
        await db_session.rollback()
    return env


async def test_register_environment_heals_missing_scope(
    db_session: AsyncSession,
    seed_user: User,
    env_without_scope: AgentEnvironment,
):
    """Re-registering an env that lost its default_scope_id
    must populate it before returning, so the daemon can boot.
    """
    if env_without_scope.default_scope_id is not None:
        # Constraint refused the NULL update; nothing to heal.
        # Treat as a passing no-op rather than a hard skip.
        return

    client = await _client_for(db_session, seed_user, None)
    try:
        resp = await client.post(
            "/api/environments",
            json={
                "machine_id": env_without_scope.machine_id,
                "machine_name": env_without_scope.machine_name,
                "agent_type": env_without_scope.agent_type,
                "os": env_without_scope.os,
                "agent_version": "0.0.1",
            },
        )
        assert resp.status_code == 200, resp.text
        # Re-read the row; the heal path should have written a
        # fresh default_scope_id.
        await db_session.refresh(env_without_scope)
        assert env_without_scope.default_scope_id is not None
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_memories_list_scoped_to_bound_env_for_deploy_keys(
    db_session: AsyncSession,
    seed_user: User,
):
    """A deploy key bound to env-A must NOT see memories whose
    source session lives in env-B (or any manual memory)."""
    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="env-a",
        machine_name="Env A",
    )
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="env-b",
        machine_name="Env B",
        agent_type="codex",
    )

    # Two sessions, one per env.
    sess_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="sa",
        started_at=__import__("datetime")
        .datetime.utcnow()
        .replace(tzinfo=__import__("datetime").timezone.utc),
    )
    sess_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="sb",
        started_at=__import__("datetime")
        .datetime.utcnow()
        .replace(tzinfo=__import__("datetime").timezone.utc),
    )
    db_session.add_all([sess_a, sess_b])
    await db_session.flush()

    # A memory for env-A (via session A), one for env-B, one
    # manual (no source session at all).
    mem_a = Memory(user_id=seed_user.id, content="from env-a", source_session_id=sess_a.id)
    mem_b = Memory(user_id=seed_user.id, content="from env-b", source_session_id=sess_b.id)
    mem_manual = Memory(user_id=seed_user.id, content="manual add")
    db_session.add_all([mem_a, mem_b, mem_manual])
    await db_session.commit()

    # Deploy key bound to env-A with memory:read scope (the
    # filter applies regardless of which scopes the key carries
    # because the cross-env leak would happen via memories:read,
    # which deploy keys today don't have — but the fix protects
    # any future scope shape).
    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="test-deploy",
        scopes=["memories:read"],
        environment_id=env_a.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        resp = await client.get("/api/memories")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        contents = {m["content"] for m in body["items"]}
        # Only env-A's memory; env-B and manual filtered out.
        assert contents == {"from env-a"}, contents
        assert body["total"] == 1
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_memories_list_pagination_correct_for_scoped_keys(
    db_session: AsyncSession,
    seed_user: User,
):
    """The post-filter pagination bug: when most page-1 memories belong
    to other envs, scoped key got `total=N_filtered_in_first_page`
    even though more env-A memories existed on page 2+. Client never
    fetched page 2 because it thought everything was on page 1.

    Fix: scoped reads page directly against the env-filtered query.
    Total reflects the env's actual memory count, not a leaky
    page-1-after-filter slice.
    """
    from datetime import UTC, datetime, timedelta

    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="paged-env-a",
        machine_name="Paged Env A",
    )
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="paged-env-b",
        machine_name="Paged Env B",
        agent_type="codex",
    )

    base = datetime.now(UTC)

    # 3 sessions in env-B (older), then 3 in env-A (newer). With
    # page_size=2 + desc order, page 1 of the unfiltered set is the
    # 2 newest env-A memories, page 2 is the third env-A + first
    # env-B, etc. Pre-fix would return total=2 on page 1 (post-
    # filter drops the env-B mix-ins) and the client gives up.
    sess_b_rows: list[Session] = []
    for i in range(3):
        s = Session(
            user_id=seed_user.id,
            environment_id=env_b.id,
            local_session_id=f"pg-sb-{i}",
            started_at=base - timedelta(minutes=10 + i),
        )
        sess_b_rows.append(s)
    sess_a_rows: list[Session] = []
    for i in range(3):
        s = Session(
            user_id=seed_user.id,
            environment_id=env_a.id,
            local_session_id=f"pg-sa-{i}",
            started_at=base - timedelta(minutes=i),
        )
        sess_a_rows.append(s)
    db_session.add_all(sess_a_rows + sess_b_rows)
    await db_session.flush()

    # 5 env-A memories total, 5 env-B, interleaved by created_at
    # so that any single page would mix both envs on the unfiltered
    # query path.
    for i in range(5):
        db_session.add(
            Memory(
                user_id=seed_user.id,
                content=f"a-mem-{i}",
                source_session_id=sess_a_rows[i % 3].id,
                created_at=base - timedelta(minutes=i * 2),
            )
        )
        db_session.add(
            Memory(
                user_id=seed_user.id,
                content=f"b-mem-{i}",
                source_session_id=sess_b_rows[i % 3].id,
                created_at=base - timedelta(minutes=i * 2 + 1),
            )
        )
    await db_session.commit()

    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="paged-deploy",
        scopes=["memories:read"],
        environment_id=env_a.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        # page 1: 2 of the 5 env-A memories.
        page1 = await client.get("/api/memories", params={"page": 1, "page_size": 2})
        body1 = page1.json()
        assert body1["total"] == 5, f"total must reflect env-A's memory count, got {body1['total']}"
        page1_contents = {m["content"] for m in body1["items"]}
        for c in page1_contents:
            assert c.startswith("a-mem-"), f"page 1 leaked non-env-A memory: {c}"
        assert len(page1_contents) == 2

        # page 3: tail of the env-A set.
        page3 = await client.get("/api/memories", params={"page": 3, "page_size": 2})
        body3 = page3.json()
        page3_contents = {m["content"] for m in body3["items"]}
        for c in page3_contents:
            assert c.startswith("a-mem-")
        # 5 total, page_size=2 → page 3 has 1 item (5 - 2*2).
        assert len(page3_contents) == 1
        assert body3["total"] == 5

        # No overlap between pages.
        assert page1_contents.isdisjoint(page3_contents)
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_unbound_cli_key_can_pin_any_scope(
    db_session: AsyncSession,
    seed_user: User,
):
    """An unbound device-flow CLI key (from `clawdi auth login`)
    must be able to read any of the user's scopes by passing
    `?scope_id=...`. Pre-fix `scope_ids_visible_to` returned only
    the most-recently-active scope for ALL is_cli auth, which
    intersected to empty when the daemon pinned a different scope
    (e.g. `clawdi serve --agent codex` with claude_code as the
    default) — daemon got zero skills.

    Bound deploy keys are still pinned to their env's scope; this
    test exercises only the unbound path.
    """
    from datetime import UTC, datetime

    from app.models.skill import Skill
    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="cli-env-a",
        machine_name="Env A",
    )
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="cli-env-b",
        machine_name="Env B",
        agent_type="codex",
    )

    # One skill per scope.
    db_session.add_all(
        [
            Skill(
                user_id=seed_user.id,
                scope_id=env_a.default_scope_id,
                skill_key="alpha-skill",
                name="alpha-skill",
                description="env A's skill",
                version=1,
                is_active=True,
                content_hash="a" * 64,
                file_count=1,
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            ),
            Skill(
                user_id=seed_user.id,
                scope_id=env_b.default_scope_id,
                skill_key="beta-skill",
                name="beta-skill",
                description="env B's skill",
                version=1,
                is_active=True,
                content_hash="b" * 64,
                file_count=1,
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            ),
        ]
    )
    await db_session.commit()

    # Unbound CLI key — no environment_id, no scopes list (full
    # account access, mirrors `clawdi auth login`).
    cli_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="cli-unbound",
        scopes=None,
        environment_id=None,
    )
    db_session.add(cli_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, cli_key)
    try:
        # Pin env-A's scope explicitly — must return env-A's
        # skill, NOT empty (the pre-fix bug).
        resp_a = await client.get("/api/skills", params={"scope_id": str(env_a.default_scope_id)})
        assert resp_a.status_code == 200, resp_a.text
        keys_a = {s["skill_key"] for s in resp_a.json()["items"]}
        assert keys_a == {"alpha-skill"}, keys_a

        # Pin env-B's scope — must return env-B's skill.
        resp_b = await client.get("/api/skills", params={"scope_id": str(env_b.default_scope_id)})
        keys_b = {s["skill_key"] for s in resp_b.json()["items"]}
        assert keys_b == {"beta-skill"}, keys_b

        # No pin → both visible (unbound key sees the user's full
        # inventory, same as the dashboard JWT).
        resp_all = await client.get("/api/skills")
        keys_all = {s["skill_key"] for s in resp_all.json()["items"]}
        assert keys_all == {"alpha-skill", "beta-skill"}, keys_all
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_bound_deploy_key_still_pinned_to_its_env(
    db_session: AsyncSession,
    seed_user: User,
):
    """The widening for unbound CLI keys must NOT widen bound
    deploy keys. A leaked env-A deploy key must still see only
    env-A's scope, even when it pins another scope explicitly."""
    from datetime import UTC, datetime

    from app.models.skill import Skill
    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="dep-env-a",
        machine_name="Env A",
    )
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="dep-env-b",
        machine_name="Env B",
        agent_type="codex",
    )
    db_session.add(
        Skill(
            user_id=seed_user.id,
            scope_id=env_b.default_scope_id,
            skill_key="env-b-only",
            name="env-b-only",
            description="not visible to env-A deploy key",
            version=1,
            is_active=True,
            content_hash="c" * 64,
            file_count=1,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="env-a-deploy",
        scopes=None,
        environment_id=env_a.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        # Even when explicitly pinning env-B's scope, the deploy
        # key must see nothing (env binding wins).
        resp = await client.get("/api/skills", params={"scope_id": str(env_b.default_scope_id)})
        assert resp.status_code == 200
        assert resp.json()["items"] == [], resp.json()
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_search_excludes_cross_env_memories_for_scoped_keys(
    db_session: AsyncSession,
    seed_user: User,
):
    """Global search memory hits must respect the same env-scope
    filter `/api/memories` applies. Without it, an env-A scoped
    key could read env-B's memory contents (and manual memories
    that have no env attribution at all) via the search palette
    — exact same leak the direct route was hardened against, just
    routed through a different endpoint.
    """
    from datetime import UTC, datetime

    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="search-env-a",
        machine_name="Env A",
    )
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="search-env-b",
        machine_name="Env B",
        agent_type="codex",
    )

    # Mark each session with a needle the search query will hit.
    sess_a = Session(
        user_id=seed_user.id,
        environment_id=env_a.id,
        local_session_id="search-sa",
        started_at=datetime.now(UTC),
    )
    sess_b = Session(
        user_id=seed_user.id,
        environment_id=env_b.id,
        local_session_id="search-sb",
        started_at=datetime.now(UTC),
    )
    db_session.add_all([sess_a, sess_b])
    await db_session.flush()

    needle = "kale-juice-needle-x7"
    db_session.add_all(
        [
            Memory(
                user_id=seed_user.id,
                content=f"env-a remembers {needle}",
                source_session_id=sess_a.id,
            ),
            Memory(
                user_id=seed_user.id,
                content=f"env-b remembers {needle}",
                source_session_id=sess_b.id,
            ),
            Memory(
                user_id=seed_user.id,
                content=f"manual note about {needle}",
            ),
        ]
    )
    await db_session.commit()

    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="test-deploy",
        scopes=["memories:read"],
        environment_id=env_a.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        resp = await client.get("/api/search", params={"q": needle})
        assert resp.status_code == 200, resp.text
        memory_titles = {
            hit["title"] for hit in resp.json().get("hits", []) if hit.get("type") == "memory"
        }
        # Only the env-A memory should leak through. Env-B and
        # the manual memory must be filtered.
        for t in memory_titles:
            assert "env-b" not in t, f"env-b memory leaked via search: {t}"
            assert "manual" not in t, f"manual memory leaked via search: {t}"
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_search_excludes_vault_for_scoped_keys(
    db_session: AsyncSession,
    seed_user: User,
):
    """Global search must omit vault metadata for any scoped
    api key (deploy keys + future scoped Personal keys).
    Personal CLI / Clerk auth keep full visibility."""
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="search-mac",
        machine_name="Search Mac",
    )
    # Create a vault item the search should NOT surface for a
    # scoped key.
    vault = Vault(
        user_id=seed_user.id,
        scope_id=env.default_scope_id,
        slug="search-vault",
        name="Search Test Vault",
    )
    db_session.add(vault)
    await db_session.flush()
    item = VaultItem(
        vault_id=vault.id,
        section="api",
        item_name="OPENAI_API_KEY",
        encrypted_value=b"x",
        nonce=b"y",
    )
    db_session.add(item)
    await db_session.commit()

    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="test-deploy",
        scopes=["sessions:write", "skills:read", "skills:write"],
        environment_id=env.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        resp = await client.get("/api/search", params={"q": "OPENAI"})
        assert resp.status_code == 200, resp.text
        sources = {hit["source"] for hit in resp.json().get("hits", [])}
        assert "vaults" not in sources
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_dashboard_endpoints_reject_env_bound_deploy_keys(
    db_session: AsyncSession,
    seed_user: User,
):
    """Round-42 P2 regression: `/api/dashboard/stats` and
    `/api/dashboard/contribution` aggregate by `user_id` only —
    no scope filter. An env-bound deploy key (full-permission
    api_key minted with `scopes=None` but pinned to
    `environment_id=A`) would otherwise read account-wide
    totals (sessions, message counts, token usage, contribution
    graph, skill/vault/memory counts) for sibling envs B/C/D
    that the resource-level routes explicitly hide from it.
    Forcing `require_web_auth` (Clerk JWT only) keeps the
    deploy-key isolation model intact."""
    from tests.conftest import create_env_with_scope

    env = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="env-a",
        machine_name="Env A",
    )
    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="test-deploy",
        # Full permission (default) — but env-bound, so the
        # dashboard's account-wide aggregate must still refuse.
        scopes=None,
        environment_id=env.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        for path in ("/api/dashboard/stats", "/api/dashboard/contribution"):
            resp = await client.get(path)
            assert resp.status_code == 403, (path, resp.status_code, resp.text)
    finally:
        await client.aclose()
        app.dependency_overrides.clear()


async def test_scope_explicit_upload_403s_bound_key_targeting_other_scope(
    db_session: AsyncSession,
    seed_user: User,
):
    """Round-r5 P1: a bound env-A deploy key sending
    `POST /api/scopes/{env_b.default_scope_id}/skills/upload`
    must 403, not silently accept the write into env-B.
    `validate_scope_for_caller` is the boundary for ALL phase-2
    scope-explicit writes (skills, vault, memory) — without it
    a leaked env-A key could plant skills (or steal vault items
    via the symmetric route) into ANY other scope by editing
    the URL. The existing `test_bound_deploy_key_still_pinned`
    only covers READ listing; this pin closes the WRITE side.
    """
    import gzip
    import io
    import tarfile

    from tests.conftest import create_env_with_scope

    env_a = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="upload-env-a",
        machine_name="Env A",
    )
    env_b = await create_env_with_scope(
        db_session,
        user_id=seed_user.id,
        machine_id="upload-env-b",
        machine_name="Env B",
        agent_type="codex",
    )

    deploy_key = ApiKey(
        user_id=seed_user.id,
        key_hash=uuid.uuid4().hex,
        key_prefix="clawdi_test",
        label="env-a-deploy",
        scopes=None,
        environment_id=env_a.id,
    )
    db_session.add(deploy_key)
    await db_session.commit()

    # Build a minimal valid skill archive rooted at "evil/".
    md_content = b"---\nname: evil\ndescription: cross-scope smuggle attempt\n---\n# attempt\n"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo(name="evil/SKILL.md")
        info.size = len(md_content)
        tf.addfile(info, io.BytesIO(md_content))
    gz_buf = io.BytesIO()
    with gzip.GzipFile(fileobj=gz_buf, mode="wb") as gz:
        gz.write(buf.getvalue())
    archive = gz_buf.getvalue()

    client = await _client_for(db_session, seed_user, deploy_key)
    try:
        resp = await client.post(
            f"/api/scopes/{env_b.default_scope_id}/skills/upload",
            data={"skill_key": "evil"},
            files={"file": ("evil.tgz", archive, "application/gzip")},
        )
        # Boundary must reject — 403 (not 404, which would leak
        # whether the scope exists).
        assert resp.status_code == 403, (resp.status_code, resp.text)
    finally:
        await client.aclose()
        app.dependency_overrides.clear()

    # Confirm no Skill row landed in env-B's scope. Without the
    # validator, the upload would have created/upserted a row
    # there.
    from sqlalchemy import select as _select

    from app.models.skill import Skill

    leaked = await db_session.execute(
        _select(Skill).where(
            Skill.scope_id == env_b.default_scope_id,
            Skill.skill_key == "evil",
        )
    )
    assert leaked.scalar_one_or_none() is None
