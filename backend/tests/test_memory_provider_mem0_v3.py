from __future__ import annotations

import sys
from types import ModuleType
from uuid import UUID

import httpx
import pytest

from app.routes import memories as memory_routes
from app.services.memory_provider import Mem0Provider
from app.services.memory_types import MemoryProviderUpstreamError

USER_ID = "11111111-1111-1111-1111-111111111111"
ENVIRONMENT_ID = UUID("22222222-2222-2222-2222-222222222222")
_DEFAULT_DELETE_RESULT = object()


class _FakeMem0Error(Exception):
    pass


class _FakeMem0NetworkError(_FakeMem0Error):
    pass


class _FakeMem0RateLimitError(_FakeMem0Error):
    pass


class _FakeMem0Module(ModuleType):
    MemoryClient: object


class _FakeMem0ExceptionsModule(ModuleType):
    MemoryError: type[Exception]
    NetworkError: type[Exception]
    RateLimitError: type[Exception]


class _RecordingMem0Client:
    def __init__(
        self,
        *,
        add_result: object = None,
        search_result: object = None,
        get_all_results: list[object] | None = None,
        get_results: list[object] | None = None,
        search_error: Exception | None = None,
        delete_result: object = _DEFAULT_DELETE_RESULT,
    ) -> None:
        self.add_result = add_result
        self.search_result = search_result
        self.get_all_results = list(get_all_results or [])
        self.get_results = list(get_results or [])
        self.search_error = search_error
        self.delete_result = (
            {"status": "deleted"} if delete_result is _DEFAULT_DELETE_RESULT else delete_result
        )
        self.add_calls: list[
            tuple[list[dict[str, object]], dict[str, object], dict[str, object]]
        ] = []
        self.search_calls: list[tuple[str, dict[str, object], int]] = []
        self.get_all_calls: list[tuple[dict[str, object], int, int]] = []
        self.get_calls: list[str] = []
        self.delete_calls: list[str] = []

    def add(
        self,
        messages: list[dict[str, object]],
        *,
        filters: dict[str, object],
        metadata: dict[str, object],
    ) -> object:
        self.add_calls.append((messages, filters, metadata))
        return self.add_result

    def search(
        self,
        query: str,
        *,
        filters: dict[str, object],
        top_k: int,
    ) -> object:
        self.search_calls.append((query, filters, top_k))
        if self.search_error is not None:
            raise self.search_error
        return self.search_result

    def get_all(
        self,
        *,
        filters: dict[str, object],
        page: int,
        page_size: int,
    ) -> object:
        self.get_all_calls.append((filters, page, page_size))
        if not self.get_all_results:
            raise AssertionError("unexpected Mem0 get_all call")
        return self.get_all_results.pop(0)

    def get(self, memory_id: str) -> object:
        self.get_calls.append(memory_id)
        if not self.get_results:
            raise AssertionError("unexpected Mem0 get call")
        return self.get_results.pop(0)

    def delete(self, memory_id: str) -> object:
        self.delete_calls.append(memory_id)
        return self.delete_result


def _provider(
    monkeypatch: pytest.MonkeyPatch,
    client: _RecordingMem0Client,
) -> Mem0Provider:
    def memory_client_factory(*, api_key: str) -> _RecordingMem0Client:
        assert api_key == "test-api-key"
        return client

    mem0_module = _FakeMem0Module("mem0")
    mem0_module.MemoryClient = memory_client_factory
    exceptions_module = _FakeMem0ExceptionsModule("mem0.exceptions")
    exceptions_module.MemoryError = _FakeMem0Error
    exceptions_module.NetworkError = _FakeMem0NetworkError
    exceptions_module.RateLimitError = _FakeMem0RateLimitError
    monkeypatch.setitem(sys.modules, "mem0", mem0_module)
    monkeypatch.setitem(sys.modules, "mem0.exceptions", exceptions_module)
    return Mem0Provider(api_key="test-api-key")


def _filters(*, category: str | None = None) -> dict[str, object]:
    conditions: list[dict[str, object]] = [{"user_id": USER_ID}]
    if category is not None:
        conditions.append({"metadata": {"category": category}})
    return {"AND": conditions}


