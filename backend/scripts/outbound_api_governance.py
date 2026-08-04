"""Exact import and owner inventory for production external API boundaries.

This scanner intentionally reasons only about import syntax. BasedPyright gates,
runtime response validation, and contract tests own the semantic guarantees at
external API boundaries.
"""

from __future__ import annotations

import ast
import json
import sys
from collections.abc import Mapping
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = BACKEND_ROOT / "app"

# SDKs with dynamic or incomplete upstream typing stay behind one reviewed
# first-party owner. Some owners are strict-clean; Mem0 is the sole exact
# standard-mode adapter exception in type_governance.py.
SDK_IMPORT_OWNERS: dict[str, str] = {
    "asyncpg": "app/services/postgres_listener.py",
    "boto3": "app/services/file_store_s3.py",
    "botocore": "app/services/file_store_s3.py",
    "composio": "app/services/composio.py",
    "composio_client": "app/services/composio.py",
    "httpx2": "app/services/composio.py",
    "mcp": "app/services/composio.py",
    "mem0": "app/services/memory_provider_mem0.py",
    "sentry_sdk": "app/core/sentry.py",
}

# Every current non-stdlib import root in app is classified here. A new or
# removed dependency root requires an explicit review of its owner and types.
EXPECTED_THIRD_PARTY_IMPORT_ROOTS = frozenset(
    {
        "asyncpg",
        "boto3",
        "botocore",
        "composio",
        "composio_client",
        "cryptography",
        "fastapi",
        "fastembed",
        "httpx",
        "httpx2",
        "idna",
        "jwt",
        "mcp",
        "mem0",
        "mypy_boto3_s3",
        "openai",
        "pgvector",
        "prometheus_client",
        "pydantic",
        "pydantic_settings",
        "sentry_sdk",
        "sqlalchemy",
        "starlette",
        "websockets",
        "xeddsa",
        "yaml",
    }
)

# Network libraries and external SDKs may be imported only by these exact
# first-party files. Equality makes both new and stale owners fail closed.
EXPECTED_EXTERNAL_IMPORTS: dict[str, frozenset[str]] = {
    **{root: frozenset({owner}) for root, owner in SDK_IMPORT_OWNERS.items()},
    "httpx": frozenset(
        {
            "app/core/auth.py",
            "app/routes/ai_providers.py",
            "app/routes/channel_routers/shared.py",
            "app/routes/channel_routers/telegram.py",
            "app/routes/clerk_webhooks.py",
            "app/routes/cli_auth.py",
            "app/services/ai_provider_connection.py",
            "app/services/ai_provider_oauth_attempt.py",
            "app/services/ai_provider_oauth_revoke_worker.py",
            "app/services/channels.py",
            "app/services/codex_oauth.py",
            "app/services/memory_provider_mem0.py",
            "app/services/safe_public_http.py",
            "app/services/skill_installer.py",
            "app/services/whatsapp_native_transport.py",
        }
    ),
    "fastembed": frozenset({"app/services/embedding.py"}),
    "openai": frozenset(
        {
            "app/services/embedding.py",
            "app/services/memory_extraction.py",
        }
    ),
    "socket": frozenset({"app/services/safe_public_http.py"}),
    "websockets": frozenset({"app/services/discord_gateway_worker.py"}),
}

PROHIBITED_NETWORK_MODULES = frozenset(
    {
        "aiohttp",
        "ftplib",
        "grpc",
        "http.client",
        "imaplib",
        "poplib",
        "requests",
        "smtplib",
        "telnetlib",
        "urllib.request",
        "urllib3",
        "xmlrpc.client",
    }
)


def parse_production_sources(app_root: Path = APP_ROOT) -> dict[str, ast.Module]:
    return {
        path.relative_to(BACKEND_ROOT).as_posix(): ast.parse(path.read_text(encoding="utf-8"))
        for path in sorted(app_root.rglob("*.py"))
    }


def imported_modules(tree: ast.Module) -> frozenset[str]:
    """Return absolute modules named by import statements, without resolving code."""

    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module is not None:
            modules.add(node.module)
            modules.update(
                f"{node.module}.{alias.name}" for alias in node.names if alias.name != "*"
            )
    return frozenset(modules)


def validate_third_party_import_roots(trees: Mapping[str, ast.Module]) -> None:
    observed = frozenset(
        root
        for tree in trees.values()
        for module in imported_modules(tree)
        if (root := module.split(".", 1)[0]) != "app" and root not in sys.stdlib_module_names
    )
    if observed != EXPECTED_THIRD_PARTY_IMPORT_ROOTS:
        raise ValueError(
            "third-party import root inventory mismatch: "
            f"expected={sorted(EXPECTED_THIRD_PARTY_IMPORT_ROOTS)} observed={sorted(observed)}"
        )


def validate_dynamic_sdk_owners(trees: Mapping[str, ast.Module]) -> None:
    for path, tree in trees.items():
        for module in imported_modules(tree):
            root = module.split(".", 1)[0]
            owner = SDK_IMPORT_OWNERS.get(root)
            if owner is not None and path != owner:
                raise ValueError(f"dynamic SDK {root} imported outside {owner}: {path}")


def validate_external_import_inventory(trees: Mapping[str, ast.Module]) -> None:
    observed: dict[str, set[str]] = {root: set() for root in EXPECTED_EXTERNAL_IMPORTS}
    prohibited: dict[str, set[str]] = {}
    for path, tree in trees.items():
        for module in imported_modules(tree):
            root = module.split(".", 1)[0]
            if root in observed:
                observed[root].add(path)
            if module in PROHIBITED_NETWORK_MODULES or root in PROHIBITED_NETWORK_MODULES:
                prohibited.setdefault(module, set()).add(path)
    if prohibited:
        raise ValueError(f"prohibited network imports: {_sorted_sets(prohibited)}")
    normalized = {root: frozenset(paths) for root, paths in observed.items()}
    if normalized != EXPECTED_EXTERNAL_IMPORTS:
        raise ValueError(
            "external import owner inventory mismatch: "
            f"expected={_sorted_sets(EXPECTED_EXTERNAL_IMPORTS)} "
            f"observed={_sorted_sets(normalized)}"
        )


def audit() -> dict[str, object]:
    trees = parse_production_sources()
    validate_third_party_import_roots(trees)
    validate_dynamic_sdk_owners(trees)
    validate_external_import_inventory(trees)
    return {
        "dynamicSdkFamilies": len(SDK_IMPORT_OWNERS),
        "externalImportFamilies": len(EXPECTED_EXTERNAL_IMPORTS),
        "productionFiles": len(trees),
        "reviewedBoundaryOwners": sorted(set(SDK_IMPORT_OWNERS.values())),
        "thirdPartyImportRoots": len(EXPECTED_THIRD_PARTY_IMPORT_ROOTS),
    }


def _sorted_sets(values: Mapping[str, set[str] | frozenset[str]]) -> dict[str, list[str]]:
    return {key: sorted(value) for key, value in sorted(values.items())}


def main() -> int:
    try:
        result = audit()
    except (SyntaxError, ValueError) as exc:
        print(f"external-api-import-governance: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
