from __future__ import annotations

import base64
import binascii
import hmac


def is_metrics_request_authorized(
    authorization_header: str | None,
    *,
    bearer_token: str = "",
    basic_user: str = "prometheus",
    basic_password: str = "",
) -> bool:
    bearer = bearer_token.strip()
    password = basic_password.strip()
    if not bearer and not password:
        return True

    header = authorization_header.strip() if authorization_header else ""
    lower_header = header.lower()
    if bearer and lower_header.startswith("bearer "):
        return hmac.compare_digest(header[7:].strip(), bearer)

    if password and lower_header.startswith("basic "):
        decoded = _decode_basic_auth(header[6:].strip())
        if decoded is None:
            return False
        expected_user = basic_user.strip() or "prometheus"
        return hmac.compare_digest(decoded[0], expected_user) and hmac.compare_digest(
            decoded[1],
            password,
        )

    return False


def _decode_basic_auth(value: str) -> tuple[str, str] | None:
    try:
        decoded = base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    separator = decoded.find(":")
    if separator < 0:
        return None
    return decoded[:separator], decoded[separator + 1 :]
