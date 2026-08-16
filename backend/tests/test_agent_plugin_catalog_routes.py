from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.agent_plugin import (
    AgentPluginInstallation,
    PluginCatalogEntry,
    PluginCatalogSnapshot,
    PluginCatalogSyncState,
)
from app.models.hosted_runtime import HostedRuntimeState
from app.schemas.runtime_observation import RuntimeObservationEventV2
from app.services.runtime_observation import ingest_runtime_observation
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
    assert state.apply_generation is None

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
    assert state.apply_generation is None

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
    assert state.apply_generation is None

    removed = await client.delete(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert removed.status_code == 202, removed.text
    assert removed.json()["desired_state"] == "absent"
    assert removed.json()["convergence"] == "not_observed"
    await db_session.refresh(state)
    assert state.apply_generation is None

    repeated_remove = await client.delete(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert repeated_remove.status_code == 202, repeated_remove.text
    await db_session.refresh(state)
    assert state.apply_generation is None


@pytest.mark.asyncio
async def test_agent_plugin_desired_state_projects_only_exact_observed_identity(
    client,
    db_session,
    channel_agent,
) -> None:
    await _activate_catalog(db_session)
    created = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={},
    )
    assert created.status_code == 202, created.text
    installation_id = created.json()["installation_id"]
    state = await db_session.get(HostedRuntimeState, channel_agent.id)
    assert state is not None
    captured = datetime.now(UTC)

    def observation(
        *,
        sequence: int,
        version: str,
        digest_character: str,
        plugin_status: str,
        error_code: str | None = None,
        event_captured: datetime | None = None,
    ) -> RuntimeObservationEventV2:
        observed_at = event_captured or captured + timedelta(seconds=sequence - 1)
        plugin = {
            "installationId": installation_id,
            "name": "clawdi",
            "version": version,
            "contentDigest": f"sha256-tree-v1:{digest_character * 64}",
            "sourceRevision": digest_character * 64,
            "generation": 1 if plugin_status == "installed" else 2,
            "status": plugin_status,
            **({"errorCode": error_code} if error_code is not None else {}),
        }
        return RuntimeObservationEventV2.model_validate(
            {
                "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
                "reportedAt": observed_at.isoformat(),
                "runtimeMode": "hosted",
                "status": "ok" if plugin_status == "installed" else "error",
                "activeCliVersion": "1.2.3-test",
                "applied": {
                    "etag": f'"sha256:{"a" * 64}"',
                    "sourceRevision": "a" * 64,
                    "generation": 1,
                    "instanceId": state.instance_id,
                    "appliedProviderIds": [],
                },
                "boot": None,
                "cli": None,
                "agentPlugins": {"schemaVersion": 1, "installations": [plugin]},
                "generation": 1,
                "manifestETag": '"manifest-agent-plugin-observation"',
                "applyReceiptId": "apply-receipt-agent-plugin-observation",
                "bootNonce": "boot-nonce-agent-plugin-observation",
                "bootSessionId": "boot-session-agent-plugin-observation",
                "sequence": sequence,
                "eventId": f"event-agent-plugin-observation-{sequence}",
                "capturedAt": observed_at.isoformat(),
            }
        )

    await ingest_runtime_observation(
        db_session,
        environment_id=channel_agent.id,
        credential_deployment_id=state.deployment_id,
        value=observation(
            sequence=1,
            version="1.0.0",
            digest_character="a",
            plugin_status="installed",
            event_captured=captured
            - timedelta(seconds=settings.runtime_observation_freshness_seconds + 1),
        ),
        received_at=captured,
    )
    await db_session.commit()
    stale = await client.get(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert stale.status_code == 200, stale.text
    assert stale.json()["convergence"] == "not_observed"

    await ingest_runtime_observation(
        db_session,
        environment_id=channel_agent.id,
        credential_deployment_id=state.deployment_id,
        value=observation(
            sequence=2,
            version="1.0.0",
            digest_character="a",
            plugin_status="installed",
        ),
        received_at=captured + timedelta(seconds=1),
    )
    await db_session.commit()
    installed = await client.get(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert installed.status_code == 200, installed.text
    assert installed.json()["convergence"] == "installed"
    assert installed.json()["observation_error_code"] is None
    assert installed.json()["observed_at"] is not None

    await _activate_catalog(db_session, version="1.1.0", digest_character="b")
    updated = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={"version": "1.1.0"},
    )
    assert updated.status_code == 202, updated.text
    assert updated.json()["convergence"] == "not_observed"
    assert updated.json()["observed_at"] is None

    await ingest_runtime_observation(
        db_session,
        environment_id=channel_agent.id,
        credential_deployment_id=state.deployment_id,
        value=observation(
            sequence=3,
            version="1.1.0",
            digest_character="b",
            plugin_status="failed",
            error_code="reconcile_failed",
        ),
        received_at=captured + timedelta(seconds=3),
    )
    await db_session.commit()
    failed = await client.get(f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi")
    assert failed.status_code == 200, failed.text
    assert failed.json()["convergence"] == "failed"
    assert failed.json()["observation_error_code"] == "reconcile_failed"

    await _activate_catalog(db_session, version="1.0.0", digest_character="a")
    restored = await client.put(
        f"/v1/agents/{channel_agent.id}/agent-plugins/clawdi",
        json={"version": "1.0.0"},
    )
    assert restored.status_code == 202, restored.text
    assert restored.json()["convergence"] == "not_observed"


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
