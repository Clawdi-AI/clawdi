from __future__ import annotations

import copy

import httpx
import pytest
from httpx import ASGITransport

from scripts import mock_deploy_api as mock


@pytest.fixture(autouse=True)
def reset_mock_deployments():
    mock.DEPLOYMENTS.clear()
    mock.DEPLOYMENTS[mock.DEV_V2_DEPLOYMENT_ID] = mock._deployment()
    yield
    mock.DEPLOYMENTS.clear()
    mock.DEPLOYMENTS[mock.DEV_V2_DEPLOYMENT_ID] = mock._deployment()


@pytest.mark.asyncio
async def test_mock_terminal_session_requires_agent_id():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        response = await client.post(f"/v2/deployments/{mock.DEV_V2_DEPLOYMENT_ID}/terminal")

    assert response.status_code == 400
    assert response.json()["detail"] == "agent_id is required"


@pytest.mark.asyncio
async def test_mock_terminal_session_rejects_unknown_agent_id():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/v2/deployments/{mock.DEV_V2_DEPLOYMENT_ID}/terminal",
            json={"agent_id": "openclaw-missing"},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported runtime target"


@pytest.mark.asyncio
async def test_mock_terminal_session_rejects_disabled_runtime_target():
    config = copy.deepcopy(mock._base_config())
    config["runtime_targets"]["openclaw"]["enabled"] = False
    config["onboarded_agent_ids"] = ["codex", "hermes"]
    mock.DEPLOYMENTS["hdep_terminal_disabled"] = mock._deployment(
        deployment_id="hdep_terminal_disabled",
        config_info=config,
    )

    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v2/deployments/hdep_terminal_disabled/terminal",
            json={"agent_id": "openclaw"},
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_mock_terminal_session_requires_exact_terminal_target():
    config = copy.deepcopy(mock._base_config())
    del config["runtime_targets"]["openclaw"]["execution"]["terminal"]
    mock.DEPLOYMENTS["hdep_terminal_missing_target"] = mock._deployment(
        deployment_id="hdep_terminal_missing_target",
        config_info=config,
    )

    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v2/deployments/hdep_terminal_missing_target/terminal",
            json={"agent_id": "openclaw"},
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_mock_terminal_session_carries_selected_agent_id_to_websocket_url():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/v2/deployments/{mock.DEV_V2_DEPLOYMENT_ID}/terminal",
            json={"agent_id": "hermes"},
        )

    assert response.status_code == 200
    websocket_url = response.json()["websocket_url"]
    assert "/terminal/ws?agent_id=hermes" in websocket_url
    assert "#token=term_" in websocket_url


@pytest.mark.asyncio
async def test_mock_terminal_session_routes_multiple_openclaw_targets_by_id():
    config = copy.deepcopy(mock._base_config())
    config["runtime_targets"] = {
        "openclaw-a": {
            **config["runtime_targets"]["openclaw"],
            "id": "openclaw-a",
            "display_name": "OpenClaw A",
            "environment_id": "env-openclaw-a",
            "execution": {
                "terminal": {
                    "container": "openclaw-a",
                    "user": "node",
                    "cwd": "/workspaces/a",
                }
            },
        },
        "openclaw-b": {
            **config["runtime_targets"]["openclaw"],
            "id": "openclaw-b",
            "display_name": "OpenClaw B",
            "environment_id": "env-openclaw-b",
            "execution": {
                "terminal": {
                    "container": "openclaw-b",
                    "user": "node",
                    "cwd": "/workspaces/b",
                }
            },
        },
    }
    config["onboarded_agent_ids"] = ["openclaw-a", "openclaw-b"]
    mock.DEPLOYMENTS["hdep_multi_openclaw"] = mock._deployment(
        deployment_id="hdep_multi_openclaw",
        config_info=config,
    )

    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        first = await client.post(
            "/v2/deployments/hdep_multi_openclaw/terminal",
            json={"agent_id": "openclaw-a"},
        )
        second = await client.post(
            "/v2/deployments/hdep_multi_openclaw/terminal",
            json={"agent_id": "openclaw-b"},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert "agent_id=openclaw-a" in first.json()["websocket_url"]
    assert "agent_id=openclaw-b" in second.json()["websocket_url"]
    assert mock._terminal_target(config, "openclaw-a") == {
        "container": "openclaw-a",
        "user": "node",
        "cwd": "/workspaces/a",
    }
    assert mock._terminal_target(config, "openclaw-b") == {
        "container": "openclaw-b",
        "user": "node",
        "cwd": "/workspaces/b",
    }


@pytest.mark.asyncio
async def test_mock_agent_type_routes_are_not_available():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=mock.app), base_url="http://test"
    ) as client:
        response = await client.patch(
            f"/v2/deployments/{mock.DEV_V2_DEPLOYMENT_ID}/agents/openclaw",
            json={"enabled": False},
        )
        onboard = await client.post(
            f"/v2/deployments/{mock.DEV_V2_DEPLOYMENT_ID}/onboard-agent",
            json={"agent_type": "openclaw"},
        )

    assert response.status_code == 404
    assert onboard.status_code == 404
