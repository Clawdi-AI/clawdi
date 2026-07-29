"""Explicit mixed-version gate for Agent-authoritative Skill sync."""

from __future__ import annotations

import re

from fastapi import HTTPException, status

SKILL_SYNC_PROTOCOL_HEADER = "X-Clawdi-Skill-Sync-Protocol"
SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1 = "agent-authoritative-v1"
_PROTOCOL_VALUE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


def require_agent_authoritative_skill_sync(protocol: str | None) -> None:
    """Fail closed unless the caller explicitly speaks the one-way protocol."""
    if protocol is not None and not _PROTOCOL_VALUE.fullmatch(protocol):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_skill_sync_protocol",
                "message": "The Agent Skill sync protocol header is malformed.",
            },
        )
    if protocol != SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1:
        raise HTTPException(
            status.HTTP_426_UPGRADE_REQUIRED,
            detail={
                "code": "agent_skill_sync_upgrade_required",
                "message": (
                    "Upgrade Clawdi before syncing Agent Project Skills; older clients "
                    "are paused to protect the Agent filesystem."
                ),
            },
            headers={"Upgrade": SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1},
        )
