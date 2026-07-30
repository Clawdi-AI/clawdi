from __future__ import annotations


class RuntimeApplyGenerationUpdateError(ValueError):
    def __init__(self, code: str, current_apply_generation: int | None) -> None:
        self.code = code
        self.current_apply_generation = current_apply_generation
        super().__init__(code)


def resolve_runtime_apply_generation(
    *,
    generation: int,
    apply_generation: int | None,
) -> int:
    """Resolve explicit apply identity with the released checkpoint fallback."""
    return apply_generation if apply_generation is not None else generation


def resolve_runtime_apply_generation_update(
    *,
    current: int | None,
    requested: int | None,
    explicitly_set: bool,
) -> int | None:
    """Preserve omission while rejecting an explicit clear or regression."""
    if explicitly_set and requested is None:
        raise RuntimeApplyGenerationUpdateError(
            "apply_generation_conflict",
            current,
        )
    if current is None:
        return requested
    if requested is not None and requested < current:
        raise RuntimeApplyGenerationUpdateError(
            "stale_apply_generation",
            current,
        )
    return current if requested is None else requested
