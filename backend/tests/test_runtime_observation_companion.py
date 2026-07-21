from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.services.runtime_observation as runtime_observation_service
from app.core.auth import AuthContext, get_auth
from app.core.config import settings
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.audit import ControlPlaneAuditEvent
from app.models.hosted_runtime import HostedRuntimeConfigObservation, HostedRuntimeState
from app.models.runtime_observation import (
    V2RuntimeEnvironmentFence,
    V2RuntimeObservationConsumerCursor,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.models.session import AgentEnvironment
from app.schemas.runtime_observation import RuntimeObservationEventV2
from app.services.api_key import mint_api_key
from app.services.runtime_observation import (
    RuntimeApplyIdentity,
    RuntimeObservationProtocolError,
    acknowledge_runtime_observation_cursor,
    expire_runtime_observation_payloads,
    provision_runtime_environment_fence,
    read_runtime_observations,
    register_runtime_observation_consumer,
    reset_runtime_observation_consumer,
)
from app.services.runtime_observation import (
    ingest_runtime_observation as _ingest_runtime_observation,
)
from app.services.runtime_observation import (
    retire_runtime_environment as _retire_runtime_environment,
)
from tests.conftest import create_env_with_project

_DEPLOYMENT_ID = "deployment-observation-companion"
_APPLY_RECEIPT_ID = "apply-receipt-00000001"
_BOOT_NONCE = "boot-nonce-0000000001"
_MANIFEST_ETAG = '"manifest-etag-0001"'


async def ingest_runtime_observation(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    value: RuntimeObservationEventV2,
    received_at: datetime | None = None,
    credential_deployment_id: str = _DEPLOYMENT_ID,
):
    return await _ingest_runtime_observation(
        db,
        environment_id=environment_id,
        credential_deployment_id=credential_deployment_id,
        value=value,
        received_at=received_at,
    )


@dataclass(frozen=True)
class _EnvironmentRef:
    id: uuid.UUID


def _payload(
    *,
    boot_session_id: str = "boot-session-0001",
    sequence: int = 1,
    event_id: str | None = None,
    captured_at: datetime | None = None,
    generation: int = 1,
    manifest_etag: str = _MANIFEST_ETAG,
    apply_receipt_id: str = _APPLY_RECEIPT_ID,
    boot_nonce: str = _BOOT_NONCE,
    status: str = "ok",
    error: str | None = None,
) -> RuntimeObservationEventV2:
    captured = captured_at or datetime.now(UTC)
    return RuntimeObservationEventV2.model_validate(
        {
            "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
            "reportedAt": captured.isoformat(),
            "runtimeMode": "hosted",
            "status": status,
            "activeCliVersion": "0.12.10-beta.55",
            "applied": {
                "etag": manifest_etag,
                "sourceRevision": "a" * 64,
                "generation": generation,
                "instanceId": "runtime-instance-0001",
                "appliedProviderIds": ["clawdi-managed-v2"],
            },
            "boot": None,
            "cli": None,
            "error": error,
            "applyReceiptId": apply_receipt_id,
            "bootNonce": boot_nonce,
            "bootSessionId": boot_session_id,
            "sequence": sequence,
            "eventId": event_id or f"event-{uuid.uuid4()}",
            "capturedAt": captured.isoformat(),
        }
    )


def _expected_identity() -> RuntimeApplyIdentity:
    return RuntimeApplyIdentity(
        generation=1,
        manifest_etag=_MANIFEST_ETAG,
        apply_receipt_id=_APPLY_RECEIPT_ID,
        boot_nonce=_BOOT_NONCE,
    )


async def retire_runtime_environment(*args, **kwargs):
    return (await _retire_runtime_environment(*args, **kwargs)).receipt


async def _provision_environment(
    db: AsyncSession,
    seed_user,
    *,
    deployment_id: str = _DEPLOYMENT_ID,
):
    environment = await create_env_with_project(
        db,
        user_id=seed_user.id,
        machine_id=f"runtime-observation-{uuid.uuid4().hex}",
        machine_name="runtime-observation",
        agent_type="openclaw",
        os="linux",
    )
    fence = await provision_runtime_environment_fence(
        db,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=deployment_id,
    )
    await db.commit()
    return _EnvironmentRef(environment.id), fence


@pytest.mark.asyncio
async def test_unique_regressions_enter_inbox_without_regressing_head(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    base = datetime.now(UTC)
    first_payload = _payload(sequence=1, captured_at=base)
    first = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=first_payload,
        received_at=base,
    )
    duplicate = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=first_payload,
        received_at=base + timedelta(seconds=1),
    )
    assert duplicate.event_id == first.event_id
    assert duplicate.stream_position == first.stream_position
    assert duplicate.duplicate is True
    assert duplicate.outcome == "duplicate_replay"
    await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=3, captured_at=base + timedelta(seconds=3)),
        received_at=base + timedelta(seconds=3),
    )
    await db_session.commit()

    with pytest.raises(RuntimeObservationProtocolError) as identity_error:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(
                sequence=4,
                captured_at=base + timedelta(seconds=4),
                apply_receipt_id="different-apply-receipt",
            ),
            received_at=base + timedelta(seconds=4),
        )
    assert identity_error.value.code == "runtime_observation_identity_conflict"
    await db_session.rollback()

    lower_sequence = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=2, captured_at=base + timedelta(seconds=2)),
        received_at=base + timedelta(seconds=5),
    )
    regressing_capture = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=4, captured_at=base + timedelta(seconds=2)),
        received_at=base + timedelta(seconds=5),
    )
    assert lower_sequence.duplicate is False
    assert regressing_capture.duplicate is False
    await db_session.commit()

    with pytest.raises(RuntimeObservationProtocolError) as restamp_error:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(
                sequence=1,
                event_id=first.event_id,
                captured_at=base + timedelta(seconds=1),
            ),
            received_at=base + timedelta(seconds=5),
        )
    assert restamp_error.value.code == "runtime_observation_event_conflict"
    await db_session.rollback()

    inbox_sequences = list(
        (
            await db_session.execute(
                select(V2RuntimeObservationInbox.sequence)
                .where(V2RuntimeObservationInbox.environment_id == environment.id)
                .order_by(V2RuntimeObservationInbox.id)
            )
        ).scalars()
    )
    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    assert inbox_sequences == [1, 3, 2, 4]
    assert head is not None
    assert head.highest_sequence == 3
    assert head.captured_at == base + timedelta(seconds=3)


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_ingestion_and_retirement_serialize_on_the_environment_fence(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    captured = datetime.now(UTC)

    async with session_factory() as ingest_session:
        await ingest_runtime_observation(
            ingest_session,
            environment_id=environment.id,
            value=_payload(captured_at=captured),
            received_at=captured,
        )

        async def retire_after_lock() -> dict:
            async with session_factory() as retire_session:
                receipt = await retire_runtime_environment(
                    retire_session,
                    environment_id=environment.id,
                    expected_deployment_id=_DEPLOYMENT_ID,
                    retirement_id="retirement-0001",
                    owner_id=seed_user.id,
                )
                await retire_session.commit()
                return receipt

        retirement = asyncio.create_task(retire_after_lock())
        await asyncio.sleep(0.05)
        assert not retirement.done()
        await ingest_session.commit()
        receipt = await asyncio.wait_for(retirement, timeout=5)

    assert receipt["finalSessionHighWaterMarks"] == [
        {"bootSessionId": "boot-session-0001", "sequence": 1}
    ]
    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    await db_session.refresh(head)
    assert head.state == "retired"
    assert head.latest_inbox_id is None
    assert head.highest_sequence == 1

    replay = await retire_runtime_environment(
        db_session,
        environment_id=environment.id,
        expected_deployment_id=_DEPLOYMENT_ID,
        retirement_id="retirement-0001",
        owner_id=seed_user.id,
    )
    assert replay == receipt
    await db_session.rollback()

    with pytest.raises(RuntimeObservationProtocolError) as new_session_error:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(
                boot_session_id="boot-session-after-retirement",
                captured_at=captured + timedelta(seconds=1),
            ),
            received_at=captured + timedelta(seconds=1),
        )
    assert new_session_error.value.code == "runtime_environment_retired"
    await db_session.rollback()


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_retirement_first_rejects_delayed_new_session(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as retirement_session:
        receipt = await retire_runtime_environment(
            retirement_session,
            environment_id=environment.id,
            expected_deployment_id=_DEPLOYMENT_ID,
            retirement_id="retirement-first",
            owner_id=seed_user.id,
        )

        async def ingest_after_retirement_lock() -> str:
            async with session_factory() as ingestion_session:
                try:
                    await ingest_runtime_observation(
                        ingestion_session,
                        environment_id=environment.id,
                        value=_payload(boot_session_id="late-new-session"),
                    )
                except RuntimeObservationProtocolError as exc:
                    await ingestion_session.rollback()
                    return exc.code
                raise AssertionError("delayed ingestion unexpectedly committed")

        ingestion = asyncio.create_task(ingest_after_retirement_lock())
        await asyncio.sleep(0.05)
        assert not ingestion.done()
        await retirement_session.commit()
        assert await asyncio.wait_for(ingestion, timeout=5) == "runtime_environment_retired"

    assert receipt["finalSessionHighWaterMarks"] == []
    head_count = await db_session.scalar(
        select(func.count())
        .select_from(V2RuntimeObservationHead)
        .where(V2RuntimeObservationHead.environment_id == environment.id)
    )
    assert head_count == 0


@pytest.mark.asyncio
async def test_database_guards_reject_runtime_rebinding_regression_and_tombstone_mutation(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="database-guard-controller",
    )
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(),
    )
    page = await read_runtime_observations(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="database-guard-controller",
        expected_apply_identity=_expected_identity(),
        after_cursor=registration["cursor"],
        limit=100,
    )
    await acknowledge_runtime_observation_cursor(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="database-guard-controller",
        opaque_cursor=page["streamHighWaterCursor"],
    )
    await db_session.commit()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await mint_api_key(
                db_session,
                user_id=seed_user.id,
                label="invalid-full-access-runtime",
                scopes=None,
                environment_id=environment.id,
                runtime_deployment_id=_DEPLOYMENT_ID,
                managed=True,
                commit=False,
            )

    legacy_key = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="legacy-null-runtime-binding",
        scopes=None,
        environment_id=environment.id,
        runtime_deployment_id=None,
        managed=True,
        commit=False,
    )
    await db_session.commit()
    assert legacy_key.api_key.runtime_deployment_id is None
    assert legacy_key.api_key.scopes is None
    strict_key = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="strict-runtime-key",
        scopes=["runtime-observations:write"],
        environment_id=environment.id,
        runtime_deployment_id=_DEPLOYMENT_ID,
        managed=True,
        commit=False,
    )
    await db_session.commit()

    guarded_updates = (
        (
            update(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment.id)
            .values(owner_id=uuid.uuid4()),
            "fence binding is immutable",
        ),
        (
            update(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment.id)
            .values(stream_high_water=0),
            "high-water cannot regress",
        ),
        (
            update(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.id == event.stream_position)
            .values(health="error"),
            "inbox events are immutable",
        ),
        (
            update(V2RuntimeObservationHead)
            .where(
                V2RuntimeObservationHead.environment_id == environment.id,
                V2RuntimeObservationHead.boot_session_id == "boot-session-0001",
            )
            .values(generation=2),
            "head binding is immutable",
        ),
        (
            update(V2RuntimeObservationHead)
            .where(
                V2RuntimeObservationHead.environment_id == environment.id,
                V2RuntimeObservationHead.boot_session_id == "boot-session-0001",
            )
            .values(latest_event_id="rebound-event"),
            "head cannot rebind a sequence",
        ),
        (
            update(V2RuntimeObservationConsumerCursor)
            .where(
                V2RuntimeObservationConsumerCursor.environment_id == environment.id,
                V2RuntimeObservationConsumerCursor.consumer_id == "database-guard-controller",
            )
            .values(acked_stream_position=0),
            "acknowledgement cannot regress",
        ),
        (
            update(ApiKey)
            .where(ApiKey.id == legacy_key.api_key.id)
            .values(runtime_deployment_id=_DEPLOYMENT_ID),
            "runtime deployment key binding is immutable",
        ),
    )
    for statement, message in guarded_updates:
        with pytest.raises(DBAPIError, match=message):
            async with db_session.begin_nested():
                await db_session.execute(statement)

    # V1 credential retraction remains frozen: it never consults the v2 fence.
    await db_session.execute(
        update(ApiKey)
        .where(ApiKey.id == strict_key.api_key.id)
        .values(revoked_at=datetime.now(UTC))
    )
    await db_session.commit()

    receipt = await retire_runtime_environment(
        db_session,
        environment_id=environment.id,
        expected_deployment_id=_DEPLOYMENT_ID,
        retirement_id="database-guard-retirement",
        owner_id=seed_user.id,
    )
    await db_session.commit()
    retired_mutations = (
        update(V2RuntimeEnvironmentFence)
        .where(V2RuntimeEnvironmentFence.environment_id == environment.id)
        .values(retirement_receipt={"forged": True}),
        delete(V2RuntimeEnvironmentFence).where(
            V2RuntimeEnvironmentFence.environment_id == environment.id
        ),
        update(V2RuntimeObservationHead)
        .where(
            V2RuntimeObservationHead.environment_id == environment.id,
            V2RuntimeObservationHead.boot_session_id == "boot-session-0001",
        )
        .values(state="active"),
        delete(V2RuntimeObservationHead).where(
            V2RuntimeObservationHead.environment_id == environment.id,
            V2RuntimeObservationHead.boot_session_id == "boot-session-0001",
        ),
    )
    for statement in retired_mutations:
        with pytest.raises(DBAPIError, match="immutable|permanent"):
            async with db_session.begin_nested():
                await db_session.execute(statement)

    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None
    await db_session.refresh(fence)
    assert fence.retirement_receipt == receipt
    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    assert head is not None
    await db_session.refresh(head)
    assert head.state == "retired"
    assert head.highest_sequence == 1


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_unknown_cursor_persists_fail_closed_reset_boundary(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    base = datetime.now(UTC)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hosted-controller",
    )
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=1, captured_at=base),
        received_at=base,
    )
    await db_session.commit()
    valid_cursor = registration["cursor"]
    tamper_index = len("clawdi-ro-v1.") + 5
    replacement = "A" if valid_cursor[tamper_index] != "A" else "B"
    tampered_cursor = valid_cursor[:tamper_index] + replacement + valid_cursor[tamper_index + 1 :]

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as snapshot_session:
        await snapshot_session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        with pytest.raises(RuntimeObservationProtocolError) as invalid:
            await read_runtime_observations(
                snapshot_session,
                environment_id=environment.id,
                owner_id=seed_user.id,
                deployment_id=_DEPLOYMENT_ID,
                consumer_id="hosted-controller",
                expected_apply_identity=_expected_identity(),
                after_cursor=tampered_cursor,
                limit=100,
            )
        assert invalid.value.code == "observation_cursor_expired"
        assert invalid.value.metadata is not None
        assert invalid.value.metadata["resetBoundary"] is not None
        assert invalid.value.metadata["sessionHighWaterMarks"] == {"boot-session-0001": 1}
        await snapshot_session.commit()

    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {"environment_id": environment.id, "consumer_id": "hosted-controller"},
    )
    assert cursor is not None
    await db_session.refresh(cursor)
    assert cursor.state == "expired"
    assert cursor.expiry_boundary_stream_position == event.stream_position
    assert cursor.expiry_session_high_waters == {"boot-session-0001": 1}

    reset = await reset_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hosted-controller",
        reset_at=base + timedelta(seconds=1),
    )
    await db_session.commit()
    assert reset["resetBoundary"] == invalid.value.metadata["resetBoundary"]
    assert reset["sessionHighWaterMarks"] == {"boot-session-0001": 1}


