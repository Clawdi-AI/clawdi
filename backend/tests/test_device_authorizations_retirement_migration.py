from __future__ import annotations

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.migration_harness import load_migration

LEGACY_MIGRATION = "f972e0fac9ef_add_device_authorizations.py"
RETIREMENT_MIGRATION = "b1c7d9e4f2a6_remove_device_authorizations.py"


def test_device_authorizations_retirement_migration_drops_and_restores_table(
    engine: AsyncEngine,
) -> None:
    legacy = load_migration(LEGACY_MIGRATION, "legacy_device_authorizations")
    retirement = load_migration(RETIREMENT_MIGRATION, "retire_device_authorizations")
    sync_engine = create_engine(engine.url.set(drivername="postgresql+psycopg2"))
    original_legacy_op = legacy.op
    original_retirement_op = retirement.op
    try:
        with sync_engine.begin() as connection:
            legacy.op = Operations(MigrationContext.configure(connection))
            retirement.op = legacy.op

            legacy.upgrade()
            assert "device_authorizations" in sa.inspect(connection).get_table_names()

            retirement.upgrade()
            assert "device_authorizations" not in sa.inspect(connection).get_table_names()

            retirement.downgrade()
            inspector = sa.inspect(connection)
            assert "device_authorizations" in inspector.get_table_names()
            assert {index["name"] for index in inspector.get_indexes("device_authorizations")} == {
                "ix_device_authorizations_device_code",
                "ix_device_authorizations_user_code",
            }
    finally:
        legacy.op = original_legacy_op
        retirement.op = original_retirement_op
        with sync_engine.begin() as connection:
            connection.execute(sa.text("DROP TABLE IF EXISTS device_authorizations"))
        sync_engine.dispose()
