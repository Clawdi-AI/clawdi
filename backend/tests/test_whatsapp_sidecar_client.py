from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest

from app.services.whatsapp_sidecar_client import (
    WhatsAppSidecarClient,
    WhatsAppSidecarConfig,
    WhatsAppSidecarProtocolError,
    WhatsAppSidecarRejectedError,
    WhatsAppSidecarUnavailableError,
)


@pytest.mark.asyncio
async def test_sidecar_client_matches_integrated_http_contract_fixtures_exactly():
    account_id = uuid4()
    seen: list[tuple[str, str]] = []
    recover_requests: list[dict[str, object]] = []
    operation = {
        "schemaVersion": "clawdi.whatsapp.operation.v1",
        "operationId": "op-1",
        "chatJid": "15550001111@s.whatsapp.net",
        "type": "send",
        "messageId": "BACKEND-M1",
        "content": {"type": "text", "text": "hello"},
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-token"
        seen.append((request.method, request.url.path))
        if request.url.path == "/v1/health":
            return httpx.Response(
                200,
                json={
                    "status": "connected",
                    "connected": True,
                    "uptimeSeconds": 1,
                    "accountId": str(account_id),
                    "advertisedRelease": {
                        "packageName": "@whiskeysockets/baileys",
                        "packageVersion": "7.0.0-rc13",
                        "sourceCommit": "8053b086ecc97ec3f78299561de11959bab05d39",
                        "version": [2, 3000, 1035194821],
                    },
                    "versionRecoveryRequired": False,
                    "registered": False,
                    "callback": {"enabled": True, "pendingEvents": 0},
                },
                request=request,
            )
        if request.url.path == "/v1/capabilities":
            return httpx.Response(
                200,
                json={
                    "schemaVersion": "clawdi.whatsapp.sidecar-capabilities.v1",
                    "operations": ["send", "edit", "delete", "reaction", "presence", "read"],
                    "pairing": ["qr", "code", "cancel", "logout", "recover"],
                    "mediaDownload": True,
                    "callbackDelivery": True,
                    "jidKinds": ["pn", "lid", "group"],
                    "rawProviderAccess": False,
                },
                request=request,
            )
        if request.url.path == "/v1/pairing/status":
            return httpx.Response(
                200,
                json={"status": "starting", "registered": False},
                request=request,
            )
        if request.url.path == "/v1/pairing/qr":
            assert request.content == b""
            return httpx.Response(
                200,
                json={
                    "status": "pairing_qr",
                    "registered": False,
                    "method": "qr",
                    "qr": "QR-SECRET",
                },
                request=request,
            )
        if request.url.path == "/v1/pairing/code":
            assert json.loads(request.content) == {"phoneNumber": "15550001111"}
            return httpx.Response(
                200,
                json={
                    "status": "pairing_code",
                    "registered": False,
                    "method": "code",
                    "code": "CODE-SECRET",
                },
                request=request,
            )
        if request.url.path in {"/v1/pairing/cancel", "/v1/pairing/logout"}:
            assert request.content == b""
            return httpx.Response(
                200,
                json={"status": "stopped", "registered": False},
                request=request,
            )
        if request.url.path == "/v1/recover":
            recovery = json.loads(request.content)
            assert isinstance(recovery, dict)
            recover_requests.append(recovery)
            return httpx.Response(200, json={"ok": True}, request=request)
        if request.url.path == "/v1/operations":
            assert json.loads(request.content) == operation
            return httpx.Response(
                200,
                json={
                    "operationId": "op-1",
                    "status": "completed",
                    "messageId": "PROVIDER-M1",
                },
                request=request,
            )
        if request.url.path == f"/v1/media/media_{'a' * 43}":
            return httpx.Response(
                200,
                content=b"\x01\x02\x03",
                headers={"content-type": "image/jpeg"},
                request=request,
            )
        return httpx.Response(404, json={"error": "not_found"}, request=request)

    config = WhatsAppSidecarConfig(
        account_id=account_id,
        base_url="http://sidecar.local",
        api_token="test-token",
    )
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(base_url=config.base_url, transport=transport) as http_client:
        client = WhatsAppSidecarClient(config, client=http_client)
        health = await client.health()
        capabilities = await client.capabilities()
        status = await client.pairing_status()
        qr = await client.pairing_qr()
        code = await client.pairing_code(phone_number="15550001111")
        cancelled = await client.pairing_cancel()
        logged_out = await client.pairing_logout()
        await client.recover(accept_version_change=True)
        await client.recover(accept_version_change=False, reset_logged_out=True)
        result = await client.execute_operation(operation, expected_operation_id="op-1")
        media = await client.fetch_media(f"media_{'a' * 43}")

    assert health.connected is True
    assert health.status == "connected"
    assert capabilities.operations == {
        "send",
        "edit",
        "delete",
        "reaction",
        "presence",
        "read",
    }
    assert not hasattr(capabilities, "max_media_bytes")
    assert status.status == "starting"
    assert qr.qr == "QR-SECRET"
    assert code.code == "CODE-SECRET"
    assert "QR-SECRET" not in repr(qr)
    assert "CODE-SECRET" not in repr(code)
    assert cancelled.status == "stopped"
    assert logged_out.status == "stopped"
    assert recover_requests == [
        {"acceptVersionChange": True, "resetLoggedOut": False},
        {"acceptVersionChange": False, "resetLoggedOut": True},
    ]
    assert result.metadata() == {
        "transport": "whatsapp_sidecar_v1",
        "operationId": "op-1",
        "status": "completed",
        "messageId": "PROVIDER-M1",
    }
    assert media.content == b"\x01\x02\x03"
    assert seen == [
        ("GET", "/v1/health"),
        ("GET", "/v1/capabilities"),
        ("GET", "/v1/pairing/status"),
        ("POST", "/v1/pairing/qr"),
        ("POST", "/v1/pairing/code"),
        ("POST", "/v1/pairing/cancel"),
        ("POST", "/v1/pairing/logout"),
        ("POST", "/v1/recover"),
        ("POST", "/v1/recover"),
        ("POST", "/v1/operations"),
        ("GET", f"/v1/media/media_{'a' * 43}"),
    ]


@pytest.mark.asyncio
async def test_sidecar_client_rejects_health_account_mismatch():
    config = WhatsAppSidecarConfig(
        account_id=uuid4(),
        base_url="http://sidecar.local",
        api_token="token",
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "connected",
                "connected": True,
                "uptimeSeconds": 1,
                "accountId": str(uuid4()),
                "advertisedRelease": {
                    "packageName": "@whiskeysockets/baileys",
                    "packageVersion": "7.0.0-rc13",
                    "sourceCommit": "8053b086ecc97ec3f78299561de11959bab05d39",
                    "version": [2, 3000, 1035194821],
                },
                "versionRecoveryRequired": False,
                "registered": True,
                "callback": {"enabled": True, "pendingEvents": 0},
            },
            request=request,
        )

    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        client = WhatsAppSidecarClient(config, client=http_client)
        with pytest.raises(WhatsAppSidecarProtocolError, match="accountId mismatch"):
            await client.health()


