from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models.ai_provider import AiProviderAuthPayload
from app.models.app_setting import AppSetting
from app.models.hosted_runtime import HostedRuntimeState
from app.schemas.runtime_observation import (
    RuntimeDriftBindingRequest,
    RuntimeDriftSummaryReadRequest,
    RuntimeObservationEventV2,
)
from app.services.runtime_drift_summary import read_runtime_drift_summaries
from app.services.runtime_observation import (
    ingest_runtime_observation,
    provision_runtime_environment_fence,
)
from app.services.runtime_source_revision import runtime_source_contract_revision
from app.services.vault_crypto import decrypt
from tests.conftest import create_env_with_project

PROVIDER = "connection-test"
ENV_NAME = "CONNECTION_API_KEY"
REVISION = "a" * 64
VERSION = "99.1.0"  # Synthetic qualified release; production allowlist remains empty.
MODELS = [{"id": "saved-model", "context_window": 8192, "capabilities": {"tools": True}}]


async def create_provider(client):
    body = {
        "provider_id": PROVIDER,
        "type": "openai",
        "base_url": "https://api.openai.com/v1",
        "api_mode": "openai_responses",
        "runtime_env_name": ENV_NAME,
        "models": MODELS,
        "auth": {"type": "api_key", "source": "managed"},
    }
    response = await client.post("/v1/ai-providers", json=body)
    assert response.status_code == 200, response.text
    response = await client.post(
        f"/v1/ai-providers/{PROVIDER}/auth/api-key", json={"value": "original-test-key"}
    )
    assert response.status_code == 200, response.text
    return body


async def consumer(
    db,
    owner_id,
    *,
    version=VERSION,
    captured_at=None,
    source_revision=REVISION,
    boot="boot-connection-test",
):
    env = await create_env_with_project(
        db,
        user_id=owner_id,
        machine_id=str(uuid4()),
        machine_name="Connection migration",
        agent_type="openclaw",
    )
    deployment = f"dep-{env.id}"
    state = HostedRuntimeState(
        environment_id=env.id,
        deployment_id=deployment,
        instance_id=f"instance-{env.id}",
        generation=1,
        apply_generation=1,
        source_revision=REVISION,
        source_revision_contract=runtime_source_contract_revision(),
        cli_package_spec=f"clawdi@{VERSION}",
        locale={"language": "en", "timezone": "UTC"},
        system={},
        live_sync={},
        recovery={},
        runtimes={
            "openclaw": {
                "enabled": True,
                "providerMode": "configured",
                "provider_ids": [PROVIDER],
                "primary_model": {"provider_id": PROVIDER, "model": "saved-model"},
                "install": {"source": "official"},
            }
        },
    )
    db.add(state)
    await provision_runtime_environment_fence(
        db, environment_id=env.id, owner_id=owner_id, deployment_id=deployment
    )
    now = captured_at or datetime.now(UTC)
    observation = RuntimeObservationEventV2.model_validate(
        {
            "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
            "reportedAt": now,
            "capturedAt": now,
            "runtimeMode": "hosted",
            "status": "ok",
            "activeCliVersion": version,
            "applied": {
                "etag": f'"sha256:{source_revision}"',
                "sourceRevision": source_revision,
                "generation": 1,
                "instanceId": state.instance_id,
                "appliedProviderIds": [PROVIDER],
            },
            "boot": None,
            "cli": None,
            "applyReceiptId": "apply-connection-0001",
            "bootNonce": "boot-nonce-connection-0001",
            "bootSessionId": boot,
            "sequence": 1,
            "eventId": str(uuid4()),
        }
    )
    await ingest_runtime_observation(
        db,
        environment_id=env.id,
        credential_deployment_id=deployment,
        value=observation,
        received_at=now,
    )
    await db.commit()
    return state


@pytest.mark.asyncio
@pytest.mark.parametrize("history", ["expired", "previous-generation", "competing-fresh"])
async def test_handoff_uses_one_fresh_current_generation_without_weakening_legacy_reads(
    client, db_session, seed_user, history
):
    await create_provider(client)
    now = datetime.now(UTC)
    state = await consumer(
        db_session,
        seed_user.id,
        captured_at=now - timedelta(minutes=20) if history == "expired" else now,
    )
    generation = 2 if history == "previous-generation" else 1
    state.generation = generation
    state.apply_generation = generation
    db_session.add(AppSetting(key="supported_connection_cli_versions", value_json=[VERSION]))
    observation = RuntimeObservationEventV2.model_validate(
        {
            "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
            "reportedAt": now,
            "capturedAt": now,
            "runtimeMode": "hosted",
            "status": "ok",
            "activeCliVersion": VERSION,
            "applied": {
                "etag": f'"sha256:{REVISION}"',
                "sourceRevision": REVISION,
                "generation": generation,
                "instanceId": state.instance_id,
                "appliedProviderIds": [PROVIDER],
            },
            "boot": None,
            "cli": None,
            "applyReceiptId": "apply-connection-0002",
            "bootNonce": "boot-nonce-connection-0002",
            "bootSessionId": "current-connection-boot",
            "sequence": 1,
            "eventId": str(uuid4()),
        }
    )
    await ingest_runtime_observation(
        db_session,
        environment_id=state.environment_id,
        credential_deployment_id=state.deployment_id,
        value=observation,
        received_at=now,
    )
    await db_session.commit()
    legacy = await read_runtime_drift_summaries(
        db_session,
        RuntimeDriftSummaryReadRequest(
            bindings=[
                RuntimeDriftBindingRequest(
                    environmentId=state.environment_id, deploymentId=state.deployment_id
                )
            ]
        ),
    )
    assert legacy.items[0].observation.status == "ambiguous"
    response = await client.patch(
        f"/v1/ai-providers/{PROVIDER}", json={"configuration_mode": "connection"}
    )
    assert response.status_code == (409 if history == "competing-fresh" else 200), response.text


