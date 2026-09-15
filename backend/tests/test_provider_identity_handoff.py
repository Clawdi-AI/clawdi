"""Real PostgreSQL handoff intent, mutation fences, acknowledgements and retry receipts."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models.ai_provider import AiProvider
from app.models.app_setting import AppSetting
from app.schemas.provider_environment_repair import NativeIdentityProof, RepairBinding
from app.services.provider_identity_handoff import identity_boundary
from tests.test_ai_provider_connection_ownership import PROVIDER, VERSION, consumer, create_provider
from tests.test_platform_workload_oauth import _access_token
from tests.test_platform_workload_oauth import workload_harness as workload_harness


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", ["complete", "wrong-incarnation", "wrong-owner", "conflicting-consumer", "supersede"]
)
async def test_handoff_requires_native_ack_and_preserves_pending_intent_on_failure(
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
    await consumer(db_session, seed_user.id, runtime_name="hermes")
    await consumer(db_session, seed_user.id, runtime_name="hermes")
    token = await _access_token(workload_harness, "platform:provider-environment:repair")
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": str(uuid4())}
    owner = {"kind": "clerk", "ref": seed_user.clerk_id}
    path = f"/v1/platform/ai-providers/{PROVIDER}"
    inventory = (
        await workload_harness.client.get(
            path + "/credential-environment-repair", params=owner, headers=headers
        )
    ).json()
    proof = NativeIdentityProof.model_validate(
        {
            "binding": inventory["bindings"][0],
            "incus_instance_uuid": str(uuid4()),
            "native_state": "running",
            "applied_push_generation": 1,
            "hosted_spec_revision": "e" * 64,
            "journal_sha256": "a" * 64,
            "config_sha256": "b" * 64,
            "native_env_sha256": "c" * 64,
            "journal_env_name": "OLD_JOURNAL_KEY",
            "native_env_name": "CURRENT_NATIVE_KEY",
            "native_base_url": "https://api.openai.com/v1",
            "native_api_mode": "openai_responses",
        }
    )
    proofs = [
        proof.model_copy(
            update={
                "binding": RepairBinding.model_validate(binding),
                "incus_instance_uuid": uuid4(),
            }
        )
        for binding in inventory["bindings"]
    ]
    if case == "conflicting-consumer":
        proofs[1] = proofs[1].model_copy(update={"native_env_name": "OTHER_NATIVE_KEY"})
    body = {
        "owner": owner,
        "provider_id": PROVIDER,
        "expected_provider_uuid": inventory["provider_uuid"],
        "expected_incarnation_id": inventory["incarnation_id"],
        "expected_revision": inventory["revision"],
        "expected_boundary": identity_boundary(inventory["revision"], proofs),
        "expected_env_name": inventory["runtime_env_name"],
        "native_env_name": "CURRENT_NATIVE_KEY",
        "operator_ref": "test-operator",
        "operator_fingerprint": "f" * 64,
        "reason": "Explicitly retain native credentials",
        "observed_at": datetime.now(UTC).isoformat(),
        "proofs": [item.model_dump(mode="json") for item in proofs],
    }
    if case == "wrong-incarnation":
        body["expected_incarnation_id"] = str(uuid4())
    if case == "wrong-owner":
        body["owner"] = {"kind": "clerk", "ref": "other-owner"}
    prepared = await workload_harness.client.post(
        path + "/identity-handoff", headers=headers, json=body
    )
    if case in {"wrong-incarnation", "wrong-owner", "conflicting-consumer"}:
        assert prepared.status_code in {403, 404, 409, 412}, prepared.text
        await db_session.refresh(provider)
        assert (
            provider.identity_handoff is None
            and provider.runtime_env_name == inventory["runtime_env_name"]
        )
        return
    assert prepared.status_code == 200, prepared.text
    receipt = prepared.json()
    assert receipt["state"] == "prepared"
    assert receipt["prepared_revision"] != inventory["revision"]
    await db_session.refresh(provider)
    assert provider.runtime_env_name == inventory["runtime_env_name"]
    replay = await workload_harness.client.post(
        path + "/identity-handoff", headers=headers, json=body
    )
    assert replay.json() == receipt
    if case == "supersede":
        current = (
            await workload_harness.client.get(
                path + "/credential-environment-repair", params=owner, headers=headers
            )
        ).json()
        new_intent = {
            **body,
            "expected_revision": current["revision"],
            "expected_boundary": identity_boundary(current["revision"], proofs),
            "supersedes_handoff_id": receipt["handoff_id"],
        }
        superseded = await workload_harness.client.post(
            path + "/identity-handoff",
            headers={**headers, "Idempotency-Key": str(uuid4())},
            json=new_intent,
        )
        assert superseded.status_code == 200, superseded.text
        assert superseded.json()["handoff_id"] != receipt["handoff_id"]
        receipt = superseded.json()
    rejected = await client.patch(f"/v1/ai-providers/{PROVIDER}", json={"label": "Must wait"})
    assert rejected.status_code == 409
    completion = {
        "owner": owner,
        "handoff_id": receipt["handoff_id"],
        "observed_at": datetime.now(UTC).isoformat(),
        "proofs": [item.model_dump(mode="json") for item in proofs],
    }
    finish_headers = {**headers, "Idempotency-Key": str(uuid4())}
    rejected = await workload_harness.client.post(
        path + "/identity-handoff/complete", headers=finish_headers, json=completion
    )
    assert rejected.status_code == 412, rejected.text
    await db_session.refresh(provider)
    assert (
        provider.identity_handoff is not None
        and provider.runtime_env_name == inventory["runtime_env_name"]
    )
    for ack in completion["proofs"]:
        ack.update(
            {
                "journal_env_name": "CURRENT_NATIVE_KEY",
                "journal_sha256": "d" * 64,
                "journal_provider_uuid": inventory["provider_uuid"],
                "journal_incarnation_id": inventory["incarnation_id"],
                "handoff_id": receipt["handoff_id"],
            }
        )
    completed = await workload_harness.client.post(
        path + "/identity-handoff/complete", headers=finish_headers, json=completion
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["state"] == "completed"
    await db_session.refresh(provider)
    assert (
        provider.native_credential_authority and provider.runtime_env_name == "CURRENT_NATIVE_KEY"
    )
    replay = await workload_harness.client.post(
        path + "/identity-handoff/complete", headers=finish_headers, json=completion
    )
    assert replay.json() == completed.json()
    wrong_provider = await workload_harness.client.post(
        "/v1/platform/ai-providers/another-provider/identity-handoff/complete",
        headers=finish_headers, json=completion,
    )
    assert wrong_provider.status_code == 409


    view = await client.get(f"/v1/ai-providers/{PROVIDER}")
    assert view.json()["credential_authority"] == "native"
    rejected = await client.patch(
        f"/v1/ai-providers/{PROVIDER}",
        json={"credential": {"type": "api_key", "value": "must-not-override-native"}},
    )
    assert rejected.status_code == 409
