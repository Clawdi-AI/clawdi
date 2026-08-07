from __future__ import annotations

from fastapi import HTTPException, status
from pydantic import JsonValue, TypeAdapter, ValidationError

from app.models.channel import ChannelAccount, ChannelBotAgentLink
from app.services.metrics import webhook_deliveries
from app.services.safe_public_http import SafePublicHttpClient, SafePublicHttpError
from app.services.url_security import UnsafeOutboundUrlError, validate_outbound_url

_CONFIG_OBJECT_ADAPTER: TypeAdapter[dict[str, object]] = TypeAdapter(dict[str, object])
type JsonObject = dict[str, JsonValue]


def _optional_str(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def _config_object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    try:
        return _CONFIG_OBJECT_ADAPTER.validate_python(value, strict=True)
    except ValidationError:
        return {}


def telegram_link_webhook_config(link: ChannelBotAgentLink) -> dict[str, object]:
    config = _config_object(link.config)
    return _config_object(config.get("telegram_webhook"))


def telegram_link_webhook_url(link: ChannelBotAgentLink) -> str | None:
    return _optional_str(telegram_link_webhook_config(link).get("url"))


async def validate_agent_webhook_url(_account: ChannelAccount, url: str) -> None:
    try:
        await validate_outbound_url(
            url,
            allowed_schemes={"https"},
            label="webhook url",
        )
    except UnsafeOutboundUrlError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


async def deliver_telegram_agent_webhook(
    _account: ChannelAccount,
    link: ChannelBotAgentLink,
    payload: JsonObject,
) -> bool:
    webhook = telegram_link_webhook_config(link)
    url = _optional_str(webhook.get("url"))
    if not url:
        return False
    headers: dict[str, str] = {}
    secret_token = _optional_str(webhook.get("secret_token"))
    if secret_token:
        headers["X-Telegram-Bot-Api-Secret-Token"] = secret_token
    try:
        client = SafePublicHttpClient(timeout=10.0)
        response = await client.post(url, headers=headers, json=payload)
    except SafePublicHttpError:
        webhook_deliveries.labels(outcome="failure").inc()
        return False
    if 200 <= response.status_code < 300:
        webhook_deliveries.labels(outcome="success").inc()
        return True
    webhook_deliveries.labels(outcome="failure").inc()
    return False
