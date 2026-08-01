from __future__ import annotations

from unittest.mock import MagicMock
from uuid import UUID

import pytest

from app.services.memory_provider import Mem0Provider

USER_ID = "11111111-1111-1111-1111-111111111111"
ENVIRONMENT_ID = UUID("22222222-2222-2222-2222-222222222222")


def _provider(client: MagicMock) -> Mem0Provider:
    provider = Mem0Provider.__new__(Mem0Provider)
    provider.client = client
    return provider


def _filters(*, category: str | None = None) -> dict:
    conditions: list[dict] = [{"user_id": USER_ID}]
    if category is not None:
        conditions.append({"metadata": {"category": category}})
    return {"AND": conditions}


@pytest.mark.asyncio
async def test_mem0_v3_add_and_search_use_filters_and_top_k() -> None:
    client = MagicMock()
    client.add.return_value = {"results": [{"id": "mem0-added"}]}
    client.search.return_value = {
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
    }
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
    client.add.assert_called_once_with(
        [{"role": "user", "content": "Scoped memory"}],
        filters={"user_id": USER_ID},
        metadata={
            "category": "decision",
            "source": "mcp",
            "tags": [],
            "source_environment_id": str(ENVIRONMENT_ID),
        },
    )
    client.search.assert_called_once_with(
        "Scoped",
        filters=_filters(category="decision"),
        top_k=7,
    )
    assert hits[0]["source_environment_id"] == str(ENVIRONMENT_ID)


@pytest.mark.asyncio
async def test_mem0_v3_list_and_count_preserve_server_pagination() -> None:
    client = MagicMock()
    client.get_all.side_effect = [
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
    assert client.get_all.call_args_list[0].kwargs == {
        "filters": _filters(category="fact"),
        "page": 3,
        "page_size": 10,
    }
    assert client.get_all.call_args_list[1].kwargs == {
        "filters": _filters(category="fact"),
        "page": 1,
        "page_size": 1,
    }


@pytest.mark.asyncio
async def test_mem0_delete_verifies_account_owner() -> None:
    client = MagicMock()
    client.get.side_effect = [
        {"id": "owned", "user_id": USER_ID},
        {"id": "foreign", "user_id": "another-user"},
    ]
    provider = _provider(client)

    assert await provider.delete(USER_ID, "owned") is True
    assert await provider.delete(USER_ID, "foreign") is False

    assert [call.args for call in client.get.call_args_list] == [("owned",), ("foreign",)]
    client.delete.assert_called_once_with("owned")
