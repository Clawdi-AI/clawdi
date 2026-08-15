from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.schemas.plugin_catalog import catalog_source_path, parse_catalog_document
from app.services.plugin_catalog import (
    PluginCatalogSyncError,
    PluginCatalogSyncWorker,
    _fetch_catalog_document,
    _resolve_github_head,
    _SyncClaim,
)


def _catalog() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "plugins": [
            {
                "name": "clawdi",
                "version": "1.0.0",
                "displayName": "Clawdi",
                "description": "Clawdi tools.",
                "publisher": "Clawdi",
                "category": "productivity",
                "keywords": ["clawdi"],
                "languages": ["en"],
                "runtimes": ["openclaw", "hermes"],
                "hasConfiguration": False,
                "components": {
                    "skills": ["clawdi"],
                    "mcpServers": {"clawdi": "streamable-http"},
                },
                "path": "./plugins/clawdi",
                "digest": f"sha256-tree-v1:{'a' * 64}",
            }
        ],
    }


def _catalog_bytes(value: dict[str, Any] | None = None) -> bytes:
    return json.dumps(value or _catalog(), separators=(",", ":")).encode()


def test_catalog_v1_parses_closed_component_summary_and_normalizes_path() -> None:
    document = parse_catalog_document(_catalog_bytes())

    entry = document.plugins[0]
    assert catalog_source_path(entry) == "v2/plugins/clawdi"
    assert entry.components.model_dump(mode="json") == {
        "skills": ["clawdi"],
        "mcpServers": {"clawdi": "streamable-http"},
    }


@pytest.mark.parametrize(
    "mutate",
    [
        lambda entry: entry.__setitem__("commit", "a" * 40),
        lambda entry: entry.__setitem__("path", "../plugins/clawdi"),
        lambda entry: entry.__setitem__("description", None),
        lambda entry: entry.__setitem__("components", {"skills": [], "mcpServers": {}}),
        lambda entry: entry["components"].__setitem__("skills", ["safe", "bad\x00"]),
        lambda entry: entry["components"].__setitem__("mcpServers", {"x" * 257: "stdio"}),
        lambda entry: entry["components"].__setitem__("unknown", []),
    ],
    ids=[
        "commit",
        "unsafe-path",
        "explicit-null",
        "empty-components",
        "control",
        "long-name",
        "unknown",
    ],
)
def test_catalog_v1_rejects_untrusted_or_unbounded_shapes(mutate) -> None:
    catalog = deepcopy(_catalog())
    entry = catalog["plugins"][0]
    mutate(entry)

    with pytest.raises(ValidationError):
        parse_catalog_document(_catalog_bytes(catalog))


def test_catalog_v1_rejects_duplicate_json_keys() -> None:
    with pytest.raises(ValueError, match="duplicate catalog key"):
        parse_catalog_document(b'{"schemaVersion":1,"schemaVersion":1,"plugins":[]}')


@pytest.mark.asyncio
async def test_catalog_fetch_resolves_head_then_uses_the_exact_commit() -> None:
    revision = "b" * 40
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "api.github.com":
            return httpx.Response(200, json={"sha": revision}, headers={"etag": '"head"'})
        return httpx.Response(200, content=_catalog_bytes(), headers={"etag": '"catalog"'})

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag=None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        resolved, head_etag = await _resolve_github_head(client, claim)
        document, catalog_etag = await _fetch_catalog_document(client, resolved)

    assert resolved == revision
    assert head_etag == '"head"'
    assert catalog_etag == '"catalog"'
    assert document.plugins[0].name == "clawdi"
    assert requests[1].url == httpx.URL(
        f"https://raw.githubusercontent.com/Clawdi-AI/store/{revision}/v2/catalog.json"
    )


@pytest.mark.asyncio
async def test_catalog_fetch_is_bounded_before_body_read() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": str(4 * 1024 * 1024 + 1)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PluginCatalogSyncError, match="upstream_response_too_large"):
            await _fetch_catalog_document(client, "c" * 40)


@pytest.mark.asyncio
async def test_catalog_worker_survives_a_failed_cycle(monkeypatch) -> None:
    worker = PluginCatalogSyncWorker(async_sessionmaker(), interval_seconds=30)
    stop = asyncio.Event()
    calls = 0

    async def run_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database unavailable")
        stop.set()

    monkeypatch.setattr(worker, "run_once", run_once)
    worker._poll_seconds = 0.001

    await worker.run_forever(stop)

    assert calls == 2
