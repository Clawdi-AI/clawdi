import hashlib
import hmac
import json
from uuid import uuid4

import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.models.hosted_runtime import HostedRuntimeSecret
from app.services.hosted_runtime_secrets import (
    hosted_runtime_secret_values_changed,
    runtime_secret_values_idempotency_identity,
)
from app.services.vault_crypto import encrypt


def test_runtime_secret_values_idempotency_identity_is_stable_and_domain_separated() -> None:
    values = {
        "secret://clawdi/auth-token": SecretStr("same-value"),
        "secret://runtime/openclaw/gateway-token": SecretStr("gateway-value"),
    }

    first = runtime_secret_values_idempotency_identity(values)
    reordered = runtime_secret_values_idempotency_identity(dict(reversed(values.items())))
    changed = runtime_secret_values_idempotency_identity(
        {
            **values,
            "secret://clawdi/auth-token": SecretStr("different-value"),
        }
    )

    assert first == reordered
    assert first != changed
    canonical_payload = json.dumps(
        {key: value.get_secret_value() for key, value in values.items()},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    direct_raw_key_hmac = hmac.new(
        bytes.fromhex(settings.vault_encryption_key),
        canonical_payload,
        hashlib.sha256,
    ).hexdigest()
    assert first != direct_raw_key_hmac
    assert first not in {secret.get_secret_value() for secret in values.values()}
    assert settings.vault_encryption_key not in first


def test_hosted_runtime_secret_compare_rejects_unknown_key_version() -> None:
    ciphertext, nonce = encrypt("same-value")
    row = HostedRuntimeSecret(
        id=uuid4(),
        environment_id=uuid4(),
        secret_ref="secret://clawdi/auth-token",
        encrypted_value=ciphertext,
        nonce=nonce,
        key_version="vault.future",
    )

    with pytest.raises(RuntimeError, match="Unsupported hosted runtime secret key version"):
        hosted_runtime_secret_values_changed(
            [row],
            {"secret://clawdi/auth-token": SecretStr("same-value")},
        )
