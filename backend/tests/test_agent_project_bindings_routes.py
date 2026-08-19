"""Route-registration smoke tests for agent project bindings."""

from fastapi.routing import iter_route_contexts


def test_agent_project_binding_routes_registered():
    from app.main import app

    paths = {route.path for route in iter_route_contexts(app.routes)}
    assert "/v1/projects/{project_id}/agents" in paths
    assert "/v1/agents/{agent_id}/project-bindings" in paths
    assert "/v1/agents/{agent_id}/project-bindings/context" in paths
    assert "/v1/agents/{agent_id}/project-bindings/context/reorder" in paths
    assert "/v1/agents/{agent_id}/project-bindings/{binding_id}" in paths
