"""Freeze the existing user/key permission matrix, including legacy edges."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException

from app.core import auth as auth_module
from app.core.auth import (
    AuthContext,
    AuthPrincipal,
    get_auth,
    get_auth_short_session,
    require_auth_scopes,
)
from app.models.api_key import ApiKey
from app.models.user import User


@dataclass(frozen=True)
class PrincipalCase:
    name: str
    api_key: bool = False
    scoped: bool = False
    bound: bool = False
    managed: bool = False
    runtime: bool = False
    connected: bool = False
    metric_kind: str = "clerk_session"


CASES = (
    PrincipalCase("web_session"),
    PrincipalCase("cli_oauth", connected=True, metric_kind="clerk_oauth_cli"),
    PrincipalCase("dev_bypass", metric_kind="dev_bypass"),
    PrincipalCase("api_key_legacy", api_key=True, connected=True, metric_kind="personal_api_key"),
    PrincipalCase(
        "api_key_scoped", api_key=True, scoped=True, connected=True, metric_kind="personal_api_key"
    ),
    PrincipalCase("api_key_env_legacy", api_key=True, bound=True, metric_kind="env_api_key"),
    PrincipalCase(
        "api_key_env_scoped", api_key=True, scoped=True, bound=True, metric_kind="env_api_key"
    ),
    PrincipalCase(
        "api_key_managed_legacy", api_key=True, managed=True, metric_kind="managed_legacy_key"
    ),
    PrincipalCase(
        "api_key_managed_scoped",
        api_key=True,
        scoped=True,
        managed=True,
        metric_kind="managed_legacy_key",
    ),
    PrincipalCase(
        "api_key_managed_env_legacy",
        api_key=True,
        bound=True,
        managed=True,
        metric_kind="managed_legacy_key",
    ),
    PrincipalCase(
        "api_key_managed_env_scoped",
        api_key=True,
        scoped=True,
        bound=True,
        managed=True,
        metric_kind="managed_legacy_key",
    ),
    PrincipalCase(
        "api_key_runtime_legacy",
        api_key=True,
        bound=True,
        managed=True,
        runtime=True,
        metric_kind="runtime_key",
    ),
    PrincipalCase(
        "api_key_runtime_scoped",
        api_key=True,
        scoped=True,
        bound=True,
        managed=True,
        runtime=True,
        metric_kind="runtime_key",
    ),
)

USER_PRINCIPALS = {"web_session", "cli_oauth", "dev_bypass"}
KEY_PRINCIPALS = {
    "api_key_legacy",
    "api_key_scoped",
    "api_key_env_legacy",
    "api_key_env_scoped",
    "api_key_managed_legacy",
    "api_key_managed_scoped",
    "api_key_managed_env_legacy",
    "api_key_managed_env_scoped",
    "api_key_runtime_legacy",
    "api_key_runtime_scoped",
}
WIDE_KEYS = {
    "api_key_legacy",
    "api_key_env_legacy",
    "api_key_managed_legacy",
    "api_key_managed_env_legacy",
    "api_key_runtime_legacy",
}
SCOPED_GATE_PASSES = (USER_PRINCIPALS | KEY_PRINCIPALS) - {"api_key_runtime_legacy"}

# Explicit acceptance sets were checked against origin/main before refactoring.
GATES = (
    ("require_cli_auth", {"cli_oauth"} | KEY_PRINCIPALS),
    ("require_oauth_cli_auth", {"cli_oauth"}),
    ("require_user_auth", USER_PRINCIPALS | WIDE_KEYS),
    ("require_user_auth_short_session", USER_PRINCIPALS | WIDE_KEYS),
    ("require_user_auth_unbound", USER_PRINCIPALS | {"api_key_legacy", "api_key_managed_legacy"}),
    ("require_user_cli", {"cli_oauth"} | WIDE_KEYS),
    ("require_user_session", USER_PRINCIPALS),
    ("require_web_auth", {"web_session", "dev_bypass"}),
    ("require_reverified_web_auth", {"web_session", "dev_bypass"}),
    ("require_scope", SCOPED_GATE_PASSES),
    ("require_scope_short_session", SCOPED_GATE_PASSES),
    ("require_any_scope", SCOPED_GATE_PASSES),
)


def context_for(case: PrincipalCase) -> AuthContext:
    user = User(id=uuid4(), clerk_id="principal-matrix", skills_revision=0)
    key = (
        ApiKey(
            user_id=user.id,
            managed=case.managed,
            environment_id=uuid4() if case.bound else None,
            runtime_deployment_id="matrix-deployment" if case.runtime else None,
            scopes=["sessions:read", "vault:read"] if case.scoped else None,
        )
        if case.api_key
        else None
    )
    return AuthContext(
        user=user,
        api_key=key,
        oauth_cli=case.name == "cli_oauth",
        oauth_access_expires_at=(
            datetime.now(UTC) + timedelta(hours=1) if case.name == "cli_oauth" else None
        ),
        dev_bypass=case.name == "dev_bypass",
        factor_verification_age=(0, -1),
    )


def gate_dependency(name: str) -> Callable:
    dependency = getattr(auth_module, name)
    if name in {"require_scope", "require_scope_short_session", "require_any_scope"}:
        return dependency("sessions:read", "vault:read")
    return dependency


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
@pytest.mark.parametrize(("gate", "accepted"), GATES, ids=[gate for gate, _ in GATES])
async def test_dependency_principal_matrix(case: PrincipalCase, gate: str, accepted: set[str]):
    """Exercise FastAPI's full dependency chain, including the unbound parent gate."""
    auth = context_for(case)
    app = FastAPI()

    async def identity() -> AuthContext:
        return auth

    async def endpoint(auth: AuthContext = Depends(gate_dependency(gate))) -> dict[str, str]:
        return {"user_id": str(auth.user_id)}

    app.add_api_route("/matrix", endpoint)
    app.dependency_overrides.update({get_auth: identity, get_auth_short_session: identity})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://matrix"
    ) as client:
        response = await client.get("/matrix")
    assert response.status_code == (200 if case.name in accepted else 403), response.text


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_principal_capabilities_and_metric_labels(case: PrincipalCase):
    auth = context_for(case)
    assert auth.principal == AuthPrincipal(case.name)
    assert auth_module.is_scoped_api_key(auth) == case.scoped
    assert auth_module.is_env_bound_api_key(auth) == case.bound
    assert auth_module.is_runtime_deployment_principal(auth) == case.runtime
    assert auth_module.is_connected_agent_principal(auth) == case.connected
    assert auth_module._credential_kind(auth) == case.metric_kind


