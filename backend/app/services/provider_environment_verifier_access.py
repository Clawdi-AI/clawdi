"""Public client bootstrap and separately delegated native verifier capability."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
from fastapi import HTTPException
from pydantic import JsonValue, TypeAdapter
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.platform_workload_auth import PlatformWorkloadClient, PlatformWorkloadSigningKey
from app.schemas.admin import (
    AdminWorkloadClientBootstrap,
    AdminWorkloadSignerBootstrap,
    AdminWorkloadSignerReceipt,
)
from app.schemas.provider_environment_repair import (
    PROVIDER_ENVIRONMENT_REPAIR_SCOPE,
    ProviderEnvironmentVerifierAccess,
    ProviderEnvironmentVerifierGrant,
)
from app.services.audit import record_control_plane_audit
from app.services.platform_contract import (
    lock_platform_idempotency,
    platform_request_hash,
    read_platform_replay,
    store_platform_response,
)
from app.services.platform_workload_auth import (
    PlatformOAuthProtocolError,
    PlatformWorkloadKeyResolver,
    PlatformWorkloadKeyUnavailable,
    validate_workload_public_key,
)
from app.services.platform_workload_signer import public_key_material, signing_key_reference


async def bootstrap_workload_client(
    db: AsyncSession,
    *,
    body: AdminWorkloadClientBootstrap,
    idempotency_key: str,
    request_id: str,
) -> ProviderEnvironmentVerifierAccess:
    """Create once; retries cannot rotate keys, resurrect clients, or grant repair."""
    try:
        validate_workload_public_key(
            body.public_jwk, kid=body.assertion_kid, algorithm=body.assertion_algorithm
        )
    except PlatformOAuthProtocolError:
        raise HTTPException(422, "Invalid public assertion JWK") from None
    operation = "platform.workload_client.bootstrap"
    request_hash = platform_request_hash(body.model_dump(mode="json"))
    previous = await lock_platform_idempotency(
        db, operation=operation, idempotency_key=idempotency_key
    )
    if previous is not None:
        if previous.request_hash != request_hash or previous.owner_user_id is not None:
            raise HTTPException(409, "Idempotency-Key belongs to a different client bootstrap")
        return ProviderEnvironmentVerifierAccess.model_validate(read_platform_replay(previous).body)
    await lock_workload_registration(db)
    if await db.scalar(
        select(PlatformWorkloadSigningKey.id)
        .where(PlatformWorkloadSigningKey.private_key_ref == signing_key_reference(body.public_jwk))
        .limit(1)
    ):
        raise HTTPException(409, "Client assertion and Cloud signing keys must be separate")
    client = await db.scalar(
        insert(PlatformWorkloadClient)
        .values(
            client_id=body.client_id,
            assertion_kid=body.assertion_kid,
            assertion_algorithm=body.assertion_algorithm,
            public_jwk={**body.public_jwk, **public_key_material(body.public_jwk)},
            allowed_scopes=["platform:runtime-state:write"],
        )
        .on_conflict_do_nothing(index_elements=[PlatformWorkloadClient.client_id])
        .returning(PlatformWorkloadClient)
    )
    if client is None:
        raise HTTPException(409, "Workload client already exists; bootstrap cannot replace it")
    response = _access(client)
    record_control_plane_audit(
        db,
        actor_type="admin",
        action=operation,
        resource_type="platform_workload_client",
        resource_id=str(client.id),
        source="api.admin",
        details={
            "request_id": request_id,
            "idempotency_key": idempotency_key,
            "reason": body.reason,
            "client_id": client.client_id,
            "public_key_fingerprint": response.public_key_fingerprint,
            "scopes": client.allowed_scopes,
        },
    )
    store_platform_response(
        db,
        operation=operation,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner_user_id=None,
        resource_type="platform_workload_client",
        resource_id=str(client.id),
        response_status=201,
        response_body=response.model_dump(mode="json"),
    )
    await db.commit()
    return response


def _access(client: PlatformWorkloadClient) -> ProviderEnvironmentVerifierAccess:
    public_key_fingerprint = platform_request_hash(client.public_jwk)
    return ProviderEnvironmentVerifierAccess(
        client_id=client.client_id,
        credential_id=client.id,
        status=client.status,
        public_key_fingerprint=public_key_fingerprint,
        revision=platform_request_hash(
            TypeAdapter(dict[str, JsonValue]).validate_python(
                {
                    "id": str(client.id),
                    "key": public_key_fingerprint,
                    "status": client.status,
                    "scopes": sorted(client.allowed_scopes),
                    "version": client.token_version,
                }
            )
        ),
        granted=client.status == "active"
        and PROVIDER_ENVIRONMENT_REPAIR_SCOPE in client.allowed_scopes,
    )


async def inspect_verifier_access(
    db: AsyncSession, client_id: str
) -> ProviderEnvironmentVerifierAccess:
    client = await db.scalar(
        select(PlatformWorkloadClient).where(PlatformWorkloadClient.client_id == client_id)
    )
    if client is None:
        raise HTTPException(404, "Workload client not found")
    return _access(client)


async def update_verifier_access(
    db: AsyncSession,
    *,
    client_id: str,
    body: ProviderEnvironmentVerifierGrant,
    idempotency_key: str,
    request_id: str,
) -> ProviderEnvironmentVerifierAccess:
    operation = "provider_environment.verifier_access"
    request_hash = platform_request_hash({"client_id": client_id, **body.model_dump(mode="json")})
    previous = await lock_platform_idempotency(
        db, operation=operation, idempotency_key=idempotency_key
    )
    if previous is not None:
        if previous.request_hash != request_hash or previous.owner_user_id is not None:
            raise HTTPException(409, "Idempotency-Key belongs to a different verifier grant")
        return ProviderEnvironmentVerifierAccess.model_validate(read_platform_replay(previous).body)
    client = await db.scalar(
        select(PlatformWorkloadClient)
        .where(PlatformWorkloadClient.client_id == client_id)
        .with_for_update()
    )
    if client is None:
        raise HTTPException(404, "Workload client not found")
    before = _access(client)
    if body.expected_revision != before.revision:
        raise HTTPException(412, "Workload credential authority changed")
    if client.status != "active":
        raise HTTPException(409, "Inactive credentials cannot receive verifier access")
    scopes = set(client.allowed_scopes)
    if body.action == "grant":
        if "platform:runtime-state:write" not in scopes:
            raise HTTPException(409, "Verifier must already own runtime projection authority")
        scopes.add(PROVIDER_ENVIRONMENT_REPAIR_SCOPE)
    else:
        scopes.discard(PROVIDER_ENVIRONMENT_REPAIR_SCOPE)
        if not scopes:
            raise HTTPException(
                409, "Repair-only credentials require their normal disable lifecycle"
            )
    if scopes != set(client.allowed_scopes):
        client.allowed_scopes = [
            scope for scope in client.allowed_scopes if scope in scopes
        ] + sorted(scopes - set(client.allowed_scopes))
    # Tokens carry their own scopes, and authentication rechecks the current grant.
    # Do not invalidate unrelated in-flight runtime tokens on an additive grant.
    response = _access(client)
    record_control_plane_audit(
        db,
        actor_type="admin",
        action=operation,
        resource_type="platform_workload_client",
        resource_id=str(client.id),
        source="api.admin",
        details={
            "request_id": request_id,
            "idempotency_key": idempotency_key,
            "reason": body.reason,
            "action": body.action,
            "before_revision": before.revision,
            "after_revision": response.revision,
            "public_key_fingerprint": response.public_key_fingerprint,
        },
    )
    store_platform_response(
        db,
        operation=operation,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner_user_id=None,
        resource_type="platform_workload_client",
        resource_id=str(client.id),
        response_status=200,
        response_body=response.model_dump(mode="json"),
    )
    await db.commit()
    return response


async def register_workload_signer(
    db: AsyncSession,
    *,
    body: AdminWorkloadSignerBootstrap,
    idempotency_key: str,
    request_id: str,
    resolver: PlatformWorkloadKeyResolver,
) -> AdminWorkloadSignerReceipt:
    try:
        key = validate_workload_public_key(body.public_jwk, kid=body.kid, algorithm=body.algorithm)
    except PlatformOAuthProtocolError:
        raise HTTPException(422, "Invalid public signing JWK") from None
    operation = "platform.workload_signer.bootstrap"
    request_hash = platform_request_hash(body.model_dump(mode="json"))
    previous = await lock_platform_idempotency(
        db, operation=operation, idempotency_key=idempotency_key
    )
    if previous is not None:
        if previous.request_hash != request_hash or previous.owner_user_id is not None:
            raise HTTPException(409, "Idempotency-Key belongs to a different signer bootstrap")
        return AdminWorkloadSignerReceipt.model_validate(read_platform_replay(previous).body)
    await lock_workload_registration(db)
    reference = signing_key_reference(body.public_jwk)
    if body.expires_at < datetime.now(UTC) + timedelta(minutes=5):
        raise HTTPException(422, "Signing key expires before an access token can complete")
    if await db.scalar(
        select(PlatformWorkloadClient.id)
        .where(PlatformWorkloadClient.public_jwk.contains(public_key_material(body.public_jwk)))
        .limit(1)
    ):
        raise HTTPException(409, "Client assertion and Cloud signing keys must be separate")
    try:
        challenge = str(uuid4())
        signed = await resolver.sign_jwt(
            private_key_ref=reference,
            algorithm=body.algorithm,
            payload={"challenge": challenge},
            headers={"kid": body.kid, "typ": "JWT"},
        )
        if jwt.get_unverified_header(signed).get("kid") != body.kid or jwt.decode(
            signed, key, algorithms=[body.algorithm]
        ) != {"challenge": challenge}:
            raise ValueError("signer mismatch")
    except (PlatformWorkloadKeyUnavailable, jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(
            503, "Configured signing authority does not match the public key"
        ) from None
    row = await db.scalar(
        insert(PlatformWorkloadSigningKey)
        .values(
            kid=body.kid,
            algorithm=body.algorithm,
            private_key_ref=reference,
            not_before=body.not_before,
            expires_at=body.expires_at,
        )
        .on_conflict_do_nothing()
        .returning(PlatformWorkloadSigningKey)
    )
    if row is None:
        raise HTTPException(409, "Signing key already registered; bootstrap cannot replace it")
    receipt = AdminWorkloadSignerReceipt(
        kid=body.kid,
        algorithm=body.algorithm,
        public_key_ref=reference,
        not_before=body.not_before,
        expires_at=body.expires_at,
    )
    record_control_plane_audit(
        db,
        actor_type="admin",
        action=operation,
        resource_type="platform_workload_signing_key",
        resource_id=str(row.id),
        source="api.admin",
        details={
            "request_id": request_id,
            "idempotency_key": idempotency_key,
            "reason": body.reason,
            "public_key_fingerprint": reference,
            "kid": body.kid,
        },
    )
    store_platform_response(
        db,
        operation=operation,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner_user_id=None,
        resource_type="platform_workload_signing_key",
        resource_id=str(row.id),
        response_status=201,
        response_body=receipt.model_dump(mode="json"),
    )
    await db.commit()
    return receipt


async def lock_workload_registration(db: AsyncSession) -> None:
    # Serialize both registration surfaces so a public key cannot race into both roles.
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended("workload-registration", 0)))
    )
