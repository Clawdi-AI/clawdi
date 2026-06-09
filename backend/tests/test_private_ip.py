from __future__ import annotations

import socket

import pytest

from app.services.private_ip import has_private_resolved_ip, is_private_hostname


@pytest.mark.parametrize(
    "hostname",
    [
        "127.0.0.1",
        "127.5.5.5",
        "::1",
        "0:0:0:0:0:0:0:1",
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "192.168.255.255",
        "169.254.169.254",
        "169.254.0.1",
        "0.0.0.0",
        "100.64.0.1",
        "100.127.255.255",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "[::1]",
        "[fe80::1]",
        "localhost",
        "ip6-localhost",
        "metadata.google.internal",
        "metadata",
        "foo.local",
        "anything.localhost",
        "",
        "  ",
    ],
)
def test_is_private_hostname_blocks_private_ranges_and_aliases(hostname: str):
    assert is_private_hostname(hostname) is True


@pytest.mark.parametrize(
    "hostname",
    [
        "172.15.0.1",
        "172.32.0.1",
        "100.128.0.1",
        "example.com",
        "api.example.com",
        "8.8.8.8",
        "1.1.1.1",
        "2001:4860:4860::8888",
    ],
)
def test_is_private_hostname_allows_public_hosts(hostname: str):
    assert is_private_hostname(hostname) is False


@pytest.mark.asyncio
async def test_has_private_resolved_ip_blocks_private_dns(monkeypatch):
    def fake_getaddrinfo(host, port):
        assert host == "public-name.example"
        assert port is None
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                ("10.0.0.10", 0),
            )
        ]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    assert await has_private_resolved_ip("public-name.example") is True


@pytest.mark.asyncio
async def test_has_private_resolved_ip_blocks_unresolved_dns(monkeypatch):
    def fake_getaddrinfo(host, port):
        assert host == "unresolved.example"
        assert port is None
        raise socket.gaierror

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    assert await has_private_resolved_ip("unresolved.example") is True


@pytest.mark.asyncio
async def test_has_private_resolved_ip_blocks_dns_os_errors(monkeypatch):
    def fake_getaddrinfo(host, port):
        assert host == "timeout.example"
        assert port is None
        raise TimeoutError

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    assert await has_private_resolved_ip("timeout.example") is True


@pytest.mark.asyncio
async def test_has_private_resolved_ip_blocks_empty_dns_results(monkeypatch):
    def fake_getaddrinfo(host, port):
        assert host == "empty.example"
        assert port is None
        return []

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    assert await has_private_resolved_ip("empty.example") is True
