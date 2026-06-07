from __future__ import annotations

import base64

from app.services.metrics_auth import is_metrics_request_authorized


def _basic(user: str, password: str) -> str:
    encoded = base64.b64encode(f"{user}:{password}".encode()).decode()
    return f"Basic {encoded}"


def test_metrics_auth_allows_when_no_auth_is_configured() -> None:
    assert is_metrics_request_authorized(None)


def test_metrics_auth_supports_bearer_token() -> None:
    assert is_metrics_request_authorized(
        "Bearer secret-token",
        bearer_token="secret-token",
    )
    assert not is_metrics_request_authorized("Bearer wrong", bearer_token="secret-token")
    assert not is_metrics_request_authorized(None, bearer_token="secret-token")


def test_metrics_auth_supports_basic_auth() -> None:
    assert is_metrics_request_authorized(
        _basic("prometheus", "secret-password"),
        basic_user="prometheus",
        basic_password="secret-password",
    )
    assert not is_metrics_request_authorized(
        _basic("prometheus", "wrong"),
        basic_user="prometheus",
        basic_password="secret-password",
    )


def test_metrics_auth_rejects_malformed_basic_auth() -> None:
    assert not is_metrics_request_authorized(
        "Basic not-base64",
        basic_password="secret-password",
    )
    assert not is_metrics_request_authorized(
        f"Basic {base64.b64encode(b'no-separator').decode()}",
        basic_password="secret-password",
    )
