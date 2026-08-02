from __future__ import annotations

from uuid import UUID

import pytest

from app.services.memory_provider import Mem0Provider

USER_ID = "11111111-1111-1111-1111-111111111111"
ENVIRONMENT_ID = UUID("22222222-2222-2222-2222-222222222222")


class _RecordingMem0Client:
    def __init__(
        self,
        *,
        add_result: object = None,
        search_result: object = None,
        get_all_results: list[object] | None = None,
        get_results: list[object] | None = None,
    ) -> None:
        self.add_result = add_result
        self.search_result = search_result
        self.get_all_results = list(get_all_results or [])
        self.get_results = list(get_results or [])
        self.add_calls: list[tuple[list[dict[str, str]], dict[str, object], dict[str, object]]] = []
        self.search_calls: list[tuple[str, dict[str, object], int]] = []
        self.get_all_calls: list[tuple[dict[str, object], int, int]] = []
        self.get_calls: list[str] = []
        self.delete_calls: list[str] = []

    def add(
        self,
        messages: list[dict[str, str]],
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

    def delete(self, memory_id: str) -> None:
        self.delete_calls.append(memory_id)


def _provider(client: _RecordingMem0Client) -> Mem0Provider:
    provider = Mem0Provider.__new__(Mem0Provider)
    provider.client = client
    return provider


def _filters(*, category: str | None = None) -> dict[str, object]:
    conditions: list[dict[str, object]] = [{"user_id": USER_ID}]
    if category is not None:
        conditions.append({"metadata": {"category": category}})
    return {"AND": conditions}


@pytest.mark.asyncio
async def test_mem0_v3_add_and_search_use_filters_and_top_k() -> None:
    client = _RecordingMem0Client(
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
    provider = _provider(client)

    added = await provider.add(
        USER_ID,
        "Scoped memory",
        category="decision",
        source="mcp",
        source_environment_id=ENVIRONMENT_ID,
    )
    hits = await provider.search(
        USER_ID,
        "Scoped",
        limit=7,
        category="decision",
    )

    assert added == {"id": "mem0-added"}
    assert client.add_calls == [
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
    assert client.search_calls == [("Scoped", _filters(category="decision"), 7)]
    assert hits[0]["source_environment_id"] == str(ENVIRONMENT_ID)


@pytest.mark.asyncio
async def test_mem0_v3_list_and_count_preserve_server_pagination() -> None:
    client = _RecordingMem0Client(
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
    provider = _provider(client)

    rows = await provider.list_all(
        USER_ID,
        limit=10,
        offset=20,
        category="fact",
    )
    total = await provider.count(
        USER_ID,
        category="fact",
    )

    assert [row["id"] for row in rows] == ["page-three"]
    assert total == 23
    assert client.get_all_calls == [
        (_filters(category="fact"), 3, 10),
        (_filters(category="fact"), 1, 1),
    ]


@pytest.mark.asyncio
async def test_mem0_delete_verifies_account_owner() -> None:
    client = _RecordingMem0Client(
        get_results=[
            {"id": "owned", "user_id": USER_ID},
            {"id": "foreign", "user_id": "another-user"},
        ]
    )
    provider = _provider(client)

    assert await provider.delete(USER_ID, "owned") is True
    assert await provider.delete(USER_ID, "foreign") is False

    assert client.get_calls == ["owned", "foreign"]
    assert client.delete_calls == ["owned"]
