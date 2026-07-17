from __future__ import annotations

import base64
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.runtime_observation import (
    RUNTIME_ENVIRONMENT_ACTIVE,
    RUNTIME_ENVIRONMENT_RETIRED,
    RUNTIME_OBSERVATION_CURSOR_ACTIVE,
    RUNTIME_OBSERVATION_CURSOR_EXPIRED,
    RUNTIME_OBSERVATION_HEAD_ACTIVE,
    RUNTIME_OBSERVATION_HEAD_RETIRED,
    V2RuntimeEnvironmentFence,
    V2RuntimeObservationConsumerCursor,
    V2RuntimeObservationHead,
    V2RuntimeObservationInbox,
)
from app.models.session import AgentEnvironment
from app.schemas.runtime_observed import HostedRuntimeObservedV2

_CURSOR_PREFIX = "clawdi-ro-v1"
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


@dataclass
class RuntimeObservationProtocolError(Exception):
    status_code: int
    code: str
    message: str
    metadata: dict[str, Any] | None = None

    def detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.metadata:
            detail.update(self.metadata)
        return detail


@dataclass(frozen=True)
class RuntimeObservationIngestResult:
    event_id: str
    stream_position: int
    duplicate: bool


@dataclass(frozen=True)
class RuntimeApplyIdentity:
    generation: int
    manifest_etag: str
    apply_receipt_id: str
    boot_nonce: str


@dataclass(frozen=True)
class DecodedRuntimeObservationCursor:
    environment_id: uuid.UUID
    consumer_id: str
    cursor_epoch: uuid.UUID
    stream_position: int


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _cursor_key() -> bytes:
    material = settings.runtime_observation_cursor_key or settings.encryption_key
    if not material:
        raise RuntimeObservationProtocolError(
            503,
            "runtime_observation_cursor_unavailable",
            "runtime observation cursor signing is not configured",
        )
    return hashlib.sha256(material.encode("utf-8")).digest()


