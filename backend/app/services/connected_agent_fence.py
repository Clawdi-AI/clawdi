from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, is_connected_agent_principal
from app.models.session import AgentEnvironment

MACHINE_ID_HEADER = "X-Clawdi-Machine-Id"
MACHINE_ID_MAX_LENGTH = 200


@dataclass(frozen=True, slots=True)
class ConnectedAgentFenceHeaders:
    machine_id: str | None


def connected_agent_fence_headers(
    clawdi_machine_id: str | None = Header(
        default=None,
        alias=MACHINE_ID_HEADER,
    ),
) -> ConnectedAgentFenceHeaders:
    machine_id = clawdi_machine_id.strip() if clawdi_machine_id is not None else None
    if machine_id is not None and len(machine_id) > MACHINE_ID_MAX_LENGTH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Machine identity header is too long")
    return ConnectedAgentFenceHeaders(machine_id=machine_id or None)


def machine_header_enables_fence(
    expected_machine_id: str,
    headers: ConnectedAgentFenceHeaders,
) -> bool:
    if headers.machine_id is None:
        return False
    if expected_machine_id != headers.machine_id:
        raise _agent_rebound("Machine identity header does not match the registration request")
    return True


async def require_connected_agent_fence(
    db: AsyncSession,
    *,
    auth: AuthContext,
    agent_ids: set[UUID],
    headers: ConnectedAgentFenceHeaders,
    lock: bool = False,
) -> None:
    """Reject stale Connected installations after setup/rebind enables fencing."""

    if not is_connected_agent_principal(auth) or not agent_ids:
        return
    statement = (
        select(AgentEnvironment)
        .where(
            AgentEnvironment.id.in_(agent_ids),
            AgentEnvironment.user_id == auth.user_id,
            AgentEnvironment.archived_at.is_(None),
            AgentEnvironment.connected_agent_registered_at.is_not(None),
        )
        .execution_options(populate_existing=True)
    )
    if lock:
        statement = statement.order_by(AgentEnvironment.id).with_for_update()
    connected = list((await db.execute(statement)).scalars())
    if not connected:
        return
    machine_id = headers.machine_id
    for agent in connected:
        if machine_id is not None and agent.machine_id != machine_id:
            raise _agent_rebound("This Agent is bound to another installation")
        if agent.machine_fence_required and machine_id is None:
            raise _agent_rebound("This Agent requires its active machine identity header")


def _agent_rebound(message: str) -> HTTPException:
    return HTTPException(
        status.HTTP_403_FORBIDDEN,
        detail={
            "code": "agent_rebound",
            "message": message,
            "recovery": "Run `clawdi agent reconnect` to reclaim this Agent on this machine.",
        },
    )
