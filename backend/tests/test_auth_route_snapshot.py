"""Permission wiring must change the committed method/path dependency snapshot."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI

from app.core.auth import AuthContext, require_scope, require_user_auth_unbound
from app.main import app
from app.services.platform_workload_auth import (
    require_platform_mutation_auth,
    require_platform_workload_auth,
)
from scripts.auth_route_snapshot import auth_route_snapshot

FIXTURE = Path(__file__).parent / "fixtures" / "auth_routes.json"


def test_auth_routes_match_snapshot():
    expected = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert auth_route_snapshot(app) == expected, (
        "Route permissions changed. Review the diff from "
        "`uv run python -m scripts.auth_route_snapshot` before updating the fixture."
    )


def test_snapshot_records_aliases_nested_gates_public_routes_and_duplicates():
    router = APIRouter()

    @router.get("/private")
    async def private(auth: AuthContext = Depends(require_user_auth_unbound)):
        return {}

    @router.get("/public")
    async def public():
        return {}

    app = FastAPI()
    app.include_router(router, prefix="/v1")
    app.include_router(router, prefix="/api", include_in_schema=False)
    app.include_router(router, prefix="/v1")
    snapshot = auth_route_snapshot(app)
    assert set(snapshot) == {
        "GET /v1/private",
        "GET /api/private",
        "GET /v1/public",
        "GET /api/public",
    }
    assert snapshot["GET /v1/public"] == [[], []]
    assert snapshot["GET /api/public"] == [[]]
    assert snapshot["GET /v1/private"] == snapshot["GET /api/private"] * 2
    assert any(
        "require_user_auth_unbound -> app.core.auth.require_user_auth -> app.core.auth.get_auth"
        in chain
        for chain in snapshot["GET /api/private"][0]
    )


def test_snapshot_changes_with_required_scopes_or_platform_credential_mode():
    def snapshot(dependency):
        app = FastAPI()

        @app.get("/gate", dependencies=[Depends(dependency)])
        async def gate():
            return {}

        return auth_route_snapshot(app)

    assert snapshot(require_scope("vault:read")) != snapshot(require_scope("vault:write"))
    assert snapshot(require_platform_mutation_auth("platform:keys:mint")) != snapshot(
        require_platform_workload_auth("platform:keys:mint")
    )
