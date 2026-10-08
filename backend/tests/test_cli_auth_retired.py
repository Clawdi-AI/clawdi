"""Routing behavior for retired CLI authentication endpoints."""

import httpx
import pytest

@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/v1", "/api"])
@pytest.mark.parametrize("endpoint", ["device", "poll", "lookup", "approve", "deny"])
async def test_retired_device_endpoints_are_not_registered(
    client: httpx.AsyncClient, prefix: str, endpoint: str
) -> None:
    response = await client.post(f"{prefix}/cli/auth/{endpoint}")
    assert response.status_code == 404
