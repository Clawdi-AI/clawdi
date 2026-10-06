import pytest

from app.core.skill_key import (
    MAX_SKILL_KEY_LEN,
    SkillKeyValidationError,
    describe_skill_key,
    has_reserved_skill_key_suffix,
    is_valid_skill_key,
    validate_derived_skill_key,
)


def test_skill_key_validation_accepts_flat_and_nested_keys():
    assert is_valid_skill_key("demo")
    assert is_valid_skill_key("category/demo")
    assert is_valid_skill_key("team.tools/demo_v1")
    assert is_valid_skill_key("Team.tools/Demo_v1")
    assert is_valid_skill_key("a/b/c/d")
    assert is_valid_skill_key("a" * MAX_SKILL_KEY_LEN)


def test_skill_key_validation_rejects_storage_unsafe_keys():
    for key in ["", ".system", "../etc", "team/.hidden", "team//demo", "a" * 201]:
        assert not is_valid_skill_key(key)
        with pytest.raises(SkillKeyValidationError):
            validate_derived_skill_key(key)


def test_reserved_suffixes_only_apply_to_nested_keys():
    assert is_valid_skill_key("download")
    assert not is_valid_skill_key("team/download")
    assert has_reserved_skill_key_suffix("team/content")
    assert not has_reserved_skill_key_suffix("content")


@pytest.mark.parametrize(
    ("key", "reason"),
    [
        ("", "empty"),
        ("中文", "non_ascii"),
        ("my skill", "invalid_characters"),
        ("demo\n", "invalid_characters"),
        (".system", "invalid_component_start"),
        ("team/_private", "invalid_component_start"),
        ("team//demo", "invalid_component_start"),
        ("a/b/c/d/e", "too_deep"),
        ("a" * 201, "too_long"),
        ("team/download", "reserved_suffix"),
    ],
)
def test_invalid_key_diagnostics_include_only_shape(key: str, reason: str):
    assert not is_valid_skill_key(key)
    description = describe_skill_key(key)
    assert description == f"length={len(key)}, components={len(key.split('/'))}, reason={reason}"
    with pytest.raises(SkillKeyValidationError) as error:
        validate_derived_skill_key(key)
    assert str(error.value) == f"Invalid skill_key ({description})"