@pytest.mark.asyncio
async def test_idempotent_reack_echoes_callers_fresh_cursor(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
) -> None:
    environment, _ = await _provision_environment(db_session, seed_user)
    admin_key = "runtime-observation-admin-secret"
    headers = {"X-Admin-Key": admin_key}
    path = f"/v2/runtime/environments/{environment.id}/observation-consumers"
    monkeypatch.setattr(settings, "admin_api_key", admin_key)

    registration = await client.post(f"{path}/register", headers=headers, json={})
    assert registration.status_code == 200, registration.text

    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(),
    )
    await db_session.commit()

    registered_cursor = runtime_observation_service.decode_runtime_observation_cursor(
        registration.json()["cursor"]
    )
    first_cursor = runtime_observation_service.encode_runtime_observation_cursor(
        environment_id=registered_cursor.environment_id,
        consumer_id=registered_cursor.consumer_id,
        cursor_epoch=registered_cursor.cursor_epoch,
        stream_position=event.stream_position,
    )
    first_ack = await client.post(f"{path}/ack", headers=headers, json={"cursor": first_cursor})
    assert first_ack.status_code == 200, first_ack.text
    assert first_ack.json()["cursor"] == first_cursor

    second_cursor = runtime_observation_service.encode_runtime_observation_cursor(
        environment_id=registered_cursor.environment_id,
        consumer_id=registered_cursor.consumer_id,
        cursor_epoch=registered_cursor.cursor_epoch,
        stream_position=event.stream_position,
    )
    assert second_cursor != first_cursor

    second_ack = await client.post(f"{path}/ack", headers=headers, json={"cursor": second_cursor})

    assert second_ack.status_code == 200, second_ack.text
    assert second_ack.json()["cursor"] == second_cursor


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_concurrent_unknown_consumer_reads_return_one_persisted_structured_expiry(
    engine,
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(),
    )
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    original_initialize = runtime_observation_service._initialize_expired_consumer
    both_snapshots_ready = asyncio.Event()
    arrivals = 0

    async def synchronize_initialization(*args, **kwargs):
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            both_snapshots_ready.set()
        await asyncio.wait_for(both_snapshots_ready.wait(), timeout=5)
        return await original_initialize(*args, **kwargs)

    monkeypatch.setattr(
        runtime_observation_service,
        "_initialize_expired_consumer",
        synchronize_initialization,
    )

    async def read_unknown() -> RuntimeObservationProtocolError:
        async with session_factory() as session:
            await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            try:
                await read_runtime_observations(
                    session,
                    environment_id=environment.id,
                    owner_id=seed_user.id,
                    deployment_id=_DEPLOYMENT_ID,
                    consumer_id="racing-unknown-controller",
                    expected_apply_identity=_expected_identity(),
                    after_cursor="unknown-cursor",
                    limit=100,
                )
            except RuntimeObservationProtocolError as exc:
                await session.commit()
                return exc
            raise AssertionError("unknown consumer unexpectedly read observations")

    outcomes = await asyncio.wait_for(
        asyncio.gather(read_unknown(), read_unknown()),
        timeout=5,
    )
    assert [outcome.code for outcome in outcomes] == [
        "observation_cursor_expired",
        "observation_cursor_expired",
    ]
    assert outcomes[0].metadata == outcomes[1].metadata
    assert outcomes[0].metadata is not None
    assert outcomes[0].metadata["sessionHighWaterMarks"] == {"boot-session-0001": 1}
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationConsumerCursor)
            .where(
                V2RuntimeObservationConsumerCursor.environment_id == environment.id,
                V2RuntimeObservationConsumerCursor.consumer_id == "racing-unknown-controller",
            )
        )
        == 1
    )
    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {
            "environment_id": environment.id,
            "consumer_id": "racing-unknown-controller",
        },
    )
    assert cursor is not None
    assert cursor.expiry_boundary_stream_position == event.stream_position


