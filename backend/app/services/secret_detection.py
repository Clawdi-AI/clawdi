import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SecretFinding:
    label: str


SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("OpenAI-style API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b")),
    ("GitHub fine-grained token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("Bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b", re.IGNORECASE)),
)


def find_likely_secret(value: str) -> SecretFinding | None:
    for label, pattern in SECRET_PATTERNS:
        if pattern.search(value):
            return SecretFinding(label=label)
    return None


def secret_memory_warning(finding: SecretFinding) -> str:
    return (
        f"Detected a likely {finding.label}. Store secrets with "
        "`clawdi vault set <KEY> --stdin` and save a clawdi:// reference in memory instead."
    )
