import asyncio

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.core.config import settings
from app.core.database import async_session_factory, control_engine, control_snapshot_engine, engine
from app.main import app
from app.models.api_key import ApiKey
from app.services.api_key import mint_api_key
from app.services.metrics import registry


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("database_engine", "lock_timeout"),
    [(engine, "0"), (control_engine, "5s"), (control_snapshot_engine, "0")],
    ids=["ordinary", "control", "snapshot"],
)
async def test_database_engine_applies_and_enforces_postgres_timeouts(
    database_engine, lock_timeout
):
    async with database_engine.connect() as connection:
        configured = (
            await connection.execute(
                text(
                    "SELECT current_setting('statement_timeout'), "
                    "current_setting('idle_in_transaction_session_timeout'), "
                    "current_setting('lock_timeout')"
                )
            )
        ).one()
        assert configured == ("2min", "5min", lock_timeout)

        await connection.execute(text("SET LOCAL statement_timeout = '10ms'"))
        with pytest.raises(DBAPIError) as cancelled:
            await connection.execute(text("SELECT pg_sleep(0.1)"))

        assert cancelled.value.orig.sqlstate == "57014"


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_control_authority_lock_timeout_is_retryable_and_recovers(
    db_session, seed_user, monkeypatch
):
    minted = await mint_api_key(db_session, user_id=seed_user.id, label="control-lock-timeout")
    key_id = minted.api_key.id
    await db_session.commit()
    monkeypatch.setattr(settings, "admin_api_key", "test-control-lock-key")
    lock_metric = "clawdi_backend_db_control_lock_timeouts_total"
    pool_metric = "clawdi_backend_db_pool_timeouts_total"
    locks_before = registry.get_sample_value(lock_metric)
    pools_before = registry.get_sample_value(pool_metric)
    assert locks_before is not None
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        async with async_session_factory() as ordinary:
            await ordinary.execute(select(ApiKey.id).where(ApiKey.id == key_id).with_for_update())
            # The ordinary authority transaction stays open past the control
            # lock timeout. An unchanged 120s statement timeout fails this bound.
            async with asyncio.timeout(12):
                rejected = await client.delete(
                    f"/v1/admin/auth/keys/{key_id}",
                    headers={"X-Admin-Key": "test-control-lock-key"},
                )
            assert rejected.status_code == 503
            assert rejected.json() == {"detail": "Deployment control temporarily unavailable"}
            assert rejected.headers["Retry-After"] == "1"
            assert registry.get_sample_value(lock_metric) == locks_before + 1
            assert registry.get_sample_value(pool_metric) == pools_before

        recovered = await client.delete(
            f"/v1/admin/auth/keys/{key_id}",
            headers={"X-Admin-Key": "test-control-lock-key"},
        )
        assert recovered.status_code == 200, recovered.text
        assert recovered.json() == {"status": "revoked"}
