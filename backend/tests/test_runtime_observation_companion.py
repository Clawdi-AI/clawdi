from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.services.runtime_observation as runtime_observation_service
from app.core.auth import AuthContext, get_auth
from app.core.database import get_session
from app.main import app
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeConfigObservation
from app.models.runtime_observation import (
    V2RuntimeEnvironmentFence,
    V2RuntimeObservationConsumerCursor,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.schemas.runtime_observed import HostedRuntimeObservedV2
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
    retire_runtime_environment,
)
from app.services.runtime_observation import (
    ingest_runtime_observation as _ingest_runtime_observation,
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
    value: HostedRuntimeObservedV2,
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
) -> HostedRuntimeObservedV2:
    captured = captured_at or datetime.now(UTC)
    return HostedRuntimeObservedV2.model_validate(
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
    assert duplicate == type(first)(first.event_id, first.stream_position, True)
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

    assert receipt["finalSessionHighWaterMarks"] == {"boot-session-0001": 1}
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

    assert receipt["finalSessionHighWaterMarks"] == {}
    head_count = await db_session.scalar(
        select(func.count())
        .select_from(V2RuntimeObservationHead)
        .where(V2RuntimeObservationHead.environment_id == environment.id)
    )
    assert head_count == 0


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
    await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(captured_at=captured),
        received_at=captured,
    )
    await db_session.commit()

    # Replay-horizon cleanup cannot delete an unacked row before the hard cap.
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


@pytest.mark.asyncio
async def test_concurrent_first_session_binding_rejects_losing_identity(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def bind_losing_identity() -> str:
        async with session_factory() as session:
            try:
                await ingest_runtime_observation(
                    session,
                    environment_id=environment.id,
                    value=_payload(
                        sequence=1,
                        event_id="binding-event-0002",
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
            value=_payload(sequence=1, event_id="binding-event-0001"),
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


@pytest.mark.asyncio
async def test_concurrent_cross_environment_event_id_collision_is_structured(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment_a, _ = await _provision_environment(db_session, seed_user)
    environment_b, _ = await _provision_environment(db_session, seed_user)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    shared_event_id = "globally-colliding-event-id"
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


@pytest.mark.asyncio
async def test_companion_heartbeat_requires_bound_managed_key_and_skips_legacy_writer(
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
    await db_session.commit()
    runtime_key = ApiKey(
        user_id=seed_user.id,
        environment_id=environment.id,
        managed=False,
        scopes=["skills:write"],
    )
    accepted_payload = _payload(captured_at=datetime.now(UTC))

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=runtime_key)

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            unmanaged_response = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={"runtime_observed": _payload().model_dump(mode="json", by_alias=True)},
            )
            runtime_key.managed = True
            legacy_managed_response = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={"runtime_observed": _payload().model_dump(mode="json", by_alias=True)},
            )
            runtime_key.runtime_deployment_id = _DEPLOYMENT_ID
            response = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={"runtime_observed": accepted_payload.model_dump(mode="json", by_alias=True)},
            )
            duplicate_response = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={"runtime_observed": accepted_payload.model_dump(mode="json", by_alias=True)},
            )
            stale_buffered_response = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={
                    "runtime_observed": _payload(
                        sequence=2,
                        captured_at=accepted_payload.captured_at - timedelta(seconds=1),
                    ).model_dump(mode="json", by_alias=True)
                },
            )
            runtime_key.environment_id = unfenced_environment_id
            unfenced_response = await client.post(
                f"/v1/agents/{unfenced_environment_id}/sync-heartbeat",
                json={"runtime_observed": _payload().model_dump(mode="json", by_alias=True)},
            )
    finally:
        app.dependency_overrides.clear()
    assert unmanaged_response.status_code == 403, unmanaged_response.text
    assert legacy_managed_response.status_code == 403, legacy_managed_response.text
    assert response.status_code == 204, response.text
    assert duplicate_response.status_code == 204, duplicate_response.text
    assert stale_buffered_response.status_code == 204, stale_buffered_response.text
    assert unfenced_response.status_code == 409, unfenced_response.text
    assert unfenced_response.json()["detail"]["code"] == "runtime_environment_fence_missing"
    assert await db_session.get(HostedRuntimeConfigObservation, environment.id) is None
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.environment_id == environment.id)
        )
        == 2
    )
    stored_environment = await db_session.get(type(unfenced_environment), environment.id)
    assert stored_environment is not None
    assert stored_environment.last_sync_at is None