def encode_runtime_observation_cursor(
    *,
    environment_id: uuid.UUID,
    consumer_id: str,
    cursor_epoch: uuid.UUID,
    stream_position: int,
) -> str:
    if stream_position < 0 or stream_position > _MAX_SAFE_INTEGER:
        raise ValueError("runtime observation stream position is out of bounds")
    claims = json.dumps(
        {
            "environmentId": str(environment_id),
            "consumerId": consumer_id,
            "cursorEpoch": str(cursor_epoch),
            "streamPosition": stream_position,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(_cursor_key()).encrypt(nonce, claims, _CURSOR_PREFIX.encode("ascii"))
    opaque = base64.urlsafe_b64encode(nonce + ciphertext).rstrip(b"=").decode("ascii")
    return f"{_CURSOR_PREFIX}.{opaque}"


def decode_runtime_observation_cursor(value: str) -> DecodedRuntimeObservationCursor:
    try:
        prefix, opaque = value.split(".", 1)
        if prefix != _CURSOR_PREFIX:
            raise ValueError("unsupported cursor version")
        padding = "=" * (-len(opaque) % 4)
        protected = base64.urlsafe_b64decode(opaque + padding)
        if len(protected) <= 12:
            raise ValueError("cursor is truncated")
        claims_raw = AESGCM(_cursor_key()).decrypt(
            protected[:12],
            protected[12:],
            _CURSOR_PREFIX.encode("ascii"),
        )
        claims = json.loads(claims_raw)
        if not isinstance(claims, dict):
            raise ValueError("cursor claims are invalid")
        stream_position = claims["streamPosition"]
        if (
            isinstance(stream_position, bool)
            or not isinstance(stream_position, int)
            or stream_position < 0
            or stream_position > _MAX_SAFE_INTEGER
        ):
            raise ValueError("cursor position is invalid")
        consumer_id = claims["consumerId"]
        if not isinstance(consumer_id, str) or not consumer_id:
            raise ValueError("cursor consumer is invalid")
        return DecodedRuntimeObservationCursor(
            environment_id=uuid.UUID(claims["environmentId"]),
            consumer_id=consumer_id,
            cursor_epoch=uuid.UUID(claims["cursorEpoch"]),
            stream_position=stream_position,
        )
    except RuntimeObservationProtocolError:
        raise
    except (InvalidTag, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeObservationProtocolError(
            410,
            "observation_cursor_expired",
            "runtime observation cursor is unknown or expired",
        ) from exc


async def provision_runtime_environment_fence(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    owner_id: uuid.UUID,
    deployment_id: str,
) -> V2RuntimeEnvironmentFence:
    """Create the permanent binding before a v2 runtime credential is inserted."""

    environment = (
        await db.execute(
            select(AgentEnvironment)
            .where(
                AgentEnvironment.id == environment_id,
                AgentEnvironment.user_id == owner_id,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if environment is None:
        raise RuntimeObservationProtocolError(
            404,
            "runtime_environment_not_found",
            "runtime environment was not found",
        )
    fence = (
        await db.execute(
            select(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if fence is None:
        fence = V2RuntimeEnvironmentFence(
            environment_id=environment_id,
            owner_id=owner_id,
            deployment_id=deployment_id,
            state=RUNTIME_ENVIRONMENT_ACTIVE,
        )
        db.add(fence)
        await db.flush()
        return fence
    if fence.owner_id != owner_id or fence.deployment_id != deployment_id:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_binding_conflict",
            "runtime environment is permanently bound to another deployment",
        )
    if fence.state != RUNTIME_ENVIRONMENT_ACTIVE:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_retired",
            "retired runtime environment identities cannot be reused",
        )
    return fence


async def require_active_runtime_environment_fence(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    owner_id: uuid.UUID | None = None,
    deployment_id: str | None = None,
) -> V2RuntimeEnvironmentFence:
    fence = (
        await db.execute(
            select(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if fence is None:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_fence_missing",
            "v2 runtime environment fence must exist before this operation",
        )
    if owner_id is not None and fence.owner_id != owner_id:
        raise RuntimeObservationProtocolError(
            403,
            "runtime_environment_binding_conflict",
            "runtime environment owner binding does not match",
        )
    if deployment_id is not None and fence.deployment_id != deployment_id:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_binding_conflict",
            "runtime environment deployment binding does not match",
        )
    if fence.state != RUNTIME_ENVIRONMENT_ACTIVE:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_retired",
            "runtime environment is retired",
        )
    return fence


def _canonical_observation_payload(value: HostedRuntimeObservedV2) -> tuple[dict[str, Any], str]:
    payload = value.model_dump(mode="json", by_alias=True, exclude_unset=True)
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return payload, hashlib.sha256(encoded).hexdigest()


def _companion_identity(value: HostedRuntimeObservedV2) -> RuntimeApplyIdentity:
    if not value.is_companion_event or value.applied is None:
        raise ValueError("strict companion runtime observation is required")
    if value.apply_receipt_id is None or value.boot_nonce is None:
        raise ValueError("strict companion apply identity is incomplete")
    return RuntimeApplyIdentity(
        generation=value.applied.generation,
        manifest_etag=value.applied.etag,
        apply_receipt_id=value.apply_receipt_id,
        boot_nonce=value.boot_nonce,
    )


def _head_identity_matches(
    head: V2RuntimeObservationHead,
    identity: RuntimeApplyIdentity,
) -> bool:
    return (
        head.generation == identity.generation
        and head.manifest_etag == identity.manifest_etag
        and head.apply_receipt_id == identity.apply_receipt_id
        and head.boot_nonce == identity.boot_nonce
    )


async def ingest_runtime_observation(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    value: HostedRuntimeObservedV2,
    received_at: datetime | None = None,
) -> RuntimeObservationIngestResult:
    """Append and CAS-advance one strict-v2 event under the environment fence."""

    identity = _companion_identity(value)
    if (
        value.boot_session_id is None
        or value.sequence is None
        or value.event_id is None
        or value.captured_at is None
    ):
        raise ValueError("strict companion event identity is incomplete")
    now = _utc(received_at or datetime.now(UTC))
    captured_at = _utc(value.captured_at)
    future_skew = timedelta(seconds=settings.runtime_observation_max_future_skew_seconds)
    max_age = timedelta(days=settings.runtime_observation_max_capture_age_days)
    if captured_at > now + future_skew:
        raise RuntimeObservationProtocolError(
            422,
            "runtime_observation_captured_at_in_future",
            "runtime observation capturedAt exceeds the allowed clock skew",
        )
    if captured_at < now - max_age:
        raise RuntimeObservationProtocolError(
            422,
            "runtime_observation_captured_at_too_old",
            "runtime observation capturedAt is outside the accepted transport age",
        )
    payload, payload_hash = _canonical_observation_payload(value)
    freshness_deadline = captured_at + timedelta(
        seconds=settings.runtime_observation_freshness_seconds
    )

    fence = await require_active_runtime_environment_fence(
        db,
        environment_id=environment_id,
    )
    head = (
        await db.execute(
            select(V2RuntimeObservationHead)
            .where(
                V2RuntimeObservationHead.environment_id == environment_id,
                V2RuntimeObservationHead.boot_session_id == value.boot_session_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if head is not None and not _head_identity_matches(head, identity):
        raise RuntimeObservationProtocolError(
            409,
            "runtime_observation_identity_conflict",
            "boot session is already bound to another apply identity",
        )
    existing_by_event = (
        await db.execute(
            select(V2RuntimeObservationInbox).where(
                V2RuntimeObservationInbox.event_id == value.event_id
            )
        )
    ).scalar_one_or_none()
    existing_by_sequence = (
        await db.execute(
            select(V2RuntimeObservationInbox).where(
                V2RuntimeObservationInbox.environment_id == environment_id,
                V2RuntimeObservationInbox.boot_session_id == value.boot_session_id,
                V2RuntimeObservationInbox.sequence == value.sequence,
            )
        )
    ).scalar_one_or_none()
    if existing_by_event is not None or existing_by_sequence is not None:
        existing = existing_by_event or existing_by_sequence
        assert existing is not None
        exact_duplicate = (
            existing_by_event is not None
            and existing_by_sequence is not None
            and existing_by_event.id == existing_by_sequence.id
            and existing.environment_id == environment_id
            and existing.boot_session_id == value.boot_session_id
            and existing.sequence == value.sequence
            and existing.event_id == value.event_id
            and existing.payload_hash == payload_hash
        )
        if exact_duplicate:
            return RuntimeObservationIngestResult(
                event_id=existing.event_id,
                stream_position=existing.id,
                duplicate=True,
            )
        raise RuntimeObservationProtocolError(
            409,
            "runtime_observation_event_conflict",
            "runtime observation identity was reused with different event data",
        )

    if head is not None:
        if head.state != RUNTIME_OBSERVATION_HEAD_ACTIVE:
            raise RuntimeObservationProtocolError(
                409,
                "runtime_environment_retired",
                "retired boot-session tombstones are immutable",
            )
        if value.sequence <= head.highest_sequence:
            raise RuntimeObservationProtocolError(
                409,
                "runtime_observation_sequence_regression",
                "runtime observation sequence must advance within a boot session",
                {"highestAcceptedSequence": head.highest_sequence},
            )
        if head.captured_at is not None and captured_at < _utc(head.captured_at):
            raise RuntimeObservationProtocolError(
                409,
                "runtime_observation_captured_at_regression",
                "runtime observation capturedAt must not regress within a boot session",
                {"highestAcceptedCapturedAt": _utc(head.captured_at).isoformat()},
            )

    inbox = V2RuntimeObservationInbox(
        environment_id=environment_id,
        deployment_id=fence.deployment_id,
        generation=identity.generation,
        manifest_etag=identity.manifest_etag,
        apply_receipt_id=identity.apply_receipt_id,
        boot_nonce=identity.boot_nonce,
        boot_session_id=value.boot_session_id,
        sequence=value.sequence,
        event_id=value.event_id,
        captured_at=captured_at,
        received_at=now,
        freshness_deadline=freshness_deadline,
        payload_hash=payload_hash,
        health=value.status,
        diagnostics=payload,
    )
    db.add(inbox)
    await db.flush()
    fence.stream_high_water = inbox.id
    if head is None:
        head = V2RuntimeObservationHead(
            environment_id=environment_id,
            deployment_id=fence.deployment_id,
            generation=identity.generation,
            manifest_etag=identity.manifest_etag,
            apply_receipt_id=identity.apply_receipt_id,
            boot_nonce=identity.boot_nonce,
            boot_session_id=value.boot_session_id,
            highest_sequence=value.sequence,
            latest_inbox_id=inbox.id,
            latest_stream_position=inbox.id,
            latest_event_id=value.event_id,
            latest_payload_hash=payload_hash,
            captured_at=captured_at,
            freshness_deadline=freshness_deadline,
            health=value.status,
            state=RUNTIME_OBSERVATION_HEAD_ACTIVE,
        )
        db.add(head)
    else:
        head.highest_sequence = value.sequence
        head.latest_inbox_id = inbox.id
        head.latest_stream_position = inbox.id
        head.latest_event_id = value.event_id
        head.latest_payload_hash = payload_hash
        head.captured_at = captured_at
        head.freshness_deadline = freshness_deadline
        head.health = value.status
    await db.flush()
    return RuntimeObservationIngestResult(
        event_id=value.event_id,
        stream_position=inbox.id,
        duplicate=False,
    )


def _session_high_waters(heads: list[V2RuntimeObservationHead]) -> dict[str, int]:
    return {
        head.boot_session_id: head.highest_sequence
        for head in sorted(heads, key=lambda item: item.boot_session_id)
    }


async def retire_runtime_environment(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    expected_deployment_id: str,
    retirement_id: str,
    owner_id: uuid.UUID | None = None,
    retired_at: datetime | None = None,
) -> dict[str, Any]:
    """Idempotently retire and tombstone an environment under the ingestion lock."""

    now = _utc(retired_at or datetime.now(UTC))
    fence = (
        await db.execute(
            select(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if fence is None:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_fence_missing",
            "runtime environment fence does not exist",
        )
    if owner_id is not None and fence.owner_id != owner_id:
        raise RuntimeObservationProtocolError(
            403,
            "runtime_environment_binding_conflict",
            "runtime environment owner binding does not match",
        )
    if fence.deployment_id != expected_deployment_id:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_binding_conflict",
            "runtime environment deployment binding does not match",
        )
    if fence.state == RUNTIME_ENVIRONMENT_RETIRED:
        if fence.retirement_id == retirement_id and isinstance(fence.retirement_receipt, dict):
            return fence.retirement_receipt
        raise RuntimeObservationProtocolError(
            409,
            "runtime_environment_retirement_conflict",
            "runtime environment was retired by another obligation",
        )

    heads = (
        (
            await db.execute(
                select(V2RuntimeObservationHead)
                .where(V2RuntimeObservationHead.environment_id == environment_id)
                .order_by(V2RuntimeObservationHead.boot_session_id)
                .execution_options(populate_existing=True)
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    final_position = fence.stream_high_water
    high_waters = _session_high_waters(list(heads))
    receipt_id = uuid.uuid4()
    final_cursor = encode_runtime_observation_cursor(
        environment_id=environment_id,
        consumer_id=f"retirement:{retirement_id}",
        cursor_epoch=receipt_id,
        stream_position=final_position,
    )
    receipt: dict[str, Any] = {
        "retirementReceiptId": str(receipt_id),
        "retirementId": retirement_id,
        "environmentId": str(environment_id),
        "deploymentId": expected_deployment_id,
        "retiredAt": now.isoformat(),
        "finalCursor": final_cursor,
        "finalSessionHighWaterMarks": high_waters,
    }
    fence.state = RUNTIME_ENVIRONMENT_RETIRED
    fence.retirement_id = retirement_id
    fence.retirement_receipt_id = receipt_id
    fence.retirement_receipt = receipt
    fence.retired_at = now
    fence.final_cursor = final_cursor
    fence.final_stream_position = final_position
    fence.final_session_high_waters = high_waters
    for head in heads:
        head.state = RUNTIME_OBSERVATION_HEAD_RETIRED
        head.latest_inbox_id = None
        head.captured_at = None
        head.freshness_deadline = None
        head.health = None
        head.tombstoned_at = now
    await db.flush()
    return receipt


def _cursor_expiry_metadata(
    cursor: V2RuntimeObservationConsumerCursor | None,
) -> dict[str, Any]:
    if cursor is None or cursor.expiry_boundary_cursor is None:
        return {"resetBoundary": None, "sessionHighWaterMarks": {}}
    return {
        "resetBoundary": {
            "cursor": cursor.expiry_boundary_cursor,
            "barrierAt": (
                _utc(cursor.reset_barrier_at).isoformat()
                if cursor.reset_barrier_at is not None
                else None
            ),
        },
        "sessionHighWaterMarks": cursor.expiry_session_high_waters or {},
    }


def _cursor_expired_error(
    cursor: V2RuntimeObservationConsumerCursor | None,
) -> RuntimeObservationProtocolError:
    return RuntimeObservationProtocolError(
        410,
        "observation_cursor_expired",
        "runtime observation cursor is unknown or expired",
        _cursor_expiry_metadata(cursor),
    )


async def _install_cursor_expiry_boundary(
    db: AsyncSession,
    *,
    fence: V2RuntimeEnvironmentFence,
    cursor: V2RuntimeObservationConsumerCursor,
    expired_at: datetime | None = None,
) -> RuntimeObservationProtocolError:
    """Persist a fail-closed reset boundary in the caller's snapshot.

    The caller holds, or has just reloaded, the consumer row lock. The fence
    high-water and boot heads are read in the same transaction snapshot so the
    returned boundary cannot leave a snapshot-to-stream gap.
    """

    if cursor.state == RUNTIME_OBSERVATION_CURSOR_EXPIRED:
        return _cursor_expired_error(cursor)
    now = _utc(expired_at or datetime.now(UTC))
    heads = list(
        (
            await db.execute(
                select(V2RuntimeObservationHead)
                .where(V2RuntimeObservationHead.environment_id == fence.environment_id)
                .order_by(V2RuntimeObservationHead.boot_session_id)
            )
        )
        .scalars()
        .all()
    )
    position = fence.stream_high_water
    cursor.state = RUNTIME_OBSERVATION_CURSOR_EXPIRED
    cursor.expired_at = now
    cursor.expiry_boundary_stream_position = position
    cursor.expiry_boundary_cursor = encode_runtime_observation_cursor(
        environment_id=fence.environment_id,
        consumer_id=cursor.consumer_id,
        cursor_epoch=cursor.cursor_epoch,
        stream_position=position,
    )
    cursor.expiry_session_high_waters = _session_high_waters(heads)
    cursor.reset_barrier_at = now
    await db.flush()
    return _cursor_expired_error(cursor)


async def _expire_invalid_cursor(
    db: AsyncSession,
    *,
    fence: V2RuntimeEnvironmentFence,
    consumer_id: str,
) -> RuntimeObservationProtocolError:
    """Lock a known consumer and make its invalid cursor explicitly resettable."""

    cursor = (
        await db.execute(
            select(V2RuntimeObservationConsumerCursor)
            .where(
                V2RuntimeObservationConsumerCursor.environment_id == fence.environment_id,
                V2RuntimeObservationConsumerCursor.consumer_id == consumer_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if cursor is None:
        return _cursor_expired_error(None)
    return await _install_cursor_expiry_boundary(db, fence=fence, cursor=cursor)


async def register_runtime_observation_consumer(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    owner_id: uuid.UUID,
    deployment_id: str,
    consumer_id: str,
) -> dict[str, Any]:
    fence = await require_active_runtime_environment_fence(
        db,
        environment_id=environment_id,
        owner_id=owner_id,
        deployment_id=deployment_id,
    )
    cursor = (
        await db.execute(
            select(V2RuntimeObservationConsumerCursor)
            .where(
                V2RuntimeObservationConsumerCursor.environment_id == environment_id,
                V2RuntimeObservationConsumerCursor.consumer_id == consumer_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if cursor is not None:
        if cursor.state != RUNTIME_OBSERVATION_CURSOR_ACTIVE:
            raise _cursor_expired_error(cursor)
        opaque = encode_runtime_observation_cursor(
            environment_id=environment_id,
            consumer_id=consumer_id,
            cursor_epoch=cursor.cursor_epoch,
            stream_position=cursor.acked_stream_position,
        )
        return {
            "environmentId": str(environment_id),
            "deploymentId": fence.deployment_id,
            "consumerId": consumer_id,
            "cursor": opaque,
            "acknowledgedAt": (
                _utc(cursor.acknowledged_at).isoformat()
                if cursor.acknowledged_at is not None
                else None
            ),
        }
    epoch = uuid.uuid4()
    opaque = encode_runtime_observation_cursor(
        environment_id=environment_id,
        consumer_id=consumer_id,
        cursor_epoch=epoch,
        stream_position=0,
    )
    cursor = V2RuntimeObservationConsumerCursor(
        environment_id=environment_id,
        consumer_id=consumer_id,
        deployment_id=fence.deployment_id,
        required=True,
        cursor_epoch=epoch,
        state=RUNTIME_OBSERVATION_CURSOR_ACTIVE,
        acked_cursor=opaque,
        acked_stream_position=0,
        replay_horizon_started_at=datetime.now(UTC),
    )
    db.add(cursor)
    await db.flush()
    return {
        "environmentId": str(environment_id),
        "deploymentId": fence.deployment_id,
        "consumerId": consumer_id,
        "cursor": opaque,
        "acknowledgedAt": None,
    }


def _validate_cursor_for_consumer(
    opaque: str,
    *,
    environment_id: uuid.UUID,
    consumer_id: str,
    cursor: V2RuntimeObservationConsumerCursor,
) -> DecodedRuntimeObservationCursor:
    if cursor.state != RUNTIME_OBSERVATION_CURSOR_ACTIVE:
        raise _cursor_expired_error(cursor)
    try:
        decoded = decode_runtime_observation_cursor(opaque)
    except RuntimeObservationProtocolError as exc:
        if exc.code == "observation_cursor_expired":
            raise _cursor_expired_error(cursor) from exc
        raise
    if (
        decoded.environment_id != environment_id
        or decoded.consumer_id != consumer_id
        or decoded.cursor_epoch != cursor.cursor_epoch
    ):
        raise _cursor_expired_error(cursor)
    boundary = cursor.expiry_boundary_stream_position
    if boundary is not None and decoded.stream_position < boundary:
        raise _cursor_expired_error(cursor)
    return decoded


def _identity_payload(
    *,
    generation: int,
    manifest_etag: str,
    apply_receipt_id: str,
    boot_nonce: str,
    boot_session_id: str,
) -> dict[str, Any]:
    return {
        "generation": generation,
        "manifestETag": manifest_etag,
        "applyReceiptId": apply_receipt_id,
        "bootNonce": boot_nonce,
        "bootSessionId": boot_session_id,
    }


def _evidence_reference(
    *,
    event_id: str,
    environment_id: uuid.UUID,
    consumer_id: str,
    cursor_epoch: uuid.UUID,
    stream_position: int,
) -> dict[str, str]:
    return {
        "eventId": event_id,
        "cursor": encode_runtime_observation_cursor(
            environment_id=environment_id,
            consumer_id=consumer_id,
            cursor_epoch=cursor_epoch,
            stream_position=stream_position,
        ),
    }


async def read_runtime_observations(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    owner_id: uuid.UUID,
    deployment_id: str,
    consumer_id: str,
    expected_apply_identity: RuntimeApplyIdentity,
    after_cursor: str,
    limit: int,
) -> dict[str, Any]:
    """Read one RR snapshot and its committed stream high-water without a gap."""

    fence = await db.get(V2RuntimeEnvironmentFence, environment_id)
    if fence is None or fence.owner_id != owner_id or fence.deployment_id != deployment_id:
        raise RuntimeObservationProtocolError(
            404,
            "runtime_environment_not_found",
            "runtime environment was not found",
        )
    cursor = await db.get(
        V2RuntimeObservationConsumerCursor,
        {"environment_id": environment_id, "consumer_id": consumer_id},
    )
    if cursor is None:
        raise _cursor_expired_error(None)
    try:
        decoded = _validate_cursor_for_consumer(
            after_cursor,
            environment_id=environment_id,
            consumer_id=consumer_id,
            cursor=cursor,
        )
    except RuntimeObservationProtocolError as exc:
        if exc.code != "observation_cursor_expired":
            raise
        raise await _expire_invalid_cursor(
            db,
            fence=fence,
            consumer_id=consumer_id,
        ) from exc
    high_water = fence.stream_high_water
    if decoded.stream_position > high_water:
        raise await _expire_invalid_cursor(
            db,
            fence=fence,
            consumer_id=consumer_id,
        )
    identity_predicates = (
        V2RuntimeObservationInbox.generation == expected_apply_identity.generation,
        V2RuntimeObservationInbox.manifest_etag == expected_apply_identity.manifest_etag,
        V2RuntimeObservationInbox.apply_receipt_id == expected_apply_identity.apply_receipt_id,
        V2RuntimeObservationInbox.boot_nonce == expected_apply_identity.boot_nonce,
    )
    events = list(
        (
            await db.execute(
                select(V2RuntimeObservationInbox)
                .where(
                    V2RuntimeObservationInbox.environment_id == environment_id,
                    V2RuntimeObservationInbox.id > decoded.stream_position,
                    V2RuntimeObservationInbox.id <= high_water,
                    *identity_predicates,
                )
                .order_by(V2RuntimeObservationInbox.id)
                .limit(limit + 1)
            )
        )
        .scalars()
        .all()
    )
    has_more = len(events) > limit
    page = events[:limit]
    next_position = page[-1].id if has_more and page else high_water
    heads = list(
        (
            await db.execute(
                select(V2RuntimeObservationHead)
                .where(
                    V2RuntimeObservationHead.environment_id == environment_id,
                    V2RuntimeObservationHead.generation == expected_apply_identity.generation,
                    V2RuntimeObservationHead.manifest_etag == expected_apply_identity.manifest_etag,
                    V2RuntimeObservationHead.apply_receipt_id
                    == expected_apply_identity.apply_receipt_id,
                    V2RuntimeObservationHead.boot_nonce == expected_apply_identity.boot_nonce,
                )
                .order_by(V2RuntimeObservationHead.boot_session_id)
            )
        )
        .scalars()
        .all()
    )
    event_payloads = [
        {
            "runtimeIdentity": _identity_payload(
                generation=event.generation,
                manifest_etag=event.manifest_etag,
                apply_receipt_id=event.apply_receipt_id,
                boot_nonce=event.boot_nonce,
                boot_session_id=event.boot_session_id,
            ),
            "sequence": event.sequence,
            "capturedAt": _utc(event.captured_at).isoformat(),
            "receivedAt": _utc(event.received_at).isoformat(),
            "freshnessDeadline": _utc(event.freshness_deadline).isoformat(),
            "evidenceReference": _evidence_reference(
                event_id=event.event_id,
                environment_id=environment_id,
                consumer_id=consumer_id,
                cursor_epoch=cursor.cursor_epoch,
                stream_position=event.id,
            ),
            "payloadHash": event.payload_hash,
            "health": event.health,
            "diagnostics": event.diagnostics,
        }
        for event in page
    ]
    head_payloads = [
        {
            "runtimeIdentity": _identity_payload(
                generation=head.generation,
                manifest_etag=head.manifest_etag,
                apply_receipt_id=head.apply_receipt_id,
                boot_nonce=head.boot_nonce,
                boot_session_id=head.boot_session_id,
            ),
            "sequence": head.highest_sequence,
            "capturedAt": (
                _utc(head.captured_at).isoformat() if head.captured_at is not None else None
            ),
            "freshnessDeadline": (
                _utc(head.freshness_deadline).isoformat()
                if head.freshness_deadline is not None
                else None
            ),
            "evidenceReference": _evidence_reference(
                event_id=head.latest_event_id,
                environment_id=environment_id,
                consumer_id=consumer_id,
                cursor_epoch=cursor.cursor_epoch,
                stream_position=head.latest_stream_position,
            ),
            "payloadHash": head.latest_payload_hash,
            "health": head.health,
            "state": head.state,
        }
        for head in heads
    ]
    return {
        "environmentId": str(environment_id),
        "deploymentId": deployment_id,
        "consumerId": consumer_id,
        "expectedApplyIdentity": {
            "generation": expected_apply_identity.generation,
            "manifestETag": expected_apply_identity.manifest_etag,
            "applyReceiptId": expected_apply_identity.apply_receipt_id,
            "bootNonce": expected_apply_identity.boot_nonce,
        },
        "heads": head_payloads,
        "events": event_payloads,
        "streamHighWaterCursor": encode_runtime_observation_cursor(
            environment_id=environment_id,
            consumer_id=consumer_id,
            cursor_epoch=cursor.cursor_epoch,
            stream_position=high_water,
        ),
        "nextCursor": encode_runtime_observation_cursor(
            environment_id=environment_id,
            consumer_id=consumer_id,
            cursor_epoch=cursor.cursor_epoch,
            stream_position=next_position,
        ),
        "hasMore": has_more,
    }


async def acknowledge_runtime_observation_cursor(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    owner_id: uuid.UUID,
    deployment_id: str,
    consumer_id: str,
    opaque_cursor: str,
    acknowledged_at: datetime | None = None,
) -> dict[str, Any]:
    fence = (
        await db.execute(
            select(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if fence is None or fence.owner_id != owner_id or fence.deployment_id != deployment_id:
        raise RuntimeObservationProtocolError(
            404,
            "runtime_environment_not_found",
            "runtime environment was not found",
        )
    cursor = (
        await db.execute(
            select(V2RuntimeObservationConsumerCursor)
            .where(
                V2RuntimeObservationConsumerCursor.environment_id == environment_id,
                V2RuntimeObservationConsumerCursor.consumer_id == consumer_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if cursor is None:
        raise _cursor_expired_error(None)
    try:
        decoded = _validate_cursor_for_consumer(
            opaque_cursor,
            environment_id=environment_id,
            consumer_id=consumer_id,
            cursor=cursor,
        )
    except RuntimeObservationProtocolError as exc:
        if exc.code != "observation_cursor_expired":
            raise
        raise await _install_cursor_expiry_boundary(
            db,
            fence=fence,
            cursor=cursor,
        ) from exc
    high_water = fence.stream_high_water
    if decoded.stream_position > high_water:
        raise await _install_cursor_expiry_boundary(
            db,
            fence=fence,
            cursor=cursor,
        )
    if decoded.stream_position < cursor.acked_stream_position:
        raise RuntimeObservationProtocolError(
            409,
            "runtime_observation_cursor_regression",
            "runtime observation acknowledgement cannot regress",
        )
    now = _utc(acknowledged_at or datetime.now(UTC))
    if decoded.stream_position > cursor.acked_stream_position:
        cursor.acked_stream_position = decoded.stream_position
        cursor.acked_cursor = opaque_cursor
        cursor.acknowledged_at = now
    await db.flush()
    return {
        "environmentId": str(environment_id),
        "deploymentId": deployment_id,
        "consumerId": consumer_id,
        "cursor": cursor.acked_cursor,
        "acknowledgedAt": (
            _utc(cursor.acknowledged_at).isoformat() if cursor.acknowledged_at is not None else None
        ),
    }


async def reset_runtime_observation_consumer(
    db: AsyncSession,
    *,
    environment_id: uuid.UUID,
    owner_id: uuid.UUID,
    deployment_id: str,
    consumer_id: str,
    reset_at: datetime | None = None,
) -> dict[str, Any]:
    fence = (
        await db.execute(
            select(V2RuntimeEnvironmentFence)
            .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if fence is None or fence.owner_id != owner_id or fence.deployment_id != deployment_id:
        raise RuntimeObservationProtocolError(
            404,
            "runtime_environment_not_found",
            "runtime environment was not found",
        )
    cursor = (
        await db.execute(
            select(V2RuntimeObservationConsumerCursor)
            .where(
                V2RuntimeObservationConsumerCursor.environment_id == environment_id,
                V2RuntimeObservationConsumerCursor.consumer_id == consumer_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if (
        cursor is None
        or cursor.state != RUNTIME_OBSERVATION_CURSOR_EXPIRED
        or cursor.expiry_boundary_stream_position is None
    ):
        raise RuntimeObservationProtocolError(
            409,
            "runtime_observation_cursor_reset_not_required",
            "runtime observation consumer has no expired cursor to reset",
        )
    epoch = uuid.uuid4()
    position = cursor.expiry_boundary_stream_position
    opaque = encode_runtime_observation_cursor(
        environment_id=environment_id,
        consumer_id=consumer_id,
        cursor_epoch=epoch,
        stream_position=position,
    )
    now = _utc(reset_at or datetime.now(UTC))
    reset_boundary = _cursor_expiry_metadata(cursor)
    cursor.cursor_epoch = epoch
    cursor.state = RUNTIME_OBSERVATION_CURSOR_ACTIVE
    cursor.acked_stream_position = position
    cursor.acked_cursor = opaque
    cursor.acknowledged_at = now
    cursor.replay_horizon_started_at = now
    cursor.expired_at = None
    cursor.reset_at = now
    await db.flush()
    return {
        "environmentId": str(environment_id),
        "deploymentId": deployment_id,
        "consumerId": consumer_id,
        "cursor": opaque,
        **reset_boundary,
    }


async def expire_runtime_observation_payloads(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    batch_size: int | None = None,
) -> int:
    """Bounded retention cleanup that never silently deletes unacked history."""

    current = _utc(now or datetime.now(UTC))
    replay_cutoff = current - timedelta(days=settings.runtime_observation_replay_horizon_days)
    hard_cutoff = current - timedelta(days=settings.runtime_observation_hard_retention_days)
    limit = batch_size or settings.runtime_observation_cleanup_batch_size
    environment_ids = list(
        (
            await db.execute(
                select(V2RuntimeObservationInbox.environment_id)
                .where(V2RuntimeObservationInbox.received_at < replay_cutoff)
                .distinct()
                .order_by(V2RuntimeObservationInbox.environment_id)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    deleted_count = 0
    for environment_id in environment_ids:
        fence = (
            await db.execute(
                select(V2RuntimeEnvironmentFence)
                .where(V2RuntimeEnvironmentFence.environment_id == environment_id)
                .execution_options(populate_existing=True)
                .with_for_update()
            )
        ).scalar_one()
        consumers = list(
            (
                await db.execute(
                    select(V2RuntimeObservationConsumerCursor)
                    .where(
                        V2RuntimeObservationConsumerCursor.environment_id == environment_id,
                        V2RuntimeObservationConsumerCursor.required.is_(True),
                    )
                    .order_by(V2RuntimeObservationConsumerCursor.consumer_id)
                    .execution_options(populate_existing=True)
                    .with_for_update()
                )
            )
            .scalars()
            .all()
        )
        if not consumers:
            # No durable required-consumer acknowledgement means no safe purge.
            continue
        replay_position = int(
            (
                await db.scalar(
                    select(func.coalesce(func.max(V2RuntimeObservationInbox.id), 0)).where(
                        V2RuntimeObservationInbox.environment_id == environment_id,
                        V2RuntimeObservationInbox.received_at < replay_cutoff,
                    )
                )
            )
            or 0
        )
        safe_position = (
            min(
                consumer.acked_stream_position
                for consumer in consumers
                if consumer.state == RUNTIME_OBSERVATION_CURSOR_ACTIVE
            )
            if all(consumer.state == RUNTIME_OBSERVATION_CURSOR_ACTIVE for consumer in consumers)
            else 0
        )
        purge_through = min(replay_position, safe_position)
        hard_position = int(
            (
                await db.scalar(
                    select(func.coalesce(func.max(V2RuntimeObservationInbox.id), 0)).where(
                        V2RuntimeObservationInbox.environment_id == environment_id,
                        V2RuntimeObservationInbox.received_at < hard_cutoff,
                    )
                )
            )
            or 0
        )
        if hard_position > purge_through:
            heads = list(
                (
                    await db.execute(
                        select(V2RuntimeObservationHead)
                        .where(V2RuntimeObservationHead.environment_id == environment_id)
                        .order_by(V2RuntimeObservationHead.boot_session_id)
                        .execution_options(populate_existing=True)
                    )
                )
                .scalars()
                .all()
            )
            high_waters = _session_high_waters(heads)
            for consumer in consumers:
                if consumer.acked_stream_position >= hard_position:
                    continue
                barrier_cursor = encode_runtime_observation_cursor(
                    environment_id=environment_id,
                    consumer_id=consumer.consumer_id,
                    cursor_epoch=consumer.cursor_epoch,
                    stream_position=hard_position,
                )
                consumer.state = RUNTIME_OBSERVATION_CURSOR_EXPIRED
                consumer.expired_at = current
                consumer.expiry_boundary_stream_position = hard_position
                consumer.expiry_boundary_cursor = barrier_cursor
                consumer.expiry_session_high_waters = high_waters
                consumer.reset_barrier_at = current
            purge_through = hard_position
        if purge_through <= 0:
            continue
        ids = list(
            (
                await db.execute(
                    select(V2RuntimeObservationInbox.id)
                    .where(
                        V2RuntimeObservationInbox.environment_id == environment_id,
                        V2RuntimeObservationInbox.id <= purge_through,
                    )
                    .order_by(V2RuntimeObservationInbox.id)
                    .limit(limit - deleted_count)
                )
            )
            .scalars()
            .all()
        )
        if not ids:
            continue
        result = await db.execute(
            delete(V2RuntimeObservationInbox).where(V2RuntimeObservationInbox.id.in_(ids))
        )
        deleted_count += result.rowcount or 0
        if deleted_count >= limit:
            break
        _ = fence  # The environment lock is intentionally held through deletion.
    await db.flush()
    return deleted_count
