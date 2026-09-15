"""Public registration cannot grant repair, replace authority, or store private keys."""

import json
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from sqlalchemy import func, select

from app.models.audit import ControlPlaneAuditEvent
from app.models.platform_workload_auth import PlatformWorkloadClient
from tests.test_platform_workload_oauth import workload_harness as workload_harness


@pytest.mark.asyncio
@pytest.mark.parametrize("algorithm", ["RS256", "ES256"])
async def test_bootstrap_is_audited_idempotent_and_requires_separate_grant(
    db_session, workload_harness, algorithm
):
    key = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        if algorithm == "RS256"
        else ec.generate_private_key(ec.SECP256R1())
    )
    kid = f"bootstrap-{uuid4().hex}"
    public_jwk = json.loads(
        jwt.algorithms.get_default_algorithms()[algorithm].to_jwk(key.public_key())
    )
    body = {
        "client_id": f"bootstrap-{uuid4().hex}",
        "assertion_kid": kid,
        "assertion_algorithm": algorithm,
        "public_jwk": {**public_jwk, "kid": kid, "alg": algorithm, "use": "sig"},
        "reason": "Register reviewed runtime projector",
    }
    path = "/v1/admin/platform/workload-clients"
    headers = {"X-Admin-Key": "test-platform-admin-secret", "Idempotency-Key": str(uuid4())}
    client = workload_harness.client
    denied = await client.post(path, json=body)
    assert denied.status_code in {401, 403}
    registered = await client.post(path, headers=headers, json=body)
    assert registered.status_code == 201, registered.text
    assert registered.json()["granted"] is False
    replay = await client.post(path, headers=headers, json=body)
    assert replay.status_code == 201 and replay.json() == registered.json()
    collision = await client.post(
        path, headers={**headers, "Idempotency-Key": str(uuid4())}, json=body
    )
    assert collision.status_code == 409
    changed = await client.post(path, headers=headers, json={**body, "reason": "Changed intent"})
    assert changed.status_code == 409
    saved = await db_session.scalar(
        select(PlatformWorkloadClient).where(PlatformWorkloadClient.client_id == body["client_id"])
    )
    assert saved.public_jwk == body["public_jwk"]
    assert saved.allowed_scopes == ["platform:runtime-state:write"]
    assert saved.token_version == 1
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ControlPlaneAuditEvent)
            .where(
                ControlPlaneAuditEvent.action == "platform.workload_client.bootstrap",
                ControlPlaneAuditEvent.resource_id == str(saved.id),
            )
        )
        == 1
    )
    granted = await client.put(
        f"{path}/{saved.client_id}/provider-environment-verifier",
        headers={**headers, "Idempotency-Key": str(uuid4())},
        json={
            "expected_revision": registered.json()["revision"],
            "action": "grant",
            "reason": "Reviewed verifier",
        },
    )
    assert granted.status_code == 200 and granted.json()["granted"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["private", "kid", "malformed", "weak", "curve", "sign"])
async def test_bootstrap_rejects_invalid_public_authority(db_session, workload_harness, invalid):
    public_jwk = dict(workload_harness.credential.public_jwk)
    algorithm = "RS256"
    if invalid == "private":
        public_jwk["d"] = "not-a-public-key"
    elif invalid == "kid":
        public_jwk["kid"] = "different-kid"
    elif invalid == "malformed":
        public_jwk["n"] = "!"
    elif invalid == "weak":
        public_jwk.update(
            json.loads(
                jwt.algorithms.RSAAlgorithm.to_jwk(
                    rsa.generate_private_key(public_exponent=65537, key_size=1024).public_key()
                )
            )
        )
    elif invalid == "curve":
        algorithm = "ES256"
        public_jwk.update(
            json.loads(
                jwt.algorithms.ECAlgorithm.to_jwk(
                    ec.generate_private_key(ec.SECP384R1()).public_key()
                )
            )
        )
        public_jwk["alg"] = algorithm
    else:
        public_jwk["key_ops"] = ["sign", "verify"]
    client_id = f"invalid-{uuid4().hex}"
    response = await workload_harness.client.post(
        "/v1/admin/platform/workload-clients",
        headers={"X-Admin-Key": "test-platform-admin-secret", "Idempotency-Key": str(uuid4())},
        json={
            "client_id": client_id,
            "assertion_kid": workload_harness.credential.assertion_kid,
            "assertion_algorithm": algorithm,
            "public_jwk": public_jwk,
            "reason": "Invalid key must not persist",
        },
    )
    assert response.status_code == 422, response.text
    assert "not-a-public-key" not in response.text
    assert (
        await db_session.scalar(
            select(PlatformWorkloadClient.id).where(PlatformWorkloadClient.client_id == client_id)
        )
        is None
    )
