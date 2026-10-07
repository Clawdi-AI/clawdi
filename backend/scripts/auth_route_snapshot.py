"""Record route dependency chains, including scope-factory arguments.

Run from backend: `uv run python -m scripts.auth_route_snapshot`. Review any
permission change before replacing tests/fixtures/auth_routes.json with stdout.
The app is imported without starting its lifespan or connecting to services.
"""

from __future__ import annotations

import inspect
import json

from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, iter_route_contexts


def _dependency_name(dependant: Dependant) -> str:
    call = dependant.call
    if call is None:
        raise ValueError("Route dependency has no callable")
    if inspect.isfunction(call):
        name = f"{call.__module__}.{call.__qualname__}"
        closure = inspect.getclosurevars(call).nonlocals
        # The scope gates are closures rather than FastAPI Security dependencies.
        for argument in ("needed", "accepted", "required_scope", "allow_legacy_admin"):
            if argument in closure:
                name += f"[{argument}={json.dumps(closure[argument], separators=(',', ':'))}]"
    else:
        name = f"{type(call).__module__}.{type(call).__qualname__}"
    scopes = sorted(set((dependant.parent_oauth_scopes or []) + (dependant.own_oauth_scopes or [])))
    if scopes:
        name += f"[oauth_scopes={json.dumps(scopes, separators=(',', ':'))}]"
    return name


def _dependency_chains(dependant: Dependant) -> list[str]:
    name = _dependency_name(dependant)
    if not dependant.dependencies:
        return [name]
    return [
        f"{name} -> {chain}"
        for child in dependant.dependencies
        for chain in _dependency_chains(child)
    ]


def auth_route_snapshot(app: FastAPI) -> dict[str, list[list[str]]]:
    """Include public routes and compatibility aliases, ignoring overrides.

    Keep every dependency so custom wrappers around auth cannot disappear from
    review. Sort method/path keys and chains, retaining duplicate registrations
    in dispatch order instead of silently overwriting a permission policy.
    """
    snapshot: dict[str, list[list[str]]] = {}
    for route in iter_route_contexts(app.routes):
        if not isinstance(route.original_route, APIRoute):
            continue
        chains = sorted(
            chain
            for dependency in route.dependant.dependencies
            for chain in _dependency_chains(dependency)
        )
        for method in sorted(route.methods or []):
            key = f"{method} {route.path}"
            snapshot.setdefault(key, []).append(chains)
    return dict(sorted(snapshot.items()))


def main() -> None:
    from app.main import app

    print(json.dumps(auth_route_snapshot(app), indent=2))


if __name__ == "__main__":
    main()
