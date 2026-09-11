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
    # Adding this Custom provider to an existing runtime requires fresh consumed evidence,
    # not merely a requested upgrade in the incoming state.
    state = await consumer(
        db_session,
        seed_user.id,
        boot="custom-binding-target",
        applied_provider_ids=["different-provider"],
    )
    state.runtimes = {
        "openclaw": {
            "enabled": True,
            "providerMode": "unmanaged",
            "provider_ids": [],
            "install": {"source": "official"},
        }
    }
    await db_session.flush()
    await require_custom_provider_cli(
        db_session,
        owner_user_id=seed_user.id,
        provider_ids=[PROVIDER],
        cli_package_spec=f"clawdi@{VERSION}",
        previous_state=state,
    )
    failed = await consumer(
        db_session,
        seed_user.id,
        boot="custom-binding-failed",
        health="error",
        applied_provider_ids=["different-provider"],
    )
    failed.runtimes = state.runtimes
    await db_session.flush()
    with pytest.raises(HTTPException):
        await require_custom_provider_cli(
            db_session,
            owner_user_id=seed_user.id,
            provider_ids=[PROVIDER],
            cli_package_spec=f"clawdi@{VERSION}",
            previous_state=failed,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "recover",
        "expired",
        "wrong-owner",
        "wrong-instance",
        "wrong-generation",
        "changed-source",
        "new-provider",
        "retired",
        "ambiguous",
    ],
)
async def test_failed_custom_selection_recovers_only_authenticated_applied_ownership(
    client, db_session, seed_user, case
):
    from fastapi import HTTPException

    from app.models.ai_provider import AiProvider
    from app.services.ai_provider_connection_ownership import require_custom_provider_cli

    await create_provider(client)
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id,
            AiProvider.provider_id == PROVIDER,
        )
    )
    provider.configuration_mode = "custom"
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    state = await consumer(
        db_session,
        seed_user.id,
        health="error",
        runtime_name="hermes",
        captured_at=datetime.now(UTC) - timedelta(hours=2) if case == "expired" else None,
        applied_provider_ids=["unrelated-provider"] if case == "new-provider" else [PROVIDER],
    )
    # A failed desired selection must not erase the last completed ownership
    # transfer. Source rendering now fails because that desired provider vanished.
    state.runtimes = {
        "hermes": {
            "enabled": True,
            "providerMode": "configured",
            "provider_ids": ["missing-provider"],
            "primary_model": None,
            "install": {"source": "official"},
        }
    }
    state.source_revision = None
    if case == "wrong-instance":
        state.instance_id = "replacement-instance"
    if case == "wrong-generation":
        state.apply_generation = 2
    if case == "changed-source":
        state.source_revision = "b" * 64
    if case == "retired":
        from app.models.session import AgentEnvironment

        env = await db_session.get(AgentEnvironment, state.environment_id)
        env.archived_at = datetime.now(UTC)
    if case == "ambiguous":
        now = datetime.now(UTC)
        await ingest_runtime_observation(
            db_session,
            environment_id=state.environment_id,
            credential_deployment_id=state.deployment_id,
            value=RuntimeObservationEventV2.model_validate(
                {
                    "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
                    "reportedAt": now,
                    "capturedAt": now,
                    "runtimeMode": "hosted",
                    "status": "error",
                    "activeCliVersion": VERSION,
                    "applied": {
                        "etag": f'"sha256:{REVISION}"',
                        "sourceRevision": REVISION,
                        "generation": 1,
                        "instanceId": state.instance_id,
                        "appliedProviderIds": [PROVIDER],
                    },
                    "boot": None,
                    "cli": None,
                    "applyReceiptId": "other-receipt-0001",
                    "bootNonce": "other-nonce-000001",
                    "bootSessionId": "other-boot",
                    "sequence": 1,
                    "eventId": str(uuid4()),
                }
            ),
            received_at=now,
        )
    await db_session.flush()
    if case == "wrong-owner":
        # Keep the requested provider owned by the caller, but not the environment.
        from app.models.session import AgentEnvironment

        env = await db_session.get(AgentEnvironment, state.environment_id)
        from app.models.user import User

        other = User(clerk_id=f"other-{uuid4()}", email="other@example.test", name="Other")
        db_session.add(other)
        await db_session.flush()
        env.user_id = other.id
        await db_session.flush()
    call = require_custom_provider_cli(
        db_session,
        owner_user_id=seed_user.id,
        provider_ids=[PROVIDER],
        cli_package_spec=f"clawdi@{VERSION}",
        previous_state=state,
    )
    if case in {"recover", "expired", "changed-source"}:
        await call
    else:
        with pytest.raises(HTTPException):
            await call
    assert state.runtimes["hermes"]["provider_ids"] == ["missing-provider"]


