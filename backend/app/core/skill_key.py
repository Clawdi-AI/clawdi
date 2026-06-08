import re

# `skill_key` is concatenated into a file-store path, so any '..'
# segment or empty / hidden component would let a caller escape the
# user's prefix. The pattern allows up to 4 nested path components
# joined by '/' (Hermes layouts like `category/foo/SKILL.md` need
# this). Each component:
#   - starts with [A-Za-z0-9] (rejects '.' / '..' as a component,
#     and leading-dot hidden segments)
#   - then [A-Za-z0-9._-]{0,199}
#
# Total length is capped separately at MAX_SKILL_KEY_LEN, matching
# the Skill.skill_key String(200) column width.
SKILL_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}(/[A-Za-z0-9][A-Za-z0-9._\-]{0,199}){0,3}$"
MAX_SKILL_KEY_LEN = 200
RESERVED_SKILL_KEY_SUFFIXES = frozenset({"download", "content", "install"})

_SKILL_KEY_RE = re.compile(SKILL_KEY_PATTERN)


class SkillKeyValidationError(ValueError):
    pass


def has_reserved_skill_key_suffix(skill_key: str) -> bool:
    """True iff the last component conflicts with a route-owned suffix.

    Flat keys like `download` are allowed; only nested keys like
    `team/download` collide with `/{skill_key:path}/download`.
    """
    parts = skill_key.split("/")
    return len(parts) > 1 and parts[-1] in RESERVED_SKILL_KEY_SUFFIXES


def is_valid_skill_key(skill_key: str) -> bool:
    return (
        len(skill_key) <= MAX_SKILL_KEY_LEN
        and _SKILL_KEY_RE.match(skill_key) is not None
        and not has_reserved_skill_key_suffix(skill_key)
    )


def validate_derived_skill_key(skill_key: str) -> str:
    """Validate a server-derived skill_key before storage.

    Marketplace installs derive keys from SKILL.md frontmatter, so they
    must pass the same storage and route-safety contract as client input.
    """
    if not is_valid_skill_key(skill_key):
        raise SkillKeyValidationError(f"derived skill_key {skill_key!r} is not safe for storage")
    return skill_key
