"""Self-test for app.services.wiki_sanitizer.

Run from backend dir:
    uv run python scripts/test_wiki_sanitizer.py

Exits non-zero on any assertion failure. Intended for CI: import as a
module, run via pytest later, or invoke directly today.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

# Allow running this script directly (uv run python scripts/...) without
# installing the backend as a package. Once the project is set up with a
# proper test runner (pytest), this can go away.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.wiki_sanitizer import (  # noqa: E402
    MIN_LENGTH,
    VaultLeakError,
    WikiSanitizer,
)


def case(label: str, fn) -> bool:
    """Run a single test case, print PASS/FAIL, return success bool."""
    try:
        fn()
        print(f"  PASS  {label}")
        return True
    except AssertionError as e:
        print(f"  FAIL  {label}")
        traceback.print_exc()
        return False
    except Exception as e:
        print(f"  ERROR {label}: {type(e).__name__}: {e}")
        traceback.print_exc()
        return False


# ---------------------------------------------------------------------------
# Sentinel values for the test corpus.
#
# Carefully chosen so that:
#   1. Each is >= MIN_LENGTH chars to exercise the length threshold.
#   2. None matches GitHub secret-scanning regexes (no `sk_live_`,
#      `sk-ant-`, `eyJhbG…`, `xoxb-`, etc. prefixes).
#   3. The realistic-test cases later use a clearly synthetic shape that
#      still demonstrates "long opaque token containing a value the
#      sanitizer must catch".
# ---------------------------------------------------------------------------

# Synthetic strings only — these are intentionally NOT shaped like any
# real secret so the secret scanner won't flag the file.
STRIPE_LIKE = "TESTSENTINEL-STRIPE-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
ANTHROPIC_LIKE = "TESTSENTINEL-ANTHROPIC-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
OPENAI_LIKE = "TESTSENTINEL-OPENAI-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
GENERIC_TOKEN = "TESTSENTINEL-GENERIC-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"

ALL_SECRETS = {STRIPE_LIKE, ANTHROPIC_LIKE, OPENAI_LIKE, GENERIC_TOKEN}

# Sentinel short values that should be IGNORED (below MIN_LENGTH).
SHORT_VALUE = "abc123"  # 6 chars, below threshold


def main() -> int:
    print(f"# Wiki sanitizer self-test (MIN_LENGTH={MIN_LENGTH})\n")
    results: list[bool] = []

    # ---- check() ----

    def check_clean_returns_empty():
        s = WikiSanitizer(ALL_SECRETS)
        clean = "Marvin uses Stripe with a live key configured in vault scope clawdi-backend."
        assert s.check(clean) == [], "clean text should return []"

    def check_finds_single_leak():
        s = WikiSanitizer(ALL_SECRETS)
        leaky = f"Use the key {STRIPE_LIKE} for charges."
        leaks = s.check(leaky)
        assert len(leaks) == 1, f"expected 1 leak, got {len(leaks)}"
        assert STRIPE_LIKE in leaks

    def check_finds_multiple_leaks():
        s = WikiSanitizer(ALL_SECRETS)
        leaky = f"stripe={STRIPE_LIKE} anthropic={ANTHROPIC_LIKE} openai={OPENAI_LIKE}"
        leaks = s.check(leaky)
        assert len(leaks) == 3, f"expected 3 leaks, got {len(leaks)}"

    def check_handles_empty_text():
        s = WikiSanitizer(ALL_SECRETS)
        assert s.check("") == []
        assert s.check(None) == []  # type: ignore[arg-type]

    def check_handles_empty_vault():
        s = WikiSanitizer(set())
        assert s.check(f"This contains {STRIPE_LIKE}") == []
        assert len(s) == 0

    # ---- MIN_LENGTH threshold ----

    def short_values_skipped():
        s = WikiSanitizer({SHORT_VALUE, STRIPE_LIKE})
        # short_value should NOT be tracked
        assert len(s) == 1, f"expected 1 tracked value, got {len(s)}"
        # text containing only short_value should be clean
        assert s.check(f"some prose {SHORT_VALUE} more prose") == []
        # text containing the long secret should leak
        assert STRIPE_LIKE in s.check(f"key={STRIPE_LIKE}")

    # ---- assert_clean() ----

    def assert_clean_passes_clean_text():
        s = WikiSanitizer(ALL_SECRETS)
        s.assert_clean("Marvin works at Phala Network on Clawdi.")  # no raise

    def assert_clean_raises_on_leak():
        s = WikiSanitizer(ALL_SECRETS)
        try:
            s.assert_clean(f"key={STRIPE_LIKE}", context="compiled_truth")
            raise AssertionError("expected VaultLeakError, got nothing")
        except VaultLeakError as e:
            msg = str(e)
            # Error message must NOT include the leaked value.
            assert STRIPE_LIKE not in msg, (
                f"VaultLeakError message leaked the value: {msg}"
            )
            # Should mention the context.
            assert "compiled_truth" in msg

    def assert_clean_message_does_not_contain_secret():
        s = WikiSanitizer(ALL_SECRETS)
        try:
            s.assert_clean(f"a={STRIPE_LIKE} b={ANTHROPIC_LIKE}")
            raise AssertionError("expected VaultLeakError")
        except VaultLeakError as e:
            msg = str(e)
            # Hard rule: error never contains secret content.
            for v in (STRIPE_LIKE, ANTHROPIC_LIKE, OPENAI_LIKE, GENERIC_TOKEN):
                assert v not in msg, f"error message leaked {v[:8]}…"

    # ---- redact() ----

    def redact_replaces_with_marker():
        s = WikiSanitizer(ALL_SECRETS)
        out = s.redact(f"Use key {STRIPE_LIKE} carefully.")
        assert STRIPE_LIKE not in out
        assert "[REDACTED:" in out

    def redact_includes_length():
        s = WikiSanitizer(ALL_SECRETS)
        out = s.redact(STRIPE_LIKE)
        assert out == f"[REDACTED:{len(STRIPE_LIKE)}]"

    def redact_handles_multiple():
        s = WikiSanitizer(ALL_SECRETS)
        out = s.redact(f"{STRIPE_LIKE} and {OPENAI_LIKE}")
        assert STRIPE_LIKE not in out
        assert OPENAI_LIKE not in out
        assert out.count("[REDACTED:") == 2

    def redact_handles_empty():
        s = WikiSanitizer(ALL_SECRETS)
        assert s.redact("") == ""

    # ---- realistic compiled_truth scenarios ----

    def realistic_compiled_truth_safe():
        """Simulated good output: mentions vault scope NAMES only."""
        s = WikiSanitizer(ALL_SECRETS)
        synthesized = (
            "Marvin's Stripe integration uses a live restricted key configured "
            "in vault scope `clawdi-backend` (`STRIPE_LIKE_KEY`). The "
            "`research/polymarket` skill provides prediction-market data."
        )
        s.assert_clean(synthesized, context="compiled_truth")

    def realistic_compiled_truth_unsafe():
        """Simulated bad output: LLM hallucinated and inlined the value."""
        s = WikiSanitizer(ALL_SECRETS)
        synthesized = (
            f"Marvin's Stripe live key is {STRIPE_LIKE}, used to charge "
            "subscriptions for the Clawdi Max product."
        )
        try:
            s.assert_clean(synthesized, context="compiled_truth")
            raise AssertionError("expected VaultLeakError on bad output")
        except VaultLeakError:
            pass  # Good — this is exactly what should fail.

    cases = [
        ("check: clean text returns []", check_clean_returns_empty),
        ("check: finds single leak", check_finds_single_leak),
        ("check: finds multiple leaks", check_finds_multiple_leaks),
        ("check: handles empty text/None", check_handles_empty_text),
        ("check: handles empty vault", check_handles_empty_vault),
        ("MIN_LENGTH: short values skipped", short_values_skipped),
        ("assert_clean: passes clean text", assert_clean_passes_clean_text),
        ("assert_clean: raises on leak", assert_clean_raises_on_leak),
        (
            "assert_clean: error message never contains the secret",
            assert_clean_message_does_not_contain_secret,
        ),
        ("redact: replaces with [REDACTED:N]", redact_replaces_with_marker),
        ("redact: marker includes length", redact_includes_length),
        ("redact: handles multiple values", redact_handles_multiple),
        ("redact: handles empty input", redact_handles_empty),
        ("realistic: clean compiled_truth passes", realistic_compiled_truth_safe),
        (
            "realistic: leaky compiled_truth fails (this is the regression test)",
            realistic_compiled_truth_unsafe,
        ),
    ]

    for label, fn in cases:
        results.append(case(label, fn))

    n_pass = sum(results)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
