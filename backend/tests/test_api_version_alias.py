"""Canonical /v1 routing and the legacy /api alias.

Legacy routes are mounted canonically under /v1 and aliased under /api for
clients built before the versioned-prefix migration. New contracts are
canonical-only. The OpenAPI schema (which the web/CLI typed-client codegen
consumes) must only advertise /v1.
"""

import httpx
import pytest
from httpx import ASGITransport

from app.main import app


def _routes_by_path() -> dict[str, set[str]]:
    routes: dict[str, set[str]] = {}
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = set(getattr(route, "methods", None) or {"WEBSOCKET"})
        routes.setdefault(path, set()).update(methods)
    return routes


def test_every_legacy_v1_route_has_api_alias():
    routes = _routes_by_path()
    v1_paths = [
        path
        for path in routes
        if path.startswith("/v1/")
        and path != "/v1/runtime/manifest"
        and not path.startswith("/v1/platform/")
    ]
    assert v1_paths, "expected /v1 routes to be mounted"
    missing = [
        path
        for path in sorted(v1_paths)
        if not routes[path] <= routes.get(f"/api{path.removeprefix('/v1')}", set())
    ]
    assert not missing, f"routes missing the /api legacy alias: {missing}"


@pytest.mark.parametrize(
    "path",
    [
        "/me/invitations",
        "/memories",
        "/projects",
        "/sessions",
        "/settings",
        "/vault",
        "/connectors",
        "/skills",
        "/agents",
        "/environments",
    ],
)
async def test_api_alias_dispatches_to_the_same_handler(path):
    """The alias must behave exactly like /v1, not merely exist.

    Unauthenticated requests exercise the full middleware + dependency
    stack; identical status and body prove both prefixes dispatch to the
    same handler chain.
    """
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        canonical = await client.get(f"/v1{path}")
        legacy = await client.get(f"/api{path}")
    assert legacy.status_code == canonical.status_code
    assert legacy.content == canonical.content
    assert canonical.status_code != 404


async def test_runtime_manifest_has_no_api_alias():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/runtime/manifest")
    assert response.status_code == 404


def test_openapi_schema_only_advertises_v1():
    spec = app.openapi()
    non_v1 = [path for path in spec["paths"] if not path.startswith("/v1/")]
    assert non_v1 == ["/health"], (
        "the /api legacy alias (and anything else outside /v1) must stay out of "
        f"the public OpenAPI schema, found: {non_v1}"
    )
