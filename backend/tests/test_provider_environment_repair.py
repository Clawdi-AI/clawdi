"""The repair writer requires a specifically delegated verifier and exact CAS."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.app_setting import AppSetting
from app.schemas.provider_environment_repair import (
    PROVIDER_ENVIRONMENT_REPAIR_SCOPE,
    NativeEnvironmentProof,
)
from app.services.ai_provider_credentials import lock_ai_provider_owner
from app.services.provider_environment_repair import native_repair_boundary
from app.services.runtime_observation import provision_runtime_environment_fence
from tests.conftest import create_env_with_project
from tests.test_ai_provider_connection_ownership import (
    PROVIDER,
    VERSION,
    consumer,
    create_provider,
)
from tests.test_platform_workload_oauth import _access_token
from tests.test_platform_workload_oauth import workload_harness as workload_harness


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "restore",
        "noop",
        "stale",
        "wrong-instance",
        "wrong-env",
        "expired",
        "wrong-owner",
        "untrusted",
    ],
)
async def test_provider_environment_cas(client, db_session, seed_user, workload_harness, case):
    await create_provider(client)
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id, AiProvider.provider_id == PROVIDER
        )
    )
    provider.configuration_mode = "custom"
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    await consumer(db_session, seed_user.id, health="error", runtime_name="hermes")
    token = await _access_token(workload_harness, PROVIDER_ENVIRONMENT_REPAIR_SCOPE)
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": str(uuid4())}
    owner = {"kind": "clerk", "ref": seed_user.clerk_id}
    path = f"/v1/platform/ai-providers/{PROVIDER}/credential-environment-repair"
    inspected = await workload_harness.client.get(path, params=owner, headers=headers)
    assert inspected.status_code == 200, inspected.text
    inventory = inspected.json()
    target_env = inventory["runtime_env_name"] if case == "noop" else "ESTABLISHED_NATIVE_KEY"
    proof = NativeEnvironmentProof.model_validate(
        {
            "binding": inventory["bindings"][0],
            "incus_instance_uuid": str(uuid4()),
            "native_state": "running",
            "applied_push_generation": 1,
            "hosted_spec_revision": "e" * 64,
            "journal_sha256": "a" * 64,
            "config_sha256": "b" * 64,
            "native_env_name": target_env,
        }
    )
    intent = {
        "owner": owner,
        "provider_id": PROVIDER,
        "expected_revision": inventory["revision"],
        "expected_boundary": native_repair_boundary(inventory["revision"], [proof]),
        "expected_env_name": inventory["runtime_env_name"],
        "native_env_name": target_env,
        "operator_fingerprint": "c" * 64,
        "operator_ref": "test-operator",
        "reason": "Restore verified native ownership",
    }
    body = {
        **intent,
        "observed_at": datetime.now(UTC).isoformat(),
        "proofs": [proof.model_dump(mode="json")],
    }
    payload = await db_session.scalar(
        select(AiProviderAuthPayload).where(
            AiProviderAuthPayload.owner_user_id == seed_user.id,
            AiProviderAuthPayload.provider_id == PROVIDER,
        )
    )
    before_secret = (payload.encrypted_payload, payload.nonce, payload.credential_revision)
    before_identity = (provider.id, provider.incarnation_id)
    if case == "stale":
        provider.label = "Newer user edit"
        await db_session.commit()
    elif case == "wrong-instance":
        body["proofs"][0]["binding"]["instance_id"] = "other-instance"
    elif case == "wrong-env":
        body["native_env_name"] = "UNATTESTED_KEY"
    elif case == "expired":
        body["observed_at"] = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    elif case == "wrong-owner":
        body["owner"] = {"kind": "clerk", "ref": "not-the-owner"}
    elif case == "untrusted":
        ordinary = await _access_token(workload_harness, "platform:runtime-state:write")
        headers["Authorization"] = f"Bearer {ordinary}"
    result = await workload_harness.client.post(path, headers=headers, json=body)
    if case in {"restore", "noop"}:
        assert result.status_code == 200, result.text
        assert result.json()["status"] == ("restored" if case == "restore" else "already_current")
        repeated = await workload_harness.client.post(path, headers=headers, json=body)
        assert repeated.status_code == 200 and repeated.json() == result.json()
        receipt = await workload_harness.client.post(
            path + "/receipt", headers=headers, json=intent
        )
        assert receipt.status_code == 200 and receipt.json() == result.json()
        assert "ESTABLISHED_NATIVE_KEY" == target_env or case == "noop"
    else:
        assert result.status_code in {403, 404, 409, 412}, result.text
    await db_session.refresh(provider)
    await db_session.refresh(payload)
    assert (provider.id, provider.incarnation_id) == before_identity
    assert (payload.encrypted_payload, payload.nonce, payload.credential_revision) == before_secret
    assert provider.runtime_env_name == (
        target_env if case in {"restore", "noop"} else inventory["runtime_env_name"]
    )

    # Even a valid native-looking proof never authorizes a direct legacy admin write.
    denied = await workload_harness.client.post(
        path,
        headers={"X-Admin-Key": "test-platform-admin-secret", "Idempotency-Key": str(uuid4())},
        json=body,
    )
    assert denied.status_code == 401


@pytest.mark.asyncio
async def test_verifier_scope_grant_is_explicit_cas_and_preserves_other_tokens(
    db_session, workload_harness
):
    from app.services.platform_workload_auth import (
        PlatformWorkloadAccessError,
        authenticate_platform_workload_access_token,
    )

    credential = workload_harness.credential
    credential.allowed_scopes = [
        scope for scope in credential.allowed_scopes if scope != PROVIDER_ENVIRONMENT_REPAIR_SCOPE
    ]
    await db_session.commit()
    previous_scopes = list(credential.allowed_scopes)
    previous_key = dict(credential.public_jwk)
    previous_version = credential.token_version
    ordinary_token = await _access_token(workload_harness, "platform:runtime-state:write")
    path = (
        f"/v1/admin/platform/workload-clients/{credential.client_id}/provider-environment-verifier"
    )
    headers = {"X-Admin-Key": "test-platform-admin-secret", "Idempotency-Key": str(uuid4())}
    view = await workload_harness.client.get(path, headers=headers)
    assert view.status_code == 200 and view.json()["granted"] is False
    request = {
        "expected_revision": view.json()["revision"],
        "action": "grant",
        "reason": "Delegate to the reviewed Hosted verifier",
    }
    granted = await workload_harness.client.put(path, headers=headers, json=request)
    assert granted.status_code == 200 and granted.json()["granted"] is True, granted.text
    replay = await workload_harness.client.put(path, headers=headers, json=request)
    assert replay.json() == granted.json()
    stale = await workload_harness.client.put(
        path,
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={**request, "action": "revoke"},
    )
    assert stale.status_code == 412
    repair_token = await _access_token(workload_harness, PROVIDER_ENVIRONMENT_REPAIR_SCOPE)
    await authenticate_platform_workload_access_token(
        db_session,
        workload_harness.resolver,
        ordinary_token,
        required_scope="platform:runtime-state:write",
    )
    revoked = await workload_harness.client.put(
        path,
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={**request, "expected_revision": granted.json()["revision"], "action": "revoke"},
    )
    assert revoked.status_code == 200 and revoked.json()["granted"] is False
    with pytest.raises(PlatformWorkloadAccessError):
        await authenticate_platform_workload_access_token(
            db_session,
            workload_harness.resolver,
            repair_token,
            required_scope=PROVIDER_ENVIRONMENT_REPAIR_SCOPE,
        )
    await db_session.refresh(credential)
    assert credential.allowed_scopes == previous_scopes
    assert credential.public_jwk == previous_key and credential.token_version == previous_version


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", ["matching", "conflict", "unbound-pending", "unbound-current", "unbound-stopped"]
)
async def test_restore_covers_other_native_owners_and_pending_absence(
    client, db_session, seed_user, workload_harness, case
):
    await create_provider(client)
    provider = await db_session.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == seed_user.id, AiProvider.provider_id == PROVIDER
        )
    )
    provider.configuration_mode = "custom"
    db_session.add(AppSetting(key="supported_custom_provider_cli_versions", value_json=[VERSION]))
    await consumer(db_session, seed_user.id, health="error", runtime_name="hermes")
    second = await consumer(db_session, seed_user.id, health="error", runtime_name="hermes")
    if case.startswith("unbound"):
        # Selection checkpoints are independent of this unchanged apply/boot identity.
        second.runtimes = {
            "hermes": {
                "enabled": True,
                "providerMode": "unmanaged",
                "provider_ids": [],
                "install": {"source": "official"},
            }
        }
        second.generation = 2
        await db_session.commit()
    token = await _access_token(workload_harness, PROVIDER_ENVIRONMENT_REPAIR_SCOPE)
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": str(uuid4())}
    owner = {"kind": "clerk", "ref": seed_user.clerk_id}
    path = f"/v1/platform/ai-providers/{PROVIDER}/credential-environment-repair"
    read = await workload_harness.client.get(path, params=owner, headers=headers)
    assert read.status_code == 200, read.text
    inventory = read.json()
    proofs = []
    for binding in inventory["bindings"]:
        other = binding["environment_id"] == str(second.environment_id)
        absent = other and case.startswith("unbound")
        proofs.append(
            NativeEnvironmentProof.model_validate(
                {
                    "binding": binding,
                    "incus_instance_uuid": str(uuid4()),
                    "native_state": "stopped" if other and case == "unbound-stopped" else "running",
                    "applied_push_generation": 2 if other and case == "unbound-current" else 1,
                    "hosted_spec_revision": "d" * 64,
                    "journal_sha256": None if absent else "a" * 64,
                    "config_sha256": None if absent else "b" * 64,
                    "native_env_name": None
                    if absent
                    else "CONFLICTING_KEY"
                    if other and case == "conflict"
                    else "ESTABLISHED_KEY",
                }
            )
        )
    body = {
        "owner": owner,
        "provider_id": PROVIDER,
        "expected_revision": inventory["revision"],
        "expected_boundary": native_repair_boundary(inventory["revision"], proofs),
        "expected_env_name": inventory["runtime_env_name"],
        "native_env_name": "ESTABLISHED_KEY",
        "operator_fingerprint": "c" * 64,
        "operator_ref": "test-operator",
        "reason": "Verify all native consumers",
        "observed_at": datetime.now(UTC).isoformat(),
        "proofs": [proof.model_dump(mode="json") for proof in proofs],
    }
    reply = await workload_harness.client.post(path, headers=headers, json=body)
    assert reply.status_code == (409 if case in {"conflict", "unbound-pending"} else 200), (
        reply.text
    )
    await db_session.refresh(provider)
    assert provider.runtime_env_name == (
        inventory["runtime_env_name"]
        if case in {"conflict", "unbound-pending"}
        else "ESTABLISHED_KEY"
    )


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_new_v2_consumer_waits_for_provider_inventory_owner_lock(
    engine, db_session, seed_user
):
    environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"repair-inventory-{uuid4()}",
        machine_name="Repair inventory fence",
    )
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as repair, sessions() as mint:
        await lock_ai_provider_owner(repair, seed_user.id)
        await mint.execute(text("SET LOCAL lock_timeout = '100ms'"))
        with pytest.raises(DBAPIError) as blocked:
            await provision_runtime_environment_fence(
                mint,
                environment_id=environment.id,
                owner_id=seed_user.id,
                deployment_id="new-v2-consumer",
            )
        assert blocked.value.orig.sqlstate == "55P03"
        await mint.rollback()
        await repair.rollback()
        fence = await provision_runtime_environment_fence(
            mint,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id="new-v2-consumer",
        )
        assert fence.deployment_id == "new-v2-consumer"
        await mint.rollback()
