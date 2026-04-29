"""Backwards-compat shim — the implementation moved to `secret_scanner.py`.

Originally `WikiSanitizer` lived here (PR #48) and protected only the wiki
synthesis path against vault-value leakage. The memory-quality proposal
(2026-04-29) found that the *write* path for memories also needed the same
guard plus pattern-based detection for well-known secret formats.

The implementation was promoted to `app.services.secret_scanner` so memory
writes, session extraction, and wiki synthesis can all share it. This module
remains as a re-export shim — existing imports of `WikiSanitizer` and
`VaultLeakError` continue to work unchanged.
"""

from app.services.secret_scanner import (
    MIN_VAULT_VALUE_LENGTH as MIN_LENGTH,
    SecretLeakError as VaultLeakError,
    SecretScanner as WikiSanitizer,
)

__all__ = ["MIN_LENGTH", "VaultLeakError", "WikiSanitizer"]
