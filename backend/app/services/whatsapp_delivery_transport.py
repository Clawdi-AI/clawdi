from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING
from uuid import UUID

from app.models.channel import CHANNEL_PROVIDER_WHATSAPP, ChannelAccount
from app.services.whatsapp_native_transport import WhatsAppProviderTransportAdapter

if TYPE_CHECKING:
    from app.services.whatsapp_sidecar_registry import WhatsAppSidecarClient


DEFAULT_WHATSAPP_SIDECAR_SOCKET_PATH = "/run/clawdi-whatsapp/sidecar.sock"


def resolve_whatsapp_delivery_transport(
    account: ChannelAccount,
) -> WhatsAppProviderTransportAdapter | None:
    client = resolve_whatsapp_sidecar_client(account)
    return WhatsAppProviderTransportAdapter(client) if client is not None else None


def resolve_whatsapp_sidecar_client(account: ChannelAccount) -> WhatsAppSidecarClient | None:
    if account.provider != CHANNEL_PROVIDER_WHATSAPP:
        return None
    config = account.config if isinstance(account.config, dict) else {}
    session_id = whatsapp_sidecar_session_id(account)
    if session_id is None:
        return None

    # Both API and channel workers own a lifecycle-managed control pool.
    # Resolving a session here does not claim provider ingress ownership.
    from app.services.whatsapp_sidecar_registry import get_active_whatsapp_sidecar_clients

    pool = get_active_whatsapp_sidecar_clients()
    if pool is None or config.get("sidecar_config_revision") != pool.session_revision(session_id):
        return None
    return pool.session_client(session_id)


def whatsapp_sidecar_session_id(account: ChannelAccount) -> UUID | None:
    config = account.config if isinstance(account.config, dict) else {}
    if config.get("connection_mode") == "baileys_managed":
        return account.id
    if config.get("connection_mode") == "baileys_custom":
        return configured_whatsapp_sidecar_session_id(config)
    return None


def configured_whatsapp_sidecar_session_id(config: Mapping[str, object]) -> UUID | None:
    raw = config.get("sidecar_account_id")
    try:
        return UUID(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
