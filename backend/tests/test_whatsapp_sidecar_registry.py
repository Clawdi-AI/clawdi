from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest

from app.services.whatsapp_sidecar_client import WhatsAppSidecarConfig, WhatsAppSidecarProtocolError
from app.services.whatsapp_sidecar_registry import (
    ConfiguredWhatsAppSidecarRegistry,
    get_configured_whatsapp_sidecar_client,
    parse_whatsapp_sidecar_registrations,
    whatsapp_sidecar_status,
)


class _FakeSidecarClient:
    def __init__(self, config: WhatsAppSidecarConfig) -> None:
        self.config = config
        self.connected = None
        self.closed = False
        self.actions: list[str] = []
        self.health_error: Exception | None = None

    async def health(self):
        if self.health_error is not None:
            raise self.health_error
        self.connected = True
        return {"status": "connected", "connected": True}

    async def close(self) -> None:
        self.closed = True


def _config(account_id: UUID, **changes: object) -> str:
    config: dict[str, object] = {
        "account_id": str(account_id),
        "base_url": "http://sidecar.local",
        "api_token": "internal-api-token",
        "timeout_seconds": 2.5,
        "media_download_max_bytes": 16 * 1024 * 1024,
    }
    config.update(changes)
    return json.dumps({str(account_id): config})


def test_parse_whatsapp_sidecar_registry_binds_account_and_internal_token():
    account_id = uuid4()
    parsed = parse_whatsapp_sidecar_registrations(_config(account_id))

    assert parsed[account_id].account_id == account_id
    assert parsed[account_id].base_url == "http://sidecar.local"
    assert parsed[account_id].api_token == "internal-api-token"
    assert parsed[account_id].media_download_max_bytes == 16 * 1024 * 1024
    assert "internal-api-token" not in repr(parsed[account_id])


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        '{"not-a-uuid": {}}',
        '{"00000000-0000-0000-0000-000000000001": {"base_url": "http://sidecar"}}',
        (
            '{"00000000-0000-0000-0000-000000000001": '
            '{"account_id": "00000000-0000-0000-0000-000000000002", '
            '"base_url": "http://sidecar", "api_token": "token"}}'
        ),
        (
            '{"00000000-0000-0000-0000-000000000001": '
            '{"base_url": "http://sidecar", "api_token": "token", '
            '"ingress_token": "plaintext-callback-token"}}'
        ),
        (
            '{"00000000-0000-0000-0000-000000000001": '
            '{"base_url": "http://sidecar", "api_token": "one"}, '
            '"00000000-0000-0000-0000-000000000002": '
            '{"base_url": "http://sidecar", "api_token": "two"}}'
        ),
        (
            '{"00000000-0000-0000-0000-000000000001": '
            '{"base_url": "http://one", "api_token": "one"}, '
            '"00000000-0000-0000-0000-000000000001": '
            '{"base_url": "http://two", "api_token": "two"}}'
        ),
    ],
)
def test_parse_whatsapp_sidecar_registry_rejects_duplicates_and_mismatches(raw: str):
    with pytest.raises(ValueError):
        parse_whatsapp_sidecar_registrations(raw)


@pytest.mark.asyncio
async def test_registry_has_one_active_client_per_account_and_cleans_up():
    account_id = uuid4()
    clients: list[_FakeSidecarClient] = []

    def factory(config: WhatsAppSidecarConfig):
        client = _FakeSidecarClient(config)
        clients.append(client)
        return client

    registry = ConfiguredWhatsAppSidecarRegistry(_config(account_id), client_factory=factory)
    await registry.start()
    assert get_configured_whatsapp_sidecar_client(account_id) is clients[0]
    assert whatsapp_sidecar_status(account_id) == {
        "mode": "sidecar",
        "configured": True,
        "connected": True,
    }

    duplicate = ConfiguredWhatsAppSidecarRegistry(_config(account_id), client_factory=factory)
    with pytest.raises(ValueError, match="duplicate active"):
        await duplicate.start()

    await registry.stop()
    assert clients[0].closed is True
    assert get_configured_whatsapp_sidecar_client(account_id) is None


@pytest.mark.asyncio
async def test_registry_fails_closed_and_unregisters_on_health_contract_mismatch():
    account_id = uuid4()
    clients: list[_FakeSidecarClient] = []

    def factory(config: WhatsAppSidecarConfig):
        client = _FakeSidecarClient(config)
        client.health_error = WhatsAppSidecarProtocolError("sidecar accountId mismatch")
        clients.append(client)
        return client

    registry = ConfiguredWhatsAppSidecarRegistry(_config(account_id), client_factory=factory)
    with pytest.raises(WhatsAppSidecarProtocolError, match="accountId mismatch"):
        await registry.start()

    assert clients[0].closed is True
    assert get_configured_whatsapp_sidecar_client(account_id) is None
