"""Route-registration smoke tests for agent project bindings."""


def test_agent_project_binding_routes_registered():
    from app.main import app

    paths = {route.path for route in app.router.routes}
    assert "/v1/agents/{agent_id}/project-bindings" in paths
    assert "/v1/agents/{agent_id}/project-bindings/context" in paths
    assert "/v1/agents/{agent_id}/project-bindings/context/reorder" in paths
    assert "/v1/agents/{agent_id}/project-bindings/{binding_id}" in paths
