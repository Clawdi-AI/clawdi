from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
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
    successor_boot=None,
    health="ok",
    applied_provider_ids=None,
    runtime_name="openclaw",
    generation=1,
):
    env = await create_env_with_project(
        db,
        user_id=owner_id,
        machine_id=str(uuid4()),
        machine_name="Connection migration",
        agent_type=runtime_name,
    )
    deployment = f"dep-{env.id}"
    state = HostedRuntimeState(
        environment_id=env.id,
        deployment_id=deployment,
        instance_id=f"instance-{env.id}",
        generation=generation,
        apply_generation=generation,
        source_revision=REVISION,
        source_revision_contract=runtime_source_contract_revision(),
        cli_package_spec=f"clawdi@{VERSION}",
        locale={"language": "en", "timezone": "UTC"},
        system={},
        live_sync={},
        recovery={},
        runtimes={
            runtime_name: {
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
            "status": health,
            "activeCliVersion": version,
            "applied": {
                "etag": f'"sha256:{source_revision}"',
                "sourceRevision": source_revision,
                "generation": generation,
                "instanceId": state.instance_id,
                "appliedProviderIds": [PROVIDER]
                if applied_provider_ids is None
                else applied_provider_ids,
            },
            "boot": None,
            "cli": None,
            "applyReceiptId": "apply-connection-0001",
            "bootNonce": "boot-nonce-connection-0001",
            "bootSessionId": boot,
            "successorBootSessionId": successor_boot,
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


@pytest.mark.asyncio
async def test_custom_create_rename_rotate_and_reject_catalog_overwrite(
    client, db_session, seed_user
):
    body = {
        "provider_id": "custom-work",
        "configuration_mode": "custom",
        "type": "custom_openai_compatible",
        "label": "Work",
        "base_url": "https://provider.example/v1",
        "api_mode": "anthropic_messages",
        "runtime_env_name": "CUSTOM_WORK_KEY",
        "auth": {"type": "api_key", "source": "managed"},
    }
    response = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": str(uuid4())},
        json={"provider": body, "credential": {"type": "api_key", "value": "first-custom-key"}},
    )
    assert response.status_code == 201, response.text
    assert response.json()["provider"]["configuration_mode"] == "custom"
    assert response.json()["provider"].get("models") is None
    payload = await db_session.scalar(
        select(AiProviderAuthPayload).where(
            AiProviderAuthPayload.owner_user_id == seed_user.id,
            AiProviderAuthPayload.provider_id == body["provider_id"],
        )
    )
    before = (payload.encrypted_payload, payload.nonce, payload.credential_revision)
    renamed = await client.patch("/v1/ai-providers/custom-work", json={"label": "Renamed"})
    assert renamed.status_code == 200, renamed.text
    await db_session.refresh(payload)
    assert (payload.encrypted_payload, payload.nonce, payload.credential_revision) == before
    rotated = await client.patch(
        "/v1/ai-providers/custom-work",
        json={
            "base_url": "https://new-provider.example/v1",
            "credential": {"type": "api_key", "value": "rotated-custom-key"},
        },
    )
    assert rotated.status_code == 200, rotated.text
    assert "rotated-custom-key" not in rotated.text
    await db_session.refresh(payload)
    assert decrypt(payload.encrypted_payload, payload.nonce) == "rotated-custom-key"
    for patch in [
        {"models": MODELS},
        {"runtime_env_name": "OTHER_KEY"},
        {"configuration_mode": "catalog"},
    ]:
        rejected = await client.patch("/v1/ai-providers/custom-work", json=patch)
        assert rejected.status_code == 409, rejected.text
    overwritten = await client.post(
        "/v1/ai-providers/accept",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "provider": body,
            "replace": True,
            "credential": {"type": "api_key", "value": "unwanted-key"},
        },
    )
    assert overwritten.status_code == 409

    await db_session.refresh(seed_user)
    changed_environment = {**body, "runtime_env_name": "REPLACED_CUSTOM_KEY"}
    overwritten = await client.post("/v1/ai-providers?replace=true", json=changed_environment)
    assert overwritten.status_code == 409, overwritten.text
    saved = await client.get("/v1/ai-providers/custom-work")
    assert saved.json()["runtime_env_name"] == body["runtime_env_name"]
    # Archiving does not revoke the native runtime's permanent ownership journal.
    deleted = await client.delete("/v1/ai-providers/custom-work")
    assert deleted.status_code == 200, deleted.text
    for path, request in (
        ("/v1/ai-providers", changed_environment),
        (
            "/v1/ai-providers/accept",
            {
                "provider": changed_environment,
                "credential": {"type": "api_key", "value": "new-test-key"},
            },
        ),
    ):
        rejected = await client.post(path, json=request, headers={"Idempotency-Key": str(uuid4())})
        assert rejected.status_code == 409, rejected.text
        await db_session.refresh(seed_user)


@pytest.mark.asyncio
async def test_custom_handoff_and_binding_require_exact_qualified_cli(
    client, db_session, seed_user
):
    from fastapi import HTTPException

    from app.models.ai_provider import AiProvider
    from app.services.ai_provider_connection_ownership import require_custom_provider_cli

    await create_provider(client)
    await consumer(db_session, seed_user.id)
    blocked = await client.patch(
        f"/v1/ai-providers/{PROVIDER}", json={"configuration_mode": "custom"}
    )
    assert blocked.status_code == 409
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    await db_session.commit()
    migrated = await client.patch(
        f"/v1/ai-providers/{PROVIDER}", json={"configuration_mode": "custom"}
    )
    assert migrated.status_code == 200, migrated.text
    assert migrated.json().get("models") is None
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id, AiProvider.provider_id == PROVIDER
        )
    )
    assert provider.models == MODELS
    for version in ["0.14.59", f"{VERSION}-beta.1"]:
        with pytest.raises(HTTPException):
            await require_custom_provider_cli(
                db_session,
                owner_user_id=seed_user.id,
                provider_ids=[PROVIDER],
                cli_package_spec=f"clawdi@{version}",
            )
    await require_custom_provider_cli(
        db_session,
        owner_user_id=seed_user.id,
        provider_ids=[PROVIDER],
        cli_package_spec=f"clawdi@{VERSION}",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("runtime_name", ["hermes", "openclaw"])
@pytest.mark.parametrize("observation", ["absent", "failed", "expired", "healthy"])
async def test_custom_binding_lifecycle_does_not_require_previous_readiness(
    client, db_session, seed_user, monkeypatch, runtime_name, observation
):
    from app.core.config import settings
    from app.models.runtime_observation import V2RuntimeObservationHead

    monkeypatch.setattr(settings, "admin_api_key", "custom-admission-test")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "https://admission.clerk.example.test")
    headers = {"X-Admin-Key": "custom-admission-test"}
    await create_provider(client)
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    await db_session.commit()
    converted = await client.patch(
        f"/v1/ai-providers/{PROVIDER}", json={"configuration_mode": "custom"}
    )
    assert converted.status_code == 200, converted.text
    if observation == "absent":
        env = await create_env_with_project(
            db_session,
            user_id=seed_user.id,
            machine_id=str(uuid4()),
            machine_name="Custom bootstrap",
            agent_type=runtime_name,
        )
        environment_id = env.id
        deployment_id = f"dep-{env.id}"
        instance_id = f"instance-{env.id}"
        await provision_runtime_environment_fence(
            db_session,
            environment_id=environment_id,
            owner_id=seed_user.id,
            deployment_id=deployment_id,
        )
    else:
        state = await consumer(
            db_session,
            seed_user.id,
            runtime_name=runtime_name,
            health="error" if observation == "failed" else "ok",
            captured_at=datetime.now(UTC) - timedelta(hours=2)
            if observation == "expired"
            else None,
            applied_provider_ids=[],
        )
        environment_id = state.environment_id
        deployment_id = state.deployment_id
        instance_id = state.instance_id
    await db_session.commit()
    head_query = select(V2RuntimeObservationHead).where(
        V2RuntimeObservationHead.environment_id == environment_id
    )
    heads = list(await db_session.scalars(head_query))
    before = [
        (head.highest_sequence, head.latest_payload_hash, head.health, head.state) for head in heads
    ]
    body = {
        "target_clerk_id": seed_user.clerk_id,
        "deployment_id": deployment_id,
        "instance_id": instance_id,
        "generation": 2,
        "apply_generation": 1,
        "cli_package_spec": f"clawdi@{VERSION}",
        "locale": {"language": "en", "timezone": "UTC"},
        "system": {},
        "live_sync": {"enabled": False, "agents": []},
        "recovery": {"cacheManifest": True, "allowOfflineBoot": True},
        "tools": {
            "codex": {
                "enabled": True,
                "provider_id": "tool-provider",
                "primary_model": {"provider_id": "tool-provider", "model": "test"},
            }
        },
        "secretValues": {},
        "runtimes": {
            runtime_name: {
                "enabled": True,
                "providerMode": "unmanaged",
                "provider_ids": [],
                "install": {"source": "official"},
            }
        },
    }
    # Ordinary authenticated desired-state writes: stop/unmanage, bind before
    # bootstrap, restart, unbind and rebind without manufacturing a new heartbeat.
    resource = "agents" if runtime_name == "hermes" else "environments"
    path = f"/v1/admin/{resource}/{environment_id}/runtime-state"
    for generation, selected, apply_generation in [
        (2, False, 1),
        (3, True, 2),
        (4, True, 3),
        (5, False, 3),
        (6, True, 3),
    ]:
        body["generation"] = generation
        body["apply_generation"] = apply_generation
        body["runtimes"][runtime_name].update(
            providerMode="configured" if selected else "unmanaged",
            provider_ids=[PROVIDER] if selected else [],
        )
        response = await client.put(path, headers=headers, json=body)
        assert response.status_code == 200, response.text
    state = await db_session.get(HostedRuntimeState, environment_id)
    await db_session.refresh(state)
    assert state.runtimes[runtime_name]["provider_ids"] == [PROVIDER]
    assert state.generation == 6 and state.apply_generation == 3
    heads = list(await db_session.scalars(head_query.execution_options(populate_existing=True)))
    assert [
        (head.highest_sequence, head.latest_payload_hash, head.health, head.state) for head in heads
    ] == before

    # The same authenticated route still rejects invalid authority and readers.
    for changes, expected in [
        ({"cli_package_spec": "clawdi@0.14.59"}, 409),
        ({"cli_package_spec": f"clawdi@{VERSION}-beta.1"}, 409),
        ({"deployment_id": "another-deployment"}, 409),
        ({"target_clerk_id": "another-owner"}, 403),
        (
            {
                "runtimes": {
                    runtime_name: {
                        **body["runtimes"][runtime_name],
                        "primary_model": {
                            "provider_id": "not-selected",
                            "model": "test",
                        },
                    }
                }
            },
            422,
        ),
    ]:
        rejected = await client.put(
            path,
            headers=headers,
            json={
                **body,
                "generation": 7,
                **changes,
            },
        )
        assert rejected.status_code == expected, rejected.text
        await db_session.refresh(state)
        assert state.generation == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("archived", [False, True])
