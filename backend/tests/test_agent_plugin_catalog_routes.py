from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models.agent_plugin import (
    AgentPluginInstallation,
    PluginCatalogEntry,
    PluginCatalogSnapshot,
    PluginCatalogSyncState,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.services.runtime_source import _project_agent_plugins
from tests.conftest import create_env_with_project


async def _activate_catalog(
    db_session,
    *,
    version: str = "1.0.0",
    digest_character: str = "a",
    has_configuration: bool = False,
    runtimes: list[str] | None = None,
) -> str:
    revision = f"{uuid4().hex}{uuid4().hex[:8]}"
    db_session.add(
        PluginCatalogSnapshot(
            revision=revision,
            schema_version=1,
            entry_count=1,
            fetched_at=datetime.now(UTC),
        )
    )
    await db_session.flush()
    db_session.add(
        PluginCatalogEntry(
            snapshot_revision=revision,
            name="clawdi",
            version=version,
            agent_plugins_schema=("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
            source_path="v2/plugins/clawdi",
            content_digest=f"sha256-tree-v1:{digest_character * 64}",
            public_metadata={
                "display_name": "Clawdi",
                "description": "Clawdi tools.",
                "publisher": "Clawdi",
                "category": "productivity",
                "keywords": ["clawdi"],
                "languages": ["en"],
                "icon": None,
                "components": {
                    "skills": ["clawdi"],
                    "mcpServers": {"clawdi": "streamable-http"},
                },
            },
            has_configuration=has_configuration,
            compatible_runtimes=(runtimes if runtimes is not None else ["openclaw", "hermes"]),
        )
    )
    await db_session.flush()
    sync_state = await db_session.get(PluginCatalogSyncState, 1)
    assert sync_state is not None
    sync_state.current_revision = revision
    sync_state.last_success_at = datetime.now(UTC)
    await db_session.commit()
    return revision


@pytest.mark.asyncio
async def test_agent_plugin_desired_state_is_explicit_pinned_and_idempotent(
    client,
    db_session,
    channel_agent,
) -> None:
    first_revision = await _activate_catalog(db_session)
    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    assert state is not None

    catalog = await client.get("/v1/plugin-catalog")
    assert catalog.status_code == 200, catalog.text
    assert catalog.json()["revision"] == first_revision
    assert catalog.json()["plugins"][0]["components"] == {
        "skills": ["clawdi"],
        "mcpServers": {"clawdi": "streamable-http"},
    }
    empty = await client.get(f"/v1/agents/{channel_agent.id}/agent-plugins")
    assert empty.status_code == 200
    assert empty.json() == {"plugins": []}
    internal_intent = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={"source": "https://github.com/Clawdi-AI/store"},
    )
    assert internal_intent.status_code == 422

    created = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={},
    )
    assert created.status_code == 202, created.text
    assert created.json()["desired_state"] == "present"
    assert created.json()["convergence"] == "not_observed"
    installation_id = created.json()["installation_id"]
    await db_session.refresh(state)
    assert state.apply_generation == 2

    row = await db_session.scalar(
        select(AgentPluginInstallation).where(
            AgentPluginInstallation.environment_id == channel_agent.id
        )
    )
    assert row is not None
    assert str(row.id) == installation_id
    assert row.catalog_revision == first_revision
    assert row.source_path == "v2/plugins/clawdi"
    assert row.content_digest == f"sha256-tree-v1:{'a' * 64}"
    projected = _project_agent_plugins((row,))
    assert projected is not None
    assert projected.installations["clawdi"].source.commit == first_revision

    repeated = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={"version": "1.0.0"},
    )
    assert repeated.status_code == 202, repeated.text
    assert repeated.json()["installation_id"] == installation_id
    await db_session.refresh(state)
    assert state.apply_generation == 2

    second_revision = await _activate_catalog(
        db_session,
        version="1.1.0",
        digest_character="b",
    )
    await db_session.refresh(row)
    assert row.catalog_revision == first_revision
    assert row.version == "1.0.0"

    updated = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={"version": "1.1.0"},
    )
    assert updated.status_code == 202, updated.text
    assert updated.json()["installation_id"] == installation_id
    assert updated.json()["catalog_revision"] == second_revision
    await db_session.refresh(state)
    assert state.apply_generation == 3

    removed = await client.delete(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert removed.status_code == 202, removed.text
    assert removed.json()["desired_state"] == "absent"
    assert removed.json()["convergence"] == "not_observed"
    await db_session.refresh(state)
    assert state.apply_generation == 4

    repeated_remove = await client.delete(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert repeated_remove.status_code == 202, repeated_remove.text
    await db_session.refresh(state)
    assert state.apply_generation == 4


@pytest.mark.asyncio
async def test_agent_plugin_install_rejects_guaranteed_nonconvergence_before_persistence(
    client,
    db_session,
    seed_user,
    channel_agent,
    test_identity,
) -> None:
    await _activate_catalog(db_session, has_configuration=True)
    not_owned = await client.put(
        f"/v1/agents/{uuid4()}/agent-plugins/clawdi",
        json={},
    )
    assert not_owned.status_code == 404
    configured = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={},
    )
    assert configured.status_code == 409, configured.text
    assert configured.json()["detail"]["code"] == "plugin_configuration_not_supported"

    await _activate_catalog(db_session, runtimes=["hermes"])
    incompatible = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={},
    )
    assert incompatible.status_code == 409, incompatible.text
    assert incompatible.json()["detail"] == {
        "code": "plugin_runtime_not_supported",
        "runtime": "openclaw",
    }

    unmanaged = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"plugin-unmanaged-{test_identity}",
        machine_name="Plugin unmanaged",
    )
    no_hosted_v2 = await client.put(
        f"/v1/agents/{unmanaged.id}/agent-plugins/clawdi",
        json={},
    )
    assert no_hosted_v2.status_code == 409, no_hosted_v2.text
    assert no_hosted_v2.json()["detail"]["code"] == "hosted_v2_runtime_required"
    assert await db_session.scalar(select(AgentPluginInstallation.id).limit(1)) is None

    await _activate_catalog(db_session, runtimes=[])
    unavailable = await client.get("/v1/plugin-catalog/clawdi")
    assert unavailable.status_code == 200, unavailable.text
    assert unavailable.json()["installable"] is False
    assert unavailable.json()["installability_reason"] == "no_supported_runtime"
