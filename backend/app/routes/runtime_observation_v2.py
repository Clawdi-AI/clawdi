from __future__ import annotations

import json
from typing import Annotated, Any, NoReturn
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth
from app.core.database import get_runtime_observation_session, get_session
from app.models.runtime_observation import V2RuntimeEnvironmentFence
from app.models.user import PRINCIPAL_KIND_CLERK, PRINCIPAL_KIND_PARTNER_TENANT, User
from app.schemas.api_key import ApiKeyCreated
from app.schemas.platform import PlatformOwner
from app.schemas.runtime_observation import (
    RUNTIME_OBSERVATION_WRITE_SCOPE,
    RuntimeDeploymentKeyCreate,
    RuntimeEnvironmentRetirementReceipt,
    RuntimeEnvironmentRetireRequest,
    RuntimeObservationConsumerAckRequest,
    RuntimeObservationConsumerRequest,
    RuntimeObservationConsumerResetResponse,
    RuntimeObservationConsumerResponse,
    RuntimeObservationEventV2,
    RuntimeObservationIngestResponse,
    RuntimeObservationReadRequest,
    RuntimeObservationReadResponse,
)
from app.services.api_key import mint_api_key
from app.services.audit import record_control_plane_audit
from app.services.platform_contract import (
    PlatformReplay,
    lock_platform_idempotency,
    platform_request_hash,
    read_platform_replay,
    store_platform_response,
)
from app.services.platform_workload_auth import (
    PlatformMutationAuth,
    require_platform_workload_auth,
)
from app.services.runtime_observation import (
    RuntimeApplyIdentity,
    RuntimeObservationProtocolError,
    acknowledge_runtime_observation_cursor,
    ingest_runtime_observation,
    provision_runtime_environment_fence,
    read_runtime_observations,
    register_runtime_observation_consumer,
    reset_runtime_observation_consumer,
    retire_runtime_environment,
)

router = APIRouter(prefix="/v2/runtime", tags=["v2-runtime-observations"])

IdempotencyKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=1, max_length=200),
]

_NON_ADVANCING_OUTCOMES = frozenset(
    {
        "accepted_non_advance_sequence",
        "accepted_non_advance_captured_at",
    }
)


async def require_runtime_observation_writer(
    environment_id: UUID,
    body: RuntimeObservationEventV2,
    auth: AuthContext = Depends(get_auth),
    db: AsyncSession = Depends(get_session),
) -> AuthContext:
    """Require one explicit, narrow deployment credential for v2 ingestion."""

    api_key = auth.api_key
    rejection_reason: str | None = None
    if not auth.is_cli or api_key is None:
        rejection_reason = "runtime_credential_required"
    elif not api_key.managed:
        rejection_reason = "managed_credential_required"
    elif api_key.environment_id != environment_id:
        rejection_reason = "environment_binding_mismatch"
    elif api_key.runtime_deployment_id is None:
        rejection_reason = "deployment_binding_missing"
    elif api_key.scopes is None or RUNTIME_OBSERVATION_WRITE_SCOPE not in api_key.scopes:
        rejection_reason = "scope_missing"
    if rejection_reason is None:
        return auth

    try:
        _record_runtime_ingest_audit(
            db,
            actor_user_id=auth.user_id,
            principal_id=api_key.id if api_key is not None else auth.user_id,
            runtime_principal_id=api_key.id if api_key is not None else None,
            deployment_id=(api_key.runtime_deployment_id if api_key is not None else None),
            environment_id=environment_id,
            value=body,
            outcome="runtime_observation_credential_mismatch",
            rejection_reason=rejection_reason,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        detail={
            "code": "runtime_observation_credential_mismatch",
            "message": "a deployment-bound v2 runtime observation credential is required",
        },
    )


async def _resolve_owner(db: AsyncSession, owner: PlatformOwner) -> User:
    if owner.kind == PRINCIPAL_KIND_CLERK:
        filters = (
            User.principal_kind == PRINCIPAL_KIND_CLERK,
            User.clerk_id == owner.ref,
        )
    else:
        filters = (
            User.principal_kind == PRINCIPAL_KIND_PARTNER_TENANT,
            User.partner_tenant_ref == owner.ref,
            User.clerk_id.is_(None),
        )
    resolved = (await db.execute(select(User).where(*filters))).scalar_one_or_none()
    if resolved is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Owner not found")
    return resolved


