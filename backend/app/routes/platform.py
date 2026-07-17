from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, NoReturn
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import invalidate_api_key_auth_cache
from app.core.database import get_runtime_observation_session, get_session
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.models.user import (
    PRINCIPAL_KIND_CLERK,
    PRINCIPAL_KIND_PARTNER_TENANT,
    User,
)
from app.schemas.api_key import ApiKeyCreated, ApiKeyRevokeResponse
from app.schemas.platform import (
    PlatformAgentCreate,
    PlatformApiKeyCreate,
    PlatformMutationBody,
    PlatformOwner,
    PlatformRuntimeEnvironmentRetire,
    PlatformRuntimeObservationConsumerAck,
    PlatformRuntimeObservationConsumerRegister,
    PlatformRuntimeObservationConsumerReset,
    PlatformRuntimeObservationRead,
    PlatformRuntimeStateResponse,
    PlatformRuntimeStateUpsert,
)
from app.schemas.platform_oauth import PlatformOAuthErrorResponse, PlatformOAuthTokenResponse
from app.schemas.runtime_observation import (
    RuntimeEnvironmentRetirementReceipt,
    RuntimeObservationConsumerResetResponse,
    RuntimeObservationConsumerResponse,
    RuntimeObservationReadResponse,
)
from app.schemas.session import EnvironmentCreatedResponse
from app.services.agent_environments import (
    AgentEnvironmentIdConflict,
    register_agent_environment,
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
    PlatformOAuthProtocolError,
    PlatformWorkloadKeyResolver,
    get_platform_workload_key_resolver,
    issue_platform_workload_token,
    require_platform_mutation_auth,
)
from app.services.runtime_observation import (
    RuntimeApplyIdentity,
    RuntimeObservationProtocolError,
    acknowledge_runtime_observation_cursor,
    provision_runtime_environment_fence,
    read_runtime_observations,
    register_runtime_observation_consumer,
    reset_runtime_observation_consumer,
    retire_runtime_environment,
)
from app.services.sync_events import (
    queue_environment_runtime_manifest_changed,
    queue_runtime_manifest_changed,
)

router = APIRouter(prefix="/platform", tags=["platform"])

IdempotencyKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=1, max_length=200),
]

_OAUTH_NO_STORE_HEADERS = {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
}
_OAUTH_TOKEN_REQUEST_SCHEMA = {
    "requestBody": {
        "required": True,
        "content": {
            "application/x-www-form-urlencoded": {
                "schema": {
                    "type": "object",
                    "required": [
                        "grant_type",
                        "client_id",
                        "scope",
                        "client_assertion_type",
                        "client_assertion",
                    ],
                    "properties": {
                        "grant_type": {"type": "string"},
                        "client_id": {"type": "string"},
                        "scope": {"type": "string"},
                        "client_assertion_type": {"type": "string"},
                        "client_assertion": {"type": "string"},
                    },
                }
            }
        },
    }
}


def _oauth_error_response(exc: PlatformOAuthProtocolError) -> JSONResponse:
    headers = dict(_OAUTH_NO_STORE_HEADERS)
    body = PlatformOAuthErrorResponse(
        error=exc.error,
        error_description=exc.description,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content=body.model_dump(),
        headers=headers,
    )


def _raise_runtime_observation_error(exc: RuntimeObservationProtocolError) -> NoReturn:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc


def _oauth_form_value(form: Any, name: str) -> str:
    values = form.getlist(name)
    if len(values) != 1 or not isinstance(values[0], str) or not values[0]:
        raise PlatformOAuthProtocolError(
            error="invalid_request",
            description=f"{name} must be provided exactly once",
        )
    return values[0]


