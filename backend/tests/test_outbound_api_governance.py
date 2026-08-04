from __future__ import annotations

import ast

import pytest

from scripts import outbound_api_governance


def test_current_external_import_inventory_is_exact() -> None:
    result = outbound_api_governance.audit()

    assert result == {
        "dynamicSdkFamilies": len(outbound_api_governance.SDK_IMPORT_OWNERS),
        "externalImportFamilies": len(outbound_api_governance.EXPECTED_EXTERNAL_IMPORTS),
        "productionFiles": len(outbound_api_governance.parse_production_sources()),
        "reviewedBoundaryOwners": [
            "app/core/sentry.py",
            "app/services/composio.py",
            "app/services/file_store_s3.py",
            "app/services/memory_provider_mem0.py",
            "app/services/postgres_listener.py",
        ],
        "thirdPartyImportRoots": len(outbound_api_governance.EXPECTED_THIRD_PARTY_IMPORT_ROOTS),
    }


def test_import_inventory_records_aliases_without_resolving_program_flow() -> None:
    tree = ast.parse(
        "import httpx as transport\n"
        "from urllib import request as url_request\n"
        "from mem0 import MemoryClient as OfficialClient\n"
    )

    assert outbound_api_governance.imported_modules(tree) == frozenset(
        {
            "httpx",
            "mem0",
            "mem0.MemoryClient",
            "urllib",
            "urllib.request",
        }
    )


def test_new_third_party_root_fails_closed() -> None:
    trees = outbound_api_governance.parse_production_sources()
    trees["app/services/unregistered_provider.py"] = ast.parse("import stripe\n")

    with pytest.raises(ValueError, match="third-party import root inventory mismatch"):
        outbound_api_governance.validate_third_party_import_roots(trees)


def test_dynamic_sdk_import_outside_exact_owner_fails_closed() -> None:
    trees = {"app/services/not_the_adapter.py": ast.parse("from mem0 import MemoryClient\n")}

    with pytest.raises(ValueError, match="imported outside"):
        outbound_api_governance.validate_dynamic_sdk_owners(trees)


def test_new_external_import_owner_fails_closed() -> None:
    trees = outbound_api_governance.parse_production_sources()
    trees["app/services/unregistered_http.py"] = ast.parse("import httpx\n")

    with pytest.raises(ValueError, match="external import owner inventory mismatch"):
        outbound_api_governance.validate_external_import_inventory(trees)


def test_stale_external_import_owner_fails_closed() -> None:
    trees = outbound_api_governance.parse_production_sources()
    del trees["app/core/auth.py"]

    with pytest.raises(ValueError, match="external import owner inventory mismatch"):
        outbound_api_governance.validate_external_import_inventory(trees)


@pytest.mark.parametrize(
    "source",
    [
        "import requests\n",
        "from urllib import request\n",
        "from http.client import HTTPConnection\n",
    ],
)
def test_prohibited_network_imports_fail_closed(source: str) -> None:
    trees = {"app/services/unregistered_http.py": ast.parse(source)}

    with pytest.raises(ValueError, match="prohibited network imports"):
        outbound_api_governance.validate_external_import_inventory(trees)
