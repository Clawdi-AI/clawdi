"""Route-registration smoke tests for agent project bindings."""


def test_agent_project_binding_routes_registered():
    from app.main import app

    paths = {route.path for route in app.router.routes}
    assert "/api/agents/{agent_id}/project-bindings" in paths
    assert "/api/agents/{agent_id}/project-bindings/primary" in paths
    assert "/api/agents/{agent_id}/project-bindings/context" in paths
    assert "/api/agents/{agent_id}/project-bindings/context/reorder" in paths
    assert "/api/agents/{agent_id}/project-bindings/{binding_id}" in paths
