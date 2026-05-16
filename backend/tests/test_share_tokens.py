"""Share-link opaque-token primitives.

Token shape: 32 random bytes -> URL-safe base64 -> 43 chars (no padding).
Server stores sha256(token). First 8 chars stored as prefix for owner UI.
"""

import re

from app.services.sharing import (
    generate_share_token,
    hash_share_token,
    token_prefix,
)


def test_generate_share_token_returns_43_url_safe_chars():
    tok = generate_share_token()
    assert len(tok) == 43
    assert re.fullmatch(r"[A-Za-z0-9_-]+", tok)


def test_generate_share_token_is_unpredictable():
    seen = {generate_share_token() for _ in range(100)}
    assert len(seen) == 100


def test_hash_share_token_returns_64_hex_chars():
    h = hash_share_token("known-token-for-test")
    assert len(h) == 64
    assert re.fullmatch(r"[0-9a-f]+", h)
    # Deterministic.
    assert hash_share_token("known-token-for-test") == h


def test_token_prefix_returns_first_8_chars():
    tok = "abcdefgh" + "x" * 35
    assert token_prefix(tok) == "abcdefgh"
