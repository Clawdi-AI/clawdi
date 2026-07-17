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


def test_settings_normalizes_coolify_line_continuation_clerk_pem_newlines():
    pem = _public_pem()
    settings = Settings(clerk_pem_public_key=pem.replace("\n", "\\" + "\n"))

    assert settings.clerk_pem_public_key == pem
    load_pem_public_key(settings.clerk_pem_public_key.encode("utf-8"))


def test_settings_normalizes_coolify_line_continuation_clerk_pem_from_env(monkeypatch):
    pem = _public_pem()
    monkeypatch.setenv("CLERK_PEM_PUBLIC_KEY", pem.replace("\n", "\\" + "\n"))

    settings = Settings(_env_file=None)

    assert settings.clerk_pem_public_key == pem
    load_pem_public_key(settings.clerk_pem_public_key.encode("utf-8"))


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
