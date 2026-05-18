"""Wiki output sanitizer — defense-in-depth against vault value leakage.

The wiki synthesis pipeline reads memory, skills, sessions, and vault
*scopes/names* (never values). But because LLMs can emit anything, every
piece of wiki-bound text passes through this sanitizer before being
written to wiki_pages.compiled_truth or wiki_links.

Strategy:
- Load all vault VALUES for the user once at the start of a synthesis run.
- Scan candidate text for any value as a literal substring.
- A short value (< MIN_LENGTH chars) is skipped to avoid false positives
  on short tokens that naturally appear in prose. Real secret keys are
  always longer than that.
- check() returns the list of leaked values (for logging by length, never
  by content). assert_clean() raises. redact() replaces inline.

This is a *defensive* layer — the synthesis pipeline must also avoid
passing vault values into the LLM in the first place. Both must hold.
"""

from __future__ import annotations


class VaultLeakError(Exception):
    """Raised when sanitized content still contains a vault value.

    The message NEVER includes the leaked content. We log lengths and
    counts only — including the value would defeat the purpose.
    """


# Vault values shorter than this are skipped during scanning.
# Rationale: short literals like "abc" or numeric IDs would match too much
# prose and produce false positives. Real secrets (API keys, JWTs, OAuth
# tokens) are universally longer than 12 chars; the median is 32+.
MIN_LENGTH = 12


class WikiSanitizer:
    """Catches vault values that have leaked into wiki-bound text.

    Construct once per synthesis run with the user's full set of vault
    values, then call check / assert_clean / redact on each LLM output
    before persisting.
    """

    def __init__(self, vault_values: set[str] | list[str]) -> None:
        self._values: set[str] = {v for v in vault_values if len(v) >= MIN_LENGTH}

    def __len__(self) -> int:
        return len(self._values)

    def check(self, text: str) -> list[str]:
        """Return the list of vault values found in `text`. Empty if clean.

        Caller must NOT log or surface the returned values directly. Use
        for length/count metrics only, or pass to assert_clean / redact.
        """
        if not text or not self._values:
            return []
        return [v for v in self._values if v in text]

    def assert_clean(self, text: str, context: str = "") -> None:
        """Raise VaultLeakError if `text` contains any vault value."""
        leaks = self.check(text)
        if leaks:
            ctx = f" in {context}" if context else ""
            raise VaultLeakError(
                f"Sanitizer detected {len(leaks)} vault value leak(s){ctx}. "
                f"Leak lengths: {sorted(len(v) for v in leaks)}."
            )

    def redact(self, text: str) -> str:
        """Replace any vault values in `text` with [REDACTED:N] (N = length).

        Use only when you must persist text that might contain a value
        and a hard fail would be worse. Prefer assert_clean for the
        synthesis pipeline so leaks fail loudly instead of silently
        being scrubbed.
        """
        if not text:
            return text
        out = text
        for v in self._values:
            out = out.replace(v, f"[REDACTED:{len(v)}]")
        return out
