from __future__ import annotations

import asyncio
import socket
import ssl
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app.services import safe_public_http
from app.services.safe_public_http import (
    SafePublicHttpClient,
    SafePublicHttpConnectError,
    SafePublicHttpDnsTimeout,
    SafePublicHttpResponseTooLarge,
    SafePublicHttpTimeout,
    SafePublicHttpTlsError,
    UnsafePublicHttpUrlError,
    resolve_public_http_target,
)


def _write_local_tls_certificate(tmp_path: Path, hostname: str) -> tuple[Path, Path]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(minutes=10))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(hostname)]),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    certificate_path = tmp_path / "safe-public-http-cert.pem"
    key_path = tmp_path / "safe-public-http-key.pem"
    certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return certificate_path, key_path


def test_public_url_rejects_embedded_userinfo_without_echoing_credentials() -> None:
    url = "https://agent-user:must-stay-secret@public.example.test/hook"

    with pytest.raises(UnsafePublicHttpUrlError) as caught:
        safe_public_http.parse_public_http_url(url)

    assert caught.value.reason == "invalid"
    assert "must-stay-secret" not in str(caught.value)
    assert url not in str(caught.value)


def test_public_url_preserves_supported_query_credentials() -> None:
    url = "https://public.example.test/hook?password=bluebubbles-secret"

    parsed = safe_public_http.parse_public_http_url(url)

    assert str(parsed) == url


@pytest.mark.parametrize(
    "url",
    [
        "https://public.example.test:0/hook",
        "https://public.example.test:65536/hook",
    ],
)
def test_public_url_rejects_invalid_network_ports(url: str) -> None:
    with pytest.raises(UnsafePublicHttpUrlError) as caught:
        safe_public_http.parse_public_http_url(url)

    assert caught.value.reason == "invalid"
    assert url not in str(caught.value)


@pytest.mark.asyncio
async def test_public_resolver_rejects_mixed_dns_even_after_address_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lookups: list[tuple[object, ...]] = []

    def mixed_getaddrinfo(*args: object) -> list[tuple[object, ...]]:
        lookups.append(args)
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("9.9.9.9", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("208.67.222.222", 443)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 443)),
        ]

    monkeypatch.setattr(socket, "getaddrinfo", mixed_getaddrinfo)

    with pytest.raises(UnsafePublicHttpUrlError) as caught:
        await resolve_public_http_target("https://mixed.example.test/hook")

    assert caught.value.reason == "private_address"
    assert len(lookups) == 1


@pytest.mark.asyncio
async def test_public_resolver_has_a_bounded_dns_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def never_returns(*_args: object, **_kwargs: object) -> object:
        await asyncio.Future()
        raise AssertionError("unreachable")

    monkeypatch.setattr(asyncio, "to_thread", never_returns)

    with pytest.raises(SafePublicHttpDnsTimeout):
        await resolve_public_http_target(
            "https://slow.example.test/hook",
            dns_timeout_seconds=0.001,
        )


@pytest.mark.asyncio
async def test_client_total_timeout_includes_dns_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def slow_resolution(
        _hostname: str,
        _port: int,
        *,
        timeout_seconds: float,
    ) -> tuple[str, ...]:
        assert timeout_seconds == 1.0
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(safe_public_http, "_resolve_public_addresses", slow_resolution)

    with pytest.raises(SafePublicHttpTimeout):
        await SafePublicHttpClient(
            dns_timeout_seconds=1.0,
            total_timeout_seconds=0.001,
        ).post("https://slow.example.test/hook")


