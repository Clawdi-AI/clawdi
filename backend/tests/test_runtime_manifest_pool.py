from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.pool import QueuePool

from app.core import auth, database
from app.core.config import settings
from app.main import app
from app.models.agent_project_binding import AgentProjectBinding
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.skill import SKILL_AUTHORITY_CLOUD, Skill
from app.routes import runtime
from app.services.api_key import mint_api_key
from app.services.project_runtime_skills import project_skill_file_signature
from app.services.runtime_source import (
    RUNTIME_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY,
    RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY,
    RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    RUNTIME_CAPABILITIES_HEADER,
    vault_key_identity,
)
from tests.conftest import create_env_with_project, create_test_hosted_runtime_state
from tests.hosted_runtime_fixtures import (
    CANONICAL_CODEX_TOOLS,
    ensure_canonical_codex_tool_provider,
)


@pytest.mark.committed_db
@pytest.mark.parametrize("conditional", [False, True], ids=["render", "etag"])
async def test_manifest_fanout_preserves_auth_without_nested_pool_starvation(
    db_session, seed_user, monkeypatch, conditional
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"manifest-pool-{seed_user.id}",
        machine_name="Manifest pool",
        agent_type="openclaw",
    )
    state = await create_test_hosted_runtime_state(db_session, env, runtime_name="openclaw")
    await ensure_canonical_codex_tool_provider(db_session, seed_user)
    state.tools = CANONICAL_CODEX_TOOLS
    minted = await mint_api_key(
        db_session, user_id=seed_user.id, environment_id=env.id, label="manifest-pool"
    )
    minted.api_key.last_used_at = datetime.now(UTC)
    await db_session.commit()

    monkeypatch.setattr(settings, "db_pool_timeout", 1.0)
    ordinary = database._create_engine(pool_size=2, max_overflow=0)
    monkeypatch.setattr(database, "engine", ordinary)
    monkeypatch.setattr(
        database,
        "async_session_factory",
        async_sessionmaker(
            ordinary, class_=database.async_session_factory.class_, expire_on_commit=False
        ),
    )
    pool = ordinary.sync_engine.pool
    assert isinstance(pool, QueuePool)
    headers = {
        "Authorization": f"Bearer {minted.raw_key}",
        "Accept": RUNTIME_BUNDLE_V2_MEDIA_TYPE,
        RUNTIME_CAPABILITIES_HEADER: ",".join(
            (
                RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY,
                RUNTIME_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY,
            )
        ),
    }
    authenticate = auth._auth_via_api_key
    pool_full = asyncio.Event()

    def on_checkout(_connection, _record, _proxy):
        if pool.checkedout() == 2:
            pool_full.set()

    async def synchronized_auth(token: str, db: AsyncSession) -> auth.AuthContext | None:
        result = await authenticate(token, db)
        assert result is not None
        assert db.in_transaction()
        await pool_full.wait()
        assert pool.checkedout() == 2
        return result

    event.listen(pool, "checkout", on_checkout)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers
        ) as client:
            initial = await client.get("/v1/runtime/manifest")
            assert initial.status_code == 200, initial.text
            pool_full.clear()
            monkeypatch.setattr(auth, "_auth_via_api_key", synchronized_auth)
            async with asyncio.timeout(5):
                responses = await asyncio.gather(
                    *(
                        client.get(
                            "/v1/runtime/manifest",
                            headers={"If-None-Match": initial.headers["etag"]}
                            if conditional
                            else {},
                        )
                        for _ in range(2)
                    )
                )
            for response in responses:
                assert response.status_code == (304 if conditional else 200), response.text
                assert response.headers["etag"] == initial.headers["etag"]
        assert pool.checkedout() == 0
    finally:
        event.remove(pool, "checkout", on_checkout)
        await ordinary.dispose()


