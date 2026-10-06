from fastapi.routing import iter_route_contexts

from app.main import app


def test_v1_platform_does_not_register_v2_runtime_observation_routes() -> None:
    paths = [
        path
        for route in iter_route_contexts(app.routes)
        if (path := getattr(route, "path", "")).startswith(("/v1/platform/", "/api/platform/"))
    ]
    assert paths
    assert not any(
        fragment in path
        for path in paths
        for fragment in ("runtime-environment", "runtime-observation")
    )
