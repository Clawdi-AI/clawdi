"""Compatibility behavior for the retired browser device flow."""

import httpx
import pytest

_DETAIL = (
    "This sign-in method is no longer supported. Update the Clawdi CLI and run `clawdi auth login`."
)


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/v1", "/api"])
@pytest.mark.parametrize("endpoint", ["device", "poll"])
async def test_retired_device_endpoints_return_upgrade_guidance(
    client: httpx.AsyncClient, prefix: str, endpoint: str
) -> None:
    response = await client.post(f"{prefix}/cli/auth/{endpoint}")
    assert response.status_code == 410
    assert response.json() == {"detail": _DETAIL}


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/v1", "/api"])
@pytest.mark.parametrize("endpoint", ["lookup", "approve", "deny"])
async def test_removed_device_endpoints_are_not_registered(
    client: httpx.AsyncClient, prefix: str, endpoint: str
) -> None:
    response = await client.request("POST", f"{prefix}/cli/auth/{endpoint}")
    assert response.status_code == 404
