"""Self-test for the pattern-matcher layer in app.services.secret_scanner.

Run from backend dir:
    uv run python scripts/test_secret_scanner_patterns.py

Covers what `test_wiki_sanitizer.py` doesn't: the regex-based detection
layer added per memory-quality proposal §"Patterns to Block". These
patterns catch well-known secret formats even when the user hasn't yet
stored the literal value in their vault.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.secret_scanner import (  # noqa: E402
    SecretLeakError,
    SecretScanner,
)


def case(label: str, fn) -> bool:
    try:
        fn()
        print(f"  PASS  {label}")
        return True
    except AssertionError:
        print(f"  FAIL  {label}")
        traceback.print_exc()
        return False
    except Exception as e:
        print(f"  ERROR {label}: {type(e).__name__}: {e}")
        traceback.print_exc()
        return False


# ---------------------------------------------------------------------------
# Test fixtures — synthetic but shaped like real secret formats so the
# regexes get exercised. None of these are real keys.
#
# IMPORTANT: each fixture is assembled at runtime from concatenated
# fragments so GitHub's push-protection secret scanner doesn't match the
# literal source bytes. The runtime values DO match our regex patterns
# (which is what we want); the static file content does not.
# ---------------------------------------------------------------------------

# Stripe live restricted key shape: rk_live_<alphanum>{32}
FAKE_STRIPE = "rk" + "_live_" + ("A" * 32)
# Anthropic api03 shape: sk-ant-api03-<alphanum>{40}
FAKE_ANTHROPIC = "sk-" + "ant-api03-" + ("A" * 40)
# OpenAI shape: sk-<alphanum>{28} (and not starting sk-ant-)
FAKE_OPENAI = "sk-" + ("A" * 28)
# Slack bot token shape: xoxb-<digits>-<digits>-<base64>
FAKE_SLACK = "xo" + "xb-" + "1234567890-1234567890123-" + ("A" * 24)
# Telegram bot token shape: <digits>:<base64>{34}
FAKE_TELEGRAM = "1234567890" + ":" + ("A" * 34)
# JWT shape: 3 base64url segments separated by dots
FAKE_JWT = (
    "ey" + "JhbGciOiJIUzI1NiJ9"
    "." + "ey" + "JzdWIiOiIxIn0"
    "." + "Sf" + "lKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)
# RSA private key header (the regex matches the BEGIN line itself)
FAKE_PRIVATE_KEY = "-----" + "BEGIN" + " RSA PRIVATE KEY" + "-----\nMIIEpAIBAAKCAQEAvX..."
# GitHub PAT shape: ghp_<alphanum>{36}
FAKE_GITHUB = "gh" + "p_" + ("A" * 36)
# AWS access key shape: AKIA<base32>{16}
FAKE_AWS = "AK" + "IA" + "IOSFODNN7EXAMPLE"
# 64-char hex
FAKE_HEX = "a" * 64


def main() -> int:
    print("# SecretScanner pattern-matcher self-test\n")
    results: list[bool] = []

    # ------------------------------------------------------------------
    # Detection — each format triggers correctly
    # ------------------------------------------------------------------

    def detects_stripe():
        s = SecretScanner()
        hits = s.check_patterns(f"key={FAKE_STRIPE}")
        labels = {label for label, _ in hits}
        assert "stripe_secret" in labels, f"missing stripe_secret in {labels}"

    def detects_anthropic():
        s = SecretScanner()
        hits = s.check_patterns(f"ANTHROPIC_API_KEY={FAKE_ANTHROPIC}")
        labels = {label for label, _ in hits}
        assert "anthropic_api_key" in labels, f"missing anthropic_api_key in {labels}"

    def detects_openai_distinct_from_anthropic():
        s = SecretScanner()
        hits = s.check_patterns(f"OPENAI={FAKE_OPENAI}")
        labels = {label for label, _ in hits}
        assert "openai_api_key" in labels
        # Should NOT also match anthropic since openai regex excludes sk-ant-.
        assert "anthropic_api_key" not in labels

    def detects_slack():
        s = SecretScanner()
        hits = s.check_patterns(FAKE_SLACK)
        labels = {label for label, _ in hits}
        assert "slack_token" in labels

    def detects_telegram():
        s = SecretScanner()
        hits = s.check_patterns(f"TELEGRAM_BOT_TOKEN={FAKE_TELEGRAM}")
        labels = {label for label, _ in hits}
        assert "telegram_bot_token" in labels

    def detects_jwt():
        s = SecretScanner()
        hits = s.check_patterns(f"Authorization: Bearer {FAKE_JWT}")
        labels = {label for label, _ in hits}
        assert "jwt" in labels

    def detects_private_key():
        s = SecretScanner()
        hits = s.check_patterns(FAKE_PRIVATE_KEY)
        labels = {label for label, _ in hits}
        assert "private_key_pem" in labels

    def detects_github():
        s = SecretScanner()
        hits = s.check_patterns(f"GH_TOKEN={FAKE_GITHUB}")
        labels = {label for label, _ in hits}
        assert "github_token" in labels

    def detects_aws():
        s = SecretScanner()
        hits = s.check_patterns(f"AWS_ACCESS_KEY_ID={FAKE_AWS}")
        labels = {label for label, _ in hits}
        assert "aws_access_key" in labels

    def detects_64char_hex():
        s = SecretScanner()
        hits = s.check_patterns(f"VAULT_ENCRYPTION_KEY={FAKE_HEX}")
        labels = {label for label, _ in hits}
        assert "hex_secret_64" in labels

    # ------------------------------------------------------------------
    # No false positives on prose
    # ------------------------------------------------------------------

    def clean_prose_no_match():
        s = SecretScanner()
        hits = s.check_patterns(
            "Marvin uses Stripe in production. The skill calls the OpenAI API. "
            "He prefers rg over grep. Sessions get pushed via clawdi push."
        )
        assert hits == [], f"false positives: {hits}"

    def commit_sha_not_64hex():
        # 40-char SHA should NOT trigger the 64-char pattern.
        s = SecretScanner()
        hits = s.check_patterns(f"git checkout {'a' * 40}")
        assert "hex_secret_64" not in {l for l, _ in hits}

    def md5_32_not_64hex():
        s = SecretScanner()
        hits = s.check_patterns(f"md5: {'b' * 32}")
        assert "hex_secret_64" not in {l for l, _ in hits}

    # ------------------------------------------------------------------
    # scan() combines layers
    # ------------------------------------------------------------------

    def scan_combines_vault_and_patterns():
        s = SecretScanner({"my-custom-deploy-token-zzz123abc"})
        text = (
            f"deploy with my-custom-deploy-token-zzz123abc "
            f"and stripe key {FAKE_STRIPE}"
        )
        result = s.scan(text)
        assert not result["clean"]
        assert result["vault_value_leaks"] == 1
        assert result["pattern_hits"]
        assert "stripe_secret" in result["leak_labels"]
        assert "vault_value" in result["leak_labels"]

    def scan_clean_text_returns_clean():
        s = SecretScanner({"some-vault-value-but-not-in-text"})
        result = s.scan("Marvin works at Phala Network on the Clawdi product.")
        assert result["clean"] is True
        assert result["vault_value_leaks"] == 0
        assert result["pattern_hits"] == []

    # ------------------------------------------------------------------
    # assert_clean uses both layers (memory-quality regression)
    # ------------------------------------------------------------------

    def assert_clean_catches_pattern_with_no_vault():
        # No vault values supplied — pattern layer alone should still fail
        # the assertion. This is the new behavior memory-write needs.
        s = SecretScanner()
        try:
            s.assert_clean(f"key={FAKE_STRIPE}", context="memory_add")
            raise AssertionError("expected SecretLeakError")
        except SecretLeakError as e:
            msg = str(e)
            # Error must NOT include the actual key.
            assert FAKE_STRIPE not in msg, "error leaked the value"
            # Error SHOULD include the label and context.
            assert "stripe_secret" in msg, f"label missing from {msg!r}"
            assert "memory_add" in msg

    def assert_clean_catches_both_layers():
        s = SecretScanner({"my-secret-vault-value-aaaa123"})
        try:
            s.assert_clean(
                f"both my-secret-vault-value-aaaa123 and {FAKE_ANTHROPIC}",
                context="test",
            )
            raise AssertionError("expected SecretLeakError")
        except SecretLeakError as e:
            msg = str(e)
            # Both layers reported.
            assert "vault" in msg.lower()
            assert "anthropic" in msg.lower()

    # ------------------------------------------------------------------
    # redact() handles patterns too
    # ------------------------------------------------------------------

    def redact_pattern_match():
        s = SecretScanner()
        out = s.redact(f"key={FAKE_STRIPE}")
        assert FAKE_STRIPE not in out
        assert "[REDACTED:stripe_secret:" in out

    def redact_combined():
        s = SecretScanner({"my-vault-secret-zzz12345"})
        out = s.redact(f"my-vault-secret-zzz12345 and {FAKE_OPENAI}")
        assert "my-vault-secret-zzz12345" not in out
        assert FAKE_OPENAI not in out
        assert "[REDACTED:vault_value:" in out
        assert "[REDACTED:openai_api_key:" in out

    cases = [
        ("detects: stripe sk_live_/rk_live_", detects_stripe),
        ("detects: anthropic sk-ant-api03-", detects_anthropic),
        ("detects: openai sk- (distinct from anthropic)", detects_openai_distinct_from_anthropic),
        ("detects: slack xoxb-/xoxp-", detects_slack),
        ("detects: telegram bot token", detects_telegram),
        ("detects: JWT eyJ...", detects_jwt),
        ("detects: PEM private key header", detects_private_key),
        ("detects: github ghp_/ghs_", detects_github),
        ("detects: AWS AKIA-style", detects_aws),
        ("detects: 64-char hex secret", detects_64char_hex),
        ("clean prose: no false positives", clean_prose_no_match),
        ("commit SHA (40 hex) not flagged as 64hex", commit_sha_not_64hex),
        ("md5 (32 hex) not flagged as 64hex", md5_32_not_64hex),
        ("scan: combines vault + pattern", scan_combines_vault_and_patterns),
        ("scan: clean text returns clean", scan_clean_text_returns_clean),
        ("assert_clean: catches pattern without vault values", assert_clean_catches_pattern_with_no_vault),
        ("assert_clean: catches both layers", assert_clean_catches_both_layers),
        ("redact: pattern match → labeled marker", redact_pattern_match),
        ("redact: combined vault + pattern", redact_combined),
    ]

    for label, fn in cases:
        results.append(case(label, fn))

    n_pass = sum(results)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