@router.post(
    "/oauth/token",
    response_model=PlatformOAuthTokenResponse,
    responses={
        400: {"model": PlatformOAuthErrorResponse},
        401: {"model": PlatformOAuthErrorResponse},
        503: {"model": PlatformOAuthErrorResponse},
    },
    openapi_extra=_OAUTH_TOKEN_REQUEST_SCHEMA,
)
async def platform_workload_oauth_token(
    request: Request,
    db: AsyncSession = Depends(get_session),
    resolver: PlatformWorkloadKeyResolver = Depends(get_platform_workload_key_resolver),
) -> PlatformOAuthTokenResponse | Response:
    if request.headers.getlist("authorization") or request.headers.getlist("x-admin-key"):
        return _oauth_error_response(
            PlatformOAuthProtocolError(
                error="invalid_request",
                description="client authentication must use client_assertion form fields only",
            )
        )
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != (
        "application/x-www-form-urlencoded"
    ):
        return _oauth_error_response(
            PlatformOAuthProtocolError(
                error="invalid_request",
                description="content type must be application/x-www-form-urlencoded",
            )
        )
    try:
        form = await request.form()
        issued = await issue_platform_workload_token(
            db,
            resolver,
            grant_type=_oauth_form_value(form, "grant_type"),
            client_id=_oauth_form_value(form, "client_id"),
            scope=_oauth_form_value(form, "scope"),
            client_assertion_type=_oauth_form_value(form, "client_assertion_type"),
            client_assertion=_oauth_form_value(form, "client_assertion"),
        )
    except PlatformOAuthProtocolError as exc:
        return _oauth_error_response(exc)
    response = PlatformOAuthTokenResponse(
        access_token=issued.access_token,
        expires_in=issued.expires_in,
        scope=issued.scope,
    )
    return JSONResponse(content=response.model_dump(), headers=_OAUTH_NO_STORE_HEADERS)


def _audit_details(
    *,
    owner: PlatformOwner,
    resource_type: str,
    resource_id: str | None,
    action: str,
    result: str,
    request_id: str,
    idempotency_key: str,
    workload_sub: str | None,
    credential_id: str | None,
    token_jti: str | None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "workload_sub": workload_sub,
        "credential_id": credential_id,
        "token_jti": token_jti,
        "owner": owner.model_dump(mode="json"),
        "resource": {"type": resource_type, "id": resource_id},
        "action": action,
        "result": result,
        "request_id": request_id,
        "idempotency_key": idempotency_key,
        **(details or {}),
    }