@pytest.mark.asyncio
async def test_mem0_v3_add_and_search_use_filters_and_top_k(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sdk_client = _RecordingMem0Client(
        add_result={"results": [{"id": "mem0-added"}]},
        search_result={
            "results": [
                {
                    "id": "mem0-hit",
                    "memory": "Scoped memory",
                    "metadata": {
                        "category": "decision",
                        "source": "mcp",
                        "source_environment_id": str(ENVIRONMENT_ID),
                    },
                }
            ]
        },
    )
    provider = _provider(monkeypatch, sdk_client)

    added = await provider.add(
        USER_ID,
        "Scoped memory",
        category="decision",
        source="mcp",
        source_environment_id=ENVIRONMENT_ID,
    )
    hits = await provider.search(USER_ID, "Scoped", limit=7, category="decision")

    assert added == {"id": "mem0-added"}
    assert sdk_client.add_calls == [
        (
            [{"role": "user", "content": "Scoped memory"}],
            {"user_id": USER_ID},
            {
                "category": "decision",
                "source": "mcp",
                "tags": [],
                "source_environment_id": str(ENVIRONMENT_ID),
            },
        )
    ]
    assert sdk_client.search_calls == [("Scoped", _filters(category="decision"), 7)]
    assert hits[0]["source_environment_id"] == str(ENVIRONMENT_ID)


@pytest.mark.asyncio
async def test_mem0_v3_list_and_count_preserve_server_pagination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sdk_client = _RecordingMem0Client(
        get_all_results=[
            {
                "count": 23,
                "results": [
                    {
                        "id": "page-three",
                        "memory": "Page three memory",
                        "metadata": {
                            "category": "fact",
                            "source_environment_id": str(ENVIRONMENT_ID),
                        },
                    }
                ],
            },
            {"count": 23, "results": []},
        ]
    )
    provider = _provider(monkeypatch, sdk_client)

    rows = await provider.list_all(USER_ID, limit=10, offset=20, category="fact")
    total = await provider.count(USER_ID, category="fact")

    assert [row["id"] for row in rows] == ["page-three"]
    assert total == 23
    assert sdk_client.get_all_calls == [
        (_filters(category="fact"), 3, 10),
        (_filters(category="fact"), 1, 1),
    ]


@pytest.mark.asyncio
async def test_mem0_delete_verifies_account_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    sdk_client = _RecordingMem0Client(
        get_results=[
            {"id": "owned", "user_id": USER_ID},
            {"id": "foreign", "user_id": "another-user"},
        ]
    )
    provider = _provider(monkeypatch, sdk_client)

    assert await provider.delete(USER_ID, "owned") is True
    assert await provider.delete(USER_ID, "foreign") is False
    assert sdk_client.get_calls == ["owned", "foreign"]
    assert sdk_client.delete_calls == ["owned"]


@pytest.mark.asyncio
async def test_mem0_delete_rejects_non_object_response(monkeypatch: pytest.MonkeyPatch) -> None:
    sdk_client = _RecordingMem0Client(
        get_results=[{"id": "owned", "user_id": USER_ID}],
        delete_result="deleted",
    )
    provider = _provider(monkeypatch, sdk_client)

    with pytest.raises(MemoryProviderUpstreamError, match="invalid response"):
        await provider.delete(USER_ID, "owned")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "add_result",
    [
        {"results": []},
        {"results": [{}]},
        {"results": [{"id": ""}]},
        {"results": [{"id": "   "}]},
        {"results": [{"id": 123}]},
    ],
)
async def test_mem0_add_rejects_missing_or_invalid_provider_id(
    monkeypatch: pytest.MonkeyPatch,
    add_result: object,
) -> None:
    provider = _provider(monkeypatch, _RecordingMem0Client(add_result=add_result))

    with pytest.raises(MemoryProviderUpstreamError, match="invalid response"):
        await provider.add(USER_ID, "memory")


@pytest.mark.asyncio
async def test_mem0_search_rejects_wrong_field_types(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = _provider(
        monkeypatch,
        _RecordingMem0Client(
            search_result={"results": [{"id": "memory", "memory": 42, "metadata": []}]}
        ),
    )

    with pytest.raises(MemoryProviderUpstreamError, match="invalid response"):
        await provider.search(USER_ID, "memory")


@pytest.mark.asyncio
async def test_mem0_count_rejects_malformed_response(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = _provider(
        monkeypatch,
        _RecordingMem0Client(get_all_results=[{"count": "12", "results": []}]),
    )

    with pytest.raises(MemoryProviderUpstreamError, match="invalid response"):
        await provider.count(USER_ID)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("sdk_error", "expected_status"),
    [
        (_FakeMem0Error("provider rejected request"), 502),
        (_FakeMem0NetworkError("provider timed out"), 503),
        (_FakeMem0RateLimitError("provider rate limited"), 503),
        (ValueError("provider rejected arguments"), 502),
        (
            httpx.ConnectError(
                "provider connection failed",
                request=httpx.Request("GET", "https://api.mem0.ai"),
            ),
            503,
        ),
    ],
)
async def test_mem0_sdk_errors_map_to_stable_retryable_http_responses(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    sdk_error: Exception,
    expected_status: int,
) -> None:
    provider = _provider(
        monkeypatch,
        _RecordingMem0Client(search_error=sdk_error),
    )

    async def configured_provider(_user_id: str, _db: object) -> Mem0Provider:
        return provider

    monkeypatch.setattr(memory_routes, "get_memory_provider", configured_provider)
    response = await client.get("/v1/memories", params={"q": "memory"})

    assert response.status_code == expected_status
    assert response.json() == {
        "detail": (
            "Memory provider request failed"
            if expected_status == 502
            else "Memory provider temporarily unavailable"
        )
    }
    assert "provider rejected" not in response.text
    assert "provider timed out" not in response.text
