from __future__ import annotations

import importlib.util
import json
from importlib.metadata import version
from pathlib import Path
from typing import Literal

import httpx
import pytest

from app.services.memory_provider_mem0 import Mem0Provider
from app.services.memory_types import (
    MemoryProviderUnavailableError,
    MemoryProviderUpstreamError,
)

USER_ID = "11111111-1111-1111-1111-111111111111"

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("mem0") is None,
    reason="mem0 optional dependency is not installed",
)


@pytest.mark.asyncio
async def test_pinned_memory_client_public_http_contract(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("MEM0_TELEMETRY", "false")
    requests: list[httpx.Request] = []
    get_all_responses = [
        {
            "count": 1,
            "results": [
                {
                    "id": "listed-memory",
                    "memory": "Listed memory",
                    "metadata": {"category": "fact"},
                }
            ],
        },
        {"count": 1, "results": []},
    ]

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if request.method == "GET" and path == "/v1/ping/":
            payload: object = {
                "org_id": "contract-org",
                "project_id": "contract-project",
                "user_email": "contract@example.test",
            }
        elif request.method == "POST" and path == "/v3/memories/add/":
            payload = {"results": [{"id": "added-memory"}]}
        elif request.method == "POST" and path == "/v3/memories/search/":
            payload = {
                "results": [
                    {
                        "id": "search-memory",
                        "memory": "Search memory",
                        "metadata": {"category": "fact"},
                    }
                ]
            }
        elif request.method == "POST" and path == "/v3/memories/":
            payload = get_all_responses.pop(0)
        elif request.method == "GET" and path == "/v1/memories/owned-memory/":
            payload = {"id": "owned-memory", "user_id": USER_ID}
        elif request.method == "DELETE" and path == "/v1/memories/owned-memory/":
            payload = {"status": "deleted"}
        else:
            raise AssertionError(f"unexpected Mem0 request: {request.method} {path}")
        return httpx.Response(200, json=payload, request=request)

    with httpx.Client(transport=httpx.MockTransport(handle)) as http_client:
        provider = Mem0Provider(api_key="contract-api-key", http_client=http_client)

        assert await provider.add(USER_ID, "Added memory") == {"id": "added-memory"}
        assert [item["id"] for item in await provider.search(USER_ID, "Search")] == [
            "search-memory"
        ]
        assert [item["id"] for item in await provider.list_all(USER_ID)] == ["listed-memory"]
        assert await provider.count(USER_ID) == 1
        assert await provider.delete(USER_ID, "owned-memory") is True

    assert version("mem0ai") == "2.0.18"
    assert [(request.method, request.url.path) for request in requests] == [
        ("GET", "/v1/ping/"),
        ("POST", "/v3/memories/add/"),
        ("POST", "/v3/memories/search/"),
        ("POST", "/v3/memories/"),
        ("POST", "/v3/memories/"),
        ("GET", "/v1/memories/owned-memory/"),
        ("DELETE", "/v1/memories/owned-memory/"),
    ]
    request_bodies = {
        request.url.path: json.loads(request.content) for request in requests if request.content
    }
    assert request_bodies["/v3/memories/add/"]["filters"] == {"user_id": USER_ID}
    assert request_bodies["/v3/memories/search/"]["filters"] == {"AND": [{"user_id": USER_ID}]}
    assert request_bodies["/v3/memories/search/"]["top_k"] == 50


@pytest.mark.asyncio
async def test_official_memory_client_malformed_response_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("MEM0_TELEMETRY", "false")

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/ping/":
            payload: object = {
                "org_id": "contract-org",
                "project_id": "contract-project",
                "user_email": "contract@example.test",
            }
        elif request.url.path == "/v3/memories/add/":
            payload = {"results": []}
        else:
            raise AssertionError(f"unexpected Mem0 request: {request.method} {request.url.path}")
        return httpx.Response(200, json=payload, request=request)

    with httpx.Client(transport=httpx.MockTransport(handle)) as http_client:
        provider = Mem0Provider(api_key="contract-api-key", http_client=http_client)

        with pytest.raises(MemoryProviderUpstreamError, match="invalid response"):
            await provider.add(USER_ID, "Malformed memory")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "expected_error"),
    [
        ("rate_limit", MemoryProviderUnavailableError),
        ("server", MemoryProviderUpstreamError),
        ("network", MemoryProviderUnavailableError),
    ],
)
async def test_official_memory_client_errors_map_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure: Literal["network", "rate_limit", "server"],
    expected_error: type[Exception],
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("MEM0_TELEMETRY", "false")

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/ping/":
            return httpx.Response(
                200,
                json={
                    "org_id": "contract-org",
                    "project_id": "contract-project",
                    "user_email": "contract@example.test",
                },
                request=request,
            )
        if request.url.path != "/v3/memories/search/":
            raise AssertionError(f"unexpected Mem0 request: {request.method} {request.url.path}")
        if failure == "network":
            raise httpx.ConnectError("contract connection failed", request=request)
        status_code = 429 if failure == "rate_limit" else 500
        return httpx.Response(
            status_code,
            json={"detail": "provider detail must stay internal"},
            request=request,
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as http_client:
        provider = Mem0Provider(api_key="contract-api-key", http_client=http_client)

        with pytest.raises(expected_error):
            await provider.search(USER_ID, "Search")
