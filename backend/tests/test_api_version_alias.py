"""Canonical /v1 routing and the legacy /api alias.

Every route is mounted canonically under /v1 and aliased under /api for
clients built before the versioned-prefix migration. The alias must keep
serving until old clients rotate; the OpenAPI schema (which the web/CLI
typed-client codegen consumes) must only advertise /v1.
"""

from app.main import app


def _routes_by_path() -> dict[str, set[str]]:
    routes: dict[str, set[str]] = {}
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = set(getattr(route, "methods", None) or {"WEBSOCKET"})
        routes.setdefault(path, set()).update(methods)
    return routes


def test_every_v1_route_has_api_legacy_alias():
    routes = _routes_by_path()
    v1_paths = [path for path in routes if path.startswith("/v1/")]
    assert v1_paths, "expected /v1 routes to be mounted"
    missing = [
        path
        for path in sorted(v1_paths)
        if not routes[path] <= routes.get(f"/api{path.removeprefix('/v1')}", set())
    ]
    assert not missing, f"routes missing the /api legacy alias: {missing}"


def test_openapi_schema_only_advertises_v1():
    spec = app.openapi()
    non_v1 = [path for path in spec["paths"] if not path.startswith("/v1/")]
    assert non_v1 == ["/health"], (
        "the /api legacy alias (and anything else outside /v1) must stay out of "
        f"the public OpenAPI schema, found: {non_v1}"
    )
