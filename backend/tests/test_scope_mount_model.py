"""Smoke tests for the AgentProjectBinding model + schemas."""

import pytest


@pytest.mark.asyncio
async def test_agent_project_binding_model_imports():
    from app.models.agent_project_binding import AgentProjectBinding

    assert AgentProjectBinding.__tablename__ == "agent_project_bindings"
    constraint_names = {c.name for c in AgentProjectBinding.__table__.constraints}
    assert "uq_agent_project_bindings_agent_project" in constraint_names
    assert "uq_agent_project_bindings_agent_type_priority" in constraint_names
    assert "ck_agent_project_bindings_type_v1" in constraint_names
    index_names = {i.name for i in AgentProjectBinding.__table__.indexes}
    assert "ix_agent_project_bindings_agent" in index_names
    assert "uq_agent_project_bindings_one_primary" in index_names


@pytest.mark.asyncio
async def test_binding_schemas_import():
    from app.schemas.sharing import AgentProjectBindingResponse, BindingCreate

    assert BindingCreate.model_fields["project_id"].annotation is str
    expected = {
        "id",
        "agent_id",
        "project_id",
        "binding_type",
        "priority",
        "default_write_enabled",
        "created_at",
    }
    assert set(AgentProjectBindingResponse.model_fields.keys()) == expected
