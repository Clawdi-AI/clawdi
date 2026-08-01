from __future__ import annotations

import pytest

from app.services.url_security import (
    UnsafePublicHttpsUrlError,
    is_public_https_url,
    validate_public_https_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "https://provider.example",
        "https://provider.example/v1",
        "https://provider.example:8443/v1",
        "https://provider.example/v1;transport=responses",
        "https://8.8.8.8/v1",
        "https://[2001:4860:4860::8888]/v1",
    ],
)
def test_public_https_url_accepts_public_host_shapes(url: str) -> None:
    validate_public_https_url(url, label="base_url")
    assert is_public_https_url(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "http://provider.example/v1",
        "https:///v1",
        "https://user@provider.example/v1",
        "https://user:password@provider.example/v1",
        "https://provider.example/v1?",
        "https://provider.example/v1?mode=responses",
        "https://provider.example/v1#",
        "https://provider.example/v1#fragment",
        " https://provider.example/v1",
        "https://provider.example/v1 ",
        "https://provider.example;transport=responses/v1",
        "https://localhost/v1",
        "https://provider.local/v1",
        "https://provider.internal/v1",
        "https://provider.home.arpa/v1",
        "https://provider.svc/v1",
        "https://127.0.0.1/v1",
        "https://10.0.0.1/v1",
        "https://169.254.169.254/v1",
        "https://192.0.2.1/v1",
        "https://224.0.0.1/v1",
        "https://[::1]/v1",
        "https://[::ffff:127.0.0.1]/v1",
        "https://[2001:db8::1]/v1",
    ],
)
def test_public_https_url_rejects_non_hosted_shapes(url: str) -> None:
    with pytest.raises(UnsafePublicHttpsUrlError):
        validate_public_https_url(url, label="base_url")
    assert is_public_https_url(url) is False
