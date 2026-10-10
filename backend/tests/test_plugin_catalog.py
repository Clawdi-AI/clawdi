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

from app.schemas.plugin_catalog import catalog_runtime_source, parse_catalog_document
from app.services.plugin_catalog import (
    PluginCatalogSyncError,
    PluginCatalogSyncWorker,
    _fetch_catalog_document,
    _resolve_github_head,
    _SyncClaim,
)


def _catalog() -> dict[str, Any]:
    return {
        "schemaVersion": 2,
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
                "components": {
                    "skills": ["clawdi"],
                    "mcpServers": {"clawdi": "streamable-http"},
                },
                "source": {"type": "store", "path": "./plugins/clawdi"},
                "digest": f"sha256-tree-v1:{'a' * 64}",
            }
        ],
    }


def _catalog_bytes(value: dict[str, Any] | None = None) -> bytes:
    return json.dumps(value or _catalog(), separators=(",", ":")).encode()


def test_catalog_v2_parses_closed_component_summary_and_binds_store_source() -> None:
    document = parse_catalog_document(_catalog_bytes())

    entry = document.plugins[0]
    assert catalog_runtime_source(entry, revision="b" * 40) == {
        "type": "github",
        "url": "https://github.com/Clawdi-AI/store",
        "path": "v2/plugins/clawdi",
        "commit": "b" * 40,
    }
    assert entry.components.model_dump(mode="json") == {
        "skills": ["clawdi"],
        "mcpServers": {"clawdi": "streamable-http"},
    }

    release_catalog = deepcopy(_catalog())
    release_catalog["plugins"][0]["source"] = {
        "type": "github-release",
        "url": "https://github.com/acme/plugins/releases/download/acme-v1.0.0/acme-1.0.0.tar.gz",
        "archiveDigest": f"sha256:{'c' * 64}",
    }
    release_entry = parse_catalog_document(_catalog_bytes(release_catalog)).plugins[0]
    assert (
        catalog_runtime_source(release_entry, revision="b" * 40)
        == release_catalog["plugins"][0]["source"]
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda entry: entry.__setitem__("commit", "a" * 40),
        lambda entry: entry["source"].__setitem__("path", "../plugins/clawdi"),
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
def test_catalog_v2_rejects_untrusted_or_unbounded_shapes(mutate) -> None:
    catalog = deepcopy(_catalog())
    entry = catalog["plugins"][0]
    mutate(entry)

    with pytest.raises(ValidationError):
        parse_catalog_document(_catalog_bytes(catalog))


def test_catalog_v2_rejects_duplicate_json_keys() -> None:
    with pytest.raises(ValueError, match="duplicate catalog key"):
        parse_catalog_document(b'{"schemaVersion":2,"schemaVersion":2,"plugins":[]}')


@pytest.mark.asyncio
async def test_catalog_fetch_resolves_head_then_uses_the_exact_commit() -> None:
    revision = "b" * 40
    requests: list[httpx.Request] = []
    large_commit = {"sha": revision, "files": [{"patch": "x" * (256 * 1024 + 1)}]}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "api.github.com":
            if request.headers.get("accept") == "application/vnd.github.sha":
                return httpx.Response(
                    200,
                    text=revision,
                    headers={"etag": '"head"', "content-type": "application/vnd.github.sha"},
                )
            return httpx.Response(200, json=large_commit, headers={"etag": '"head"'})
        return httpx.Response(200, content=_catalog_bytes(), headers={"etag": '"catalog"'})

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag=None)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), headers={"Accept": "application/vnd.github+json"}
    ) as client:
        resolved, head_etag = await _resolve_github_head(client, claim)
        document, catalog_etag = await _fetch_catalog_document(client, resolved)

    assert resolved == revision
    assert head_etag == '"head"'
    assert catalog_etag == '"catalog"'
    assert document.plugins[0].name == "clawdi"
    assert requests[0].url == httpx.URL("https://api.github.com/repos/Clawdi-AI/store/commits/main")
    assert requests[0].headers["accept"] == "application/vnd.github.sha"
    assert requests[1].url == httpx.URL(
        f"https://raw.githubusercontent.com/Clawdi-AI/store/{revision}/v2/catalog.json"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "error"),
    [
        (b"", "head_revision_invalid"),
        (b"b" * 39, "head_revision_invalid"),
        (b"b" * 41, "head_revision_invalid"),
        (b"B" * 40, "head_revision_invalid"),
        (b"g" * 40, "head_revision_invalid"),
        (json.dumps({"sha": "b" * 40}).encode(), "head_revision_invalid"),
        (b"\xff" * 40, "head_response_invalid"),
        ("é".encode() * 20, "head_response_invalid"),
    ],
    ids=["empty", "short", "long", "uppercase", "non-hex", "json", "non-utf8", "non-ascii"],
)
async def test_catalog_head_rejects_malformed_sha(body: bytes, error: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept"] == "application/vnd.github.sha"
        return httpx.Response(200, content=body)

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag=None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PluginCatalogSyncError, match=f"^{error}$"):
            await _resolve_github_head(client, claim)


@pytest.mark.asyncio
@pytest.mark.parametrize("declared_length", [True, False], ids=["declared", "streamed"])
async def test_catalog_head_rejects_oversized_sha(declared_length: bool) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        body = b"b" * 40 + b" " * 89
        headers = {"content-length": str(len(body))} if declared_length else {}
        return httpx.Response(200, stream=httpx.ByteStream(body), headers=headers)

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag=None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PluginCatalogSyncError, match="^upstream_response_too_large$"):
            await _resolve_github_head(client, claim)


@pytest.mark.asyncio
async def test_catalog_head_etag_is_reused_for_not_modified_response() -> None:
    revision = "b" * 40
    etag = '"head-sha"'
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["accept"] == "application/vnd.github.sha"
        if request.headers.get("if-none-match") == etag:
            return httpx.Response(304)
        return httpx.Response(200, text=revision, headers={"etag": etag})

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag=None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        resolved, head_etag = await _resolve_github_head(client, claim)
        cached_claim = _SyncClaim(
            attempted_at=datetime.now(UTC), current_revision=resolved, head_etag=head_etag
        )
        cached_result = await _resolve_github_head(client, cached_claim)

    assert (resolved, head_etag) == (revision, etag)
    assert cached_result == (revision, etag)
    assert "if-none-match" not in requests[0].headers
    assert requests[1].headers["if-none-match"] == etag


@pytest.mark.asyncio
async def test_catalog_head_not_modified_requires_a_snapshot() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(304)

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag='"head"')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PluginCatalogSyncError, match="^head_not_modified_without_snapshot$"):
            await _resolve_github_head(client, claim)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 403, 404, 422, 429, 500, 503])
async def test_catalog_head_preserves_http_error_codes(status: int) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"message": "upstream unavailable"})

    claim = _SyncClaim(attempted_at=datetime.now(UTC), current_revision=None, head_etag=None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PluginCatalogSyncError, match=f"^head_http_{status}$"):
            await _resolve_github_head(client, claim)


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
