from __future__ import annotations

import httpx
import pytest

from app.services.memory_provider import _reciprocal_rank_fusion
from app.services.memory_types import MemoryItem


def _hit(memory_id: str, content: str) -> MemoryItem:
    return {"id": memory_id, "content": content}


def test_reciprocal_rank_fusion_rewards_results_found_by_both_retrievers() -> None:
    lexical = [_hit("shared", "shared"), _hit("lexical", "lexical")]
    semantic = [_hit("semantic", "semantic"), _hit("shared", "shared")]

    assert [item["id"] for item in _reciprocal_rank_fusion((lexical, semantic), 3)] == [
        "shared",
        "semantic",
        "lexical",
    ]


@pytest.mark.asyncio
async def test_memory_search_escapes_wildcards_and_keeps_typo_recall(
    client: httpx.AsyncClient,
) -> None:
    memories = [
        "Release marker is 100%_ready for the staged rollout.",
        "Use the deployment handoff checklist before promoting.",
        "Unrelated preference about concise status reports.",
    ]
    for content in memories:
        response = await client.post("/v1/memories", json={"content": content, "category": "fact"})
        assert response.status_code == 200, response.text

    wildcard = await client.get("/v1/memories", params={"q": "%_"})
    assert wildcard.status_code == 200, wildcard.text
    assert [item["content"] for item in wildcard.json()["items"]] == [memories[0]]

    typo = await client.get("/v1/memories", params={"q": "deployment handof checklist"})
    assert typo.status_code == 200, typo.text
    assert memories[1] in [item["content"] for item in typo.json()["items"]]


@pytest.mark.asyncio
async def test_global_memory_search_returns_context_around_the_match(
    client: httpx.AsyncClient,
) -> None:
    needle = "deployment handoff marker"
    content = f"{'Earlier context. ' * 30}{needle}. {'Later context. ' * 30}"
    created = await client.post(
        "/v1/memories",
        json={"content": content, "category": "decision"},
    )
    assert created.status_code == 200, created.text

    response = await client.get("/v1/search", params={"q": f"  {needle}  "})
    assert response.status_code == 200, response.text
    hit = next(item for item in response.json()["results"] if item["type"] == "memory")
    assert hit["title"].startswith("...")
    assert needle in hit["title"]
    assert hit["title"].endswith("...")
    assert hit["href"] == f"/memories/{created.json()['id']}"