@pytest.mark.asyncio
async def test_real_transport_pins_dns_host_sni_ignores_proxy_and_never_follows_redirects(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hostname = "agent.example.test"
    certificate_path, key_path = _write_local_tls_certificate(tmp_path, hostname)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(certificate_path, key_path)
    observed_sni: list[str | None] = []
    observed_requests: list[str] = []
    observed_server_hosts: list[str] = []
    server_context.set_servername_callback(
        lambda _socket, server_name, _context: observed_sni.append(server_name)
    )
    responses = [
        (301, b"redirect-body-must-not-be-read"),
        (200, b"oversized"),
    ]

    async def handle_connection(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            observed_server_hosts.append(writer.get_extra_info("sockname")[0])
            raw_headers = await reader.readuntil(b"\r\n\r\n")
            headers = raw_headers.decode("ascii")
            observed_requests.append(headers)
            content_length = 0
            for line in headers.split("\r\n"):
                if line.lower().startswith("content-length:"):
                    content_length = int(line.split(":", 1)[1].strip())
            if content_length:
                await reader.readexactly(content_length)
            status_code, body = responses.pop(0)
            extra_headers = (
                b"Location: /must-not-be-followed\r\n" if 300 <= status_code < 400 else b""
            )
            writer.write(
                f"HTTP/1.1 {status_code} Test\r\n".encode()
                + f"Content-Length: {len(body)}\r\n".encode()
                + extra_headers
                + b"Connection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(
        handle_connection,
        host="127.0.0.1",
        port=0,
        ssl=server_context,
    )
    assert server.sockets
    port = server.sockets[0].getsockname()[1]
    resolution_calls: list[tuple[str, int]] = []

    async def validated_test_resolution(
        resolved_hostname: str,
        resolved_port: int,
        *,
        timeout_seconds: float,
    ) -> tuple[str, ...]:
        assert timeout_seconds > 0
        resolution_calls.append((resolved_hostname, resolved_port))
        return ("127.0.0.1",)

    request_stage_dns: list[str] = []

    def fail_request_stage_dns(host: object, *_args: object, **_kwargs: object) -> object:
        request_stage_dns.append(str(host))
        raise AssertionError("the request stage performed a second DNS lookup")

    monkeypatch.setattr(safe_public_http, "_resolve_public_addresses", validated_test_resolution)
    monkeypatch.setattr(socket, "getaddrinfo", fail_request_stage_dns)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    client_context = ssl.create_default_context(cafile=str(certificate_path))
    client = SafePublicHttpClient(verify=client_context)
    url = f"https://{hostname}:{port}/deliver?token=must-stay-secret"

    try:
        delivered = await client.post(url, json={"attempt": "redirect"})
        assert resolution_calls == [(hostname, port)]
        assert request_stage_dns == []
        small_client = SafePublicHttpClient(verify=client_context, max_response_bytes=2)
        with pytest.raises(SafePublicHttpResponseTooLarge) as oversized:
            await small_client.post(url, json={"attempt": "oversized"})
    finally:
        server.close()
        await server.wait_closed()

    assert delivered.status_code == 301
    assert delivered.is_success is False
    assert delivered.body == b""
    assert "must-stay-secret" not in str(oversized.value)
    assert resolution_calls == [(hostname, port)] * 2
    assert request_stage_dns == []
    assert observed_server_hosts == ["127.0.0.1"] * 2
    assert observed_sni == [hostname] * 2
    assert len(observed_requests) == 2
    assert all(f"host: {hostname}:{port}\r\n" in item.lower() for item in observed_requests)
    assert all("/must-not-be-followed" not in item for item in observed_requests)


@pytest.mark.asyncio
async def test_real_transport_classifies_and_redacts_tls_hostname_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_hostname = "requested.example.test"
    certificate_hostname = "certificate.example.test"
    certificate_path, key_path = _write_local_tls_certificate(
        tmp_path,
        certificate_hostname,
    )
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(certificate_path, key_path)
    observed_sni: list[str | None] = []
    server_context.set_servername_callback(
        lambda _socket, server_name, _context: observed_sni.append(server_name)
    )

    async def handle_connection(
        _reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(
        handle_connection,
        host="127.0.0.1",
        port=0,
        ssl=server_context,
    )
    assert server.sockets
    port = server.sockets[0].getsockname()[1]
    resolution_calls: list[tuple[str, int]] = []

    async def validated_test_resolution(
        resolved_hostname: str,
        resolved_port: int,
        *,
        timeout_seconds: float,
    ) -> tuple[str, ...]:
        assert timeout_seconds > 0
        resolution_calls.append((resolved_hostname, resolved_port))
        return ("127.0.0.1",)

    request_stage_dns: list[str] = []

    def fail_request_stage_dns(host: object, *_args: object, **_kwargs: object) -> object:
        request_stage_dns.append(str(host))
        raise AssertionError("the request stage performed a second DNS lookup")

    monkeypatch.setattr(safe_public_http, "_resolve_public_addresses", validated_test_resolution)
    monkeypatch.setattr(socket, "getaddrinfo", fail_request_stage_dns)
    client_context = ssl.create_default_context(cafile=str(certificate_path))
    client = SafePublicHttpClient(verify=client_context)
    sensitive_url = f"https://{requested_hostname}:{port}/deliver?token=must-stay-secret"

    try:
        with pytest.raises(SafePublicHttpTlsError) as caught:
            await client.post(sensitive_url, json={"test": "hostname-mismatch"})
    finally:
        server.close()
        await server.wait_closed()

    assert resolution_calls == [(requested_hostname, port)]
    assert request_stage_dns == []
    assert observed_sni == [requested_hostname]
    assert requested_hostname not in str(caught.value)
    assert certificate_hostname not in str(caught.value)
    assert "must-stay-secret" not in str(caught.value)
    assert sensitive_url not in str(caught.value)


@pytest.mark.asyncio
async def test_client_retries_validated_addresses_in_order_and_redacts_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def resolve(
        _hostname: str,
        _port: int,
        *,
        timeout_seconds: float,
    ) -> tuple[str, ...]:
        assert timeout_seconds > 0
        return ("2001:4860:4860::8888", "8.8.8.8", "1.1.1.1")

    attempted: list[str] = []

    async def send(
        self: SafePublicHttpClient,
        *,
        address: str,
        **_kwargs: object,
    ) -> None:
        del self
        attempted.append(address)
        raise httpx.ConnectError(
            "https://agent.example.test/hook?token=must-stay-secret is unavailable"
        )

    monkeypatch.setattr(safe_public_http, "_resolve_public_addresses", resolve)
    monkeypatch.setattr(SafePublicHttpClient, "_send_pinned_request", send)

    with pytest.raises(SafePublicHttpConnectError) as caught:
        await SafePublicHttpClient().post("https://agent.example.test/hook?token=must-stay-secret")

    assert attempted == ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]
    assert "must-stay-secret" not in str(caught.value)
    assert "agent.example.test" not in str(caught.value)
