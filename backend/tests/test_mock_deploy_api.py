from scripts import mock_deploy_api


def test_mock_deployment_read_response_projects_authoritative_a4_fields() -> None:
    record = mock_deploy_api._deployment()

    read = mock_deploy_api._deployment_read_response(record)

    assert "resource" in read
    assert "id" not in read
    assert read["resource"]["id"] == record["id"]
    assert read["resource"]["spec"]["runtime"] == "openclaw"
    assert read["resource"]["status"]["summary_state"] == "running"
    assert read["resource"]["status"]["conditions"] == [
        {
            "type": "Ready",
            "status": "True",
            "observedGeneration": 1,
            "lastTransitionTime": record["created_at"],
            "reason": "RuntimeReady",
            "message": "Runtime is ready.",
        }
    ]
    assert read["resource"]["metadata"]["manifestETag"] == (
        f"etag_{mock_deploy_api.DEV_V2_DEPLOYMENT_ID}"
    )
    assert read["resource"]["metadata"]["resourceVersion"] == (
        f"rv_{mock_deploy_api.DEV_V2_DEPLOYMENT_ID}"
    )
    assert read["ai_provider_auth_kinds"] == {"openclaw": "api_key"}
    assert read["runtime_ui_endpoint"] == {
        "runtime": "openclaw",
        "role": "control_ui",
        "url": "https://openclaw.dev-preview.local",
        "requires_bridge_token": True,
    }
    assert read["current_plan_slug"] == "compute_performance"
    assert read["commercial_display"]["latest_funding_fact"] is None

    assert record["id"] == mock_deploy_api.DEV_V2_DEPLOYMENT_ID
    assert "resource" not in record


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


def test_mock_failure_projects_a_matching_degraded_condition() -> None:
    record = mock_deploy_api._deployment(status="failed")
    record["failure_reason"] = "Runtime did not become ready."

    status = mock_deploy_api._deployment_read_response(record)["resource"]["status"]

    assert status["summary_state"] == "failed"
    assert status["conditions"] == [
        {
            "type": "Degraded",
            "status": "True",
            "observedGeneration": 1,
            "lastTransitionTime": record["created_at"],
            "reason": "RuntimeReadinessTimeout",
            "message": "Runtime did not become ready.",
        }
    ]
    assert status["failure"]["conditionReason"] == "RuntimeReadinessTimeout"
    assert status["failure"]["conditionMessage"] == "Runtime did not become ready."


def test_mock_lro_response_advances_the_complete_declarative_read_generation() -> None:
    record = mock_deploy_api._deployment()

    operation = mock_deploy_api._accept_operation(
        record,
        verb="restart",
        idempotency_key="mock-read-generation-test",
    )
    resource = operation["response"]["deployment"]

    assert resource["metadata"]["generation"] == 2
    assert resource["metadata"]["resourceVersion"].startswith(f"rv_{record['id']}_")
    assert resource["status"]["observedGeneration"] == 2
    assert resource["status"]["driver_acknowledged_generation"] == 2
    assert resource["status"]["driver_applied_generation"] == 2
    assert resource["status"]["conditions"][0]["observedGeneration"] == 2
