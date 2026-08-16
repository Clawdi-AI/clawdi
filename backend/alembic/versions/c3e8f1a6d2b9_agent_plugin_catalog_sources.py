"""Persist immutable Agent Plugin catalog source identities.

Revision ID: c3e8f1a6d2b9
Revises: f7c2d4a9e1b6
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c3e8f1a6d2b9"
down_revision: str | Sequence[str] | None = "f7c2d4a9e1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STORE_URL = "https://github.com/Clawdi-AI/store"


def upgrade() -> None:
    op.drop_constraint(
        "ck_plugin_catalog_snapshots_schema_version",
        "plugin_catalog_snapshots",
        type_="check",
    )
    op.create_check_constraint(
        "ck_plugin_catalog_snapshots_schema_version",
        "plugin_catalog_snapshots",
        "schema_version IN (1, 2)",
    )

    for table in ("plugin_catalog_entries", "agent_plugin_installations"):
        op.add_column(
            table,
            sa.Column("source", postgresql.JSONB(none_as_null=True), nullable=True),
        )

    op.execute(
        sa.text(
            """
            UPDATE plugin_catalog_entries
            SET source = jsonb_build_object(
                'type', 'github',
                'url', :store_url,
                'path', source_path,
                'commit', snapshot_revision
            )
            """
        ).bindparams(store_url=_STORE_URL)
    )
    op.execute(
        sa.text(
            """
            UPDATE agent_plugin_installations
            SET source = jsonb_build_object(
                'type', 'github',
                'url', :store_url,
                'path', source_path,
                'commit', catalog_revision
            )
            """
        ).bindparams(store_url=_STORE_URL)
    )

    for table in ("plugin_catalog_entries", "agent_plugin_installations"):
        op.alter_column(table, "source", nullable=False)
        op.drop_column(table, "source_path")


def downgrade() -> None:
    bind = op.get_bind()
    has_v2_snapshots = bind.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM plugin_catalog_snapshots WHERE schema_version <> 1)")
    ).scalar_one()
    incompatible_source = bind.execute(
        sa.text(
            """
            SELECT EXISTS (
                SELECT 1 FROM plugin_catalog_entries
                WHERE jsonb_typeof(source) IS DISTINCT FROM 'object'
                   OR source->>'type' IS DISTINCT FROM 'github'
                   OR source->>'url' IS DISTINCT FROM :store_url
                   OR source->>'commit' IS DISTINCT FROM snapshot_revision
                   OR source->>'path' IS NULL
                UNION ALL
                SELECT 1 FROM agent_plugin_installations
                WHERE jsonb_typeof(source) IS DISTINCT FROM 'object'
                   OR source->>'type' IS DISTINCT FROM 'github'
                   OR source->>'url' IS DISTINCT FROM :store_url
                   OR source->>'commit' IS DISTINCT FROM catalog_revision
                   OR source->>'path' IS NULL
            )
            """
        ).bindparams(store_url=_STORE_URL)
    ).scalar_one()
    if has_v2_snapshots or incompatible_source:
        raise RuntimeError(
            "Cannot downgrade Agent Plugin source identities while catalog v2 "
            "or non-Store sources exist."
        )

    op.add_column(
        "plugin_catalog_entries",
        sa.Column("source_path", sa.String(length=500), nullable=True),
    )
    op.execute(sa.text("UPDATE plugin_catalog_entries SET source_path = source->>'path'"))
    op.alter_column("plugin_catalog_entries", "source_path", nullable=False)
    op.drop_column("plugin_catalog_entries", "source")
    op.add_column(
        "agent_plugin_installations",
        sa.Column("source_path", sa.String(length=500), nullable=True),
    )
    op.execute(sa.text("UPDATE agent_plugin_installations SET source_path = source->>'path'"))
    op.alter_column("agent_plugin_installations", "source_path", nullable=False)
    op.drop_column("agent_plugin_installations", "source")

    op.drop_constraint(
        "ck_plugin_catalog_snapshots_schema_version",
        "plugin_catalog_snapshots",
        type_="check",
    )
    op.create_check_constraint(
        "ck_plugin_catalog_snapshots_schema_version",
        "plugin_catalog_snapshots",
        "schema_version = 1",
    )