@pytest.mark.asyncio
async def test_sidecar_client_maps_operation_results_and_redacts_rejections():
    responses = iter(
        [
            (422, {"operationId": "op-failed", "status": "failed", "error": "not_found"}),
            (
                409,
                {
                    "operationId": "op-ambiguous",
                    "status": "ambiguous",
                    "error": "provider_outcome_unknown",
                },
            ),
            (409, {"error": "operation_id_conflict"}),
            (401, {"error": "top-secret-token from upstream"}),
        ]
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        status, body = next(responses)
        return httpx.Response(status, json=body, request=request)

    config = WhatsAppSidecarConfig(
        account_id=uuid4(),
        base_url="http://sidecar.local",
        api_token="top-secret-token",
    )
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        client = WhatsAppSidecarClient(config, client=http_client)
        failed = await client.execute_operation({}, expected_operation_id="op-failed")
        ambiguous = await client.execute_operation({}, expected_operation_id="op-ambiguous")
        with pytest.raises(WhatsAppSidecarRejectedError) as conflict:
            await client.execute_operation({}, expected_operation_id="op-conflict")
        with pytest.raises(WhatsAppSidecarRejectedError) as rejected:
            await client.health()

    assert failed.status == "failed"
    assert failed.error_code == "not_found"
    assert ambiguous.status == "ambiguous"
    assert conflict.value.code == "operation_id_conflict"
    assert rejected.value.code == "request_rejected"
    assert "top-secret-token" not in repr(config)
    assert "top-secret-token" not in str(rejected.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("http_status", "operation_status"),
    [
        (200, "failed"),
        (200, "ambiguous"),
        (409, "completed"),
        (409, "failed"),
        (422, "completed"),
        (422, "ambiguous"),
    ],
)
async def test_sidecar_client_rejects_http_operation_outcome_mismatches(
    http_status: int,
    operation_status: str,
):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            http_status,
            json={
                "operationId": "op-inconsistent",
                "status": operation_status,
            },
            request=request,
        )

    config = WhatsAppSidecarConfig(
        account_id=uuid4(),
        base_url="http://sidecar.local",
        api_token="token",
    )
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        client = WhatsAppSidecarClient(config, client=http_client)
        with pytest.raises(
            WhatsAppSidecarProtocolError,
            match="HTTP status does not match outcome",
        ):
            await client.execute_operation({}, expected_operation_id="op-inconsistent")


@pytest.mark.asyncio
async def test_sidecar_client_maps_network_and_503_to_retryable_unavailable():
    requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        if requests == 1:
            raise httpx.ConnectError("private-sidecar-host", request=request)
        return httpx.Response(
            503,
            json={
                "operationId": "op-1",
                "status": "failed",
                "error": "baileys_not_connected",
            },
            request=request,
        )

    config = WhatsAppSidecarConfig(
        account_id=uuid4(),
        base_url="http://sidecar.local",
        api_token="token",
    )
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        client = WhatsAppSidecarClient(config, client=http_client)
        with pytest.raises(WhatsAppSidecarUnavailableError, match="sidecar unavailable"):
            await client.health()
        with pytest.raises(WhatsAppSidecarUnavailableError, match="sidecar unavailable"):
            await client.execute_operation({}, expected_operation_id="op-1")


@pytest.mark.asyncio
async def test_sidecar_client_bounds_streamed_media_before_returning_content():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"12345",
            headers={"content-type": "application/octet-stream"},
            request=request,
        )

    config = WhatsAppSidecarConfig(
        account_id=uuid4(),
        base_url="http://sidecar.local",
        api_token="token",
    )
    async with httpx.AsyncClient(
        base_url=config.base_url,
        transport=httpx.MockTransport(handler),
    ) as http_client:
        client = WhatsAppSidecarClient(config, client=http_client)
        with pytest.raises(WhatsAppSidecarRejectedError, match="media_too_large"):
            await client.fetch_media(f"media_{'a' * 43}", max_bytes=4)