def _record_platform_audit(
    db: AsyncSession,
    *,
    owner: PlatformOwner,
    owner_user_id: UUID | None,
    resource_type: str,
    resource_id: str | None,
    action: str,
    result: str,
    request: Request,
    idempotency_key: str,
    environment_id: UUID | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    auth = getattr(request.state, "platform_mutation_auth", None)
    record_control_plane_audit(
        db,
        actor_type="platform",
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        environment_id=environment_id,
        target_user_id=owner_user_id,
        source="api.platform",
        details=_audit_details(
            owner=owner,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            result=result,
            request_id=str(request.state.request_id),
            idempotency_key=idempotency_key,
            workload_sub=auth.client_id if auth is not None else None,
            credential_id=(
                str(auth.credential_id)
                if auth is not None and auth.credential_id is not None
                else None
            ),
            token_jti=auth.token_jti if auth is not None else None,
            details=details,
        ),
    )


async def _reject(
    db: AsyncSession,
    *,
    status_code: int,
    detail: str | dict[str, Any],
    result: str,
    owner: PlatformOwner,
    owner_user_id: UUID | None,
    resource_type: str,
    resource_id: str | None,
    action: str,
    request: Request,
    idempotency_key: str,
    environment_id: UUID | None = None,
) -> None:
    _record_platform_audit(
        db,
        owner=owner,
        owner_user_id=owner_user_id,
        resource_type=resource_type,
        resource_id=resource_id,
        action=action,
        result=result,
        request=request,
        idempotency_key=idempotency_key,
        environment_id=environment_id,
    )
    await db.commit()
    raise HTTPException(status_code, detail)


async def _resolve_owner(
    db: AsyncSession,
    *,
    owner: PlatformOwner,
    resource_type: str,
    resource_id: str | None,
    action: str,
    request: Request,
    idempotency_key: str,
) -> User:
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
    user = (await db.execute(select(User).where(*filters))).scalar_one_or_none()
    if user is None:
        await _reject(
            db,
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Owner not found",
            result="owner_not_found",
            owner=owner,
            owner_user_id=None,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            request=request,
            idempotency_key=idempotency_key,
        )
        raise AssertionError("unreachable")
    return user


async def _resolve_owner_read(db: AsyncSession, owner: PlatformOwner) -> User:
    """Resolve a read principal without creating mutation/audit side effects."""

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
    user = (await db.execute(select(User).where(*filters))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Owner not found")
    return user


async def _begin_mutation(
    db: AsyncSession,
    *,
    operation: str,
    idempotency_key: str,
    request_payload: dict[str, Any],
    owner: PlatformOwner,
    owner_user_id: UUID,
    resource_type: str,
    resource_id: str | None,
    action: str,
    request: Request,
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
        await _reject(
            db,
            status_code=status.HTTP_409_CONFLICT,
            detail="Idempotency-Key was already used with a different request",
            result="idempotency_conflict",
            owner=owner,
            owner_user_id=owner_user_id,
            resource_type=resource_type,
            resource_id=resource_id,
            action=action,
            request=request,
            idempotency_key=idempotency_key,
        )
        raise AssertionError("unreachable")
    return request_hash, read_platform_replay(existing)


def _replay_response(replay: PlatformReplay) -> Response:
    if replay.status_code == status.HTTP_204_NO_CONTENT:
        return Response(status_code=replay.status_code)
    return JSONResponse(status_code=replay.status_code, content=replay.body)


async def _complete_mutation(
    db: AsyncSession,
    *,
    operation: str,
    idempotency_key: str,
    request_hash: str,
    owner: PlatformOwner,
    owner_user_id: UUID,
    resource_type: str,
    resource_id: str | None,
    action: str,
    request: Request,
    response_status: int,
    response_body: BaseModel | dict[str, Any] | None,
    environment_id: UUID | None = None,
    audit_details: dict[str, Any] | None = None,
) -> None:
    if isinstance(response_body, BaseModel):
        stored_body = response_body.model_dump(mode="json")
    else:
        stored_body = response_body or {}
    _record_platform_audit(
        db,
        owner=owner,
        owner_user_id=owner_user_id,
        resource_type=resource_type,
        resource_id=resource_id,
        action=action,
        result="success",
        request=request,
        idempotency_key=idempotency_key,
        environment_id=environment_id,
        details=audit_details,
    )
    store_platform_response(
        db,
        operation=operation,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner_user_id=owner_user_id,
        resource_type=resource_type,
        resource_id=resource_id,
        response_status=response_status,
        response_body=stored_body,
    )
    await db.commit()


async def _load_owned_agent(
    db: AsyncSession,
    *,
    agent_id: UUID,
    owner: PlatformOwner,
    owner_user_id: UUID,
    action: str,
    request: Request,
    idempotency_key: str,
) -> AgentEnvironment:
    agent = (
        await db.execute(
            select(AgentEnvironment)
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == owner_user_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if agent is not None:
        return agent
    exists = await db.scalar(select(AgentEnvironment.id).where(AgentEnvironment.id == agent_id))
    await _reject(
        db,
        status_code=status.HTTP_403_FORBIDDEN if exists is not None else status.HTTP_404_NOT_FOUND,
        detail="Agent is not owned by requested owner" if exists is not None else "Agent not found",
        result="owner_mismatch" if exists is not None else "resource_not_found",
        owner=owner,
        owner_user_id=owner_user_id,
        resource_type="agent_environment",
        resource_id=str(agent_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
        environment_id=agent_id if exists is not None else None,
    )
    raise AssertionError("unreachable")


async def _load_owned_key(
    db: AsyncSession,
    *,
    key_id: UUID,
    owner: PlatformOwner,
    owner_user_id: UUID,
    action: str,
    request: Request,
    idempotency_key: str,
) -> ApiKey:
    api_key = (
        await db.execute(
            select(ApiKey)
            .where(ApiKey.id == key_id, ApiKey.user_id == owner_user_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if api_key is not None:
        return api_key
    exists = await db.scalar(select(ApiKey.id).where(ApiKey.id == key_id))
    await _reject(
        db,
        status_code=status.HTTP_403_FORBIDDEN if exists is not None else status.HTTP_404_NOT_FOUND,
        detail="API key is not owned by requested owner"
        if exists is not None
        else "API key not found",
        result="owner_mismatch" if exists is not None else "resource_not_found",
        owner=owner,
        owner_user_id=owner_user_id,
        resource_type="api_key",
        resource_id=str(key_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    raise AssertionError("unreachable")


async def _next_agent_sort_order(db: AsyncSession, user_id: UUID) -> int:
    value = await db.scalar(
        select(func.coalesce(func.max(AgentEnvironment.sort_order), -1) + 1).where(
            AgentEnvironment.user_id == user_id
        )
    )
    return int(value or 0)


@router.post("/agents", response_model=EnvironmentCreatedResponse)
async def platform_create_agent(
    body: PlatformAgentCreate,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(require_platform_mutation_auth("platform:agents:create")),
    db: AsyncSession = Depends(get_session),
) -> EnvironmentCreatedResponse | Response:
    action = "agent_environment.create"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="agent_environment",
        resource_id=str(body.agent_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="agents.create",
        idempotency_key=idempotency_key,
        request_payload=body.model_dump(mode="json"),
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="agent_environment",
        resource_id=str(body.agent_id),
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    try:
        registered = await register_agent_environment(
            db,
            user_id=owner.id,
            machine_id=body.machine_id,
            machine_name=body.machine_name,
            agent_type=body.agent_type,
            agent_version=body.agent_version,
            os_name=body.os_name,
            sort_order=await _next_agent_sort_order(db, owner.id),
            environment_id=body.agent_id,
            registration_key=None,
            commit=False,
        )
    except AgentEnvironmentIdConflict:
        exists = await db.scalar(
            select(AgentEnvironment.id).where(AgentEnvironment.id == body.agent_id)
        )
        await _reject(
            db,
            status_code=status.HTTP_403_FORBIDDEN
            if exists is not None
            else status.HTTP_409_CONFLICT,
            detail=(
                "Agent is not owned by requested owner"
                if exists is not None
                else "Agent could not be registered"
            ),
            result="owner_mismatch" if exists is not None else "resource_conflict",
            owner=body.owner,
            owner_user_id=owner.id,
            resource_type="agent_environment",
            resource_id=str(body.agent_id),
            action=action,
            request=request,
            idempotency_key=idempotency_key,
            environment_id=body.agent_id if exists is not None else None,
        )
        raise AssertionError("unreachable")
    response = EnvironmentCreatedResponse(id=str(registered.env.id))
    await _complete_mutation(
        db,
        operation="agents.create",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="agent_environment",
        resource_id=str(registered.env.id),
        action=action,
        request=request,
        response_status=status.HTTP_200_OK,
        response_body=response,
        environment_id=registered.env.id,
        audit_details={"created": registered.created},
    )
    return response


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def platform_delete_agent(
    agent_id: UUID,
    body: PlatformMutationBody,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(require_platform_mutation_auth("platform:agents:delete")),
    db: AsyncSession = Depends(get_session),
) -> Response:
    action = "agent_environment.delete"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="agent_environment",
        resource_id=str(agent_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="agents.delete",
        idempotency_key=idempotency_key,
        request_payload={"agent_id": str(agent_id), **body.model_dump(mode="json")},
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="agent_environment",
        resource_id=str(agent_id),
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    agent = await _load_owned_agent(
        db,
        agent_id=agent_id,
        owner=body.owner,
        owner_user_id=owner.id,
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    audit_details = {
        "agent_type": agent.agent_type,
        "machine_id": agent.machine_id,
        "explicit_identity": agent.registration_key is None,
    }
    await queue_environment_runtime_manifest_changed(db, owner.id, agent_id)
    await db.delete(agent)
    await _complete_mutation(
        db,
        operation="agents.delete",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="agent_environment",
        resource_id=str(agent_id),
        action=action,
        request=request,
        response_status=status.HTTP_204_NO_CONTENT,
        response_body=None,
        environment_id=agent_id,
        audit_details=audit_details,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put(
    "/agents/{agent_id}/runtime-state",
    response_model=PlatformRuntimeStateResponse,
)
async def platform_upsert_runtime_state(
    agent_id: UUID,
    body: PlatformRuntimeStateUpsert,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-state:write")
    ),
    db: AsyncSession = Depends(get_session),
) -> PlatformRuntimeStateResponse | Response:
    action = "hosted_runtime_state.upsert"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="runtime_state.upsert",
        idempotency_key=idempotency_key,
        request_payload={"agent_id": str(agent_id), **body.model_dump(mode="json")},
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    agent = await _load_owned_agent(
        db,
        agent_id=agent_id,
        owner=body.owner,
        owner_user_id=owner.id,
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    runtime_state = (
        await db.execute(
            select(HostedRuntimeState)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == HostedRuntimeState.environment_id,
            )
            .where(
                HostedRuntimeState.environment_id == agent_id,
                AgentEnvironment.user_id == owner.id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    previous_generation = runtime_state.generation if runtime_state is not None else None
    changed_fields = _runtime_state_changed_fields(runtime_state, body)
    if runtime_state is not None and body.generation <= runtime_state.generation:
        current_generation = runtime_state.generation
        if body.generation < current_generation:
            await _reject(
                db,
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "stale_generation",
                    "current_generation": current_generation,
                },
                result="stale_generation",
                owner=body.owner,
                owner_user_id=owner.id,
                resource_type="hosted_runtime_state",
                resource_id=str(agent_id),
                action=action,
                request=request,
                idempotency_key=idempotency_key,
                environment_id=agent_id,
            )
            raise AssertionError("unreachable")
        material_changes = [field for field in changed_fields if field != "generation"]
        if material_changes:
            await _reject(
                db,
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "generation_conflict",
                    "current_generation": current_generation,
                },
                result="generation_conflict",
                owner=body.owner,
                owner_user_id=owner.id,
                resource_type="hosted_runtime_state",
                resource_id=str(agent_id),
                action=action,
                request=request,
                idempotency_key=idempotency_key,
                environment_id=agent_id,
            )
            raise AssertionError("unreachable")
    if runtime_state is None:
        runtime_state = HostedRuntimeState(environment_id=agent_id)
        db.add(runtime_state)
    _assign_runtime_state(runtime_state, body)
    if changed_fields:
        queue_runtime_manifest_changed(db, agent.user_id, agent_id)
    response = PlatformRuntimeStateResponse(
        environment_id=agent_id,
        deployment_id=body.deployment_id,
        instance_id=body.instance_id,
        generation=body.generation,
    )
    await _complete_mutation(
        db,
        operation="runtime_state.upsert",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        action=action,
        request=request,
        response_status=status.HTTP_200_OK,
        response_body=response,
        environment_id=agent_id,
        audit_details={
            "deployment_id": body.deployment_id,
            "generation": body.generation,
            "previous_generation": previous_generation,
            "changed_fields": changed_fields,
        },
    )
    return response


@router.delete(
    "/agents/{agent_id}/runtime-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def platform_delete_runtime_state(
    agent_id: UUID,
    body: PlatformMutationBody,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-state:write")
    ),
    db: AsyncSession = Depends(get_session),
) -> Response:
    action = "hosted_runtime_state.delete"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="runtime_state.delete",
        idempotency_key=idempotency_key,
        request_payload={"agent_id": str(agent_id), **body.model_dump(mode="json")},
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    agent = await _load_owned_agent(
        db,
        agent_id=agent_id,
        owner=body.owner,
        owner_user_id=owner.id,
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    runtime_state = (
        await db.execute(
            select(HostedRuntimeState)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == HostedRuntimeState.environment_id,
            )
            .where(
                HostedRuntimeState.environment_id == agent_id,
                AgentEnvironment.user_id == owner.id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    existed = runtime_state is not None
    if runtime_state is not None:
        await db.delete(runtime_state)
        queue_runtime_manifest_changed(db, agent.user_id, agent_id)
    await _complete_mutation(
        db,
        operation="runtime_state.delete",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="hosted_runtime_state",
        resource_id=str(agent_id),
        action=action,
        request=request,
        response_status=status.HTTP_204_NO_CONTENT,
        response_body=None,
        environment_id=agent_id,
        audit_details={"existed": existed},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/agents/{agent_id}/runtime-environment/retire",
    response_model=RuntimeEnvironmentRetirementReceipt,
)
async def platform_retire_runtime_environment(
    agent_id: UUID,
    body: PlatformRuntimeEnvironmentRetire,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-state:write")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeEnvironmentRetirementReceipt | Response:
    action = "runtime_environment.retire"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="runtime_environment_fence",
        resource_id=str(agent_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="runtime_environment.retire",
        idempotency_key=idempotency_key,
        request_payload={"agent_id": str(agent_id), **body.model_dump(mode="json")},
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="runtime_environment_fence",
        resource_id=str(agent_id),
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    try:
        receipt_values = await retire_runtime_environment(
            db,
            environment_id=agent_id,
            expected_deployment_id=body.expected_deployment_id,
            retirement_id=body.retirement_id,
            owner_id=owner.id,
        )
    except RuntimeObservationProtocolError as exc:
        await _reject(
            db,
            status_code=exc.status_code,
            detail=exc.detail(),
            result=exc.code,
            owner=body.owner,
            owner_user_id=owner.id,
            resource_type="runtime_environment_fence",
            resource_id=str(agent_id),
            action=action,
            request=request,
            idempotency_key=idempotency_key,
            environment_id=agent_id,
        )
        raise AssertionError("unreachable")
    receipt = RuntimeEnvironmentRetirementReceipt.model_validate(receipt_values)
    await _complete_mutation(
        db,
        operation="runtime_environment.retire",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="runtime_environment_fence",
        resource_id=str(agent_id),
        action=action,
        request=request,
        response_status=status.HTTP_200_OK,
        response_body=receipt,
        environment_id=agent_id,
        audit_details={
            "deployment_id": body.expected_deployment_id,
            "retirement_id": body.retirement_id,
            "retirement_receipt_id": receipt.retirement_receipt_id,
        },
    )
    return receipt


@router.post(
    "/agents/{agent_id}/runtime-observation-consumers/register",
    response_model=RuntimeObservationConsumerResponse,
)
async def platform_register_runtime_observation_consumer(
    agent_id: UUID,
    body: PlatformRuntimeObservationConsumerRegister,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-observations:read")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationConsumerResponse:
    owner = await _resolve_owner_read(db, body.owner)
    try:
        values = await register_runtime_observation_consumer(
            db,
            environment_id=agent_id,
            owner_id=owner.id,
            deployment_id=body.deployment_id,
            consumer_id=body.consumer_id,
        )
    except RuntimeObservationProtocolError as exc:
        await db.rollback()
        _raise_runtime_observation_error(exc)
    await db.commit()
    return RuntimeObservationConsumerResponse.model_validate(values)


@router.post(
    "/agents/{agent_id}/runtime-observations/read",
    response_model=RuntimeObservationReadResponse,
)
async def platform_read_runtime_observations(
    agent_id: UUID,
    body: PlatformRuntimeObservationRead,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-observations:read")
    ),
    db: AsyncSession = Depends(get_runtime_observation_session),
) -> RuntimeObservationReadResponse:
    """Read credential-authenticated guest reports for the Hosted controller.

    The readiness authority is the authenticated guest report from the
    per-deployment runtime credential. It is not attestation-bound instance identity.
    """

    owner = await _resolve_owner_read(db, body.owner)
    identity = body.expected_apply_identity
    try:
        values = await read_runtime_observations(
            db,
            environment_id=agent_id,
            owner_id=owner.id,
            deployment_id=body.deployment_id,
            consumer_id=body.consumer_id,
            expected_apply_identity=RuntimeApplyIdentity(
                generation=identity.generation,
                manifest_etag=identity.manifest_etag,
                apply_receipt_id=identity.apply_receipt_id,
                boot_nonce=identity.boot_nonce,
            ),
            after_cursor=body.after_cursor,
            limit=body.limit,
        )
    except RuntimeObservationProtocolError as exc:
        if exc.code == "observation_cursor_expired":
            # A known invalid cursor installs its explicit reset boundary in
            # this same repeatable-read transaction before the 410 is visible.
            await db.commit()
        else:
            await db.rollback()
        _raise_runtime_observation_error(exc)
    return RuntimeObservationReadResponse.model_validate(values)


@router.post(
    "/agents/{agent_id}/runtime-observation-consumers/ack",
    response_model=RuntimeObservationConsumerResponse,
)
async def platform_ack_runtime_observation_consumer(
    agent_id: UUID,
    body: PlatformRuntimeObservationConsumerAck,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-observations:read")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationConsumerResponse:
    owner = await _resolve_owner_read(db, body.owner)
    try:
        values = await acknowledge_runtime_observation_cursor(
            db,
            environment_id=agent_id,
            owner_id=owner.id,
            deployment_id=body.deployment_id,
            consumer_id=body.consumer_id,
            opaque_cursor=body.cursor,
        )
    except RuntimeObservationProtocolError as exc:
        if exc.code == "observation_cursor_expired":
            await db.commit()
        else:
            await db.rollback()
        _raise_runtime_observation_error(exc)
    await db.commit()
    return RuntimeObservationConsumerResponse.model_validate(values)


@router.post(
    "/agents/{agent_id}/runtime-observation-consumers/reset",
    response_model=RuntimeObservationConsumerResetResponse,
)
async def platform_reset_runtime_observation_consumer(
    agent_id: UUID,
    body: PlatformRuntimeObservationConsumerReset,
    _auth: PlatformMutationAuth = Depends(
        require_platform_mutation_auth("platform:runtime-observations:read")
    ),
    db: AsyncSession = Depends(get_session),
) -> RuntimeObservationConsumerResetResponse:
    owner = await _resolve_owner_read(db, body.owner)
    try:
        values = await reset_runtime_observation_consumer(
            db,
            environment_id=agent_id,
            owner_id=owner.id,
            deployment_id=body.deployment_id,
            consumer_id=body.consumer_id,
        )
    except RuntimeObservationProtocolError as exc:
        await db.rollback()
        _raise_runtime_observation_error(exc)
    await db.commit()
    return RuntimeObservationConsumerResetResponse.model_validate(values)


@router.post("/auth/keys", response_model=ApiKeyCreated)
async def platform_mint_api_key(
    body: PlatformApiKeyCreate,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(require_platform_mutation_auth("platform:keys:mint")),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyCreated | Response:
    action = "api_key.mint"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="api_key",
        resource_id=None,
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="keys.mint",
        idempotency_key=idempotency_key,
        request_payload=body.model_dump(mode="json"),
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="api_key",
        resource_id=None,
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    await _load_owned_agent(
        db,
        agent_id=body.environment_id,
        owner=body.owner,
        owner_user_id=owner.id,
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    try:
        await provision_runtime_environment_fence(
            db,
            environment_id=body.environment_id,
            owner_id=owner.id,
            deployment_id=body.deployment_id,
        )
    except RuntimeObservationProtocolError as exc:
        await _reject(
            db,
            status_code=exc.status_code,
            detail=exc.detail(),
            result=exc.code,
            owner=body.owner,
            owner_user_id=owner.id,
            resource_type="runtime_environment_fence",
            resource_id=str(body.environment_id),
            action=action,
            request=request,
            idempotency_key=idempotency_key,
            environment_id=body.environment_id,
        )
        raise AssertionError("unreachable")
    minted = await mint_api_key(
        db,
        user_id=owner.id,
        label=body.label,
        scopes=body.scopes,
        environment_id=body.environment_id,
        managed=True,
        commit=False,
    )
    api_key = minted.api_key
    response = ApiKeyCreated(
        id=str(api_key.id),
        label=api_key.label,
        key_prefix=api_key.key_prefix,
        created_at=api_key.created_at,
        last_used_at=api_key.last_used_at,
        expires_at=api_key.expires_at,
        revoked_at=api_key.revoked_at,
        raw_key=minted.raw_key,
    )
    await _complete_mutation(
        db,
        operation="keys.mint",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="api_key",
        resource_id=str(api_key.id),
        action=action,
        request=request,
        response_status=status.HTTP_200_OK,
        response_body=response,
        environment_id=body.environment_id,
        audit_details={
            "label": api_key.label,
            "key_prefix": api_key.key_prefix,
            "managed": api_key.managed,
            "scopes": api_key.scopes,
        },
    )
    return response


@router.delete("/auth/keys/{key_id}", response_model=ApiKeyRevokeResponse)
async def platform_revoke_api_key(
    key_id: UUID,
    body: PlatformMutationBody,
    request: Request,
    idempotency_key: IdempotencyKey,
    _auth: PlatformMutationAuth = Depends(require_platform_mutation_auth("platform:keys:revoke")),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyRevokeResponse | Response:
    action = "api_key.revoke"
    owner = await _resolve_owner(
        db,
        owner=body.owner,
        resource_type="api_key",
        resource_id=str(key_id),
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    request_hash, replay = await _begin_mutation(
        db,
        operation="keys.revoke",
        idempotency_key=idempotency_key,
        request_payload={"key_id": str(key_id), **body.model_dump(mode="json")},
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="api_key",
        resource_id=str(key_id),
        action=action,
        request=request,
    )
    if replay is not None:
        return _replay_response(replay)
    api_key = await _load_owned_key(
        db,
        key_id=key_id,
        owner=body.owner,
        owner_user_id=owner.id,
        action=action,
        request=request,
        idempotency_key=idempotency_key,
    )
    already_revoked = api_key.revoked_at is not None
    if not already_revoked:
        api_key.revoked_at = datetime.now(UTC)
    response = ApiKeyRevokeResponse(status="revoked")
    await _complete_mutation(
        db,
        operation="keys.revoke",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        owner=body.owner,
        owner_user_id=owner.id,
        resource_type="api_key",
        resource_id=str(key_id),
        action=action,
        request=request,
        response_status=status.HTTP_200_OK,
        response_body=response,
        environment_id=api_key.environment_id,
        audit_details={"already_revoked": already_revoked},
    )
    if not already_revoked:
        invalidate_api_key_auth_cache(api_key.id)
    return response


def _assign_runtime_state(
    state: HostedRuntimeState,
    body: PlatformRuntimeStateUpsert,
) -> None:
    state.deployment_id = body.deployment_id
    state.instance_id = body.instance_id
    state.generation = body.generation
    state.cli_package_spec = body.cli_package_spec
    state.locale = body.locale.model_dump()
    state.system = body.system.model_dump(exclude_none=True, mode="json")
    state.egress_engine = _optional_runtime_model(body.egress_engine)
    state.runtimes = {
        name: runtime.model_dump(exclude_none=True, mode="json")
        for name, runtime in body.runtimes.items()
    }
    state.bridge = _optional_runtime_model(body.bridge)
    state.live_sync = body.live_sync.model_dump(mode="json")
    state.recovery = body.recovery.model_dump(mode="json")
    state.egress_profiles = _optional_runtime_model(body.egress_profiles)
    state.mcp = body.mcp
    state.tools = body.tools.model_dump(exclude_none=True, exclude_unset=True, mode="json")


def _optional_runtime_model(value: BaseModel | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return value.model_dump(exclude_none=True, exclude_unset=True, mode="json")


def _runtime_state_changed_fields(
    state: HostedRuntimeState | None,
    body: PlatformRuntimeStateUpsert,
) -> list[str]:
    fields = [
        "deployment_id",
        "instance_id",
        "generation",
        "cli_package_spec",
        "locale",
        "system",
        "egress_engine",
        "runtimes",
        "bridge",
        "live_sync",
        "recovery",
        "egress_profiles",
        "mcp",
        "tools",
    ]
    if state is None:
        return fields
    changed: list[str] = []
    for field in fields:
        if field == "locale":
            body_value = body.locale.model_dump()
        elif field == "system":
            body_value = body.system.model_dump(exclude_none=True, mode="json")
        elif field == "runtimes":
            body_value = {
                name: runtime.model_dump(exclude_none=True, mode="json")
                for name, runtime in body.runtimes.items()
            }
        elif field in {"bridge", "egress_engine", "egress_profiles"}:
            body_value = _optional_runtime_model(getattr(body, field))
        elif field in {"live_sync", "recovery"}:
            body_value = getattr(body, field).model_dump(mode="json")
        elif field == "tools":
            body_value = body.tools.model_dump(exclude_none=True, exclude_unset=True, mode="json")
        else:
            body_value = getattr(body, field)
        if getattr(state, field) != body_value:
            changed.append(field)
    return changed