@pytest.mark.asyncio
@pytest.mark.parametrize("competing_current", [False, True])
async def test_custom_recovery_scopes_all_active_boots_to_current_apply_generation(
    client, db_session, seed_user, competing_current
):
    from fastapi import HTTPException

    from app.models.ai_provider import AiProvider
    from app.models.runtime_observation import V2RuntimeObservationHead
    from app.services.ai_provider_connection_ownership import require_custom_provider_cli

    await create_provider(client)
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id,
            AiProvider.provider_id == PROVIDER,
        )
    )
    provider.configuration_mode = "custom"
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    now = datetime.now(UTC)
    state = await consumer(
        db_session,
        seed_user.id,
        runtime_name="hermes",
        generation=26,
        health="error",
        captured_at=now - timedelta(hours=2),
    )
    # Push sequence and apply generation are independent. A failed selection can
    # coexist with many active historical boots and one expired current receipt.
    state.generation = 81
    state.source_revision = None
    state.runtimes = {
        "hermes": {
            "enabled": True,
            "providerMode": "configured",
            "provider_ids": ["missing-provider"],
            "primary_model": None,
            "install": {"source": "official"},
        }
    }
    prior_generations = [1, 2, 3, 4, 7, 19, 20, 21, 22]
    for generation in prior_generations + ([26] if competing_current else []):
        captured = now - timedelta(hours=3)
        await ingest_runtime_observation(
            db_session,
            environment_id=state.environment_id,
            credential_deployment_id=state.deployment_id,
            value=RuntimeObservationEventV2.model_validate(
                {
                    "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
                    "reportedAt": captured,
                    "capturedAt": captured,
                    "runtimeMode": "hosted",
                    "status": "error",
                    "activeCliVersion": VERSION,
                    "applied": {
                        "etag": f'"sha256:{REVISION}"',
                        "sourceRevision": REVISION,
                        "generation": generation,
                        "instanceId": state.instance_id,
                        "appliedProviderIds": ["different-provider"],
                    },
                    "boot": None,
                    "cli": None,
                    "applyReceiptId": f"historical-receipt-{generation:04}",
                    "bootNonce": f"historical-boot-nonce-{generation:04}",
                    "bootSessionId": f"historical-session-{generation:04}",
                    "sequence": 1,
                    "eventId": str(uuid4()),
                }
            ),
            received_at=captured,
        )
    await db_session.flush()
    request = RuntimeDriftSummaryReadRequest(
        bindings=[
            RuntimeDriftBindingRequest(
                environmentId=state.environment_id,
                deploymentId=state.deployment_id,
            )
        ]
    )
    legacy = await read_runtime_drift_summaries(db_session, request)
    assert legacy.items[0].observation.status == "ambiguous"
    # Ordinary drift reads intentionally choose one expired head. That policy
    # cannot be used to authorize historical ownership recovery.
    ordinary = await read_runtime_drift_summaries(
        db_session,
        request,
        expected_generations={state.environment_id: 26},
    )
    assert ordinary.items[0].observation.status == "expired"
    strict = await read_runtime_drift_summaries(
        db_session,
        request,
        expected_generations={state.environment_id: 26},
        require_unique_active_head=True,
    )
    assert strict.items[0].observation.status == ("ambiguous" if competing_current else "expired")
    call = require_custom_provider_cli(
        db_session,
        owner_user_id=seed_user.id,
        provider_ids=[PROVIDER],
        cli_package_spec=f"clawdi@{VERSION}",
        previous_state=state,
    )
    if competing_current:
        with pytest.raises(HTTPException):
            await call
    else:
        await call
    # Neither reader nor admission retires or deletes historical observations.
    heads = list(
        await db_session.scalars(
            select(V2RuntimeObservationHead).where(
                V2RuntimeObservationHead.environment_id == state.environment_id,
            )
        )
    )
    assert len(heads) == 10 + int(competing_current)
    assert all(head.state == "active" for head in heads)
    assert state.generation == 81 and state.apply_generation == 26
    assert state.runtimes["hermes"]["provider_ids"] == ["missing-provider"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "history", ["retained", "purged", "unqualified", "other-instance", "other-boot"]
)
async def test_custom_rollback_uses_prior_applied_evidence_from_current_boot(
    client, db_session, seed_user, history
):
    from fastapi import HTTPException

    from app.models.ai_provider import AiProvider
    from app.models.runtime_observation import V2RuntimeObservationInbox
    from app.services.ai_provider_connection_ownership import require_custom_provider_cli

    await create_provider(client)
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id, AiProvider.provider_id == PROVIDER
        )
    )
    provider.configuration_mode = "custom"
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    state = await consumer(
        db_session,
        seed_user.id,
        runtime_name="hermes",
        version="98.0.0" if history == "unqualified" else VERSION,
        successor_boot="next-provider-boot" if history == "other-boot" else None,
        captured_at=datetime.now(UTC) - timedelta(minutes=5),
    )
    old = await db_session.scalar(
        select(V2RuntimeObservationInbox).where(
            V2RuntimeObservationInbox.environment_id == state.environment_id
        )
    )
    if history == "purged":
        old.diagnostics = {}
        old.payload_purged_at = datetime.now(UTC)
    if history == "other-instance":
        state.instance_id = "another-runtime-instance"
    await db_session.flush()
    source = "b" * 64
    now = datetime.now(UTC)
    event = {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": now,
        "capturedAt": now,
        "runtimeMode": "hosted",
        "status": "error",
        "activeCliVersion": VERSION,
        "applied": {
            "etag": f'"sha256:{source}"',
            "sourceRevision": source,
            "generation": 1,
            "instanceId": state.instance_id,
            "appliedProviderIds": ["later-connection"],
        },
        "boot": None,
        "cli": None,
        "generation": 1,
        "manifestETag": f'"sha256:{REVISION}"',
        "applyReceiptId": "apply-connection-0001",
        "bootNonce": "boot-nonce-connection-0001",
        "bootSessionId": "boot-connection-test",
        "sequence": 2,
        "eventId": str(uuid4()),
    }
    if history == "other-boot":
        event["bootSessionId"] = "next-provider-boot"
        event["predecessorBootSessionId"] = "boot-connection-test"
    await ingest_runtime_observation(
        db_session,
        environment_id=state.environment_id,
        credential_deployment_id=state.deployment_id,
        value=RuntimeObservationEventV2.model_validate(event),
        received_at=now,
    )
    state.source_revision = "c" * 64
    state.runtimes = {
        "hermes": {
            "enabled": True,
            "providerMode": "configured",
            "provider_ids": ["later-connection"],
            "primary_model": None,
            "install": {"source": "official"},
        }
    }
    await db_session.flush()
    for _ in range(3):
        call = require_custom_provider_cli(
            db_session,
            owner_user_id=seed_user.id,
            provider_ids=[PROVIDER],
            cli_package_spec=f"clawdi@{VERSION}",
            previous_state=state,
        )
        if history == "retained":
            await call
        else:
            with pytest.raises(HTTPException):
                await call
    assert state.runtimes["hermes"]["provider_ids"] == ["later-connection"]
