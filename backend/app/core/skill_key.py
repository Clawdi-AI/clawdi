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
        and _SKILL_KEY_RE.fullmatch(skill_key) is not None
        and not has_reserved_skill_key_suffix(skill_key)
    )


def describe_skill_key(skill_key: str) -> str:
    """Diagnose rejected names without including directory names or content."""
    parts = skill_key.split("/")
    reason = "valid"
    if not skill_key:
        reason = "empty"
    elif len(skill_key) > MAX_SKILL_KEY_LEN:
        reason = "too_long"
    elif len(parts) > 4:
        reason = "too_deep"
    elif not skill_key.isascii():
        reason = "non_ascii"
    elif re.search(r"[^A-Za-z0-9/._-]", skill_key):
        reason = "invalid_characters"
    elif any(re.match(r"^[A-Za-z0-9]", part) is None for part in parts):
        reason = "invalid_component_start"
    elif has_reserved_skill_key_suffix(skill_key):
        reason = "reserved_suffix"
    return f"length={len(skill_key)}, components={len(parts)}, reason={reason}"


def is_legacy_hidden_skill_key(skill_key: str) -> bool:
    """Accept safe dot-prefixed metadata paths without the stored-key depth cap."""
    parts = skill_key.split("/")
    visible_key = "/".join(part.removeprefix(".") for part in parts)
    return (
        len(skill_key) <= MAX_SKILL_KEY_LEN
        and visible_key != skill_key
        and all(is_valid_skill_key(part.removeprefix(".")) for part in parts)
        and not has_reserved_skill_key_suffix(visible_key)
    )


def validate_derived_skill_key(skill_key: str) -> str:
    """Validate a server-derived skill_key before storage.

    Marketplace installs derive keys from SKILL.md frontmatter, so they
    must pass the same storage and route-safety contract as client input.
    """
    if not is_valid_skill_key(skill_key):
        raise SkillKeyValidationError(f"Invalid skill_key ({describe_skill_key(skill_key)})")
    return skill_key