@pytest.mark.asyncio
async def test_cursor_expiry_is_explicit_and_cleanup_never_silently_advances(
    db_session: AsyncSession,
    seed_user,
):
    owner_id = seed_user.id
    environment, _ = await _provision_environment(db_session, seed_user)
    captured = datetime.now(UTC) - timedelta(days=31)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=owner_id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hosted-controller",
    )
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(captured_at=captured),
        received_at=captured,
    )
    await db_session.commit()

    # Replay-horizon cleanup cannot compact an unacked row before the hard cap.
    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=8),
        )
        == 0
    )
    await db_session.commit()
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.environment_id == environment.id)
        )
        == 1
    )
    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=31),
        )
        == 1
    )
    await db_session.commit()
    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {"environment_id": environment.id, "consumer_id": "hosted-controller"},
    )
    assert cursor is not None
    assert cursor.state == "expired"
    assert cursor.expiry_session_high_waters == {"boot-session-0001": 1}
    retention_audits = list(
        (
            await db_session.execute(
                select(ControlPlaneAuditEvent).where(
                    ControlPlaneAuditEvent.source == "runtime_observation.retention",
                    ControlPlaneAuditEvent.action == "runtime_observation.cursor_expired",
                    ControlPlaneAuditEvent.resource_id == str(environment.id),
                )
            )
        ).scalars()
    )
    assert len(retention_audits) == 1
    retention_audit = retention_audits[0]
    assert retention_audit.actor_type == "system"
    assert retention_audit.environment_id is None
    assert retention_audit.details == {
        "actor_service": "runtime_observation_retention",
        "environment_id": str(environment.id),
        "deployment_id": _DEPLOYMENT_ID,
        "consumer_id": "hosted-controller",
        "reason": "hard_retention",
        "outcome": "expired",
        "previous_state": "active",
        "new_state": "expired",
        "previous_boundary_stream_position": None,
        "boundary_stream_position": event.stream_position,
        "stream_high_water": event.stream_position,
        "session_high_water_marks": {"boot-session-0001": 1},
    }
    assert "clawdi-ro-v1" not in json.dumps(retention_audit.details, sort_keys=True)

    with pytest.raises(RuntimeObservationProtocolError) as expired:
        await read_runtime_observations(
            db_session,
            environment_id=environment.id,
            owner_id=owner_id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="hosted-controller",
            expected_apply_identity=_expected_identity(),
            after_cursor=registration["cursor"],
            limit=100,
        )
    assert expired.value.status_code == 410
    assert expired.value.code == "observation_cursor_expired"
    assert expired.value.metadata is not None
    assert expired.value.metadata["resetBoundary"] is not None
    await db_session.rollback()

    reset = await reset_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=owner_id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hosted-controller",
        reset_at=captured + timedelta(days=31, seconds=1),
    )
    await db_session.commit()
    assert reset["sessionHighWaterMarks"] == {"boot-session-0001": 1}


@pytest.mark.asyncio
async def test_hard_cap_expiry_audit_failure_rolls_back_cursor_floor_and_compaction(
    db_session: AsyncSession,
    seed_user,
    monkeypatch,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    captured = datetime.now(UTC) - timedelta(days=31)
    await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="retention-audit-rollback",
    )
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            captured_at=captured,
            error="private diagnostic retained after rollback",
        ),
        received_at=captured,
    )
    await db_session.commit()

    def fail_retention_audit(*args, **kwargs):
        raise RuntimeError("injected retention audit failure")

    monkeypatch.setattr(
        runtime_observation_service,
        "record_control_plane_audit",
        fail_retention_audit,
    )
    with pytest.raises(RuntimeError, match="injected retention audit failure"):
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=31),
        )
    await db_session.rollback()

    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {
            "environment_id": environment.id,
            "consumer_id": "retention-audit-rollback",
        },
    )
    assert cursor is not None and cursor.state == "active"
    assert cursor.expiry_boundary_stream_position is None
    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None and fence.replay_floor_stream_position == 0
    inbox = await db_session.get(V2RuntimeObservationInbox, event.stream_position)
    assert inbox is not None
    assert inbox.payload_purged_at is None
    assert inbox.diagnostics["error"] == "private diagnostic retained after rollback"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ControlPlaneAuditEvent)
            .where(ControlPlaneAuditEvent.resource_id == str(environment.id))
        )
        == 0
    )


