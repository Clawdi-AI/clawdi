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
from app.services.runtime_observation import (
    RuntimeApplyIdentity,
    RuntimeObservationProtocolError,
    expire_runtime_observation_payloads,
    ingest_runtime_observation,
    provision_runtime_environment_fence,
    read_runtime_observations,
    register_runtime_observation_consumer,
    reset_runtime_observation_consumer,
    retire_runtime_environment,
)
from tests.conftest import create_env_with_project

_DEPLOYMENT_ID = "deployment-observation-companion"
_APPLY_RECEIPT_ID = "apply-receipt-00000001"
_BOOT_NONCE = "boot-nonce-0000000001"
_MANIFEST_ETAG = '"manifest-etag-0001"'


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
async def test_identity_and_monotonicity_conflicts_never_enter_inbox(
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

    with pytest.raises(RuntimeObservationProtocolError) as sequence_error:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(sequence=2, captured_at=base + timedelta(seconds=2)),
            received_at=base + timedelta(seconds=5),
        )
    assert sequence_error.value.code == "runtime_observation_sequence_regression"
    await db_session.rollback()

    with pytest.raises(RuntimeObservationProtocolError) as capture_error:
        await ingest_runtime_observation(
            db_session,
            environment_id=environment.id,
            value=_payload(sequence=4, captured_at=base + timedelta(seconds=2)),
            received_at=base + timedelta(seconds=5),
        )
    assert capture_error.value.code == "runtime_observation_captured_at_regression"
    await db_session.rollback()

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

    inbox_count = await db_session.scalar(
        select(func.count())
        .select_from(V2RuntimeObservationInbox)
        .where(V2RuntimeObservationInbox.environment_id == environment.id)
    )
    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    assert inbox_count == 2
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
async def test_concurrent_cas_winner_cannot_be_regressed(
    engine,
    db_session: AsyncSession,
    seed_user,
):
    environment, _ = await _provision_environment(db_session, seed_user)
    base = datetime.now(UTC)
    await ingest_runtime_observation(
        db_session,
        environment_id=environment.id,
        value=_payload(sequence=1, captured_at=base),
        received_at=base,
    )
    await db_session.commit()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with session_factory() as high_session:
        await ingest_runtime_observation(
            high_session,
            environment_id=environment.id,
            value=_payload(sequence=3, captured_at=base + timedelta(seconds=3)),
            received_at=base + timedelta(seconds=3),
        )

        async def ingest_lower() -> str:
            async with session_factory() as low_session:
                try:
                    await ingest_runtime_observation(
                        low_session,
                        environment_id=environment.id,
                        value=_payload(sequence=2, captured_at=base + timedelta(seconds=2)),
                        received_at=base + timedelta(seconds=4),
                    )
                except RuntimeObservationProtocolError as exc:
                    await low_session.rollback()
                    return exc.code
                raise AssertionError("lower sequence unexpectedly committed")

        lower = asyncio.create_task(ingest_lower())
        await asyncio.sleep(0.05)
        assert not lower.done()
        await high_session.commit()
        assert await asyncio.wait_for(lower, timeout=5) == "runtime_observation_sequence_regression"

    head = await db_session.get(
        V2RuntimeObservationHead,
        {"environment_id": environment.id, "boot_session_id": "boot-session-0001"},
    )
    await db_session.refresh(head)
    assert head.highest_sequence == 3
    assert head.captured_at == base + timedelta(seconds=3)


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
            response = await client.post(
                f"/v1/agents/{environment.id}/sync-heartbeat",
                json={"runtime_observed": _payload().model_dump(mode="json", by_alias=True)},
            )
            runtime_key.environment_id = unfenced_environment_id
            unfenced_response = await client.post(
                f"/v1/agents/{unfenced_environment_id}/sync-heartbeat",
                json={"runtime_observed": _payload().model_dump(mode="json", by_alias=True)},
            )
    finally:
        app.dependency_overrides.clear()
    assert unmanaged_response.status_code == 403, unmanaged_response.text
    assert response.status_code == 204, response.text
    assert unfenced_response.status_code == 409, unfenced_response.text
    assert unfenced_response.json()["detail"]["code"] == "runtime_environment_fence_missing"
    assert await db_session.get(HostedRuntimeConfigObservation, environment.id) is None
    assert (
        await db_session.scalar(
            select(func.count())
            .select_from(V2RuntimeObservationInbox)
            .where(V2RuntimeObservationInbox.environment_id == environment.id)
        )
        == 1
    )


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
