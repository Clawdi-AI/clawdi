from scripts import mock_deploy_api


def test_mock_deployment_read_response_is_projected_from_flat_mutation_record() -> None:
    mutation = mock_deploy_api._deployment()

    read = mock_deploy_api._deployment_read_response(mutation)

    assert "resource" in read
    assert "id" not in read
    assert read["resource"]["id"] == mutation["id"]
    assert read["resource"]["spec"]["runtime"] == "openclaw"
    assert read["ai_provider_auth_kinds"] == {"openclaw": "api_key"}
    assert read["runtime_ui_endpoint"] == {
        "runtime": "openclaw",
        "role": "control_ui",
        "url": "https://openclaw.dev-preview.local",
        "requires_bridge_token": True,
    }
    assert read["current_plan_slug"] == "compute_performance"
    assert read["commercial_display"]["latest_funding_fact"] is None

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
