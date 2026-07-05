"""agent primary model provider pool

Revision ID: 8b7d2f1a6c4e
Revises: 74d1b8e2c9a3
Create Date: 2026-07-05 00:00:00.000000
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "8b7d2f1a6c4e"
down_revision: str | Sequence[str] | None = "74d1b8e2c9a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_providers",
        sa.Column("models", postgresql.JSONB(none_as_null=True), nullable=True),
    )
    op.execute(
        sa.text(
            """
            UPDATE ai_providers
            SET models = jsonb_build_array(jsonb_build_object('id', default_model))
            WHERE default_model IS NOT NULL
              AND btrim(default_model) <> ''
              AND models IS NULL
            """
        )
    )
    _backfill_runtime_primary_models()
    op.drop_column("ai_providers", "default_model")


def downgrade() -> None:
    op.add_column(
        "ai_providers",
        sa.Column("default_model", sa.String(length=300), nullable=True),
    )
    op.execute(
        sa.text(
            """
            UPDATE ai_providers
            SET default_model = models->0->>'id'
            WHERE models IS NOT NULL
              AND jsonb_typeof(models) = 'array'
              AND jsonb_array_length(models) > 0
              AND models->0->>'id' IS NOT NULL
            """
        )
    )
    op.drop_column("ai_providers", "models")


def _backfill_runtime_primary_models() -> None:
    bind = op.get_bind()
    provider_models = {
        (
            str(row.owner_user_id),
            row.provider_id,
        ): row.default_model
        for row in bind.execute(
            sa.text(
                """
                SELECT owner_user_id, provider_id, default_model
                FROM ai_providers
                WHERE default_model IS NOT NULL
                  AND btrim(default_model) <> ''
                """
            )
        )
    }
    rows = bind.execute(
        sa.text(
            """
            SELECT
                hosted_runtime_states.environment_id::text AS environment_id,
                agent_environments.user_id::text AS owner_user_id,
                hosted_runtime_states.provider_id,
                hosted_runtime_states.runtimes
            FROM hosted_runtime_states
            JOIN agent_environments
              ON agent_environments.id = hosted_runtime_states.environment_id
            """
        )
    )
    update_stmt = sa.text(
        """
        UPDATE hosted_runtime_states
        SET runtimes = CAST(:runtimes AS jsonb)
        WHERE environment_id = CAST(:environment_id AS uuid)
        """
    )
    for row in rows:
        runtimes = row.runtimes
        if not isinstance(runtimes, dict):
            continue
        changed = False
        next_runtimes = dict(runtimes)
        for runtime_name, runtime in runtimes.items():
            if not isinstance(runtime, dict) or runtime.get("enabled") is not True:
                continue
            next_runtime = dict(runtime)
            provider_ids = _provider_ids(next_runtime, row.provider_id)
            primary_provider_id, primary_model = _primary_model(next_runtime)
            if primary_provider_id and primary_provider_id not in provider_ids:
                provider_ids.append(primary_provider_id)
            if primary_provider_id is None and len(provider_ids) == 1:
                primary_provider_id = provider_ids[0]
            if primary_model is None and primary_provider_id:
                primary_model = provider_models.get((row.owner_user_id, primary_provider_id))
            if provider_ids and next_runtime.get("provider_ids") != provider_ids:
                next_runtime["provider_ids"] = provider_ids
                changed = True
            if primary_provider_id and primary_model:
                next_primary = {
                    "provider_id": primary_provider_id,
                    "model": primary_model,
                }
                if next_runtime.get("primary_model") != next_primary:
                    next_runtime["primary_model"] = next_primary
                    changed = True
            next_runtimes[str(runtime_name)] = next_runtime
        if changed:
            bind.execute(
                update_stmt,
                {
                    "environment_id": row.environment_id,
                    "runtimes": json.dumps(next_runtimes),
                },
            )


def _provider_ids(runtime: dict[str, Any], state_provider_id: str | None) -> list[str]:
    raw_provider_ids = runtime.get("provider_ids") or runtime.get("providerIds")
    if isinstance(raw_provider_ids, list):
        return [
            value.strip()
            for value in raw_provider_ids
            if isinstance(value, str) and value.strip()
        ]
    raw_provider_id = runtime.get("provider_id") or runtime.get("providerId") or state_provider_id
    if isinstance(raw_provider_id, str) and raw_provider_id.strip():
        return [raw_provider_id.strip()]
    return []


def _primary_model(runtime: dict[str, Any]) -> tuple[str | None, str | None]:
    raw_primary = runtime.get("primary_model") or runtime.get("primaryModel")
    if isinstance(raw_primary, dict):
        raw_provider_id = raw_primary.get("provider_id") or raw_primary.get("providerId")
        raw_model = raw_primary.get("model")
        return _non_empty(raw_provider_id), _non_empty(raw_model)
    raw_model = _non_empty(raw_primary) or _non_empty(runtime.get("model"))
    return None, raw_model


def _non_empty(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
