"""Smoke tests for the ScopeMount model + schemas.

Just import smoke. Real uniqueness + cascade behavior is verified
in tests/test_scope_mounts.py (MB phase) when the CRUD endpoints
actually exercise the constraints.
"""

import pytest


@pytest.mark.asyncio
async def test_scope_mount_model_imports():
    from app.models.scope_mount import ScopeMount

    assert ScopeMount.__tablename__ == "scope_mounts"
    # Sanity check the unique constraints are declared on the model;
    # alembic migration test verifies they exist in the DB itself.
    constraint_names = {c.name for c in ScopeMount.__table__.constraints}
    assert "uq_scope_mounts_parent_source" in constraint_names
    assert "uq_scope_mounts_parent_alias" in constraint_names


@pytest.mark.asyncio
async def test_mount_schemas_import():
    from app.schemas.sharing import MountCreate, MountResponse

    assert MountCreate.model_fields["source_scope_id"].annotation is str
    expected = {
        "id",
        "parent_scope_id",
        "source_scope_id",
        "source_scope_name",
        "source_scope_slug",
        "source_owner_display",
        "source_owner_handle",
        "alias",
        "mode",
        "created_at",
    }
    assert set(MountResponse.model_fields.keys()) == expected
