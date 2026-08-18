import uuid

from fastapi.testclient import TestClient

from scripts import mock_deploy_api


def test_mock_deployment_read_response_is_projected_from_flat_mutation_record() -> None:
    mutation = mock_deploy_api._deployment()
    expected_agent_id = str(
        uuid.uuid5(
            uuid.UUID("e016a4c8-7943-4ae9-9c53-5f1a5db9f3e1"),
            f"{mutation['id']}:openclaw",
        )
    )

    read = mock_deploy_api._deployment_read_response(mutation)

    assert read["agent_id"] == expected_agent_id
    assert "resource" in read
    assert "id" not in read
    assert read["resource"]["id"] == mutation["id"]
    assert read["resource"]["name"] == mutation["name"]
    assert "name" not in read["resource"]["spec"]
    assert read["resource"]["spec"]["runtime"] == "openclaw"
    assert read["ai_provider_auth_kinds"] == {"openclaw": "api_key"}
    assert read["runtime_ui_endpoint"] == {
        "runtime": "openclaw",
        "role": "control_ui",
        "url": "https://openclaw.dev-preview.local",
    }
    assert read["current_plan_slug"] == "compute_performance"
    assert read["commercial_display"]["latest_funding_fact"] is None

    mutation["config_info"]["clawdi_cloud_environments"] = {}
    read_without_projection = mock_deploy_api._deployment_read_response(mutation)
    assert read_without_projection["clawdi_cloud_environments"] == {}
    assert read_without_projection["agent_id"] == expected_agent_id

    assert mutation["id"] == mock_deploy_api.DEV_V2_DEPLOYMENT_ID
    assert "resource" not in mutation


def test_mock_funding_revocation_projects_complete_provenance() -> None:
    mutation = mock_deploy_api._deployment()
    mutation["last_funding_event"] = {
        "type": "compute_subscription_fallback",
        "funding_source": "wallet",
        "reason": "disputed",
        "prior_plan_slug": "compute_basic",
        "occurred_at": "2026-07-18T12:00:00Z",
        "subscription_id": 42,
    }

    fact = mock_deploy_api._deployment_read_response(mutation)["commercial_display"][
        "latest_funding_fact"
    ]

    assert fact["funding_source"] == "wallet"
    assert fact["reason"] == "disputed"
    assert fact["prior_plan_slug"] == "compute_basic"
    assert fact["occurred_at"] == "2026-07-18T12:00:00Z"


def test_mock_v2_create_projects_only_the_resource_name() -> None:
    with TestClient(mock_deploy_api.app) as client:
        response = client.post(
            "/v2/subscription/checkout",
            json={
                "funding_source": "wallet",
                "deploy_config": {
                    "name": "Canonical deployment name",
                    "runtime": "hermes",
                    "deploy_request_id": "mock-name-contract",
                },
            },
        )

        assert response.status_code == 200
        deployment_id = response.json()["deployment_id"]
        try:
            resource = client.get(f"/v2/deployments/{deployment_id}").json()["resource"]
            assert resource["name"] == "Canonical deployment name"
            assert "name" not in resource["spec"]
            assert "assistant_name" not in resource["spec"]["runtime_configuration"]
        finally:
            mock_deploy_api.DEPLOYMENTS.pop(deployment_id, None)


def test_mock_v2_rejects_retired_names_and_updates_runtime_configuration() -> None:
    deployment = mock_deploy_api._create_deployment_record(
        {"name": "Stable resource name", "runtime": "hermes"}
    )
    deployment_id = deployment["id"]
    resource_version = f"rv_{deployment_id}"
    headers = {
        "Idempotency-Key": "mock-runtime-update",
        "If-Match": f'"{resource_version}"',
    }
    try:
        with TestClient(mock_deploy_api.app) as client:
            updated = client.patch(
                f"/v2/deployments/{deployment_id}",
                headers=headers,
                json={"language": "zh-CN", "timezone": "Asia/Shanghai"},
            )
            assert updated.status_code == 200
            resource = updated.json()["response"]["deployment"]
            assert resource["name"] == "Stable resource name"
            assert resource["spec"]["runtime_configuration"]["language"] == "zh-CN"
            assert resource["spec"]["runtime_configuration"]["timezone"] == ("Asia/Shanghai")

            next_version = resource["metadata"]["resourceVersion"]
            for field in ("name", "assistant_name"):
                rejected = client.patch(
                    f"/v2/deployments/{deployment_id}",
                    headers={
                        "Idempotency-Key": f"mock-reject-{field}",
                        "If-Match": f'"{next_version}"',
                    },
                    json={field: "Rejected name"},
                )
                assert rejected.status_code == 422
    finally:
        mock_deploy_api.DEPLOYMENTS.pop(deployment_id, None)


def test_mock_v2_create_rejects_retired_assistant_name() -> None:
    with TestClient(mock_deploy_api.app) as client:
        for deploy_config in (
            {"assistant_name": "Retired"},
            {"config": {"assistant_name": "Retired"}},
        ):
            response = client.post(
                "/v2/subscription/checkout",
                json={"funding_source": "wallet", "deploy_config": deploy_config},
            )
            assert response.status_code == 422
