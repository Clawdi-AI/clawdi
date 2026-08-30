"""Query-string utilities shared by search + list endpoints."""

from collections.abc import Sequence
from typing import Any

from sqlalchemy import func, literal_column, or_
from sqlalchemy.sql.elements import ColumnElement, SQLColumnExpression

_SIMPLE_TEXT_SEARCH_CONFIG: SQLColumnExpression[Any] = literal_column("'simple'::regconfig")


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


def search_terms(query: str) -> tuple[str, ...]:
    """Return unique, whitespace-delimited terms while preserving input order."""
    terms: list[str] = []
    seen: set[str] = set()
    for term in query.split():
        folded = term.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        terms.append(term)
    return tuple(terms)


def websearch_query(query: str) -> ColumnElement[Any]:
    """Build PostgreSQL's forgiving, web-style lexical query."""
    return func.websearch_to_tsquery(_SIMPLE_TEXT_SEARCH_CONFIG, query)


def text_search_document(
    fields: Sequence[SQLColumnExpression[Any]],
) -> ColumnElement[Any]:
    """Build the canonical simple-config document used by filters and indexes."""
    if not fields:
        raise ValueError("text search requires at least one field")
    source = fields[0] if len(fields) == 1 else func.concat_ws(" ", *fields)
    return func.to_tsvector(_SIMPLE_TEXT_SEARCH_CONFIG, source)


def lexical_search_filter(
    query: str,
    fields: Sequence[SQLColumnExpression[Any]],
    *,
    search_vector: SQLColumnExpression[Any] | None = None,
) -> ColumnElement[bool]:
    """Match a literal phrase or PostgreSQL web-search terms across fields."""
    literal_match = or_(
        *(field.ilike(like_needle(query), escape="\\") for field in fields),
    )
    document = search_vector
    if document is None:
        document = text_search_document(fields)
    return or_(literal_match, document.op("@@")(websearch_query(query)))


def search_excerpt(content: str, query: str, *, limit: int = 240) -> str:
    """Return compact context around a literal, case-insensitive match."""
    compact = " ".join(content.split())
    if len(compact) <= limit:
        return compact
    phrase = query.strip()
    match_at = compact.casefold().find(phrase.casefold()) if phrase else -1
    if match_at < 0:
        folded = compact.casefold()
        term_matches = [
            match for term in search_terms(query) if (match := folded.find(term.casefold())) >= 0
        ]
        match_at = min(term_matches, default=-1)
    if match_at < 0:
        return f"{compact[: limit - 3]}..."
    start = max(0, match_at - limit // 3)
    end = min(len(compact), start + limit)
    start = max(0, end - limit)
    return f"{'...' if start else ''}{compact[start:end]}{'...' if end < len(compact) else ''}"
