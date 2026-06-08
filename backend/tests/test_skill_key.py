import pytest

from app.core.skill_key import (
    MAX_SKILL_KEY_LEN,
    SkillKeyValidationError,
    has_reserved_skill_key_suffix,
    is_valid_skill_key,
    validate_derived_skill_key,
)


def test_skill_key_validation_accepts_flat_and_nested_keys():
    assert is_valid_skill_key("demo")
    assert is_valid_skill_key("category/demo")
    assert is_valid_skill_key("team.tools/demo_v1")
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
