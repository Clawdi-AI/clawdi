"""Mixed-version compatibility for Agent Skill sync clients."""

from __future__ import annotations

import re
from enum import StrEnum

from fastapi import HTTPException, status

SKILL_SYNC_PROTOCOL_HEADER = "X-Clawdi-Skill-Sync-Protocol"
SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0 = "agent-authoritative-v0"
SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1 = "agent-authoritative-v1"
_PROTOCOL_VALUE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


class SkillSyncProtocol(StrEnum):
    LEGACY = "legacy"
    AGENT_AUTHORITATIVE_V1 = SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1


def resolve_skill_sync_protocol(protocol: str | None) -> SkillSyncProtocol:
    """Validate the wire value and resolve its compatibility behavior."""
    if protocol is None or protocol == SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V0:
        return SkillSyncProtocol.LEGACY
    if protocol == SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1:
        return SkillSyncProtocol.AGENT_AUTHORITATIVE_V1
    if protocol is not None and not _PROTOCOL_VALUE.fullmatch(protocol):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_skill_sync_protocol",
                "message": "The Agent Skill sync protocol header is malformed.",
            },
        )
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={
            "code": "unsupported_skill_sync_protocol",
            "message": "The Agent Skill sync protocol is not supported.",
        },
    )