def test_matrix_covers_every_principal_and_context_gate():
    assert {case.name for case in CASES} == {principal.value for principal in AuthPrincipal}
    # Admin headers, URL share tokens, and Clerk-id extraction use different
    # inputs. Every gate taking AuthContext must be represented in this matrix.
    excluded = {"require_admin_api_key", "require_share_token", "require_clerk_id"}
    assert {gate for gate, _ in GATES} | {"require_auth_scopes"} == {
        name for name in vars(auth_module) if name.startswith("require_") and name not in excluded
    }


@pytest.mark.parametrize(
    "case", [case for case in CASES if case.api_key], ids=lambda case: case.name
)
@pytest.mark.parametrize(
    ("scopes", "all_pass", "any_pass"),
    [(None, True, True), ([], False, False), (["sessions:read"], False, True)],
)
async def test_api_key_scope_subsets(case: PrincipalCase, scopes, all_pass: bool, any_pass: bool):
    auth = context_for(case)
    assert auth.api_key is not None
    # Resolve a fresh identity after changing the fixture credential, as get_auth does.
    auth.api_key.scopes = scopes
    auth = AuthContext(user=auth.user, api_key=auth.api_key)
    for gate, passes in (
        ("require_scope", all_pass),
        ("require_scope_short_session", all_pass),
        ("require_any_scope", any_pass),
    ):
        if scopes is None and case.runtime:
            passes = False
        if passes:
            assert await gate_dependency(gate)(auth) is auth
        else:
            with pytest.raises(HTTPException) as exc:
                await gate_dependency(gate)(auth)
            assert exc.value.status_code == 403
    if all_pass and not (scopes is None and case.runtime):
        require_auth_scopes(auth, "sessions:read", "vault:read")
    else:
        with pytest.raises(HTTPException) as exc:
            require_auth_scopes(auth, "sessions:read", "vault:read")
        assert exc.value.status_code == 403


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
async def test_empty_scope_requirements(case: PrincipalCase):
    auth = context_for(case)
    for factory in (auth_module.require_scope, auth_module.require_scope_short_session):
        assert await factory()(auth) is auth
    any_scope = auth_module.require_any_scope()
    if case.name in USER_PRINCIPALS | (WIDE_KEYS - {"api_key_runtime_legacy"}):
        assert await any_scope(auth) is auth
    else:
        with pytest.raises(HTTPException) as exc:
            await any_scope(auth)
        assert exc.value.status_code == 403
