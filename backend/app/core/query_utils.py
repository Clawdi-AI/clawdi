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
