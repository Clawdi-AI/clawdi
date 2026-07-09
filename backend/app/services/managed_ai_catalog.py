from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import settings
from app.schemas.ai_provider import AiProviderModel

log = logging.getLogger(__name__)

_DEFAULT_MANAGED_AI_MODELS = [{"id": "gpt-5.5"}]
_MANAGED_AI_GATEWAY_TIMEOUT_SECONDS = 5.0
_MANAGED_AI_GATEWAY_USER_AGENT = "clawdi-managed-ai-catalog/1.0"


@dataclass(frozen=True)
class ManagedAiCatalogSnapshot:
    source: str
    models: list[AiProviderModel]


async def load_managed_ai_catalog() -> ManagedAiCatalogSnapshot:
    gateway_models = await _load_gateway_models()
    if gateway_models:
        return ManagedAiCatalogSnapshot(source="gateway", models=gateway_models)
    return ManagedAiCatalogSnapshot(source="fallback", models=_load_fallback_models())


async def _load_gateway_models() -> list[AiProviderModel]:
    base_url = settings.managed_ai_catalog_base_url.strip()
    api_key = settings.managed_ai_catalog_api_key.strip()
    if not base_url or not api_key:
        return []

    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        log.warning("managed_ai_catalog_invalid_base_url")
        return []

    try:
        payload = await _fetch_gateway_models_payload(_gateway_models_url(base_url), api_key)
    except Exception as exc:  # noqa: BLE001 - fallback path must never hard-fail callers
        log.warning("managed_ai_catalog_gateway_fetch_failed: %s", exc)
        return []

    models = _normalize_models(payload)
    if models:
        return models
    log.warning("managed_ai_catalog_gateway_payload_invalid")
    return []


async def _fetch_gateway_models_payload(url: str, api_key: str) -> Any:
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=_MANAGED_AI_GATEWAY_TIMEOUT_SECONDS,
    ) as client:
        response = await client.get(
            url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": _MANAGED_AI_GATEWAY_USER_AGENT,
            },
        )
        response.raise_for_status()
        return response.json()


def _load_fallback_models() -> list[AiProviderModel]:
    raw = settings.managed_ai_catalog_fallback_json.strip()
    if raw:
        try:
            models = _normalize_models(json.loads(raw))
        except json.JSONDecodeError as exc:
            log.warning("managed_ai_catalog_fallback_invalid_json: %s", exc)
        else:
            if models:
                return models
            log.warning("managed_ai_catalog_fallback_invalid_payload")
    return _normalize_models(_DEFAULT_MANAGED_AI_MODELS)


def _gateway_models_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1/models"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/models"
    return f"{normalized}/v1/models"


def _normalize_models(payload: Any) -> list[AiProviderModel]:
    raw_models: Any
    if isinstance(payload, dict):
        raw_models = payload.get("models")
        if raw_models is None:
            raw_models = payload.get("data")
    else:
        raw_models = payload
    if not isinstance(raw_models, list):
        return []

    models: list[AiProviderModel] = []
    seen: set[str] = set()
    for entry in raw_models:
        model = _normalize_model(entry)
        if model is None or model.id in seen:
            continue
        seen.add(model.id)
        models.append(model)
    return models


def _normalize_model(entry: Any) -> AiProviderModel | None:
    if isinstance(entry, str):
        model_id = entry.strip()
        return AiProviderModel(id=model_id) if model_id else None
    if not isinstance(entry, dict):
        return None

    payload = dict(entry)
    slug = payload.get("slug")
    if "id" not in payload and isinstance(slug, str):
        payload["id"] = slug
    display_name = payload.get("display_name")
    if "label" not in payload and isinstance(display_name, str) and display_name.strip():
        payload["label"] = display_name.strip()
    if "context_window" not in payload:
        payload["context_window"] = _positive_int(
            payload.get("context_length"),
        ) or _positive_int(payload.get("max_input_tokens"))
    if "max_tokens" not in payload:
        payload["max_tokens"] = _positive_int(payload.get("max_output_tokens"))
    try:
        model = AiProviderModel.model_validate(payload)
    except Exception:
        return None
    return model if model.id.strip() else None


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float) and value.is_integer() and value > 0:
        return int(value)
    return None
