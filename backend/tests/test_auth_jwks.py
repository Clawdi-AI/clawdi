from __future__ import annotations

import logging
import threading
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials

import app.core.auth as auth_module
from app.core.auth import _auth_via_clerk_jwt, get_auth, warm_clerk_jwks
from app.core.config import settings

_ISSUER = "https://clerk.example.test"
_KEY_ID = "clerk-test-key"


class _FakeJWKClient:
    def __init__(
        self,
        *,
        signing_key: jwt.PyJWK | None = None,
        error: Exception | None = None,
    ):
        self.signing_key = signing_key
        self.error = error
        self.lookup_thread_id: int | None = None

    def get_signing_key_from_jwt(self, _token: str) -> jwt.PyJWK:
        self.lookup_thread_id = threading.get_ident()
        if self.error is not None:
            raise self.error
        assert self.signing_key is not None
        return self.signing_key

    def get_signing_keys(self) -> list[object]:
        if self.error is not None:
            raise self.error
        return [object()]


def _rsa_keypair() -> tuple[str, jwt.PyJWK]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()
    jwk_data = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk_data.update({"alg": "RS256", "kid": _KEY_ID, "use": "sig"})
    return private_pem, jwt.PyJWK.from_dict(jwk_data)


def _session_token(private_pem: str, sub: str) -> str:
    return jwt.encode(
        {"sub": sub, "iss": _ISSUER},
        private_pem,
        algorithm="RS256",
        headers={"kid": _KEY_ID, "typ": "JWT"},
    )


@pytest.fixture
def jwks_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "clerk_pem_public_key", "")
    monkeypatch.setattr(settings, "clerk_jwt_issuer", _ISSUER)
    monkeypatch.setattr(settings, "clerk_jwt_audience", "")
    monkeypatch.setattr(settings, "dev_auth_bypass", False)


@pytest.mark.asyncio
async def test_clerk_jwks_verifies_token_off_event_loop(
    db_session,
    jwks_settings: None,
    monkeypatch: pytest.MonkeyPatch,
):
    private_pem, signing_key = _rsa_keypair()
    client = _FakeJWKClient(signing_key=signing_key)
    monkeypatch.setattr(auth_module, "_clerk_jwks_client", client)

    context = await _auth_via_clerk_jwt(
        _session_token(private_pem, f"user_jwks_{uuid.uuid4().hex}"),
        db_session,
    )

    assert context is not None
    assert client.lookup_thread_id is not None
    assert client.lookup_thread_id != threading.get_ident()


@pytest.mark.asyncio
async def test_clerk_jwks_unknown_kid_returns_unauthorized(
    db_session,
    jwks_settings: None,
    monkeypatch: pytest.MonkeyPatch,
):
    private_pem, _ = _rsa_keypair()
    client = _FakeJWKClient(
        error=jwt.PyJWKClientError(f'Unable to find a signing key that matches: "{_KEY_ID}"')
    )
    monkeypatch.setattr(auth_module, "_clerk_jwks_client", client)
    credentials = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=_session_token(private_pem, f"user_unknown_kid_{uuid.uuid4().hex}"),
    )

    with pytest.raises(HTTPException) as exc_info:
        await get_auth(credentials, db_session)

    assert exc_info.value.status_code == status.HTTP_401_UNAUTHORIZED


@pytest.mark.asyncio
async def test_clerk_jwks_fetch_failure_returns_service_unavailable(
    db_session,
    jwks_settings: None,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    private_pem, _ = _rsa_keypair()
    client = _FakeJWKClient(error=jwt.PyJWKClientConnectionError("JWKS endpoint unavailable"))
    monkeypatch.setattr(auth_module, "_clerk_jwks_client", client)
    credentials = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=_session_token(private_pem, f"user_jwks_failure_{uuid.uuid4().hex}"),
    )

    with caplog.at_level(logging.ERROR, logger="app.core.auth"):
        with pytest.raises(HTTPException) as exc_info:
            await get_auth(credentials, db_session)

    assert exc_info.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert "Clerk JWKS signing-key lookup failed." in caplog.messages


@pytest.mark.asyncio
async def test_clerk_jwks_warmup_failure_does_not_block_startup(
    jwks_settings: None,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    client = _FakeJWKClient(error=jwt.PyJWKClientConnectionError("JWKS endpoint unavailable"))
    monkeypatch.setattr(auth_module, "_clerk_jwks_client", client)

    with caplog.at_level(logging.WARNING, logger="app.core.auth"):
        await warm_clerk_jwks()

    assert "Clerk JWKS warmup failed." in caplog.messages