async def _begin_idempotent_mutation(
    db: AsyncSession,
    *,
    operation: str,
    idempotency_key: str,
    request_payload: dict[str, Any],
    owner_user_id: UUID,
) -> tuple[str, PlatformReplay | None]:
    request_hash = platform_request_hash(request_payload)
    existing = await lock_platform_idempotency(
        db,
        operation=operation,
        idempotency_key=idempotency_key,
    )
    if existing is None:
        return request_hash, None
    if existing.request_hash != request_hash or existing.owner_user_id != owner_user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Idempotency-Key was already used with a different request",
        )
    return request_hash, read_platform_replay(existing)


def _canonical_response_body(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        body = value.model_dump(mode="json", by_alias=True)
    elif isinstance(value, dict):
        body = value
    else:
        raise TypeError("v2 runtime response must be an object")
    return json.loads(json.dumps(body, sort_keys=True, separators=(",", ":")))


class _CanonicalJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")


def _replay_response(replay: PlatformReplay) -> JSONResponse:
    return _CanonicalJSONResponse(status_code=replay.status_code, content=replay.body)


def _workload_identity(auth: PlatformMutationAuth) -> tuple[str, str]:
    if auth.kind != "workload" or auth.client_id is None or auth.credential_id is None:
        raise RuntimeError("v2 runtime control-plane routes require workload identity")
    return auth.client_id, str(auth.credential_id)


def _record_workload_audit(
    db: AsyncSession,
    *,
    auth: PlatformMutationAuth,
    action: str,
    target_user_id: UUID,
    environment_id: UUID,
    deployment_id: str,
    outcome: str,
    details: dict[str, Any] | None = None,
) -> None:
    client_id, principal_id = _workload_identity(auth)
    record_control_plane_audit(
        db,
        actor_type="platform_workload",
        target_user_id=target_user_id,
        source="api.v2.runtime",
        action=action,
        resource_type="runtime_environment_fence",
        resource_id=str(environment_id),
        # Keep the durable identity after AgentEnvironment deletion. The
        # environment UUID remains in resource_id and safe details.
        environment_id=None,
        details={
            "workload_client_id": client_id,
            "workload_principal_id": principal_id,
            "environment_id": str(environment_id),
            "deployment_id": deployment_id,
            "outcome": outcome,
            **(details or {}),
        },
    )


def _record_runtime_ingest_audit(
    db: AsyncSession,
    *,
    actor_user_id: UUID,
    principal_id: UUID,
    runtime_principal_id: UUID | None,
    deployment_id: str | None,
    environment_id: UUID,
    value: RuntimeObservationEventV2,
    outcome: str,
    rejection_reason: str | None = None,
) -> None:
    record_control_plane_audit(
        db,
        actor_type="runtime_deployment" if runtime_principal_id is not None else "user",
        actor_user_id=actor_user_id,
        target_user_id=actor_user_id,
        source="api.v2.runtime",
        action="runtime_observation.ingest",
        resource_type="runtime_observation",
        resource_id=str(environment_id),
        environment_id=None,
        details={
            "principal_id": str(principal_id),
            # Retain the initial companion audit field while exposing the
            # protocol-neutral principal name required by the v2 audit contract.
            "runtime_principal_id": (
                str(runtime_principal_id) if runtime_principal_id is not None else None
            ),
            "environment_id": str(environment_id),
            "deployment_id": deployment_id,
            "boot_session_id": value.boot_session_id,
            "sequence": value.sequence,
            "event_id": value.event_id,
            "outcome": outcome,
            **({"rejection_reason": rejection_reason} if rejection_reason else {}),
        },
    )


def _record_cursor_expiry_audit(
    db: AsyncSession,
    *,
    auth: PlatformMutationAuth,
    target_user_id: UUID,
    environment_id: UUID,
    deployment_id: str,
    operation: str,
) -> None:
    client_id, principal_id = _workload_identity(auth)
    record_control_plane_audit(
        db,
        actor_type="platform_workload",
        target_user_id=target_user_id,
        source="api.v2.runtime",
        action="runtime_observation.cursor_expired",
        resource_type="runtime_observation_consumer",
        resource_id=str(environment_id),
        environment_id=None,
        details={
            "workload_client_id": client_id,
            "workload_principal_id": principal_id,
            "consumer_id": client_id,
            "environment_id": str(environment_id),
            "deployment_id": deployment_id,
            "operation": operation,
            "outcome": "observation_cursor_expired",
            "reset_required": True,
        },
    )


def _raise_protocol_error(exc: RuntimeObservationProtocolError) -> NoReturn:
    raise HTTPException(exc.status_code, exc.detail()) from exc


async def _load_fence_binding(
    db: AsyncSession,
    *,
    environment_id: UUID,
) -> V2RuntimeEnvironmentFence:
    """Resolve immutable owner/deployment authority without caller-supplied identity."""

    fence = await db.get(V2RuntimeEnvironmentFence, environment_id)
    if fence is None:
        _raise_protocol_error(
            RuntimeObservationProtocolError(
                status.HTTP_409_CONFLICT,
                "runtime_environment_fence_missing",
                "runtime environment fence does not exist",
            )
        )
    return fence


@router.post("/auth/keys", response_model=ApiKeyCreated)
async def create_runtime_deployment_key(
    body: RuntimeDeploymentKeyCreate,
    idempotency_key: IdempotencyKey,
    auth: PlatformMutationAuth = Depends(require_platform_workload_auth("platform:keys:mint")),
    db: AsyncSession = Depends(get_session),
) -> JSONResponse:
    owner = await _resolve_owner(db, body.owner)
    request_payload = body.model_dump(mode="json", by_alias=True)
    request_hash, replay = await _begin_idempotent_mutation(
        db,
        operation="v2.runtime.keys.mint",
        idempotency_key=idempotency_key,
        request_payload=request_payload,
        owner_user_id=owner.id,
    )
    if replay is not None:
        return _replay_response(replay)
    try:
        await provision_runtime_environment_fence(
            db,
            environment_id=body.environment_id,
            owner_id=owner.id,
            deployment_id=body.deployment_id,
        )
        minted = await mint_api_key(
            db,
            user_id=owner.id,
            label=body.label,
            scopes=body.scopes,
            environment_id=body.environment_id,
            runtime_deployment_id=body.deployment_id,
            managed=True,
            commit=False,
        )
        response = ApiKeyCreated(
            id=str(minted.api_key.id),
            label=minted.api_key.label,
            key_prefix=minted.api_key.key_prefix,
            created_at=minted.api_key.created_at,
            last_used_at=minted.api_key.last_used_at,
            expires_at=minted.api_key.expires_at,
            revoked_at=minted.api_key.revoked_at,
            raw_key=minted.raw_key,
        )
        response_body = _canonical_response_body(response)
        _record_workload_audit(
            db,
            auth=auth,
            action="runtime_environment.provision",
            target_user_id=owner.id,
            environment_id=body.environment_id,
            deployment_id=body.deployment_id,
            outcome="provisioned",
            details={"runtime_principal_id": str(minted.api_key.id)},
        )
        store_platform_response(
            db,
            operation="v2.runtime.keys.mint",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            owner_user_id=owner.id,
            resource_type="runtime_deployment_key",
            resource_id=str(minted.api_key.id),
            response_status=status.HTTP_200_OK,
            response_body=response_body,
        )
        await db.commit()
    except RuntimeObservationProtocolError as exc:
        await db.rollback()
        _raise_protocol_error(exc)
    except Exception:
        await db.rollback()
        raise
    return _CanonicalJSONResponse(status_code=status.HTTP_200_OK, content=response_body)


@router.post(
    "/environments/{environment_id}/observations",
    response_model=RuntimeObservationIngestResponse,
)
async def ingest_runtime_observation_event(
    environment_id: UUID,
    body: RuntimeObservationEventV2,
    auth: AuthContext = Depends(require_runtime_observation_writer),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationIngestResponse:
    api_key = auth.api_key
    if api_key is None or api_key.runtime_deployment_id is None:
        raise RuntimeError("runtime deployment identity was not authenticated")
    actor_user_id = auth.user_id
    runtime_principal_id = api_key.id
    deployment_id = api_key.runtime_deployment_id
    try:
        result = await ingest_runtime_observation(
            db,
            environment_id=environment_id,
            credential_deployment_id=deployment_id,
            value=body,
        )
        if result.outcome in _NON_ADVANCING_OUTCOMES:
            _record_runtime_ingest_audit(
                db,
                actor_user_id=actor_user_id,
                principal_id=runtime_principal_id,
                runtime_principal_id=runtime_principal_id,
                deployment_id=deployment_id,
                environment_id=environment_id,
                value=body,
                outcome=result.outcome,
            )
        await db.commit()
    except RuntimeObservationProtocolError as exc:
        await db.rollback()
        try:
            _record_runtime_ingest_audit(
                db,
                actor_user_id=actor_user_id,
                principal_id=runtime_principal_id,
                runtime_principal_id=runtime_principal_id,
                deployment_id=deployment_id,
                environment_id=environment_id,
                value=body,
                outcome=exc.code,
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        _raise_protocol_error(exc)
    except Exception:
        await db.rollback()
        raise
    return RuntimeObservationIngestResponse(
        eventId=result.event_id,
        streamPosition=result.stream_position,
        outcome=result.outcome,
    )


@router.post(
    "/environments/{environment_id}/retire",
    response_model=RuntimeEnvironmentRetirementReceipt,
)
async def retire_runtime_environment_endpoint(
    environment_id: UUID,
    body: RuntimeEnvironmentRetireRequest,
    idempotency_key: IdempotencyKey,
    auth: PlatformMutationAuth = Depends(
        require_platform_workload_auth("platform:runtime-environments:retire")
    ),
    db: AsyncSession = Depends(get_session),
) -> JSONResponse:
    binding = await _load_fence_binding(db, environment_id=environment_id)
    binding_owner_id = binding.owner_id
    request_payload = {
        "environmentId": str(environment_id),
        **body.model_dump(mode="json", by_alias=True),
    }
    request_hash, replay = await _begin_idempotent_mutation(
        db,
        operation="v2.runtime.environment.retire",
        idempotency_key=idempotency_key,
        request_payload=request_payload,
        owner_user_id=binding_owner_id,
    )
    if replay is not None:
        return _replay_response(replay)
    try:
        result = await retire_runtime_environment(
            db,
            environment_id=environment_id,
            expected_deployment_id=body.expected_deployment_binding,
            retirement_id=body.retirement_id,
            owner_id=binding_owner_id,
        )
        receipt = RuntimeEnvironmentRetirementReceipt.model_validate(result.receipt)
        response_body = _canonical_response_body(receipt)
        if result.transitioned:
            _record_workload_audit(
                db,
                auth=auth,
                action="runtime_environment.retire",
                target_user_id=binding_owner_id,
                environment_id=environment_id,
                deployment_id=body.expected_deployment_binding,
                outcome="transitioned",
                details={
                    "retirement_id": body.retirement_id,
                    "retirement_receipt_id": str(binding.retirement_receipt_id),
                    "previous_state": "active",
                    "new_state": "retired",
                    "retired_at": receipt.retired_at.isoformat(),
                    "final_stream_position": result.final_stream_position,
                    "final_cursor_present": True,
                    "final_session_high_water_marks": result.final_session_high_waters,
                },
            )
        else:
            _record_workload_audit(
                db,
                auth=auth,
                action="runtime_environment.retire_replay",
                target_user_id=binding_owner_id,
                environment_id=environment_id,
                deployment_id=body.expected_deployment_binding,
                outcome="replayed",
                details={
                    "retirement_id": body.retirement_id,
                    "retirement_receipt_id": str(binding.retirement_receipt_id),
                },
            )
        store_platform_response(
            db,
            operation="v2.runtime.environment.retire",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            owner_user_id=binding_owner_id,
            resource_type="runtime_environment_fence",
            resource_id=str(environment_id),
            response_status=status.HTTP_200_OK,
            response_body=response_body,
        )
        await db.commit()
    except RuntimeObservationProtocolError as exc:
        await db.rollback()
        try:
            _record_workload_audit(
                db,
                auth=auth,
                action="runtime_environment.retire",
                target_user_id=binding_owner_id,
                environment_id=environment_id,
                deployment_id=body.expected_deployment_binding,
                outcome=exc.code,
                details={"retirement_id": body.retirement_id},
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        _raise_protocol_error(exc)
    except Exception:
        await db.rollback()
        raise
    return _CanonicalJSONResponse(status_code=status.HTTP_200_OK, content=response_body)


async def _commit_cursor_expiry_or_rollback(
    db: AsyncSession,
    *,
    exc: RuntimeObservationProtocolError,
    auth: PlatformMutationAuth,
    owner_id: UUID,
    environment_id: UUID,
    deployment_id: str,
    operation: str,
) -> NoReturn:
    if exc.code != "observation_cursor_expired":
        await db.rollback()
        _raise_protocol_error(exc)
    try:
        _record_cursor_expiry_audit(
            db,
            auth=auth,
            target_user_id=owner_id,
            environment_id=environment_id,
            deployment_id=deployment_id,
            operation=operation,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    _raise_protocol_error(exc)


@router.post(
    "/environments/{environment_id}/observation-consumers/register",
    response_model=RuntimeObservationConsumerResponse,
)
async def register_runtime_observation_consumer_endpoint(
    environment_id: UUID,
    body: RuntimeObservationConsumerRequest,
    auth: PlatformMutationAuth = Depends(
        require_platform_workload_auth("platform:runtime-observations:consume")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationConsumerResponse:
    binding = await _load_fence_binding(db, environment_id=environment_id)
    client_id, _ = _workload_identity(auth)
    try:
        values = await register_runtime_observation_consumer(
            db,
            environment_id=environment_id,
            owner_id=binding.owner_id,
            deployment_id=binding.deployment_id,
            consumer_id=client_id,
        )
        await db.commit()
    except RuntimeObservationProtocolError as exc:
        await _commit_cursor_expiry_or_rollback(
            db,
            exc=exc,
            auth=auth,
            owner_id=binding.owner_id,
            environment_id=environment_id,
            deployment_id=binding.deployment_id,
            operation="register",
        )
    return RuntimeObservationConsumerResponse.model_validate(values)


@router.post(
    "/environments/{environment_id}/observations/read",
    response_model=RuntimeObservationReadResponse,
)
async def read_runtime_observations_endpoint(
    environment_id: UUID,
    body: RuntimeObservationReadRequest,
    auth: PlatformMutationAuth = Depends(
        require_platform_workload_auth("platform:runtime-observations:consume")
    ),
    db: AsyncSession = Depends(get_runtime_observation_session),
) -> RuntimeObservationReadResponse:
    binding = await _load_fence_binding(db, environment_id=environment_id)
    client_id, _ = _workload_identity(auth)
    expected = body.expected_apply_identity
    try:
        values = await read_runtime_observations(
            db,
            environment_id=environment_id,
            owner_id=binding.owner_id,
            deployment_id=binding.deployment_id,
            consumer_id=client_id,
            expected_apply_identity=RuntimeApplyIdentity(
                generation=expected.generation,
                manifest_etag=expected.manifest_etag,
                apply_receipt_id=expected.apply_receipt_id,
                boot_nonce=expected.boot_nonce,
            ),
            after_cursor=body.after_cursor,
            limit=body.limit,
        )
    except RuntimeObservationProtocolError as exc:
        await _commit_cursor_expiry_or_rollback(
            db,
            exc=exc,
            auth=auth,
            owner_id=binding.owner_id,
            environment_id=environment_id,
            deployment_id=binding.deployment_id,
            operation="read",
        )
    return RuntimeObservationReadResponse.model_validate(values)


@router.post(
    "/environments/{environment_id}/observation-consumers/ack",
    response_model=RuntimeObservationConsumerResponse,
)
async def acknowledge_runtime_observation_consumer_endpoint(
    environment_id: UUID,
    body: RuntimeObservationConsumerAckRequest,
    auth: PlatformMutationAuth = Depends(
        require_platform_workload_auth("platform:runtime-observations:consume")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationConsumerResponse:
    binding = await _load_fence_binding(db, environment_id=environment_id)
    client_id, _ = _workload_identity(auth)
    try:
        values = await acknowledge_runtime_observation_cursor(
            db,
            environment_id=environment_id,
            owner_id=binding.owner_id,
            deployment_id=binding.deployment_id,
            consumer_id=client_id,
            opaque_cursor=body.cursor,
        )
        await db.commit()
    except RuntimeObservationProtocolError as exc:
        await _commit_cursor_expiry_or_rollback(
            db,
            exc=exc,
            auth=auth,
            owner_id=binding.owner_id,
            environment_id=environment_id,
            deployment_id=binding.deployment_id,
            operation="ack",
        )
    return RuntimeObservationConsumerResponse.model_validate(values)


@router.post(
    "/environments/{environment_id}/observation-consumers/reset",
    response_model=RuntimeObservationConsumerResetResponse,
)
async def reset_runtime_observation_consumer_endpoint(
    environment_id: UUID,
    body: RuntimeObservationConsumerRequest,
    auth: PlatformMutationAuth = Depends(
        require_platform_workload_auth("platform:runtime-observations:consume")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationConsumerResetResponse:
    binding = await _load_fence_binding(db, environment_id=environment_id)
    client_id, _ = _workload_identity(auth)
    try:
        values = await reset_runtime_observation_consumer(
            db,
            environment_id=environment_id,
            owner_id=binding.owner_id,
            deployment_id=binding.deployment_id,
            consumer_id=client_id,
        )
        await db.commit()
    except RuntimeObservationProtocolError as exc:
        await db.rollback()
        _raise_protocol_error(exc)
    return RuntimeObservationConsumerResetResponse.model_validate(values)
