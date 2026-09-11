"""One explicitly delegated verifier capability; no key management or implicit grants."""

from fastapi import HTTPException
from pydantic import JsonValue, TypeAdapter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.platform_workload_auth import PlatformWorkloadClient
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
