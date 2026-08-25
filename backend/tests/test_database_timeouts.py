import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.database import engine


@pytest.mark.asyncio
async def test_database_engine_applies_and_enforces_postgres_timeouts():
    async with engine.connect() as connection:
        configured = (
            await connection.execute(
                text(
                    "SELECT current_setting('statement_timeout'), "
                    "current_setting('idle_in_transaction_session_timeout')"
                )
            )
        ).one()
        assert configured == ("2min", "5min")

        await connection.execute(text("SET LOCAL statement_timeout = '10ms'"))
        with pytest.raises(DBAPIError) as cancelled:
            await connection.execute(text("SELECT pg_sleep(0.1)"))

        assert cancelled.value.orig.sqlstate == "57014"
