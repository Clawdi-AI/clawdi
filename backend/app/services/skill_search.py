"""Shared literal search semantics for Skill collection surfaces."""

from sqlalchemy import case, or_
from sqlalchemy.sql.elements import ColumnElement

from app.core.query_utils import escape_like, like_needle, search_excerpt
from app.models.skill import Skill


def skill_search_filter(query: str) -> ColumnElement[bool]:
    needle = like_needle(query)
    return or_(
        Skill.name.ilike(needle, escape="\\"),
        Skill.skill_key.ilike(needle, escape="\\"),
        Skill.description.ilike(needle, escape="\\"),
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
    folded_query = query.casefold()
    if folded_query in skill.skill_key.casefold():
        return skill.skill_key
    description = (skill.description or "").strip()
    if description and folded_query in description.casefold():
        return search_excerpt(description, query, limit=160)
    return description or skill.skill_key