@pytest.mark.asyncio
async def test_runtime_credential_cannot_report_for_another_deployment(
    db_session: AsyncSession,
    seed_user,
) -> None:
    deployment_a = "deployment-credential-a"
    deployment_b = "deployment-credential-b"
    environment_a, fence_a = await _provision_environment(
        db_session,
        seed_user,
        deployment_id=deployment_a,
    )
    environment_b, fence_b = await _provision_environment(
        db_session,
        seed_user,
        deployment_id=deployment_b,
    )
    assert fence_a.deployment_id != fence_b.deployment_id
    runtime_key_a = ApiKey(
        user_id=seed_user.id,
        environment_id=environment_a.id,
        runtime_deployment_id=deployment_a,
        managed=True,
        scopes=["skills:write"],
    )

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    async def override_auth() -> AuthContext:
        return AuthContext(user=seed_user, api_key=runtime_key_a)

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[get_auth] = override_auth
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            accepted = await client.post(
                f"/v1/agents/{environment_a.id}/sync-heartbeat",
                json={
                    "runtime_observed": _payload(
                        boot_session_id="credential-a-session",
                    ).model_dump(mode="json", by_alias=True)
                },
            )
            rejected = await client.post(
                f"/v1/agents/{environment_b.id}/sync-heartbeat",
                json={
                    "runtime_observed": _payload(
                        boot_session_id="credential-b-forged-session",
                    ).model_dump(mode="json", by_alias=True)
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert accepted.status_code == 204, accepted.text
    assert rejected.status_code == 403, rejected.text
    assert rejected.json()["detail"]["code"] == "runtime_observation_credential_mismatch"
    counts = dict(
        (
            await db_session.execute(
                select(
                    V2RuntimeObservationInbox.environment_id,
                    func.count(V2RuntimeObservationInbox.id),
                )
                .where(
                    V2RuntimeObservationInbox.environment_id.in_(
                        [environment_a.id, environment_b.id]
                    )
                )
                .group_by(V2RuntimeObservationInbox.environment_id)
            )
        ).all()
    )
    assert counts == {environment_a.id: 1}


@pytest.mark.asyncio
async def test_real_minted_bearer_requires_immutable_runtime_deployment_binding(
    db_session: AsyncSession,
    seed_user,
) -> None:
    deployment_a = "deployment-minted-bearer-a"
    deployment_b = "deployment-minted-bearer-b"
    environment_a_row = await create_env_with_project(
        db_session,
        user_id=seed_user.id,
        machine_id=f"legacy-before-fence-{uuid.uuid4().hex}",
        machine_name="legacy-before-fence",
        agent_type="openclaw",
        os="linux",
    )
    environment_a = _EnvironmentRef(environment_a_row.id)
    legacy = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="legacy-managed-runtime",
        scopes=["skills:write"],
        environment_id=environment_a.id,
        managed=True,
        commit=True,
    )
    assert await db_session.get(V2RuntimeEnvironmentFence, environment_a.id) is None
    await provision_runtime_environment_fence(
        db_session,
        environment_id=environment_a.id,
        owner_id=seed_user.id,
        deployment_id=deployment_a,
    )
    await db_session.commit()
    strict = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="strict-v2-runtime",
        scopes=["skills:write"],
        environment_id=environment_a.id,
        runtime_deployment_id=deployment_a,
        managed=True,
        commit=True,
    )
    environment_b, _ = await _provision_environment(
        db_session,
        seed_user,
        deployment_id=deployment_b,
    )
    legacy_row = await db_session.get(ApiKey, legacy.api_key.id)
    strict_row = await db_session.get(ApiKey, strict.api_key.id)
    assert legacy_row is not None
    assert strict_row is not None
    assert legacy_row.created_at < strict_row.created_at
    assert legacy_row.runtime_deployment_id is None
    assert strict_row.runtime_deployment_id == deployment_a

    async def override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = override_session
    try:
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            legacy_rejected = await client.post(
                f"/v1/agents/{environment_a.id}/sync-heartbeat",
                headers={"Authorization": f"Bearer {legacy.raw_key}"},
                json={
                    "runtime_observed": _payload(
                        boot_session_id="legacy-minted-session",
                    ).model_dump(mode="json", by_alias=True)
                },
            )
            accepted = await client.post(
                f"/v1/agents/{environment_a.id}/sync-heartbeat",
                headers={"Authorization": f"Bearer {strict.raw_key}"},
                json={
                    "runtime_observed": _payload(
                        boot_session_id="strict-minted-session",
                    ).model_dump(mode="json", by_alias=True)
                },
            )
            cross_deployment = await client.post(
                f"/v1/agents/{environment_b.id}/sync-heartbeat",
                headers={"Authorization": f"Bearer {strict.raw_key}"},
                json={
                    "runtime_observed": _payload(
                        boot_session_id="strict-cross-deployment-session",
                    ).model_dump(mode="json", by_alias=True)
                },
            )
    finally:
        app.dependency_overrides.clear()

    assert legacy_rejected.status_code == 403, legacy_rejected.text
    assert legacy_rejected.json()["detail"]["code"] == ("runtime_observation_credential_mismatch")
    assert accepted.status_code == 204, accepted.text
    assert cross_deployment.status_code == 403, cross_deployment.text
    assert cross_deployment.json()["detail"]["code"] == ("runtime_observation_credential_mismatch")
