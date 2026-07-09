import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport

from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.main import app
from app.models.user import User
from app.services import managed_ai_catalog


@pytest_asyncio.fixture
async def managed_ai_client() -> AsyncIterator[httpx.AsyncClient]:
    async def _override_get_auth() -> AuthContext:
        return AuthContext(
            user=User(
                id=uuid.uuid4(),
                clerk_id="managed-ai-test",
                email="managed-ai@test.clawdi.local",
                name="Managed AI Test",
            )
        )

    app.dependency_overrides[get_auth] = _override_get_auth
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_managed_ai_models_endpoint_prefers_gateway_catalog(managed_ai_client, monkeypatch):
    previous_base_url = settings.managed_ai_catalog_base_url
    previous_api_key = settings.managed_ai_catalog_api_key
    previous_fallback = settings.managed_ai_catalog_fallback_json
    settings.managed_ai_catalog_base_url = "https://gateway.example.test/v1"
    settings.managed_ai_catalog_api_key = "sk-managed-service"
    settings.managed_ai_catalog_fallback_json = '[{"id":"fallback-model"}]'

    async def fake_fetch(url: str, api_key: str):
        assert url == "https://gateway.example.test/v1/models"
        assert api_key == "sk-managed-service"
        return {
            "object": "list",
            "data": [
                {
                    "id": "gpt-5.5",
                    "display_name": "GPT 5.5",
                    "context_length": 272000,
                    "max_output_tokens": 128000,
                },
                {"id": "gpt-5.4-mini"},
            ],
        }

    monkeypatch.setattr(managed_ai_catalog, "_fetch_gateway_models_payload", fake_fetch)
    try:
        response = await managed_ai_client.get("/v1/managed-ai/models")
    finally:
        settings.managed_ai_catalog_base_url = previous_base_url
        settings.managed_ai_catalog_api_key = previous_api_key
        settings.managed_ai_catalog_fallback_json = previous_fallback

    assert response.status_code == 200, response.text
    assert response.json() == {
        "source": "gateway",
        "models": [
            {"id": "gpt-5.5", "label": "GPT 5.5", "context_window": 272000, "max_tokens": 128000},
            {"id": "gpt-5.4-mini"},
        ],
    }


@pytest.mark.asyncio
async def test_managed_ai_models_endpoint_falls_back_to_global_config(
    managed_ai_client,
    monkeypatch,
):
    previous_base_url = settings.managed_ai_catalog_base_url
    previous_api_key = settings.managed_ai_catalog_api_key
    previous_fallback = settings.managed_ai_catalog_fallback_json
    settings.managed_ai_catalog_base_url = "https://gateway.example.test"
    settings.managed_ai_catalog_api_key = "sk-managed-service"
    settings.managed_ai_catalog_fallback_json = (
        '[{"id":"gpt-5.5"},{"id":"gpt-5.4","context_window":200000,"max_tokens":64000}]'
    )

    async def fake_fetch(_url: str, _api_key: str):
        raise RuntimeError("gateway unavailable")

    monkeypatch.setattr(managed_ai_catalog, "_fetch_gateway_models_payload", fake_fetch)
    try:
        response = await managed_ai_client.get("/v1/managed-ai/models")
    finally:
        settings.managed_ai_catalog_base_url = previous_base_url
        settings.managed_ai_catalog_api_key = previous_api_key
        settings.managed_ai_catalog_fallback_json = previous_fallback

    assert response.status_code == 200, response.text
    assert response.json() == {
        "source": "fallback",
        "models": [
            {"id": "gpt-5.5"},
            {"id": "gpt-5.4", "context_window": 200000, "max_tokens": 64000},
        ],
    }
