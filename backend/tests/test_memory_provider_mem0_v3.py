from __future__ import annotations

from unittest.mock import MagicMock
from uuid import UUID

import pytest

from app.services.memory_provider import Mem0Provider

USER_ID = "11111111-1111-1111-1111-111111111111"
ENVIRONMENT_ID = UUID("22222222-2222-2222-2222-222222222222")
SESSION_ID = UUID("33333333-3333-3333-3333-333333333333")


def _provider(client: MagicMock) -> Mem0Provider:
    provider = Mem0Provider.__new__(Mem0Provider)
    provider.client = client
    return provider


def _scoped_filters(*, category: str | None = None) -> dict:
    conditions: list[dict] = [{"user_id": USER_ID}]
    if category is not None:
        conditions.append({"metadata": {"category": category}})
    conditions.append(
        {
            "OR": [
                {"metadata": {"source_environment_id": str(ENVIRONMENT_ID)}},
                {"metadata": {"source_session_id": str(SESSION_ID)}},
            ]
        }
    )
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
        source_environment_id=ENVIRONMENT_ID,
        source_session_ids=[SESSION_ID],
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
        filters=_scoped_filters(category="decision"),
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
        source_environment_id=ENVIRONMENT_ID,
        source_session_ids=[SESSION_ID],
    )
    total = await provider.count(
        USER_ID,
        category="fact",
        source_environment_id=ENVIRONMENT_ID,
        source_session_ids=[SESSION_ID],
    )

    assert [row["id"] for row in rows] == ["page-three"]
    assert total == 23
    assert client.get_all.call_args_list[0].kwargs == {
        "filters": _scoped_filters(category="fact"),
        "page": 3,
        "page_size": 10,
    }
    assert client.get_all.call_args_list[1].kwargs == {
        "filters": _scoped_filters(category="fact"),
        "page": 1,
        "page_size": 1,
    }