@pytest.mark.asyncio
async def test_replay_horizon_purge_waits_for_every_required_consumer_ack(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    captured = datetime.now(UTC) - timedelta(days=8)
    registrations = {}
    for consumer_id in ("controller-a", "controller-b"):
        registrations[consumer_id] = await register_runtime_observation_consumer(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id=consumer_id,
        )
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(captured_at=captured),
        received_at=captured,
    )
    await db_session.commit()

    async def read_and_ack(consumer_id: str) -> None:
        page = await read_runtime_observations(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id=consumer_id,
            expected_apply_identity=_expected_identity(),
            after_cursor=registrations[consumer_id]["cursor"],
            limit=100,
        )
        await acknowledge_runtime_observation_cursor(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id=consumer_id,
            opaque_cursor=page["streamHighWaterCursor"],
        )
        await db_session.commit()

    await read_and_ack("controller-a")
    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=8),
        )
        == 0
    )
    await db_session.commit()

    await read_and_ack("controller-b")
    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=8),
        )
        == 1
    )
    await db_session.commit()
    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None
    assert fence.replay_floor_stream_position == event.stream_position
    assert fence.replay_floor_session_high_waters == {"boot-session-0001": 1}


@pytest.mark.asyncio
async def test_payload_compaction_preserves_event_and_session_sequence_uniqueness(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    current = datetime.now(UTC)
    captured = current - timedelta(days=31)
    event_id = f"durable-event-{uuid.uuid4().hex}"
    accepted = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            boot_session_id="durable-session",
            sequence=1,
            event_id=event_id,
            captured_at=captured,
            error="private diagnostic that must be scrubbed",
        ),
        received_at=captured,
    )
    await db_session.commit()

    assert await expire_runtime_observation_payloads(db_session, now=current) == 1
    await db_session.commit()

    compacted = await db_session.get(V2RuntimeObservationInbox, accepted.stream_position)
    assert compacted is not None
    assert compacted.event_id == event_id
    assert compacted.boot_session_id == "durable-session"
    assert compacted.sequence == 1
    assert compacted.diagnostics == {}
    assert compacted.payload_purged_at == current

    with pytest.raises(RuntimeObservationProtocolError) as reused_event_id:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(
                boot_session_id="different-session",
                sequence=1,
                event_id=event_id,
                captured_at=current,
            ),
            received_at=current,
        )
    assert reused_event_id.value.code == "runtime_observation_event_conflict"
    await db_session.rollback()

    with pytest.raises(RuntimeObservationProtocolError) as reused_sequence:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(
                boot_session_id="durable-session",
                sequence=1,
                event_id=f"replacement-{uuid.uuid4().hex}",
                captured_at=current,
            ),
            received_at=current,
        )
    assert reused_sequence.value.code == "runtime_observation_event_conflict"
    await db_session.rollback()

    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.environment_id == environment.id)
        )
        == 1
    )
    forbidden_tombstone_mutations = (
        update(V2RuntimeObservationInbox)
        .where(V2RuntimeObservationInbox.id == accepted.stream_position)
        .values(diagnostics={"rehydrated": True}),
        update(V2RuntimeObservationInbox)
        .where(V2RuntimeObservationInbox.id == accepted.stream_position)
        .values(payload_purged_at=current + timedelta(seconds=1)),
        delete(V2RuntimeObservationInbox).where(
            V2RuntimeObservationInbox.id == accepted.stream_position
        ),
    )
    for statement in forbidden_tombstone_mutations:
        with pytest.raises(DBAPIError, match="immutable|permanent"):
            async with db_session.begin_nested():
                await db_session.execute(statement)


@pytest.mark.asyncio
async def test_retired_environment_compacts_payload_without_mutating_retirement_receipt(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    current = datetime.now(UTC)
    captured = current - timedelta(days=31)
    accepted = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            boot_session_id="retired-retention-session",
            event_id=f"retired-retention-{uuid.uuid4().hex}",
            captured_at=captured,
            error="private retired diagnostic",
        ),
        received_at=captured,
    )
    receipt = await retire_runtime_environment(
        db_session,
        environment_id=environment.id,
        expected_deployment_id=_DEPLOYMENT_ID,
        retirement_id="retired-retention-obligation",
        owner_id=seed_user.id,
        retired_at=current,
    )
    await db_session.commit()

    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None
    frozen_retirement = {
        "state": fence.state,
        "stream_high_water": fence.stream_high_water,
        "retirement_id": fence.retirement_id,
        "retirement_receipt_id": fence.retirement_receipt_id,
        "retirement_receipt": json.loads(json.dumps(fence.retirement_receipt)),
        "retired_at": fence.retired_at,
        "final_cursor": fence.final_cursor,
        "final_stream_position": fence.final_stream_position,
        "final_session_high_waters": json.loads(json.dumps(fence.final_session_high_waters)),
    }

    assert await expire_runtime_observation_payloads(db_session, now=current) == 1
    await db_session.commit()

    await db_session.refresh(fence)
    assert fence.replay_floor_stream_position == accepted.stream_position
    assert {
        "state": fence.state,
        "stream_high_water": fence.stream_high_water,
        "retirement_id": fence.retirement_id,
        "retirement_receipt_id": fence.retirement_receipt_id,
        "retirement_receipt": fence.retirement_receipt,
        "retired_at": fence.retired_at,
        "final_cursor": fence.final_cursor,
        "final_stream_position": fence.final_stream_position,
        "final_session_high_waters": fence.final_session_high_waters,
    } == frozen_retirement
    assert fence.retirement_receipt == receipt

    compacted = await db_session.get(V2RuntimeObservationInbox, accepted.stream_position)
    assert compacted is not None
    assert compacted.diagnostics == {}
    assert compacted.payload_purged_at == current


@pytest.mark.asyncio
async def test_replay_horizon_purge_stops_before_young_lower_stream_position(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    current = datetime.now(UTC)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="prefix-controller",
    )
    young = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            sequence=1,
            event_id=f"young-{uuid.uuid4().hex}",
            captured_at=current - timedelta(days=1),
        ),
        received_at=current - timedelta(days=1),
    )
    old = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            sequence=2,
            event_id=f"old-{uuid.uuid4().hex}",
            captured_at=current - timedelta(days=8),
        ),
        received_at=current - timedelta(days=8),
    )
    page = await read_runtime_observations(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="prefix-controller",
        expected_apply_identity=_expected_identity(),
        after_cursor=registration["cursor"],
        limit=100,
    )
    await acknowledge_runtime_observation_cursor(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="prefix-controller",
        opaque_cursor=page["streamHighWaterCursor"],
    )
    await db_session.commit()

    deleted = await expire_runtime_observation_payloads(db_session, now=current)
    await db_session.commit()

    assert deleted == 0
    retained_ids = list(
        (
            await db_session.execute(
                select(V2RuntimeObservationInbox.id)
                .where(V2RuntimeObservationInbox.environment_id == environment.id)
                .order_by(V2RuntimeObservationInbox.id)
            )
        ).scalars()
    )
    assert retained_ids == [young.stream_position, old.stream_position]
    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None and fence.replay_floor_stream_position == 0
    replay = await read_runtime_observations(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="prefix-controller",
        expected_apply_identity=_expected_identity(),
        after_cursor=registration["cursor"],
        limit=100,
    )
    assert [event["evidenceReference"]["eventId"] for event in replay["events"]] == [
        young.event_id,
        old.event_id,
    ]


