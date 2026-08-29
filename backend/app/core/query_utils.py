"""Query-string utilities shared by search + list endpoints."""


def escape_like(s: str, escape_char: str = "\\") -> str:
    """Escape ``%`` / ``_`` / escape-char so user input can't become a wildcard.

    SQLAlchemy's ``.ilike()`` does not auto-escape LIKE metacharacters — a user
    typing ``%`` turns the needle into a match-everything wildcard, defeats
    selectivity, and forces a full-column scan. Always wrap user-supplied
    search text with this before interpolating into a ``LIKE`` pattern, and
    pass ``escape="\\"`` to ``.ilike(...)`` so the DB honors the escape char.
    """
    return (
        s.replace(escape_char, escape_char * 2)
        .replace("%", f"{escape_char}%")
        .replace("_", f"{escape_char}_")
    )


def like_needle(query: str) -> str:
    """Build a safe ``%query%`` ILIKE needle. Pair with ``.ilike(n, escape="\\")``."""
    return f"%{escape_like(query)}%"


def search_excerpt(content: str, query: str, *, limit: int = 240) -> str:
    """Return compact context around a literal, case-insensitive match."""
    compact = " ".join(content.split())
    if len(compact) <= limit:
        return compact
    phrase = query.strip()
    match_at = compact.casefold().find(phrase.casefold()) if phrase else -1
    if match_at < 0:
        return f"{compact[: limit - 3]}..."
    start = max(0, match_at - limit // 3)
    end = min(len(compact), start + limit)
    start = max(0, end - limit)
    return f"{'...' if start else ''}{compact[start:end]}{'...' if end < len(compact) else ''}"
