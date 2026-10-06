"""Canonical agent types accepted by registration APIs."""

from typing import Annotated

from pydantic import AfterValidator, Field

AGENT_TYPE_LABELS = {
    "claude_code": "Claude Code",
    "codex": "Codex",
    "openclaw": "OpenClaw",
    "hermes": "Hermes",
    "pi": "Pi",
    "opencode": "OpenCode",
    "dsh": "DeepSeek Harness",
}


def _validate_agent_type(value: str) -> str:
    if value not in AGENT_TYPE_LABELS:
        raise ValueError("unsupported agent type")
    return value


SupportedAgentType = Annotated[
    str,
    AfterValidator(_validate_agent_type),
    Field(json_schema_extra={"enum": list(AGENT_TYPE_LABELS)}),
]
