from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from uuid import UUID

from app.core.config import settings
from app.models.channel import CHANNEL_PROVIDER_WHATSAPP, ChannelAccount
from app.services.whatsapp_native_transport import (
    WhatsAppBaileysSidecarConfig,
    WhatsAppBaileysSidecarService,
    WhatsAppProviderTransportAdapter,
)

DEFAULT_WHATSAPP_SIDECAR_SOCKET_PATH = "/run/clawdi-whatsapp/sidecar.sock"

_delivery_sidecar_service: WhatsAppBaileysSidecarService | None = None


def resolve_whatsapp_delivery_transport(
    account: ChannelAccount,
) -> WhatsAppProviderTransportAdapter | None:
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        return None
    config = account.config if isinstance(account.config, dict) else {}
    connection_mode = config.get("connection_mode")
    if connection_mode == "baileys_managed":
        session_id = account.id
    elif connection_mode == "baileys_custom":
        session_id = configured_whatsapp_sidecar_session_id(config)
    else:
        return None
    if session_id is None:
        return None

    service_config = _configured_delivery_service()
    if service_config is None:
        return None
    session_config = replace(service_config, account_id=session_id)
    if config.get("sidecar_config_revision") != session_config.binding_revision:
        return None

    global _delivery_sidecar_service
    if _delivery_sidecar_service is None:
        _delivery_sidecar_service = WhatsAppBaileysSidecarService(service_config)
    return WhatsAppProviderTransportAdapter(_delivery_sidecar_service.session_client(session_id))


def _configured_delivery_service() -> WhatsAppBaileysSidecarConfig | None:
    api_token = settings.channel_whatsapp_baileys_sidecar_token.get_secret_value().strip()
    if not api_token:
        return None
    base_url = settings.channel_whatsapp_baileys_sidecar_url.strip() or None
    return WhatsAppBaileysSidecarConfig(
        api_token=api_token,
        base_url=base_url,
        unix_socket_path=None if base_url else DEFAULT_WHATSAPP_SIDECAR_SOCKET_PATH,
    )


def configured_whatsapp_sidecar_session_id(config: Mapping[str, object]) -> UUID | None:
    raw = config.get("sidecar_account_id")
    try:
        return UUID(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
