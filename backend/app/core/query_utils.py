"""Query-string utilities shared by search + list endpoints."""

import re
from collections.abc import Sequence
from typing import Annotated, Any

from pydantic import StringConstraints
from sqlalchemy import func, literal_column, or_
from sqlalchemy.sql.elements import ColumnElement, SQLColumnExpression

_SIMPLE_TEXT_SEARCH_CONFIG: SQLColumnExpression[Any] = literal_column("'simple'::regconfig")
_WEBSEARCH_TOKEN_RE = re.compile(r'(-?)"([^"]+)"|(\S+)')

SEARCH_QUERY_MIN_LENGTH = 2
SEARCH_QUERY_MAX_LENGTH = 500
SearchQuery = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=SEARCH_QUERY_MIN_LENGTH,
        max_length=SEARCH_QUERY_MAX_LENGTH,
    ),
]


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
    """Return positive PostgreSQL web-search operands in display order."""
    terms: list[str] = []
    seen: set[str] = set()
    for match in _WEBSEARCH_TOKEN_RE.finditer(query):
        negated, quoted, unquoted = match.groups()
        if quoted is not None:
            if negated:
                continue
            term = quoted.strip()
        else:
            assert unquoted is not None
            if unquoted.startswith("-") or unquoted.casefold() == "or":
                continue
            term = unquoted
        if not term:
            continue
        folded = term.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        terms.append(term)
    return tuple(terms)


def search_highlight_terms(query: str) -> tuple[str, ...]:
    """Return display terms, preferring a contiguous plain query when present."""
    terms = search_terms(query)
    phrase = query.strip()
    has_websearch_operator = '"' in phrase or any(
        token.startswith("-") or token.casefold() == "or" for token in phrase.split()
    )
    if phrase and len(terms) > 1 and not has_websearch_operator:
        return (phrase, *terms)
    return terms


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
    folded = compact.casefold()
    terms = search_terms(query)
    highlight_terms = search_highlight_terms(query)
    preferred_phrase = highlight_terms[0] if len(highlight_terms) > len(terms) else None
    preferred_match = folded.find(preferred_phrase.casefold()) if preferred_phrase else -1
    fallback_match = min(
        (match for term in terms if (match := folded.find(term.casefold())) >= 0),
        default=-1,
    )
    match_at = preferred_match if preferred_match >= 0 else fallback_match
    if match_at < 0:
        return f"{compact[: limit - 3]}..."
    start = max(0, match_at - limit // 3)
    end = min(len(compact), start + limit)
    start = max(0, end - limit)
    return f"{'...' if start else ''}{compact[start:end]}{'...' if end < len(compact) else ''}"
