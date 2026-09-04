import pytest
from fastapi import HTTPException

from app.services.connected_agent_fence import (
    ConnectedAgentFenceHeaders,
    connected_agent_fence_headers,
    machine_header_enables_fence,
)


def test_machine_fence_header_rejects_invalid_values_without_type_errors() -> None:
    with pytest.raises(HTTPException) as mismatch:
        machine_header_enables_fence(
            "machine-a",
            ConnectedAgentFenceHeaders(machine_id="机器-b"),
        )
    assert mismatch.value.status_code == 403
    assert mismatch.value.detail["code"] == "agent_rebound"

    with pytest.raises(HTTPException) as oversized:
        connected_agent_fence_headers("x" * 201)
    assert oversized.value.status_code == 400