@pytest.mark.asyncio
async def test_hard_cap_purge_does_not_expire_past_young_lower_stream_position(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    current = datetime.now(UTC)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hard-prefix-controller",
    )
    young = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            sequence=1,
            event_id=f"hard-young-{uuid.uuid4().hex}",
            captured_at=current - timedelta(days=1),
        ),
        received_at=current - timedelta(days=1),
    )
    old = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(
            sequence=2,
            event_id=f"hard-old-{uuid.uuid4().hex}",
            captured_at=current - timedelta(days=31),
        ),
        received_at=current - timedelta(days=31),
    )
    await db_session.commit()

    deleted = await expire_runtime_observation_payloads(db_session, now=current)
    await db_session.commit()

    assert deleted == 0
    retained_ids = list(
        (
            await db_session.execute(
                select(V2RuntimeObservationInbox.id)
                .where(V2RuntimeObservationInbox.environment_id == environment.id)
                .order_by(V2RuntimeObservationInbox.id)
            )
        ).scalars()
    )
    assert retained_ids == [young.stream_position, old.stream_position]
    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None and fence.replay_floor_stream_position == 0
    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {"environment_id": environment.id, "consumer_id": "hard-prefix-controller"},
    )
    assert cursor is not None
    assert cursor.state == "active"
    assert cursor.expiry_boundary_stream_position is None
    replay = await read_runtime_observations(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hard-prefix-controller",
        expected_apply_identity=_expected_identity(),
        after_cursor=registration["cursor"],
        limit=100,
    )
    assert [event["evidenceReference"]["eventId"] for event in replay["events"]] == [
        young.event_id,
        old.event_id,
    ]


@pytest.mark.asyncio
async def test_late_and_unknown_consumers_get_persisted_reset_boundaries(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    captured = datetime.now(UTC) - timedelta(days=8)
    initial = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="initial-controller",
    )
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(captured_at=captured),
        received_at=captured,
    )
    page = await read_runtime_observations(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="initial-controller",
        expected_apply_identity=_expected_identity(),
        after_cursor=initial["cursor"],
        limit=100,
    )
    await acknowledge_runtime_observation_cursor(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="initial-controller",
        opaque_cursor=page["streamHighWaterCursor"],
    )
    await db_session.commit()
    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=8),
        )
        == 1
    )
    await db_session.commit()

    with pytest.raises(RuntimeObservationProtocolError) as late:
        await register_runtime_observation_consumer(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="late-controller",
        )
    assert late.value.code == "observation_cursor_expired"
    assert late.value.metadata is not None
    assert late.value.metadata["resetBoundary"] is not None
    assert late.value.metadata["sessionHighWaterMarks"] == {"boot-session-0001": 1}
    await db_session.commit()

    with pytest.raises(RuntimeObservationProtocolError) as unknown:
        await read_runtime_observations(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="unknown-controller",
            expected_apply_identity=_expected_identity(),
            after_cursor="unknown-cursor",
            limit=100,
        )
    assert unknown.value.code == "observation_cursor_expired"
    assert unknown.value.metadata is not None
    assert unknown.value.metadata["resetBoundary"] is not None
    assert unknown.value.metadata["sessionHighWaterMarks"] == {"boot-session-0001": 1}
    await db_session.commit()

    for consumer_id in ("late-controller", "unknown-controller"):
        cursor = await db_session.get(
            V2RuntimeObservationConsumerCursor,
            {"environment_id": environment.id, "consumer_id": consumer_id},
        )
        assert cursor is not None
        assert cursor.state == "expired"
        assert cursor.expiry_boundary_stream_position == event.stream_position
        reset = await reset_runtime_observation_consumer(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id=consumer_id,
        )
        assert reset["sessionHighWaterMarks"] == {"boot-session-0001": 1}
        await db_session.commit()


@pytest.mark.asyncio
async def test_hard_cap_without_consumers_persists_floor_for_late_registration(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    captured = datetime.now(UTC) - timedelta(days=31)
    event = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(captured_at=captured),
        received_at=captured,
    )
    await db_session.commit()

    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=31),
        )
        == 1
    )
    await db_session.commit()

    fence = await db_session.get(V2RuntimeEnvironmentFence, environment.id)
    assert fence is not None
    assert fence.replay_floor_stream_position == event.stream_position
    assert fence.replay_floor_session_high_waters == {"boot-session-0001": 1}
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationConsumerCursor)
            .where(V2RuntimeObservationConsumerCursor.environment_id == environment.id)
        )
        == 0
    )

    with pytest.raises(RuntimeObservationProtocolError) as late:
        await register_runtime_observation_consumer(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="late-after-hard-cap",
        )
    assert late.value.code == "observation_cursor_expired"
    assert late.value.metadata is not None
    assert late.value.metadata["sessionHighWaterMarks"] == {"boot-session-0001": 1}
    assert late.value.metadata["resetBoundary"] is not None
    await db_session.commit()

    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {
            "environment_id": environment.id,
            "consumer_id": "late-after-hard-cap",
        },
    )
    assert cursor is not None
    assert cursor.state == "expired"
    assert cursor.expiry_boundary_stream_position == event.stream_position


