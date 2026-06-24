#!/usr/bin/env python3
"""Filter the hosted deploy API OpenAPI spec down to just the endpoint and
schema closure consumed by the OSS dashboard.

The full deploy API spec carries private control-plane endpoints that the
OSS dashboard must not accidentally grow into. The dashboard only calls the
hosted user profile, v2 billing, v2 usage, and v2 deployment-management
operations listed in `KEEP_OPERATIONS_BY_PATH`. Without this filter,
`openapi-typescript` emits a
~7000-line TypeScript dump on every regen; this script trims it to
only the surface we actually consume so:

  * `tsc` doesn't trawl thousands of dead types on every build,
  * PR diffs don't drown reviewers in regenerated boilerplate,
  * adding a new endpoint requires editing the allowlist below (a
    deliberate audit point) instead of silently widening the bundle.

Usage (wired up via `apps/web/package.json`):

    curl -s http://localhost:50021/openapi.json \
      | python3 scripts/filter-deploy-openapi.py \
      | bun x openapi-typescript /dev/stdin \
          -o packages/shared/src/api/deploy.generated.ts

To consume a new endpoint, add its path + HTTP method to
`KEEP_OPERATIONS_BY_PATH` and rerun the generate command. Schema closure is
auto-discovered via `$ref` walks, so referenced types come along for free.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from typing import Any

# Endpoints the OSS dashboard actually calls. Adding a new operation here is the
# SINGLE knob for widening the schema surface.
KEEP_OPERATIONS_BY_PATH: dict[str, set[str]] = {
    "/me": {"get"},
    "/v2/deployments": {"get", "post"},
    "/v2/deployments/{deployment_id}": {"get", "delete", "patch"},
    "/v2/deployments/{deployment_id}/agents/{agent_type}": {"patch"},
    "/v2/deployments/{deployment_id}/agents/{agent_type}/ai-provider": {"patch"},
    "/v2/deployments/{deployment_id}/onboard-agent": {"post"},
    "/v2/deployments/{deployment_id}/restart": {"post"},
    "/v2/deployments/{deployment_id}/start": {"post"},
    "/v2/deployments/{deployment_id}/stop": {"post"},
    "/v2/subscription/activation-fee": {"get"},
    "/v2/subscription/checkout": {"post"},
    "/v2/subscription/current": {"get"},
    "/v2/subscription/plans": {"get"},
    "/v2/subscription/portal": {"post"},
    "/v2/usage": {"get"},
    "/v2/wallet": {"get"},
    "/v2/wallet/auto-reload": {"put"},
    "/v2/wallet/ledger": {"get"},
    "/v2/wallet/topup": {"post"},
}

_PATH_ITEM_NON_OPERATION_KEYS = {
    "summary",
    "description",
    "servers",
    "parameters",
}


def _walk_refs(node: Any, sink: set[str]) -> None:
    """Walk a JSON value, recording every string value at any
    `$ref` key. Schema closure discovery uses this to find every
    component a kept path or schema transitively depends on."""
    if isinstance(node, dict):
        for key, val in node.items():
            if key == "$ref" and isinstance(val, str):
                sink.add(val)
            else:
                _walk_refs(val, sink)
    elif isinstance(node, list):
        for item in node:
            _walk_refs(item, sink)


_SCHEMA_REF_PREFIX = "#/components/schemas/"


def _schema_names_referenced(refs: Iterable[str]) -> set[str]:
    return {r[len(_SCHEMA_REF_PREFIX) :] for r in refs if r.startswith(_SCHEMA_REF_PREFIX)}


def filter_spec(spec: dict[str, Any]) -> dict[str, Any]:
    paths = spec.get("paths", {}) or {}
    all_schemas = (spec.get("components", {}) or {}).get("schemas", {}) or {}

    kept_paths: dict[str, Any] = {}
    missing: list[str] = []
    for path, methods in KEEP_OPERATIONS_BY_PATH.items():
        path_item = paths.get(path)
        if path_item is None:
            missing.append(path)
            continue
        kept_item = {
            key: value
            for key, value in path_item.items()
            if key in _PATH_ITEM_NON_OPERATION_KEYS or key.lower() in methods
        }
        missing_methods = sorted(methods - {key.lower() for key in kept_item})
        if missing_methods:
            missing.append(f"{path} methods={missing_methods}")
            continue
        kept_paths[path] = kept_item
    if missing:
        # Loud failure so a deploy API rename of a kept endpoint shows
        # up in CI / dev right away, rather than producing a silently
        # smaller schema.
        msg = f"filter-deploy-openapi: kept operations not in spec: {missing}"
        raise SystemExit(msg)

    # BFS the $ref graph starting from the kept paths.
    seen: set[str] = set()
    pending: set[str] = set()

    initial_refs: set[str] = set()
    _walk_refs(kept_paths, initial_refs)
    pending.update(_schema_names_referenced(initial_refs))

    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        schema = all_schemas.get(name)
        if schema is None:
            # Deploy API spec references a schema name that doesn't exist —
            # treat as a generator bug rather than silently ignoring;
            # the resulting deploy.generated.ts would type-check OK
            # but lie about its shape at runtime.
            msg = f"filter-deploy-openapi: missing schema referenced by closure: {name}"
            raise SystemExit(msg)
        nested: set[str] = set()
        _walk_refs(schema, nested)
        pending.update(_schema_names_referenced(nested) - seen)

    kept_schemas = {n: all_schemas[n] for n in sorted(seen)}

    # Preserve top-level keys openapi-typescript cares about; drop
    # everything else (tags, security schemes, etc.) so the output
    # is as minimal as the kept surface allows.
    filtered: dict[str, Any] = {
        "openapi": spec.get("openapi", "3.0.0"),
        "info": spec.get("info", {"title": "deploy-api (filtered)", "version": "0"}),
        "paths": kept_paths,
        "components": {"schemas": kept_schemas},
    }
    return filtered


def main() -> None:
    spec = json.load(sys.stdin)
    json.dump(filter_spec(spec), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
