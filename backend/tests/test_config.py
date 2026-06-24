from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import load_pem_public_key

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
