"""Clerk Public OAuth App JWT and CLI revoke-grant contracts."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from httpx import ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import app.routes.cli_auth as cli_auth_module
from app.core.auth import _auth_via_clerk_jwt, require_cli_auth, require_user_cli
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.app_setting import AppSetting
from app.models.user import User
from app.services.clerk_cli_oauth_settings import (
    CLERK_CLI_OAUTH_SETTING_ADAPTER,
    CLERK_CLI_OAUTH_SETTING_KEY,
)
from app.services.principal_lifecycle import set_clerk_principal_suspension

_ISSUER = "https://clerk.example.test"
_CLIENT_ID = "client_clawdi_cli"
_AUDIENCE = "clawdi-cloud-api"
_AUTHORIZED_PARTY = "https://accounts.clawdi.test"
_REDIRECT_URI = "http://127.0.0.1:18473/oauth/callback"
_APPLICATION_ID = "oauthapp_clawdi_cli"
_SECRET_KEY = "sk_test_clerk_backend"


def _rsa_keypair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem


def _oauth_setting_value(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "enabled": True,
        "schema_version": 1,
        "issuer": _ISSUER,
        "client_id": _CLIENT_ID,
        "application_id": _APPLICATION_ID,
        "redirect_uri": _REDIRECT_URI,
        "audience": _AUDIENCE,
        "authorized_parties": [_AUTHORIZED_PARTY],
    }
    value.update(overrides)
    validated = CLERK_CLI_OAUTH_SETTING_ADAPTER.validate_python(value)
    return CLERK_CLI_OAUTH_SETTING_ADAPTER.dump_python(validated, mode="json")


async def _set_oauth_setting(db: AsyncSession, **overrides: object) -> AppSetting:
    row = await db.get(AppSetting, CLERK_CLI_OAUTH_SETTING_KEY)
    value = _oauth_setting_value(**overrides)
    if row is None:
        row = AppSetting(key=CLERK_CLI_OAUTH_SETTING_KEY, value_json=value)
        db.add(row)
    else:
        row.value_json = value
    await db.commit()
    return row


@pytest_asyncio.fixture
async def clerk_oauth_signing_key(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> str:
    private_pem, public_pem = _rsa_keypair()
    monkeypatch.setattr(settings, "clerk_pem_public_key", public_pem)
    monkeypatch.setattr(settings, "clerk_jwt_issuer", _ISSUER)
    monkeypatch.setattr(settings, "clerk_jwt_audience", "")
    monkeypatch.setattr(settings, "clerk_secret_key", _SECRET_KEY)
    monkeypatch.setattr(settings, "dev_auth_bypass", False)
    await _set_oauth_setting(db_session)
    return private_pem


@pytest_asyncio.fixture
async def raw_auth_client(db_session: AsyncSession):
    """ASGI client using the real bearer verifier and test DB session."""

    async def _override_get_session():
        yield db_session

    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_session] = _override_get_session
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def _session_token(
    private_pem: str,
    sub: str,
    claims: dict[str, Any] | None = None,
) -> str:
    payload: dict[str, Any] = {"sub": sub}
    if claims:
        payload.update(claims)
    return jwt.encode(payload, private_pem, algorithm="RS256", headers={"typ": "JWT"})


def _oauth_access_token(
    private_pem: str,
    sub: str,
    *,
    claims: dict[str, Any] | None = None,
    drop_claims: set[str] | None = None,
    token_type: str = "at+jwt",
) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": sub,
        "iss": _ISSUER,
        "aud": _AUDIENCE,
        "azp": _AUTHORIZED_PARTY,
        "client_id": _CLIENT_ID,
        "exp": now + timedelta(minutes=5),
        "nbf": now - timedelta(seconds=1),
        "iat": now - timedelta(seconds=1),
    }
    if claims:
        payload.update(claims)
    if drop_claims:
        for claim in drop_claims:
            payload.pop(claim, None)
    return jwt.encode(payload, private_pem, algorithm="RS256", headers={"typ": token_type})


@pytest.mark.asyncio
@pytest.mark.parametrize("token_type", ["at+jwt", "application/at+jwt"])
async def test_oauth_access_and_session_tokens_are_classified_separately(
    db_session: AsyncSession, clerk_oauth_signing_key: str, token_type: str
):
    session = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            f"user_session_{uuid.uuid4().hex}",
            {"iss": _ISSUER, "aud": _AUDIENCE},
        ),
        db_session,
    )
    oauth = await _auth_via_clerk_jwt(
        _oauth_access_token(
            clerk_oauth_signing_key,
            f"user_oauth_{uuid.uuid4().hex}",
            token_type=token_type,
        ),
        db_session,
    )

    assert session is not None
    assert session.oauth_cli is False
    assert session.is_cli is False
    assert oauth is not None
    assert oauth.oauth_cli is True
    assert oauth.is_cli is False


@pytest.mark.asyncio
async def test_suspended_browser_and_oauth_tokens_share_public_problem_contract(
    raw_auth_client: httpx.AsyncClient,
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
) -> None:
    subject = f"user_suspended_{uuid.uuid4().hex}"
    browser_token = _session_token(
        clerk_oauth_signing_key,
        subject,
        {"iss": _ISSUER},
    )
    oauth_token = _oauth_access_token(clerk_oauth_signing_key, subject)

    admitted = await raw_auth_client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {browser_token}"},
    )
    assert admitted.status_code == 200, admitted.text

    await set_clerk_principal_suspension(
        db_session,
        issuer=_ISSUER,
        subject=subject,
        suspended=True,
        reason="operator_internal_case_42",
    )
    await db_session.commit()

    expected = {
        "type": "urn:clawdi:problem:account-suspended",
        "title": "Account suspended",
        "status": 401,
        "detail": "Account is suspended",
        "code": "account_suspended",
    }
    for token in (browser_token, oauth_token):
        response = await raw_auth_client.get(
            "/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401, response.text
        assert response.headers["content-type"] == "application/problem+json"
        assert response.json() == expected
        assert "operator_internal_case_42" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("claim", "value"),
    [
        ("iss", "https://other-clerk.example.test"),
        ("aud", "other-cloud-api"),
        ("client_id", "client_other"),
        ("azp", "https://wrong-origin.example.test"),
    ],
)
async def test_oauth_access_token_rejects_wrong_bound_claims(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    claim: str,
    value: str,
):
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_bad_{uuid.uuid4().hex}",
        claims={claim: value},
    )

    assert await _auth_via_clerk_jwt(token, db_session) is None


@pytest.mark.asyncio
async def test_oauth_access_token_accepts_clerk_optional_audience(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
):
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_optional_claims_{uuid.uuid4().hex}",
        drop_claims={"aud"},
    )

    assert await _auth_via_clerk_jwt(token, db_session) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured_authorized_parties", "authorized_party", "accepted"),
    [
        ([], None, True),
        ([], {"unexpected": "shape"}, True),
        ([], "https://wrong-origin.example.test", True),
        ([_AUTHORIZED_PARTY], None, False),
        ([_AUTHORIZED_PARTY], _AUTHORIZED_PARTY, True),
        ([_AUTHORIZED_PARTY], "https://wrong-origin.example.test", False),
    ],
)
async def test_oauth_access_token_authorized_party_binding_matrix(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    configured_authorized_parties: list[str],
    authorized_party: object,
    accepted: bool,
):
    await _set_oauth_setting(
        db_session,
        authorized_parties=configured_authorized_parties,
    )
    claims = {"azp": authorized_party} if authorized_party is not None else None
    drop_claims = {"azp"} if authorized_party is None else None
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_azp_matrix_{uuid.uuid4().hex}",
        claims=claims,
        drop_claims=drop_claims,
    )

    result = await _auth_via_clerk_jwt(token, db_session)

    assert (result is not None) is accepted


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured_audience", "token_audience", "accepted"),
    [
        ("", None, True),
        ("", {"unexpected": "shape"}, True),
        ("", "wrong-audience", True),
        (_AUDIENCE, None, True),
        (_AUDIENCE, _AUDIENCE, True),
        (_AUDIENCE, "wrong-audience", False),
        (_AUDIENCE, {"unexpected": "shape"}, False),
    ],
)
async def test_oauth_access_token_optional_audience_binding_matrix(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    configured_audience: str,
    token_audience: object,
    accepted: bool,
):
    await _set_oauth_setting(db_session, audience=configured_audience)
    claims = {"aud": token_audience} if token_audience is not None else None
    drop_claims = {"aud"} if token_audience is None else None
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_aud_matrix_{uuid.uuid4().hex}",
        claims=claims,
        drop_claims=drop_claims,
    )

    result = await _auth_via_clerk_jwt(token, db_session)

    assert (result is not None) is accepted


@pytest.mark.asyncio
@pytest.mark.parametrize("missing_claim", ["exp"])
async def test_oauth_access_token_requires_expiration(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    missing_claim: str,
):
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_missing_{uuid.uuid4().hex}",
        drop_claims={missing_claim},
    )

    assert await _auth_via_clerk_jwt(token, db_session) is None


@pytest.mark.asyncio
async def test_oauth_access_token_accepts_optional_iat_and_nbf(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
):
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_optional_time_{uuid.uuid4().hex}",
        drop_claims={"iat", "nbf"},
    )

    assert await _auth_via_clerk_jwt(token, db_session) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claims",
    [
        {"exp": datetime.now(UTC) - timedelta(seconds=10)},
        {"nbf": datetime.now(UTC) + timedelta(minutes=5)},
        {"iat": datetime.now(UTC) + timedelta(minutes=5)},
    ],
)
async def test_oauth_access_token_validates_time_claim_values(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    claims: dict[str, datetime],
):
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_bad_time_{uuid.uuid4().hex}",
        claims=claims,
    )

    assert await _auth_via_clerk_jwt(token, db_session) is None


@pytest.mark.asyncio
async def test_oauth_access_token_rejects_unrepresentable_exp_without_500(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
):
    token = _oauth_access_token(
        clerk_oauth_signing_key,
        f"user_huge_exp_{uuid.uuid4().hex}",
        claims={"exp": 10**100},
    )

    assert await _auth_via_clerk_jwt(token, db_session) is None


@pytest.mark.asyncio
async def test_oauth_access_token_requires_configured_rs256_signer(
    db_session: AsyncSession, clerk_oauth_signing_key: str
):
    different_private_pem, _ = _rsa_keypair()
    token = _oauth_access_token(
        different_private_pem,
        f"user_wrong_signer_{uuid.uuid4().hex}",
    )

    assert await _auth_via_clerk_jwt(token, db_session) is None


@pytest.mark.asyncio
async def test_session_token_uses_independent_strict_issuer_and_audience_settings(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "https://session.clerk.example.test")
    monkeypatch.setattr(settings, "clerk_jwt_audience", "clawdi-dashboard")

    valid = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            f"user_session_valid_{uuid.uuid4().hex}",
            {"iss": "https://session.clerk.example.test", "aud": "clawdi-dashboard"},
        ),
        db_session,
    )
    missing_claims = await _auth_via_clerk_jwt(
        _session_token(clerk_oauth_signing_key, f"user_legacy_{uuid.uuid4().hex}"),
        db_session,
    )
    wrong_issuer = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            f"user_wrong_issuer_{uuid.uuid4().hex}",
            {"iss": "https://other-clerk.example.test", "aud": "clawdi-dashboard"},
        ),
        db_session,
    )
    wrong_audience = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            f"user_wrong_audience_{uuid.uuid4().hex}",
            {"iss": "https://session.clerk.example.test", "aud": "other-cloud-api"},
        ),
        db_session,
    )

    assert valid is not None
    assert missing_claims is None
    assert wrong_issuer is None
    assert wrong_audience is None


@pytest.mark.asyncio
async def test_unconfigured_session_claim_binding_preserves_browser_compatibility(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "clerk_jwt_issuer", "")
    monkeypatch.setattr(settings, "clerk_jwt_audience", "")
    session = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            f"user_session_legacy_{uuid.uuid4().hex}",
            {"iss": "https://legacy-session.example.test", "aud": "legacy-dashboard"},
        ),
        db_session,
    )

    assert session is not None
    assert session.oauth_cli is False


@pytest.mark.asyncio
async def test_oauth_identity_passes_cli_only_cloud_dependencies(
    db_session: AsyncSession, clerk_oauth_signing_key: str
):
    oauth = await _auth_via_clerk_jwt(
        _oauth_access_token(clerk_oauth_signing_key, f"user_cli_{uuid.uuid4().hex}"),
        db_session,
    )

    assert oauth is not None
    assert await require_cli_auth(oauth) is oauth
    assert await require_user_cli(oauth) is oauth


@pytest.mark.asyncio
async def test_oauth_and_session_for_same_clerk_sub_resolve_same_user(
    db_session: AsyncSession, clerk_oauth_signing_key: str
):
    clerk_sub = f"user_shared_{uuid.uuid4().hex}"
    session = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            clerk_sub,
            {"iss": _ISSUER, "aud": _AUDIENCE},
        ),
        db_session,
    )
    oauth = await _auth_via_clerk_jwt(
        _oauth_access_token(clerk_oauth_signing_key, clerk_sub),
        db_session,
    )

    assert session is not None
    assert oauth is not None
    assert oauth.user.id == session.user.id
    assert (
        await db_session.execute(select(User).where(User.clerk_id == clerk_sub))
    ).scalars().all() == [session.user]


@pytest.mark.asyncio
async def test_oauth_and_session_issuers_cannot_rebind_the_same_clerk_sub(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
    monkeypatch: pytest.MonkeyPatch,
):
    clerk_sub = f"user_cross_issuer_{uuid.uuid4().hex}"
    browser_issuer = "https://browser.clerk.example.test"
    monkeypatch.setattr(settings, "clerk_jwt_issuer", browser_issuer)
    session = await _auth_via_clerk_jwt(
        _session_token(
            clerk_oauth_signing_key,
            clerk_sub,
            {"iss": browser_issuer},
        ),
        db_session,
    )

    assert session is not None
    with pytest.raises(HTTPException) as rejected:
        await _auth_via_clerk_jwt(
            _oauth_access_token(clerk_oauth_signing_key, clerk_sub),
            db_session,
        )
    assert rejected.value.status_code == 401
    assert rejected.value.detail == "Invalid account identity"


@pytest.mark.asyncio
async def test_oauth_config_returns_only_public_values(
    raw_auth_client: httpx.AsyncClient, clerk_oauth_signing_key: str
):
    response = await raw_auth_client.get("/v1/cli/auth/oauth/config")

    assert response.status_code == 200
    assert response.json() == {
        "issuer": _ISSUER,
        "client_id": _CLIENT_ID,
        "audience": _AUDIENCE,
        "authorized_parties": [_AUTHORIZED_PARTY],
        "redirect_uri": _REDIRECT_URI,
    }
    assert _SECRET_KEY not in response.text
    assert _APPLICATION_ID not in response.text


@pytest.mark.asyncio
async def test_oauth_config_canonicalizes_public_issuer_and_authorized_parties(
    raw_auth_client: httpx.AsyncClient,
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
):
    await _set_oauth_setting(
        db_session,
        issuer="https://BÜCHER.example:443/",
        authorized_parties=[
            "https://Accounts.Clawdi.test:443/",
            "http://127.0.0.1:18473/",
        ],
    )

    response = await raw_auth_client.get("/v1/cli/auth/oauth/config")

    assert response.status_code == 200
    assert response.json()["issuer"] == "https://xn--bcher-kva.example"
    assert response.json()["authorized_parties"] == [
        "http://127.0.0.1:18473",
        "https://accounts.clawdi.test",
    ]


@pytest.mark.asyncio
async def test_oauth_config_fails_closed_for_invalid_authorized_party(
    raw_auth_client: httpx.AsyncClient,
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
):
    row = await db_session.get(AppSetting, CLERK_CLI_OAUTH_SETTING_KEY)
    assert row is not None
    row.value_json = {
        **_oauth_setting_value(),
        "authorized_parties": ["https://accounts.clawdi.test/private"],
    }
    await db_session.commit()

    response = await raw_auth_client.get("/v1/cli/auth/oauth/config")

    assert response.status_code == 503
    assert response.json() == {"detail": "OAuth CLI authentication is not configured"}


@pytest.mark.asyncio
async def test_oauth_config_fails_closed_when_public_app_is_not_configured(
    raw_auth_client: httpx.AsyncClient,
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
):
    await _set_oauth_setting(
        db_session,
        enabled=False,
        issuer="",
        client_id="",
        application_id="",
        redirect_uri="",
        audience="",
        authorized_parties=[],
    )

    response = await raw_auth_client.get("/v1/cli/auth/oauth/config")

    assert response.status_code == 503
    assert response.json() == {"detail": "OAuth CLI authentication is not configured"}


@pytest.mark.asyncio
async def test_disabled_oauth_setting_fails_closed_for_access_tokens(
    db_session: AsyncSession,
    clerk_oauth_signing_key: str,
) -> None:
    await _set_oauth_setting(
        db_session,
        enabled=False,
        issuer="",
        client_id="",
        application_id="",
        redirect_uri="",
        audience="",
        authorized_parties=[],
    )

    with pytest.raises(HTTPException) as raised:
        await _auth_via_clerk_jwt(
            _oauth_access_token(clerk_oauth_signing_key, f"user_disabled_{uuid.uuid4().hex}"),
            db_session,
        )

    assert raised.value.status_code == 503


@pytest.mark.asyncio
async def test_oauth_desktop_ticket_is_short_lived_and_not_cached(
    raw_auth_client: httpx.AsyncClient,
    clerk_oauth_signing_key: str,
    monkeypatch: pytest.MonkeyPatch,
):
    captured: dict[str, Any] = {}
    clerk_sub = f"user_desktop_{uuid.uuid4().hex}"

    class FakeResponse:
        status_code = 200
        content = b'{"token":"desktop_ticket"}'

    class FakeAsyncClient:
        def __init__(self, **kwargs: Any):
            captured["timeout"] = kwargs["timeout"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return False

        async def post(self, url: str, **kwargs: Any) -> FakeResponse:
            captured["url"] = url
            captured.update(kwargs)
            return FakeResponse()

    monkeypatch.setattr(cli_auth_module.httpx, "AsyncClient", FakeAsyncClient)
    response = await raw_auth_client.post(
        "/v1/cli/auth/oauth/desktop-ticket",
        headers={
            "Authorization": f"Bearer {_oauth_access_token(clerk_oauth_signing_key, clerk_sub)}"
        },
    )

    assert response.status_code == 200
    assert response.json() == {"ticket": "desktop_ticket", "expires_in": 60}
    assert response.headers["cache-control"] == "no-store"
    assert captured["url"] == "https://api.clerk.com/v1/sign_in_tokens"
    assert captured["json"] == {"user_id": clerk_sub, "expires_in_seconds": 60}


@pytest.mark.asyncio
async def test_oauth_revoke_uses_validated_oauth_identity_and_safe_proxy(
    raw_auth_client: httpx.AsyncClient,
    clerk_oauth_signing_key: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    captured: dict[str, Any] = {}
    refresh_token = "refresh_secret_should_not_escape"

    class FakeResponse:
        status_code = 204

    class FakeAsyncClient:
        def __init__(self, **kwargs: Any):
            captured["timeout"] = kwargs["timeout"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return False

        async def post(self, url: str, **kwargs: Any) -> FakeResponse:
            captured["url"] = url
            captured.update(kwargs)
            return FakeResponse()

    monkeypatch.setattr(cli_auth_module.httpx, "AsyncClient", FakeAsyncClient)
    access_token = _oauth_access_token(clerk_oauth_signing_key, f"user_revoke_{uuid.uuid4().hex}")
    response = await raw_auth_client.post(
        "/v1/cli/auth/oauth/revoke",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"refresh_token": refresh_token},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "revoked"}
    assert captured["url"] == (
        f"https://api.clerk.com/v1/oauth_applications/{_APPLICATION_ID}/revoke_token"
    )
    assert captured["headers"] == {
        "Authorization": f"Bearer {_SECRET_KEY}",
        "Clerk-API-Version": "2026-05-12",
        "User-Agent": "clawdi-backend/1.0",
    }
    assert captured["json"] == {"token": refresh_token}
    assert refresh_token not in response.text
    assert refresh_token not in caplog.text


@pytest.mark.asyncio
async def test_oauth_revoke_rejects_session_and_legacy_api_key_auth(
    raw_auth_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user: User,
    clerk_oauth_signing_key: str,
):
    session_response = await raw_auth_client.post(
        "/v1/cli/auth/oauth/revoke",
        headers={
            "Authorization": "Bearer "
            + _session_token(
                clerk_oauth_signing_key,
                f"user_session_revoke_{uuid.uuid4().hex}",
                {"iss": _ISSUER, "aud": _AUDIENCE},
            )
        },
        json={"refresh_token": "refresh_not_used"},
    )

    raw_api_key = "clawdi_legacy_api_key_for_revoke_test"
    db_session.add(
        ApiKey(
            user_id=seed_user.id,
            key_hash=hashlib.sha256(raw_api_key.encode()).hexdigest(),
            key_prefix=raw_api_key[:16],
            label="Legacy CLI key",
        )
    )
    await db_session.commit()
    api_key_response = await raw_auth_client.post(
        "/v1/cli/auth/oauth/revoke",
        headers={"Authorization": f"Bearer {raw_api_key}"},
        json={"refresh_token": "refresh_not_used"},
    )

    assert session_response.status_code == 403
    assert api_key_response.status_code == 403


@pytest.mark.asyncio
async def test_oauth_revoke_hides_upstream_failure_details(
    raw_auth_client: httpx.AsyncClient,
    clerk_oauth_signing_key: str,
    monkeypatch: pytest.MonkeyPatch,
):
    refresh_token = "refresh_secret_for_failed_revoke"

    class FakeResponse:
        status_code = 500
        text = f"upstream error containing {refresh_token}"

    class FakeAsyncClient:
        def __init__(self, **kwargs: Any):
            _ = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return False

        async def post(self, url: str, **kwargs: Any) -> FakeResponse:
            _ = (url, kwargs)
            return FakeResponse()

    monkeypatch.setattr(cli_auth_module.httpx, "AsyncClient", FakeAsyncClient)
    access_token = _oauth_access_token(
        clerk_oauth_signing_key, f"user_revoke_error_{uuid.uuid4().hex}"
    )
    response = await raw_auth_client.post(
        "/v1/cli/auth/oauth/revoke",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"refresh_token": refresh_token},
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "OAuth CLI revocation is temporarily unavailable"}
    assert refresh_token not in response.text
