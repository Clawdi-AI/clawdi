"""Self-test for app.services.slug_resolver.

Run from backend dir:
    uv run python scripts/test_slug_resolver.py

Tests the pure `normalize` function only. The DB-aware `SlugResolver.resolve`
is exercised end-to-end by the entity extraction job's integration tests
once that pipeline lands.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.slug_resolver import normalize  # noqa: E402


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


def main() -> int:
    print("# Slug resolver self-test (normalize)\n")
    results: list[bool] = []

    EXPECTED = [
        # input → expected
        ("Polymarket", "polymarket"),
        ("polymarket", "polymarket"),
        ("POLYMARKET", "polymarket"),
        ("Poly Market", "poly-market"),
        ("poly market", "poly-market"),
        ("POLY_MARKET", "poly-market"),
        ("poly-market", "poly-market"),
        ("poly--market", "poly-market"),
        ("Poly's Market!", "polys-market"),
        ("  spaced  ", "spaced"),
        ("hyphens---collapse", "hyphens-collapse"),
        ("---leading-trailing---", "leading-trailing"),
        ("Mix3d_C4se Stuff", "mix3d-c4se-stuff"),
        # Realistic shapes from the user's actual data:
        ("Twilio Voice Agent", "twilio-voice-agent"),
        ("clawdi-backend", "clawdi-backend"),
        ("Hermes + OpenClaw", "hermes-openclaw"),
        ("phala-metrics-analyser-redpill-api", "phala-metrics-analyser-redpill-api"),
        # Edge cases:
        ("", ""),
        ("   ", ""),
        ("!!!", ""),
        ("---", ""),
        ("a", "a"),  # single char preserved
    ]

    def deterministic_mapping():
        for raw, expected in EXPECTED:
            got = normalize(raw)
            assert got == expected, (
                f"normalize({raw!r}) → {got!r}, expected {expected!r}"
            )

    def idempotent():
        # normalize(normalize(x)) == normalize(x) for all inputs
        for raw, _ in EXPECTED:
            once = normalize(raw)
            twice = normalize(once)
            assert once == twice, (
                f"not idempotent: {raw!r} → {once!r} → {twice!r}"
            )

    def case_only_aliases_collapse_to_same_slug():
        # Pure normalize handles only case/whitespace/punct-only variants.
        # Cross-word-boundary aliases ("Poly Market" vs "Polymarket") are
        # the DB-fuzzy-match's responsibility, tested via pg_trgm at
        # SlugResolver.resolve integration time.
        aliases = ["Polymarket", "polymarket", "POLYMARKET", "Polymarket  "]
        slugs = {normalize(a) for a in aliases}
        assert slugs == {"polymarket"}, f"case-only aliases produced {slugs}"

    def whitespace_aliases_collapse_to_same_slug():
        aliases = ["Poly Market", "Poly  Market", "POLY_MARKET", "poly-market", "poly--market"]
        slugs = {normalize(a) for a in aliases}
        assert slugs == {"poly-market"}, f"whitespace aliases produced {slugs}"

    def long_input_truncated():
        long_name = "a" * 250
        out = normalize(long_name)
        assert len(out) <= 200, f"length {len(out)} exceeds MAX_SLUG_LENGTH=200"

    cases = [
        ("normalize: deterministic mapping (22 cases)", deterministic_mapping),
        ("normalize: idempotent", idempotent),
        (
            "normalize: case-only aliases collapse to one slug",
            case_only_aliases_collapse_to_same_slug,
        ),
        (
            "normalize: whitespace/underscore aliases collapse to one slug",
            whitespace_aliases_collapse_to_same_slug,
        ),
        ("normalize: input over 200 chars is truncated", long_input_truncated),
    ]

    for label, fn in cases:
        results.append(case(label, fn))

    n_pass = sum(results)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