@pytest.mark.asyncio
async def test_mode_only_handoff_and_atomic_key_edit_preserve_identity_metadata_and_credentials(
    client, db_session, seed_user
):
    original_body = await create_provider(client)
    await consumer(db_session, seed_user.id)
    db_session.add(AppSetting(key="supported_connection_cli_versions", value_json=[VERSION]))
    await db_session.commit()
    payload = await db_session.scalar(
        select(AiProviderAuthPayload).where(
            AiProviderAuthPayload.owner_user_id == seed_user.id,
            AiProviderAuthPayload.provider_id == PROVIDER,
        )
    )
    assert payload is not None
    before = (payload.encrypted_payload, payload.nonce, payload.credential_revision)
    migrated = await client.patch(
        f"/v1/ai-providers/{PROVIDER}", json={"configuration_mode": "connection"}
    )
    assert migrated.status_code == 200, migrated.text
    assert migrated.json()["models"] == MODELS
    await db_session.refresh(payload)
    assert (payload.encrypted_payload, payload.nonce, payload.credential_revision) == before
    edited = await client.patch(
        f"/v1/ai-providers/{PROVIDER}",
        json={
            "configuration_mode": "connection",
            "label": "Edited connection",
            "base_url": "https://proxy.example/v1",
            "credential": {"type": "api_key", "value": "replacement-test-key"},
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["configuration_mode"] == "connection"
    assert edited.json()["base_url"] == "https://proxy.example/v1"
    assert edited.json()["runtime_env_name"] == ENV_NAME
    assert edited.json()["models"] == MODELS
    assert "replacement-test-key" not in edited.text
    await db_session.refresh(payload)
    assert decrypt(payload.encrypted_payload, payload.nonce) == "replacement-test-key"

    for patch in (
        {"models": []},
        {"models": None},
        {"runtime_env_name": "OTHER_KEY"},
        {"configuration_mode": "catalog"},
        {"auth": {"type": "secret_ref", "ref": "env:OTHER_KEY"}},
        {"auth": {"type": "agent_profile", "tool": "codex", "profile": "default"}},
    ):
        response = await client.patch(f"/v1/ai-providers/{PROVIDER}", json=patch)
        assert response.status_code == 409, response.text
    for path, body in (
        (
            f"/v1/ai-providers/{PROVIDER}/auth/api-key",
            {"value": "wrong-key", "runtime_env_name": "OTHER_KEY"},
        ),
        (
            f"/v1/ai-providers/{PROVIDER}/auth/import",
            {"type": "agent_profile", "tool": "codex", "payload": "{}"},
        ),
        (f"/v1/ai-providers/{PROVIDER}/auth/oauth/start", {"provider": "codex"}),
        (f"/v1/ai-providers/{PROVIDER}/auth/oauth/device/start", {"provider": "codex"}),
        ("/v1/ai-providers?replace=true", original_body),
        (
            "/v1/ai-providers/accept",
            {
                "provider": original_body,
                "credential": {"type": "api_key", "value": "wrong-key"},
                "replace": True,
            },
        ),
    ):
        response = await client.post(path, json=body, headers={"Idempotency-Key": str(uuid4())})
        assert response.status_code == 409, (path, response.text)
        # /accept rolls back its request transaction on rejection; refresh the shared auth fixture.
        await db_session.refresh(seed_user)
    replaced = await client.post(
        f"/v1/ai-providers/{PROVIDER}/auth/api-key", json={"value": "dedicated-replacement-key"}
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["configuration_mode"] == "connection"
    assert replaced.json()["runtime_env_name"] == ENV_NAME
    assert replaced.json()["models"] == MODELS
    phantom = {
        **original_body,
        "provider_id": "phantom-connection",
        "configuration_mode": "connection",
    }
    rejected = await client.post("/v1/ai-providers", json=phantom)
    assert rejected.status_code == 422
    rejected = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": str(uuid4())},
        json={"provider": phantom, "credential": {"type": "api_key", "value": "unused-test-key"}},
    )
    assert rejected.status_code == 422
    assert (await client.get("/v1/ai-providers/phantom-connection")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "disabled",
        "empty",
        "fresh-agent",
        "old-cli",
        "pending-cli",
        "stale",
        "future",
        "wrong-source",
        "other-consumer",
    ],
)
async def test_handoff_requires_all_existing_consumers_to_have_qualified_current_evidence(
    client, db_session, seed_user, case
):
    await create_provider(client)
    if case != "disabled":
        db_session.add(
            AppSetting(
                key="supported_connection_cli_versions",
                value_json=[] if case == "empty" else [VERSION],
            )
        )
        await db_session.commit()
    if case != "fresh-agent":
        state = await consumer(
            db_session,
            seed_user.id,
            version="0.14.56" if case == "old-cli" else VERSION,
            captured_at=(
                datetime.now(UTC) + timedelta(hours=1)
                if case == "future"
                else datetime.now(UTC) - timedelta(hours=1)
                if case == "stale"
                else None
            ),
            source_revision="b" * 64 if case == "wrong-source" else REVISION,
        )
        if case == "pending-cli":
            state.cli_package_spec = "clawdi@0.14.56"
            await db_session.commit()
        if case == "other-consumer":
            await consumer(db_session, seed_user.id, version="0.14.56")
    response = await client.patch(
        f"/v1/ai-providers/{PROVIDER}", json={"configuration_mode": "connection"}
    )
    assert response.status_code == 409, response.text
    saved = (await client.get(f"/v1/ai-providers/{PROVIDER}")).json()
    assert saved["configuration_mode"] == "catalog"
    assert saved["models"] == MODELS
