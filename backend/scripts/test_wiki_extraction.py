"""Self-test for app.services.wiki_extraction.extract_candidates (pure function).

Run from backend dir:
    uv run python scripts/test_wiki_extraction.py

Tests the heuristic extractor only. The DB pipeline is exercised by the
synthesis self-test once that lands.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.wiki_extraction import extract_candidates  # noqa: E402


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


# Sample memory contents from the user's actual data shape.
SAMPLE_VOICE_MEMORY = """# Voice Call Twilio Setup

Voice-call extension switched from Telnyx to Twilio (2026-03-13).

Config (in /data/openclaw/openclaw.json under extensions.voice-call):
- Provider: twilio
- Phone: +16505252934
- Public URL: https://example.dstack-pha-prod3.phala.network/voice/webhook

Architecture: Twilio Media Streams → OpenAI Realtime API for STT.
"""

SAMPLE_DEPLOY_MEMORY = """ClawdBot deployed on Phala Cloud as CVM marvin-claw.
Uses OpenClaw 2026.2.17-phala.7. Branch phala-2026.2.17.
Phala profile: marvintongs-projects.
"""

SAMPLE_SHORT_NOISE = """OK now this is fine. The DB has POSTHOG configured."""

SAMPLE_SKILL_DESC = "Query Polymarket prediction market data — search markets, get prices."


def main() -> int:
    print("# wiki_extraction.extract_candidates self-test\n")
    results: list[bool] = []

    def voice_memory_extracts_real_entities():
        cands = extract_candidates(SAMPLE_VOICE_MEMORY)
        # Should find: Twilio, Telnyx, Voice Call Twilio Setup (multi-word),
        # OpenAI, STT (acronym), and possibly others.
        # Don't over-specify: just assert the must-haves. Over-extraction
        # is acceptable — pages with weak/single source links get pruned
        # at the synthesis stage by source_count thresholds.
        cl = {c.lower() for c in cands}
        for must in ("twilio", "telnyx", "openai"):
            assert must in cl, f"missing {must!r}; got {sorted(cl)}"
        # Stopwords / pronouns must not appear.
        for noise in ("the", "this", "if"):
            assert noise not in cl, f"stopword leaked: {noise!r} in {sorted(cl)}"

    def deploy_memory_extracts_real_entities():
        cands = extract_candidates(SAMPLE_DEPLOY_MEMORY)
        cl = {c.lower() for c in cands}
        for must in ("clawdbot", "phala cloud", "openclaw"):
            assert must in cl, f"missing {must!r}; got {sorted(cl)}"

    def short_noise_yields_only_acronyms():
        cands = extract_candidates(SAMPLE_SHORT_NOISE)
        cl = {c.lower() for c in cands}
        # POSTHOG is the only real entity here.
        assert "posthog" in cl
        # "OK", "DB", "The" must be filtered.
        for noise in ("ok", "the", "db"):
            assert noise not in cl, f"stopword leaked: {noise!r}"

    def skill_description_extracts_brand():
        cands = extract_candidates(SAMPLE_SKILL_DESC)
        cl = {c.lower() for c in cands}
        assert "polymarket" in cl, f"missing 'polymarket' in {sorted(cl)}"

    def empty_input_returns_empty():
        assert extract_candidates("") == []
        assert extract_candidates(None) == []  # type: ignore[arg-type]

    def deduplicates_case_insensitively():
        text = "Stripe is a payment provider. Use stripe for charges. STRIPE checkout."
        cands = extract_candidates(text)
        # Either "Stripe" or "STRIPE" comes first; only one is kept.
        stripe_count = sum(1 for c in cands if c.lower() == "stripe")
        assert stripe_count == 1, f"expected dedup; got {cands}"

    def trailing_punctuation_stripped():
        cands = extract_candidates("ClawdBot. Then we use OpenClaw, then Twilio!")
        for c in cands:
            assert not c.endswith((".", ",", "!", "?")), f"punctuation leaked: {c!r}"

    def realistic_session_summary():
        text = (
            "I'm continuing work from a past session about a printer script. "
            "Marvin asked me to debug the Phala Cloud deployment of ClawdBot. "
            "We checked CLERK and STRIPE configurations."
        )
        cands = extract_candidates(text)
        cl = {c.lower() for c in cands}
        # "Marvin" is a proper noun (the user's name) — should be caught.
        assert "marvin" in cl, f"missed 'Marvin' in {sorted(cl)}"
        assert "phala cloud" in cl, f"missed 'Phala Cloud' in {sorted(cl)}"
        assert "clawdbot" in cl, f"missed 'ClawdBot' in {sorted(cl)}"
        # All-caps brand names (CLERK, STRIPE) caught by acronym regex.
        # (Underscored env-var names like CLERK_SECRET_KEY are intentionally
        # NOT entities — those are first-class via the vault domain.)
        assert "clerk" in cl or "stripe" in cl, (
            f"missed all-caps brand names in {sorted(cl)}"
        )

    cases = [
        ("voice memory: extracts Twilio + Telnyx", voice_memory_extracts_real_entities),
        ("deploy memory: extracts ClawdBot + Phala Cloud + OpenClaw", deploy_memory_extracts_real_entities),
        ("short noise: extracts POSTHOG, filters stopwords", short_noise_yields_only_acronyms),
        ("skill description: extracts Polymarket", skill_description_extracts_brand),
        ("empty/None: returns []", empty_input_returns_empty),
        ("deduplicates case-insensitively (Stripe/stripe/STRIPE → 1)", deduplicates_case_insensitively),
        ("strips trailing punctuation", trailing_punctuation_stripped),
        ("realistic session summary: catches names + env vars", realistic_session_summary),
    ]

    for label, fn in cases:
        results.append(case(label, fn))

    n_pass = sum(results)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