async def test_custom_upsert_preserves_credential_authority_and_incarnation(
    client, db_session, seed_user, archived
):
    body = await create_provider(client)
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id, AiProvider.provider_id == PROVIDER
        )
    )
    # Model the completed handoff; no consumer is needed for this account-level boundary.
    provider.configuration_mode = "custom"
    provider.models = None
    await db_session.commit()
    body = {**body, "configuration_mode": "custom", "models": None}
    identity = (provider.id, provider.incarnation_id)
    if archived:
        deleted = await client.delete(f"/v1/ai-providers/{PROVIDER}")
        assert deleted.status_code == 200, deleted.text
    await db_session.refresh(provider)
    before = (provider.auth_type, provider.auth_ref, provider.auth_metadata, provider.archived_at)
    payload = await db_session.scalar(
        select(AiProviderAuthPayload).where(
            AiProviderAuthPayload.owner_user_id == seed_user.id,
            AiProviderAuthPayload.provider_id == PROVIDER,
        )
    )
    secret = (
        payload.encrypted_payload,
        payload.nonce,
        payload.credential_revision,
        payload.archived_at,
    )
    rejected = await client.post(
        "/v1/ai-providers?replace=true",
        json={**body, "auth": {"type": "api_key", "source": "env", "ref": f"env:{ENV_NAME}"}},
    )
    assert rejected.status_code == 409, rejected.text
    await db_session.refresh(provider)
    await db_session.refresh(payload)
    assert (provider.id, provider.incarnation_id) == identity
    assert (
        provider.auth_type,
        provider.auth_ref,
        provider.auth_metadata,
        provider.archived_at,
    ) == before
    assert (
        payload.encrypted_payload,
        payload.nonce,
        payload.credential_revision,
        payload.archived_at,
    ) == secret
    if archived:
        accepted = await client.post(
            "/v1/ai-providers/accept",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "provider": body,
                "credential": {"type": "api_key", "value": "new-authorized-key"},
            },
        )
        assert accepted.status_code == 201, accepted.text
        await db_session.refresh(provider)
        assert provider.id == identity[0] and provider.incarnation_id != identity[1]
        assert provider.runtime_env_name == ENV_NAME and provider.archived_at is None
