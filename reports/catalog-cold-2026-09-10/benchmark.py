"""Controlled SDK transport benchmark; no provider traffic or credentials.

Run in the locked backend environment with PYTHONPATH pointing at backend.
"""

import asyncio
import json
import time
from collections import Counter

import httpx
from composio_client import AsyncComposio
from fastapi import FastAPI

from app.core.auth import AuthContext, require_user_auth_short_session
from app.core.config import settings
from app.models.user import User
from app.routes.connectors import router
from app.services import composio


async def measure(concurrency: int) -> dict:
    counts = Counter()
    latencies = {"toolkits": [760, 784], "auth_configs": [428, 419, 353, 369, 317]}

    async def handle(request: httpx.Request) -> httpx.Response:
        resource = request.url.path.rsplit("/", 1)[-1]
        params = dict(request.url.params)
        page = int(params.pop("cursor", "0"))
        expected = (
            {"managed_by": "composio", "sort_by": "usage", "limit": "1000"}
            if resource == "toolkits"
            else {"is_composio_managed": "false", "show_disabled": "false", "limit": "50"}
        )
        assert params == expected
        counts[resource] += 1
        await asyncio.sleep(latencies[resource][page] / 1000)
        if resource == "toolkits":
            items = [
                {
                    "slug": f"toolkit_{i}",
                    "name": f"Toolkit {i}",
                    "meta": {"logo": "", "description": "Synthetic catalog entry"},
                    "auth_schemes": ["OAUTH2"],
                    "composio_managed_auth_schemes": [] if i < 248 else ["OAUTH2"],
                }
                for i in range(page * 1000, min((page + 1) * 1000, 1100))
            ]
            total = 1100
        else:
            items = [
                {
                    "id": f"ac_{i}",
                    "uuid": f"uuid_{i}",
                    "name": f"Config {i}",
                    "no_of_connections": 0,
                    "status": "ENABLED",
                    "tool_access_config": {},
                    "toolkit": {"slug": f"toolkit_{i}", "logo": ""},
                    "type": "custom",
                    "auth_scheme": "OAUTH2",
                    "is_composio_managed": False,
                }
                for i in range(page * 50, min((page + 1) * 50, 248))
            ]
            total = 248
        return httpx.Response(
            200,
            json={
                "items": items,
                "current_page": page + 1,
                "total_items": total,
                "total_pages": len(latencies[resource]),
                "next_cursor": str(page + 1) if page + 1 < len(latencies[resource]) else None,
            },
        )

    composio._toolkits_cache = None
    composio._toolkits_cache_at = None
    composio._toolkits_cache_lock = asyncio.Lock()
    composio._custom_auth_config_index = None
    composio._custom_auth_config_index_at = None
    if hasattr(composio, "_custom_auth_config_index_lock"):
        composio._custom_auth_config_index_lock = asyncio.Lock()
    app = FastAPI()
    app.include_router(router, prefix="/v1")
    app.dependency_overrides[require_user_auth_short_session] = lambda: AuthContext(
        user=User(clerk_id="benchmark", email="benchmark@example.test")
    )
    settings.composio_api_key = "isolated-test"
    async with (
        AsyncComposio(
            api_key="isolated-test",
            max_retries=0,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        ) as sdk,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as browser,
    ):
        composio._client = sdk

        async def request() -> float:
            started = time.perf_counter()
            response = await browser.get("/v1/connectors/available?page=1&page_size=24")
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["total"] == 1100 and len(body["items"]) == 24
            assert all(not item["connect_disabled"] for item in body["items"])
            return round((time.perf_counter() - started) * 1000, 1)

        cold_ms = await asyncio.gather(*(request() for _ in range(concurrency)))
        cold_calls = dict(counts)
        counts.clear()
        warm_ms = await request()
        composio._client = None
        return {
            "n": concurrency,
            "cold_ms": cold_ms,
            "cold_calls": cold_calls,
            "warm_ms": warm_ms,
            "warm_calls": dict(counts),
        }


async def main() -> None:
    print(json.dumps([await measure(n) for n in (1, 4, 8)], indent=2))


if __name__ == "__main__":
    asyncio.run(main())