@pytest.mark.asyncio
async def test_current_epoch_cursor_below_replay_floor_expires_before_read(
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    captured = datetime.now(UTC) - timedelta(days=8)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="replay-floor-controller",
    )
    first = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=1, captured_at=captured),
        received_at=captured,
    )
    page = await read_runtime_observations(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="replay-floor-controller",
        expected_apply_identity=_expected_identity(),
        after_cursor=registration["cursor"],
        limit=100,
    )
    await acknowledge_runtime_observation_cursor(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="replay-floor-controller",
        opaque_cursor=page["streamHighWaterCursor"],
    )
    await db_session.commit()
    assert (
        await expire_runtime_observation_payloads(
            db_session,
            now=captured + timedelta(days=8),
        )
        == 1
    )
    await db_session.commit()
    second = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=2, captured_at=datetime.now(UTC)),
    )
    await db_session.commit()

    with pytest.raises(RuntimeObservationProtocolError) as expired:
        await read_runtime_observations(
            db_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="replay-floor-controller",
            expected_apply_identity=_expected_identity(),
            after_cursor=registration["cursor"],
            limit=100,
        )
    assert expired.value.code == "observation_cursor_expired"
    assert expired.value.metadata is not None
    assert expired.value.metadata["sessionHighWaterMarks"] == {"boot-session-0001": 2}
    await db_session.commit()
    cursor = await db_session.get(
        V2RuntimeObservationConsumerCursor,
        {
            "environment_id": environment.id,
            "consumer_id": "replay-floor-controller",
        },
    )
    assert cursor is not None
    assert cursor.state == "expired"
    assert cursor.expiry_boundary_stream_position == second.stream_position
    assert cursor.acked_stream_position == first.stream_position


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_concurrent_cas_winner_cannot_be_regressed(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    base = datetime.now(UTC)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    start = asyncio.Event()

    async def ingest_sequence(sequence: int):
        async with session_factory() as session:
            await start.wait()
            result = await ingest_runtime_observation(
                session,
                environment_id=environment.id,
                value=_payload(
                    sequence=sequence,
                    captured_at=base + timedelta(seconds=sequence),
                ),
                received_at=base + timedelta(seconds=sequence),
            )
            await session.commit()
            return result

    lower = asyncio.create_task(ingest_sequence(2))
    higher = asyncio.create_task(ingest_sequence(3))
    start.set()
    results = await asyncio.wait_for(asyncio.gather(lower, higher), timeout=5)
    assert all(not result.duplicate for result in results)

    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    await db_session.refresh(head)
    assert head.highest_sequence == 3
    assert head.captured_at == base + timedelta(seconds=3)
    inbox_sequences = list(
        (
            await db_session.execute(
                select(V2RuntimeObservationInbox.sequence)
                .where(V2RuntimeObservationInbox.environment_id == environment.id)
                .order_by(V2RuntimeObservationInbox.sequence)
            )
        ).scalars()
    )
    assert inbox_sequences == [2, 3]


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_concurrent_first_session_binding_rejects_losing_identity(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    winning_event_id = f"binding-event-{environment.id}-0001"
    losing_event_id = f"binding-event-{environment.id}-0002"

    async def bind_losing_identity() -> str:
        async with session_factory() as session:
            try:
                await ingest_runtime_observation(
                    session,
                    environment_id=environment.id,
                    value=_payload(
                        sequence=1,
                        event_id=losing_event_id,
                        generation=2,
                        manifest_etag='"different-manifest-etag"',
                        apply_receipt_id="different-apply-receipt",
                        boot_nonce="different-boot-nonce-0001",
                    ),
                )
                await session.commit()
                return "accepted"
            except RuntimeObservationProtocolError as exc:
                await session.rollback()
                return exc.code

    async with session_factory() as winner_session:
        await ingest_runtime_observation(
            winner_session,
            environment_id=environment.id,
            value=_payload(sequence=1, event_id=winning_event_id),
        )
        loser = asyncio.create_task(bind_losing_identity())
        await asyncio.sleep(0.05)
        assert not loser.done()
        await winner_session.commit()
    assert await asyncio.wait_for(loser, timeout=5) == "runtime_observation_identity_conflict"

    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    inbox = await db_session.scalar(
        select(V2RuntimeObservationInbox).where(
            V2RuntimeObservationInbox.environment_id == environment.id
        )
    )
    assert head is not None
    assert inbox is not None
    assert (
        (
            head.generation,
            head.manifest_etag,
            head.apply_receipt_id,
            head.boot_nonce,
        )
        == (
            inbox.generation,
            inbox.manifest_etag,
            inbox.apply_receipt_id,
            inbox.boot_nonce,
        )
        == (
            1,
            _MANIFEST_ETAG,
            _APPLY_RECEIPT_ID,
            _BOOT_NONCE,
        )
    )


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_concurrent_cross_environment_event_id_collision_is_structured(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment_a, _ = await _provision_environment(db_session, seed_user)
    environment_b, _ = await _provision_environment(db_session, seed_user)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    shared_event_id = f"globally-colliding-event-{environment_a.id}"
    loser_started = asyncio.Event()

    async def ingest_loser() -> str:
        async with session_factory() as session:
            loser_started.set()
            try:
                await ingest_runtime_observation(
                    session,
                    environment_id=environment_b.id,
                    value=_payload(
                        boot_session_id="collision-session-b",
                        event_id=shared_event_id,
                    ),
                )
                await session.commit()
                return "accepted"
            except RuntimeObservationProtocolError as exc:
                await session.rollback()
                return exc.code

    async with session_factory() as winner_session:
        await ingest_runtime_observation(
            winner_session,
            environment_id=environment_a.id,
            value=_payload(
                boot_session_id="collision-session-a",
                event_id=shared_event_id,
            ),
        )
        loser = asyncio.create_task(ingest_loser())
        await asyncio.wait_for(loser_started.wait(), timeout=5)
        await asyncio.sleep(0.05)
        assert not loser.done()
        await winner_session.commit()
    assert await asyncio.wait_for(loser, timeout=5) == "runtime_observation_event_conflict"
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.event_id == shared_event_id)
        )
        == 1
    )


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_snapshot_and_high_water_share_one_repeatable_read_snapshot(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    base = datetime.now(UTC)
    registration = await register_runtime_observation_consumer(
        db_session,
        environment_id=environment.id,
        owner_id=seed_user.id,
        deployment_id=_DEPLOYMENT_ID,
        consumer_id="hosted-controller",
    )
    first = await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=1, captured_at=base),
        received_at=base,
    )
    await db_session.commit()

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as snapshot_session:
        await snapshot_session.connection(
            execution_options={
                "isolation_level": "REPEATABLE READ",
                "postgresql_readonly": True,
            }
        )
        # Establish the transaction snapshot before the racing commit.
        assert await snapshot_session.get(V2RuntimeEnvironmentFence, environment.id) is not None

        async with session_factory() as writer:
            second = await ingest_runtime_observation(
                writer,
                environment_id=environment.id,
                value=_payload(sequence=2, captured_at=base + timedelta(seconds=1)),
                received_at=base + timedelta(seconds=1),
            )
            await writer.commit()

        snapshot = await read_runtime_observations(
            snapshot_session,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="hosted-controller",
            expected_apply_identity=_expected_identity(),
            after_cursor=registration["cursor"],
            limit=100,
        )
        assert [event["sequence"] for event in snapshot["events"]] == [1]
        assert [head["sequence"] for head in snapshot["heads"]] == [1]

    async with session_factory() as next_snapshot:
        await next_snapshot.connection(
            execution_options={
                "isolation_level": "REPEATABLE READ",
                "postgresql_readonly": True,
            }
        )
        incremental = await read_runtime_observations(
            next_snapshot,
            environment_id=environment.id,
            owner_id=seed_user.id,
            deployment_id=_DEPLOYMENT_ID,
            consumer_id="hosted-controller",
            expected_apply_identity=_expected_identity(),
            after_cursor=snapshot["streamHighWaterCursor"],
            limit=100,
        )
    assert [event["sequence"] for event in incremental["events"]] == [2]
    assert [head["sequence"] for head in incremental["heads"]] == [2]
    assert first.stream_position < second.stream_position
    assert incremental["events"][0]["runtimeIdentity"]["bootSessionId"] == ("boot-session-0001")
    assert (
        incremental["events"][0]["freshnessDeadline"] == (base + timedelta(seconds=91)).isoformat()
    )
    assert set(incremental["events"][0]["evidenceReference"]) == {"eventId", "cursor"}
    assert "streamPosition" not in incremental
    assert "streamPosition" not in incremental["events"][0]
    assert incremental["streamHighWaterCursor"].startswith("clawdi-ro-v1.")
    assert incremental["nextCursor"].startswith("clawdi-ro-v1.")


def _legacy_runtime_observed(value: RuntimeObservationEventV2) -> dict:
    payload = value.model_dump(mode="json", by_alias=True)
    for field in (
        "applyReceiptId",
        "bootNonce",
        "bootSessionId",
        "sequence",
        "eventId",
        "capturedAt",
    ):
        payload.pop(field)
    return payload


def _runtime_state(environment_id: uuid.UUID) -> HostedRuntimeState:
    return HostedRuntimeState(
        environment_id=environment_id,
        deployment_id="legacy-hosted-runtime",
        instance_id="legacy-instance",
        generation=1,
        cli_package_spec="@clawdi/cli@0.12.10-beta.55",
        locale={"timezone": "UTC", "language": "en"},
        system={"packages": []},
        runtimes={"openclaw": {"enabled": True}},
        live_sync={"enabled": True, "agents": []},
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
    )


@pytest.mark.asyncio
async def test_v1_heartbeat_is_byte_frozen_and_has_no_companion_side_effects(
    db_session: AsyncSession,
    seed_user,
) -> None:
    environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"v1-frozen-{uuid.uuid4().hex}",
        machine_name="v1-frozen",
        agent_type="openclaw",
        os="linux",
    )
    db_session.add(_runtime_state(environment.id))
    await db_session.commit()
    key = ApiKey(
        id=uuid.uuid4(),
        user_id=seed_user.id,
        managed=True,
        environment_id=environment.id,
        scopes=["skills:write"],
    )

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=key)

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            legacy = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={
                    "last_revision_seen": 7,
                    "last_sync_error": None,
                    "queue_depth": 3,
                    "dropped_count_delta": 2,
                    "runtime_observed": _legacy_runtime_observed(_payload()),
                },
            )
            strict_v2_on_v1 = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={
                    "runtime_observed": _payload().model_dump(mode="json", by_alias=True),
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert legacy.status_code == 204
    assert legacy.content == b""
    assert strict_v2_on_v1.status_code == 422
    observation = await db_session.get(HostedRuntimeConfigObservation, environment.id)
    assert observation is not None
    assert observation.observed_config_generation == 1
    await db_session.refresh(environment)
    assert environment.last_revision_seen == 7
    assert environment.last_sync_at is not None
    assert environment.queue_depth_high_water_since_start == 3
    assert environment.dropped_count_since_start == 2
    assert await db_session.get(V2RuntimeEnvironmentFence, environment.id) is None
    for model in (V2RuntimeObservationInbox, V2RuntimeObservationHead):
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(model)
                .where(model.environment_id == environment.id)
            )
            == 0
        )
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(ControlPlaneAuditEvent)
            .where(ControlPlaneAuditEvent.resource_id == str(environment.id))
        )
        == 0
    )


