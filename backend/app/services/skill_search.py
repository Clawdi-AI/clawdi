"""Shared literal search semantics for Skill collection surfaces."""

from sqlalchemy import case
from sqlalchemy.sql.elements import ColumnElement

from app.core.query_utils import (
    escape_like,
    lexical_search_filter,
    like_needle,
    search_excerpt,
    search_terms,
)
from app.models.skill import Skill


def skill_search_filter(query: str) -> ColumnElement[bool]:
    return lexical_search_filter(
        query,
        (Skill.name, Skill.skill_key, Skill.description),
    )


def skill_search_rank(query: str) -> ColumnElement[int]:
    exact = escape_like(query)
    prefix = f"{exact}%"
    needle = like_needle(query)
    return case(
        (Skill.name.ilike(exact, escape="\\"), 0),
        (Skill.skill_key.ilike(exact, escape="\\"), 1),
        (Skill.name.ilike(prefix, escape="\\"), 2),
        (Skill.skill_key.ilike(prefix, escape="\\"), 3),
        (Skill.name.ilike(needle, escape="\\"), 4),
        (Skill.skill_key.ilike(needle, escape="\\"), 5),
        (Skill.description.ilike(needle, escape="\\"), 6),
        else_=7,
    )


def skill_search_subtitle(skill: Skill, query: str) -> str:
    terms = tuple(term.casefold() for term in search_terms(query))
    if any(term in skill.skill_key.casefold() for term in terms):
        return skill.skill_key
    description = (skill.description or "").strip()
    if description and any(term in description.casefold() for term in terms):
        return search_excerpt(description, query, limit=160)
    return description or skill.skill_key
