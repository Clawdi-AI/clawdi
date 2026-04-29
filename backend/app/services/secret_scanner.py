"""Defense-in-depth secret detection for any text headed for storage.

Used at four enforcement points (per memory-quality proposal §"Fix surface"):
  1. memory write (POST /api/memories)        — pre-INSERT
  2. wiki synthesis (compiled_truth)           — pre-PERSIST
  3. session-extracted memory candidates       — pre-INSERT
  4. memory audit (`clawdi memory audit`)     — post-hoc scan, future

Two complementary signals combine into one verdict:

  A) **User-vault values** — the user's actual decrypted vault values are loaded
     once and treated as literal substrings to look for. Catches user-specific
     secrets the regex layer would miss (custom-prefixed deploy keys, internal
     tokens with non-standard formats, etc.).

  B) **Pattern matchers** — regexes for well-known secret formats (Stripe live,
     Anthropic, OpenAI, Slack, Telegram bot, JWT, RSA private keys, 64-char hex
     admin tokens). Catches secrets the user hasn't yet stored in the vault but
     pasted into a session — common when onboarding a new service.

Originally lived as `WikiSanitizer` (PR #48). Promoted here so memory-write paths
can reuse it (memory quality proposal §4.5 Phase 1.5 quick win). The
`WikiSanitizer` name remains as a re-export shim for backwards compatibility.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------

# Vault values shorter than this are skipped during scanning. Rationale:
# short literals like "abc" or 6-digit numeric IDs would match too much
# prose and produce false positives. Real secrets (API keys, JWTs, OAuth
# tokens) are universally longer than 12 chars; the median is 32+.
MIN_VAULT_VALUE_LENGTH = 12


# ---------------------------------------------------------------------------
# Pattern matchers
# ---------------------------------------------------------------------------
#
# Each entry: (label, compiled_regex). Labels are surfaced in error messages
# (label is safe to log; the matched substring is not).
#
# Conservative bias — false negatives are recoverable (vault-value layer
# catches user-specific cases); false positives block legitimate writes.
# When in doubt, narrow the regex.
#
# Sources for canonical formats:
# - Stripe:    https://stripe.com/docs/api/authentication
# - Anthropic: sk-ant-api03-* (observed)
# - OpenAI:    sk-* (observed)
# - Slack:     xoxb-/xoxp-/xoxa-/xoxr- (https://api.slack.com/authentication/token-types)
# - Telegram:  digit:base64-ish (https://core.telegram.org/bots/api)
# - JWT:       3-part dot-separated base64url (RFC 7519)
# - RSA priv:  PEM header (RFC 7468)


_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # Stripe live restricted/secret keys: rk_live_, sk_live_, restricted+test variants.
    ("stripe_secret", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}")),
    # Anthropic API keys (observed shape: sk-ant-api03-<base64ish>).
    ("anthropic_api_key", re.compile(r"\bsk-ant-api03-[A-Za-z0-9_\-]{32,}")),
    # OpenAI API keys (sk-..., excluding sk-ant- which is already matched above).
    ("openai_api_key", re.compile(r"\bsk-(?!ant-)[A-Za-z0-9_\-]{20,}")),
    # Slack tokens (bot/user/app/refresh).
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    # Telegram bot tokens: <numeric_id>:<35-char base64ish>.
    ("telegram_bot_token", re.compile(r"\b\d{8,12}:[A-Za-z0-9_\-]{30,}")),
    # JWT (3-part base64url + dots). Tolerates whitespace/quotes around it.
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")),
    # PEM private keys (RSA / EC / OpenSSH / generic).
    (
        "private_key_pem",
        re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)?PRIVATE KEY-----"),
    ),
    # GitHub PATs / fine-grained tokens.
    ("github_token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}")),
    # AWS access keys (account-bound).
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    # Bare 64-char hex strings (long admin keys, encryption keys, content hashes
    # of ciphertext) — high-entropy, conservative match. Skip if surrounded by
    # other hex (commit SHAs are 40, MD5 is 32; we want the long-secret shape).
    ("hex_secret_64", re.compile(r"(?<![A-Za-z0-9])[a-fA-F0-9]{64}(?![A-Za-z0-9])")),
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class SecretLeakError(Exception):
    """Raised when content contains one or more secrets.

    The message NEVER includes the leaked content. We surface labels +
    counts + lengths only — including the value would defeat the purpose.
    """


# Backwards compat alias for the wiki-only era. PR #48's wiki_synthesis.py
# imports `VaultLeakError`; keep that import path working.
VaultLeakError = SecretLeakError


class SecretScanner:
    """Combined vault-value + pattern-based secret detector.

    Construct once per request (or batch) for a given user, then call
    `check` / `assert_clean` / `redact` on every piece of text that's
    about to hit storage.
    """

    def __init__(self, vault_values: set[str] | list[str] | None = None) -> None:
        # Keep only values long enough to avoid false positives on prose.
        self._values: set[str] = {
            v for v in (vault_values or ()) if len(v) >= MIN_VAULT_VALUE_LENGTH
        }

    def __len__(self) -> int:
        # Number of vault values being tracked — useful for logging.
        return len(self._values)

    # ---- Detection ----

    def check(self, text: str) -> list[str]:
        """Vault-value layer. Returns the list of values found in `text`.

        Empty if clean. Caller must NOT log or surface the returned values
        directly — use for length/count metrics or pass to assert_clean / redact.

        This is the original `WikiSanitizer.check` semantic, preserved for
        backwards compat. For pattern-based checks too, use `scan()`.
        """
        if not text or not self._values:
            return []
        return [v for v in self._values if v in text]

    def check_patterns(self, text: str) -> list[tuple[str, int]]:
        """Pattern layer. Returns [(label, char_offset), ...] for every match.

        Char offsets are safe to log; the matched substring is not.
        """
        if not text:
            return []
        hits: list[tuple[str, int]] = []
        for label, pattern in _PATTERNS:
            for m in pattern.finditer(text):
                hits.append((label, m.start()))
        return hits

    def scan(self, text: str) -> dict:
        """Combined scan. Returns a structured result dict:

            {
              "clean": bool,
              "vault_value_leaks": int,      # count, never values
              "pattern_hits": [(label, offset), ...],
              "leak_labels": [str, ...],     # union of labels for logging
            }

        Use this on the memory-write path where you want both layers AND
        a single decision point. `assert_clean()` calls this internally.
        """
        vault_leaks = self.check(text)
        pattern_hits = self.check_patterns(text)
        clean = not vault_leaks and not pattern_hits
        return {
            "clean": clean,
            "vault_value_leaks": len(vault_leaks),
            "pattern_hits": pattern_hits,
            "leak_labels": (
                (["vault_value"] if vault_leaks else [])
                + sorted({label for label, _ in pattern_hits})
            ),
        }

    # ---- Enforcement ----

    def assert_clean(self, text: str, context: str = "") -> None:
        """Raise SecretLeakError if `text` contains ANY secret.

        Use this on the write path when a leak should hard-fail rather
        than silently scrub. Synthesis / extraction / memory-write all
        prefer this — fail loudly so the source data or prompt can be fixed.

        Backwards-compat note: the original `WikiSanitizer.assert_clean`
        only checked vault values. This now checks BOTH vault values and
        the regex patterns — strictly stronger; existing callers benefit
        for free.
        """
        result = self.scan(text)
        if result["clean"]:
            return
        ctx = f" in {context}" if context else ""
        bits: list[str] = []
        if result["vault_value_leaks"]:
            bits.append(f"{result['vault_value_leaks']} vault value(s)")
        if result["pattern_hits"]:
            labels = ", ".join(sorted({label for label, _ in result["pattern_hits"]}))
            bits.append(f"pattern: {labels}")
        raise SecretLeakError(
            f"SecretScanner detected leak{ctx}: {'; '.join(bits)}."
        )

    def redact(self, text: str) -> str:
        """Replace any detected secrets with `[REDACTED:<label>:N]`.

        Use only when persisting text that might contain a value and a
        hard fail would be worse (e.g. a debug log capture). Prefer
        assert_clean for the synthesis / memory-write pipelines so leaks
        fail loudly instead of silently being scrubbed.
        """
        if not text:
            return text
        out = text
        # Vault-value layer first (longer literals, more specific).
        for v in self._values:
            out = out.replace(v, f"[REDACTED:vault_value:{len(v)}]")
        # Pattern layer.
        for label, pattern in _PATTERNS:
            out = pattern.sub(
                lambda m, lbl=label: f"[REDACTED:{lbl}:{len(m.group(0))}]", out
            )
        return out


# ---------------------------------------------------------------------------
# Backwards compat — `WikiSanitizer` was the original name (PR #48).
# Wiki synthesis already imports it; keep the import path working.
# ---------------------------------------------------------------------------

WikiSanitizer = SecretScanner


__all__ = [
    "MIN_VAULT_VALUE_LENGTH",
    "SecretLeakError",
    "SecretScanner",
    "VaultLeakError",
    "WikiSanitizer",
]
