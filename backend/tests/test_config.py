import base64

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from pydantic import ValidationError

from app.core.config import Settings


def _public_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )


def test_settings_normalizes_literal_escaped_clerk_pem_newlines():
    pem = _public_pem()
    settings = Settings(clerk_pem_public_key=pem.replace("\n", "\\n"))

    assert settings.clerk_pem_public_key == pem
    load_pem_public_key(settings.clerk_pem_public_key.encode("utf-8"))


def test_settings_decodes_base64_clerk_pem():
    pem = _public_pem()
    encoded = base64.b64encode(pem.encode("utf-8")).decode("ascii")

    settings = Settings(clerk_pem_public_key=encoded)

    assert settings.clerk_pem_public_key == pem
    load_pem_public_key(settings.clerk_pem_public_key.encode("utf-8"))


def test_settings_normalizes_line_continuation_clerk_pem_newlines():
    pem = _public_pem()
    settings = Settings(clerk_pem_public_key=pem.replace("\n", "\\" + "\n"))

    assert settings.clerk_pem_public_key == pem
    load_pem_public_key(settings.clerk_pem_public_key.encode("utf-8"))


def test_settings_normalizes_line_continuation_clerk_pem_from_env(monkeypatch):
    pem = _public_pem()
    monkeypatch.setenv("CLERK_PEM_PUBLIC_KEY", pem.replace("\n", "\\" + "\n"))

    settings = Settings(_env_file=None)

    assert settings.clerk_pem_public_key == pem
    load_pem_public_key(settings.clerk_pem_public_key.encode("utf-8"))


def test_settings_redacts_whatsapp_sidecar_registration_token():
    raw_config = (
        '{"00000000-0000-0000-0000-000000000777":'
        '{"base_url":"https://sidecar.example.test","api_token":"sidecar-secret"}}'
    )

    settings = Settings(_env_file=None, channel_whatsapp_baileys_sidecars_json=raw_config)

    assert settings.channel_whatsapp_baileys_sidecars_json.get_secret_value() == raw_config
    assert "sidecar-secret" not in repr(settings)


def test_settings_canonicalizes_browser_clerk_issuer():
    settings = Settings(_env_file=None, clerk_jwt_issuer="  https://Clerk.Example.test/ ")

    assert settings.clerk_jwt_issuer == "https://clerk.example.test"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://Clerk.Example.test", "https://clerk.example.test"),
        ("https://Clerk.Example.test:443/", "https://clerk.example.test"),
        ("https://Clerk.Example.test:8443/", "https://clerk.example.test:8443"),
        ("http://LOCALHOST:80/", "http://localhost"),
        ("http://127.0.0.1:43119/", "http://127.0.0.1:43119"),
        ("http://[::1]:43120/", "http://[::1]:43120"),
        ("http://[0:0:0:0:0:0:0:1]:80/", "http://[::1]"),
        ("https://BÜCHER.example:443/", "https://xn--bcher-kva.example"),
        ("https://faß.example/", "https://xn--fa-hia.example"),
        ("https://[2001:0DB8:0:0:0:0:0:1]:443/", "https://[2001:db8::1]"),
    ],
)
def test_settings_canonicalizes_clerk_issuer_origins(value: str, expected: str):
    settings = Settings(_env_file=None, clerk_jwt_issuer=value)

    assert settings.clerk_jwt_issuer == expected


@pytest.mark.parametrize(
    "value",
    [
        "clerk.example.test",
        "ftp://clerk.example.test",
        "http://clerk.example.test",
        "http://localhost.example.test",
        "http://127.0.0.2",
        "http://[::2]",
        "https://user@clerk.example.test",
        "https://clerk.example.test/oauth",
        "https://clerk.example.test///",
        "https://clerk.example.test?tenant=secret",
        "https://clerk.example.test#fragment",
        "https://clerk.example.test?",
        "https://clerk.example.test#",
        "https://clerk.example.test.",
        "https://bad_host.example.test",
        "https://-bad.example.test",
        "https://[2001:db8::gg]",
    ],
)
def test_settings_rejects_invalid_clerk_issuer_origins(value: str):
    with pytest.raises(ValidationError, match="Clerk issuer"):
        Settings(_env_file=None, clerk_jwt_issuer=value)


@pytest.mark.parametrize(
    "field",
    [
        "runtime_observation_freshness_seconds",
        "runtime_observation_max_future_skew_seconds",
        "runtime_observation_max_capture_age_days",
        "runtime_observation_replay_horizon_days",
        "runtime_observation_hard_retention_days",
        "runtime_observation_cleanup_batch_size",
    ],
)
def test_runtime_observation_settings_require_positive_bounds(field: str):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: 0})


def test_runtime_observation_hard_retention_cannot_precede_replay_horizon():
    with pytest.raises(ValidationError, match="hard_retention_days"):
        Settings(
            _env_file=None,
            runtime_observation_replay_horizon_days=8,
            runtime_observation_hard_retention_days=7,
        )