@pytest.mark.asyncio
async def test_v2_ingestion_only_writes_companion_tables_and_requires_dedicated_scope(
    db_session: AsyncSession,
    seed_user,
) -> None:
    environment, _ = await _provision_environment(db_session, seed_user)
    state = _runtime_state(environment.id)
    observation = HostedRuntimeConfigObservation(
        environment_id=environment.id,
        observed_at=datetime(2026, 1, 1, tzinfo=UTC),
        observed_config_generation=99,
        observed_manifest_etag="legacy-etag",
        observed_source_revision="b" * 64,
        diagnostics={"sentinel": "legacy"},
    )
    db_session.add(state)
    await db_session.flush()
    db_session.add(observation)
    environment_row = await db_session.get(AgentEnvironment, environment.id)
    assert environment_row is not None
    sentinel_sync_at = datetime(2026, 1, 2, tzinfo=UTC)
    environment_row.last_sync_at = sentinel_sync_at
    environment_row.last_sync_error = "legacy-error"
    environment_row.last_revision_seen = 11
    environment_row.queue_depth_high_water_since_start = 17
    environment_row.dropped_count_since_start = 19
    environment_row.sync_enabled = False
    await db_session.commit()

    runtime_key = ApiKey(
        id=uuid.uuid4(),
        user_id=seed_user.id,
        managed=True,
        environment_id=environment.id,
        runtime_deployment_id=_DEPLOYMENT_ID,
        scopes=["skills:write"],
    )

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=runtime_key)

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    event_id = f"v2-only-{environment.id}"
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            skills_only = await client.post(
                f"/v2/runtime/environments/{environment.id}/observations",
                json=_payload().model_dump(mode="json", by_alias=True),
            )
            runtime_key.scopes = ["runtime-observations:write"]
            accepted = await client.post(
                f"/v2/runtime/environments/{environment.id}/observations",
                json=_payload(event_id=event_id).model_dump(mode="json", by_alias=True),
            )
    finally:
        app.dependency_overrides.clear()

    assert skills_only.status_code == 403
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["outcome"] == "accepted_head_created"
    stored_observation = await db_session.get(HostedRuntimeConfigObservation, environment.id)
    assert stored_observation is not None
    assert stored_observation.observed_config_generation == 99
    assert stored_observation.diagnostics == {"sentinel": "legacy"}
    await db_session.refresh(environment_row)
    assert environment_row.last_sync_at == sentinel_sync_at
    assert environment_row.last_sync_error == "legacy-error"
    assert environment_row.last_revision_seen == 11
    assert environment_row.queue_depth_high_water_since_start == 17
    assert environment_row.dropped_count_since_start == 19
    assert environment_row.sync_enabled is False
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.environment_id == environment.id)
        )
        == 1
    )
    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    assert head is not None and head.highest_sequence == 1


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_v2_ingestion_audits_every_service_rejection_without_private_payload(
    db_session: AsyncSession,
    seed_user,
) -> None:
    environment, _ = await _provision_environment(db_session, seed_user)
    unfenced_environment = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"runtime-observation-unfenced-{uuid.uuid4().hex}",
        machine_name="runtime-observation-unfenced",
        agent_type="openclaw",
        os="linux",
    )
    unfenced_environment_id = unfenced_environment.id
    environment_id = environment.id
    owner_id = seed_user.id
    runtime_key = ApiKey(
        id=uuid.uuid4(),
        user_id=owner_id,
        managed=True,
        environment_id=environment_id,
        runtime_deployment_id=_DEPLOYMENT_ID,
        scopes=["runtime-observations:write"],
    )
    auth_context = AuthContext(user=seed_user, api_key=runtime_key)

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_auth() -> AuthContext:
        return auth_context

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    base = datetime.now(UTC)
    event_prefix = f"audit-{environment_id}"
    path = f"/v2/runtime/environments/{environment_id}/observations"
    raw_credential = "raw-runtime-credential-must-not-enter-audit"
    private_diagnostic = "private-diagnostic-and-opaque-cursor-must-not-enter-audit"
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"Authorization": f"Bearer {raw_credential}"},
        ) as client:
            future = await client.post(
                path,
                json=_payload(
                    event_id=f"{event_prefix}-future",
                    captured_at=base + timedelta(days=1),
                    error=private_diagnostic,
                ).model_dump(mode="json", by_alias=True),
            )
            too_old = await client.post(
                path,
                json=_payload(
                    event_id=f"{event_prefix}-too-old",
                    captured_at=base - timedelta(days=365),
                    error=private_diagnostic,
                ).model_dump(mode="json", by_alias=True),
            )
            runtime_key.runtime_deployment_id = "different-credential-deployment"
            credential_mismatch = await client.post(
                path,
                json=_payload(
                    event_id=f"{event_prefix}-credential",
                    error=private_diagnostic,
                ).model_dump(mode="json", by_alias=True),
            )
            runtime_key.runtime_deployment_id = _DEPLOYMENT_ID
            runtime_key.environment_id = unfenced_environment_id
            fence_missing = await client.post(
                f"/v2/runtime/environments/{unfenced_environment_id}/observations",
                json=_payload(
                    event_id=f"{event_prefix}-fence-missing",
                    error=private_diagnostic,
                ).model_dump(mode="json", by_alias=True),
            )
            runtime_key.environment_id = environment_id
            for payload in (
                _payload(sequence=1, event_id=f"{event_prefix}-1", captured_at=base),
                _payload(
                    sequence=3,
                    event_id=f"{event_prefix}-3",
                    captured_at=base + timedelta(seconds=3),
                ),
            ):
                response = await client.post(
                    path,
                    json=payload.model_dump(mode="json", by_alias=True),
                )
                assert response.status_code == 200, response.text

            non_advance = await client.post(
                path,
                json=_payload(
                    sequence=2,
                    event_id=f"{event_prefix}-2",
                    captured_at=base + timedelta(seconds=2),
                    error="private-diagnostic-must-not-enter-audit",
                ).model_dump(mode="json", by_alias=True),
            )
            captured_at_regression = await client.post(
                path,
                json=_payload(
                    sequence=4,
                    event_id=f"{event_prefix}-captured-regression",
                    captured_at=base + timedelta(seconds=2),
                    error="private-regression-diagnostic-must-not-enter-audit",
                ).model_dump(mode="json", by_alias=True),
            )
            rebind = await client.post(
                path,
                json=_payload(
                    sequence=5,
                    event_id=f"{event_prefix}-rebind",
                    captured_at=base + timedelta(seconds=4),
                    apply_receipt_id="different-receipt-000001",
                    error="private-rebind-diagnostic",
                ).model_dump(mode="json", by_alias=True),
            )
            event_conflict = await client.post(
                path,
                json=_payload(
                    sequence=3,
                    event_id=f"{event_prefix}-conflict",
                    captured_at=base + timedelta(seconds=3),
                    error="private-conflict-diagnostic",
                ).model_dump(mode="json", by_alias=True),
            )
            await _retire_runtime_environment(
                db_session,
                environment_id=environment_id,
                expected_deployment_id=_DEPLOYMENT_ID,
                retirement_id="audit-retirement",
                owner_id=owner_id,
            )
            await db_session.commit()
            retired = await client.post(
                path,
                json=_payload(
                    boot_session_id="new-session-after-retirement",
                    sequence=1,
                    event_id=f"{event_prefix}-retired",
                    captured_at=base + timedelta(seconds=5),
                    error="private-retired-diagnostic",
                ).model_dump(mode="json", by_alias=True),
            )
    finally:
        app.dependency_overrides.clear()

    assert future.status_code == 422
    assert future.json()["detail"]["code"] == "runtime_observation_captured_at_in_future"
    assert too_old.status_code == 422
    assert too_old.json()["detail"]["code"] == "runtime_observation_captured_at_too_old"
    assert credential_mismatch.status_code == 403
    assert credential_mismatch.json()["detail"]["code"] == "runtime_observation_credential_mismatch"
    assert fence_missing.status_code == 409
    assert fence_missing.json()["detail"]["code"] == "runtime_environment_fence_missing"
    assert non_advance.status_code == 200
    assert non_advance.json()["outcome"] == "accepted_non_advance_sequence"
    assert captured_at_regression.status_code == 200
    assert captured_at_regression.json()["outcome"] == "accepted_non_advance_captured_at"
    assert rebind.status_code == 409
    assert rebind.json()["detail"]["code"] == "runtime_observation_identity_conflict"
    assert event_conflict.status_code == 409
    assert event_conflict.json()["detail"]["code"] == "runtime_observation_event_conflict"
    assert retired.status_code == 409
    assert retired.json()["detail"]["code"] == "runtime_environment_retired"
    audits = list(
        (
            await db_session.execute(
                select(ControlPlaneAuditEvent).where(
                    ControlPlaneAuditEvent.source == "api.v2.runtime",
                    ControlPlaneAuditEvent.action == "runtime_observation.ingest",
                    ControlPlaneAuditEvent.details["event_id"].astext.like(f"{event_prefix}%"),
                )
            )
        )
        .scalars()
        .all()
    )
    expected_outcomes = {
        f"{event_prefix}-future": "runtime_observation_captured_at_in_future",
        f"{event_prefix}-too-old": "runtime_observation_captured_at_too_old",
        f"{event_prefix}-credential": "runtime_observation_credential_mismatch",
        f"{event_prefix}-fence-missing": "runtime_environment_fence_missing",
        f"{event_prefix}-2": "accepted_non_advance_sequence",
        f"{event_prefix}-captured-regression": "accepted_non_advance_captured_at",
        f"{event_prefix}-rebind": "runtime_observation_identity_conflict",
        f"{event_prefix}-conflict": "runtime_observation_event_conflict",
        f"{event_prefix}-retired": "runtime_environment_retired",
    }
    assert {event.details["event_id"]: event.details["outcome"] for event in audits} == (
        expected_outcomes
    )
    for event in audits:
        details = event.details
        assert event.actor_user_id == owner_id
        assert event.target_user_id == owner_id
        assert details["principal_id"] == str(runtime_key.id)
        assert details["runtime_principal_id"] == str(runtime_key.id)
        assert details["environment_id"] == event.resource_id
        assert details["deployment_id"] in {
            _DEPLOYMENT_ID,
            "different-credential-deployment",
        }
        assert details["boot_session_id"]
        assert details["sequence"] >= 1
        assert details["event_id"] in expected_outcomes
    serialized_audits = json.dumps([event.details for event in audits], sort_keys=True)
    assert "private-" not in serialized_audits
    assert "diagnostics" not in serialized_audits
    assert raw_credential not in serialized_audits
    assert "opaque-cursor" not in serialized_audits
    assert "runtime environment fence does not exist" not in serialized_audits
    inbox_events = list(
        (
            await db_session.execute(
                select(V2RuntimeObservationInbox.event_id)
                .where(V2RuntimeObservationInbox.environment_id == environment_id)
                .order_by(V2RuntimeObservationInbox.id)
            )
        ).scalars()
    )
    assert inbox_events == [
        f"{event_prefix}-1",
        f"{event_prefix}-3",
        f"{event_prefix}-2",
        f"{event_prefix}-captured-regression",
    ]
    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment_id, "boot_session_id": "boot-session-0001"},
    )
    assert head is not None
    assert head.highest_sequence == 3


