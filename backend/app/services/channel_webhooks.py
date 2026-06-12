from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from fastapi import HTTPException, status

from app.models.channel import ChannelAccount, ChannelBotAgentLink
from app.services.metrics import webhook_deliveries
from app.services.url_security import UnsafeOutboundUrlError, validate_outbound_url
from app.services.vault_crypto import decrypt_field, encrypt_field


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def _account_config(account: ChannelAccount) -> dict[str, Any]:
    return account.config if isinstance(account.config, dict) else {}


def bluebubbles_webhook_config(account: ChannelAccount) -> dict[str, Any]:
    webhook = _account_config(account).get("bluebubbles_webhook")
    return webhook if isinstance(webhook, dict) else {}


def bluebubbles_webhook_password(account: ChannelAccount) -> str | None:
    encrypted = _optional_str(bluebubbles_webhook_config(account).get("password_encrypted"))
    if encrypted is None:
        return _optional_str(bluebubbles_webhook_config(account).get("password"))
    return decrypt_field(encrypted)


def bluebubbles_webhook_update(
    *,
    url: str,
    events: list[Any],
    password: str,
) -> dict[str, Any]:
    return {
        "url": url,
        "events": events,
        "password_encrypted": encrypt_field(password),
    }


def telegram_link_webhook_config(link: ChannelBotAgentLink) -> dict[str, Any]:
    config = link.config if isinstance(link.config, dict) else {}
    webhook = config.get("telegram_webhook")
    return webhook if isinstance(webhook, dict) else {}


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


async def deliver_bluebubbles_agent_webhook(
    account: ChannelAccount,
    event_type: str,
    data: dict[str, Any],
) -> bool:
    webhook = bluebubbles_webhook_config(account)
    url = _optional_str(webhook.get("url"))
    if not url:
        return False
    password = bluebubbles_webhook_password(account)
    delivery_url = _webhook_url_with_password(url, password) if password else url
    headers = {"x-password": password} if password else None
    try:
        await validate_agent_webhook_url(account, url)
    except HTTPException:
        return False
    for _attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    delivery_url,
                    headers=headers,
                    json={"type": event_type, "data": data},
                )
        except httpx.HTTPError:
            webhook_deliveries.labels(outcome="failure").inc()
            continue
        if response.status_code < 400:
            webhook_deliveries.labels(outcome="success").inc()
            return True
        if response.status_code < 500:
            webhook_deliveries.labels(outcome="failure").inc()
            return False
        webhook_deliveries.labels(outcome="failure").inc()
    return False


async def deliver_telegram_agent_webhook(
    account: ChannelAccount,
    link: ChannelBotAgentLink,
    payload: dict[str, Any],
) -> bool:
    webhook = telegram_link_webhook_config(link)
    url = _optional_str(webhook.get("url"))
    if not url:
        return False
    try:
        await validate_agent_webhook_url(account, url)
    except HTTPException:
        webhook_deliveries.labels(outcome="failure").inc()
        return False
    headers: dict[str, str] = {}
    secret_token = _optional_str(webhook.get("secret_token"))
    if secret_token:
        headers["X-Telegram-Bot-Api-Secret-Token"] = secret_token
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError:
        webhook_deliveries.labels(outcome="failure").inc()
        return False
    if response.status_code < 400:
        webhook_deliveries.labels(outcome="success").inc()
        return True
    webhook_deliveries.labels(outcome="failure").inc()
    return False


def _webhook_url_with_password(url: str, password: str) -> str:
    parsed = urlparse(url)
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != "password"
    ]
    query.append(("password", password))
    return urlunparse(parsed._replace(query=urlencode(query)))
