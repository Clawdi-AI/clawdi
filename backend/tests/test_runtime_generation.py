from __future__ import annotations

import pytest

from app.services.runtime_generation import (
    RuntimeApplyGenerationUpdateError,
    resolve_runtime_apply_generation,
    resolve_runtime_apply_generation_update,
)


def test_runtime_apply_generation_resolver_names_the_legacy_checkpoint_fallback() -> None:
    assert resolve_runtime_apply_generation(generation=2, apply_generation=1) == 1
    assert resolve_runtime_apply_generation(generation=2, apply_generation=None) == 2


def test_runtime_apply_generation_update_preserves_omission_and_binds_once() -> None:
    assert (
        resolve_runtime_apply_generation_update(
            current=None,
            requested=None,
            explicitly_set=False,
        )
        is None
    )
    assert (
        resolve_runtime_apply_generation_update(
            current=None,
            requested=1,
            explicitly_set=True,
        )
        == 1
    )
    assert (
        resolve_runtime_apply_generation_update(
            current=2,
            requested=3,
            explicitly_set=True,
        )
        == 3
    )


@pytest.mark.parametrize(
    ("current", "requested", "code"),
    [
        (None, None, "apply_generation_conflict"),
        (1, None, "apply_generation_conflict"),
        (2, 1, "stale_apply_generation"),
    ],
)
def test_runtime_apply_generation_update_rejects_explicit_null_and_regression(
    current: int | None,
    requested: int | None,
    code: str,
) -> None:
    with pytest.raises(RuntimeApplyGenerationUpdateError) as exc_info:
        resolve_runtime_apply_generation_update(
            current=current,
            requested=requested,
            explicitly_set=True,
        )

    assert exc_info.value.code == code
    assert exc_info.value.current_apply_generation == current