@pytest.mark.committed_db
@pytest.mark.asyncio
async def test_v2_ingestion_route_auth_rejections_are_durably_audited(
    db_session: AsyncSession,
    seed_user,
) -> None:
    environment, _ = await _provision_environment(db_session, seed_user)
    environment_id = environment.id
    path = f"/v2/runtime/environments/{environment_id}/observations"
    event_prefix = f"route-auth-audit-{environment_id}"
    auth_context: AuthContext

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_auth() -> AuthContext:
        return auth_context

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    raw_credential = "raw-route-credential-must-not-enter-audit"
    private_diagnostic = "private-internal-error-and-opaque-cursor-must-not-enter-audit"
    cases = (
        (
            "runtime_credential_required",
            None,
            None,
            None,
            None,
        ),
        (
            "managed_credential_required",
            False,
            environment_id,
            _DEPLOYMENT_ID,
            ["runtime-observations:write"],
        ),
        (
            "scope_missing",
            True,
            environment_id,
            _DEPLOYMENT_ID,
            ["skills:write"],
        ),
        (
            "environment_binding_mismatch",
            True,
            uuid.uuid4(),
            _DEPLOYMENT_ID,
            ["runtime-observations:write"],
        ),
        (
            "deployment_binding_missing",
            True,
            environment_id,
            None,
            ["runtime-observations:write"],
        ),
    )
    expected: dict[str, dict[str, object]] = {}
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"Authorization": f"Bearer {raw_credential}"},
        ) as client:
            for index, (reason, managed, bound_environment, deployment_id, scopes) in enumerate(
                cases,
                start=1,
            ):
                runtime_key = None
                if managed is not None:
                    runtime_key = ApiKey(
                        id=uuid.uuid4(),
                        user_id=seed_user.id,
                        managed=managed,
                        environment_id=bound_environment,
                        runtime_deployment_id=deployment_id,
                        scopes=scopes,
                        key_hash=raw_credential,
                        key_prefix="raw-route-prefix",
                    )
                auth_context = AuthContext(user=seed_user, api_key=runtime_key)
                event_id = f"{event_prefix}-{reason}"
                payload = _payload(
                    boot_session_id=f"route-auth-boot-{index}",
                    sequence=index,
                    event_id=event_id,
                    error=private_diagnostic,
                )
                response = await client.post(
                    path,
                    json=payload.model_dump(mode="json", by_alias=True),
                )
                assert response.status_code == 403
                assert (
                    response.json()["detail"]["code"] == "runtime_observation_credential_mismatch"
                )
                principal_id = runtime_key.id if runtime_key is not None else seed_user.id
                expected[event_id] = {
                    "reason": reason,
                    "actor_type": ("runtime_deployment" if runtime_key is not None else "user"),
                    "principal_id": str(principal_id),
                    "runtime_principal_id": (
                        str(runtime_key.id) if runtime_key is not None else None
                    ),
                    "deployment_id": deployment_id,
                    "boot_session_id": payload.boot_session_id,
                    "sequence": payload.sequence,
                }
    finally:
        app.dependency_overrides.clear()

    audits = list(
        (
            await db_session.execute(
                select(ControlPlaneAuditEvent).where(
                    ControlPlaneAuditEvent.source == "api.v2.runtime",
                    ControlPlaneAuditEvent.action == "runtime_observation.ingest",
                    ControlPlaneAuditEvent.resource_id == str(environment_id),
                    ControlPlaneAuditEvent.details["event_id"].astext.like(f"{event_prefix}%"),
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(audits) == len(cases)
    for event in audits:
        details = event.details
        expected_details = expected[details["event_id"]]
        assert event.actor_type == expected_details["actor_type"]
        assert event.actor_user_id == seed_user.id
        assert event.target_user_id == seed_user.id
        assert details["principal_id"] is not None
        assert details == {
            "principal_id": expected_details["principal_id"],
            "runtime_principal_id": expected_details["runtime_principal_id"],
            "environment_id": str(environment_id),
            "deployment_id": expected_details["deployment_id"],
            "boot_session_id": expected_details["boot_session_id"],
            "sequence": expected_details["sequence"],
            "event_id": details["event_id"],
            "outcome": "runtime_observation_credential_mismatch",
            "rejection_reason": expected_details["reason"],
        }
    serialized_audits = json.dumps([event.details for event in audits], sort_keys=True)
    assert raw_credential not in serialized_audits
    assert "private-" not in serialized_audits
    assert "opaque-cursor" not in serialized_audits
    assert "internal-error" not in serialized_audits
    assert "diagnostics" not in serialized_audits