async def test_manifest_pairs_allow_four_snapshots_and_clean_up_partial_acquisition(monkeypatch):
    ordinary = database._create_engine(pool_size=8, max_overflow=0)
    monkeypatch.setattr(database, "engine", ordinary)
    pool = ordinary.sync_engine.pool
    assert isinstance(pool, QueuePool)
    rendezvous = asyncio.Barrier(4)
    pairs = asynccontextmanager(database.get_runtime_manifest_sessions)

    async def read_pair():
        async with pairs() as pair:
            await pair.auth.execute(text("SELECT 1"))
            await pair.auth.commit()
            async with database.runtime_snapshot_session(session_factory=pair.snapshots) as db:
                configured = (
                    await db.execute(
                        text(
                            "SELECT current_setting('transaction_isolation'), "
                            "current_setting('transaction_read_only')"
                        )
                    )
                ).one()
                assert configured == ("repeatable read", "on")
                await rendezvous.wait()
                assert pool.checkedout() == 8

    try:
        async with asyncio.timeout(5):
            await asyncio.gather(*(read_pair() for _ in range(4)))
        assert pool.checkedout() == 0
        async with AsyncExitStack() as stack:
            for _ in range(7):
                await stack.enter_async_context(ordinary.connect())
            partial = asyncio.Event()

            def on_checkout(_connection, _record, _proxy):
                partial.set()

            event.listen(pool, "checkout", on_checkout)
            dependency = database.get_runtime_manifest_sessions()
            acquire = asyncio.create_task(anext(dependency))
            try:
                await asyncio.wait_for(partial.wait(), timeout=5)
                acquire.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await acquire
                assert pool.checkedout() == 7
                assert not database._manifest_checkout_lock.locked()
            finally:
                event.remove(pool, "checkout", on_checkout)
                acquire.cancel()
                await asyncio.gather(acquire, return_exceptions=True)
                await dependency.aclose()
        assert pool.checkedout() == 0
    finally:
        await ordinary.dispose()


async def test_manifest_jwks_wait_does_not_reserve_database_connections(monkeypatch):
    pool = database.engine.sync_engine.pool
    assert isinstance(pool, QueuePool)
    baseline = pool.checkedout()
    lookup = asyncio.Event()

    async def signing_key(_token: str):
        lookup.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(auth, "_resolve_clerk_signing_key", signing_key)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        request = asyncio.create_task(
            client.get("/v1/runtime/manifest", headers={"Authorization": "Bearer clerk-jwt"})
        )
        try:
            await asyncio.wait_for(lookup.wait(), timeout=5)
            assert pool.checkedout() == baseline
        finally:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)


@pytest.mark.committed_db
@pytest.mark.parametrize("archive", [False, True], ids=["file", "archive"])
async def test_signed_project_skill_download_releases_lookup_before_storage(
    db_session, seed_user, monkeypatch, archive
):
    env = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"skill-storage-{seed_user.id}",
        machine_name="Skill storage",
    )
    project = Project(
        user_id=seed_user.id,
        name="Shared skills",
        slug=f"shared-skills-{seed_user.id}",
        kind=PROJECT_KIND_WORKSPACE,
    )
    db_session.add(project)
    await db_session.flush()
    skill = Skill(
        user_id=seed_user.id,
        project_id=project.id,
        skill_key="example",
        name="Example",
        description="Example skill",
        content_hash="a" * 64,
        authority=SKILL_AUTHORITY_CLOUD,
        file_key="example.md",
    )
    db_session.add_all(
        [
            skill,
            AgentProjectBinding(
                agent_id=env.id,
                project_id=project.id,
                binding_type="context",
                priority=1,
                created_by_user_id=seed_user.id,
            ),
        ]
    )
    await db_session.commit()
    signature = project_skill_file_signature(
        signing_key=vault_key_identity(settings.vault_encryption_key),
        agent_id=env.id,
        skill_id=skill.id,
        content_hash=skill.content_hash,
    )
    path = (
        f"project-skill-archives/{env.id}/{project.id}/{skill.id}/"
        f"{skill.content_hash}/{signature}/example.tar.gz"
        if archive
        else f"project-skill-files/{env.id}/{skill.id}/{skill.content_hash}/{signature}/SKILL.md"
    )
    pool = database.engine.sync_engine.pool
    assert isinstance(pool, QueuePool)
    baseline = pool.checkedout()
    storage_started = asyncio.Event()
    release_storage = asyncio.Event()

    async def read_storage(_key: str) -> bytes:
        storage_started.set()
        await release_storage.wait()
        return b"# Example\n"

    monkeypatch.setattr(runtime.file_store, "get", read_storage)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        request = asyncio.create_task(client.get(f"/v1/runtime/{path}"))
        try:
            await asyncio.wait_for(storage_started.wait(), timeout=5)
            assert pool.checkedout() == baseline
            release_storage.set()
            response = await request
            assert response.status_code == 200, response.text
            assert response.content
        finally:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
