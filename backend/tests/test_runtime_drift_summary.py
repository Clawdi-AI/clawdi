from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import delete, event, update
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.core.database as database
from app.core.config import settings
from app.main import app
from app.models.hosted_runtime import HostedRuntimeState
from app.models.runtime_observation import V2RuntimeObservationInbox
from app.schemas.runtime_observation import (
    RuntimeDriftObservationHead,
    RuntimeDriftSourceAuthority,
    RuntimeObservationEventV2,
)
from app.services.runtime_observation import (
    ingest_runtime_observation,
    provision_runtime_environment_fence,
    retire_runtime_environment,
)
from app.services.runtime_source_revision import runtime_source_contract_revision
from tests.conftest import create_env_with_project

pytestmark = pytest.mark.committed_db
ENDPOINT = "/v2/runtime/environments/drift-summary:batchRead"
REVISION = "a" * 64
EXPECTED_APPLY_IDENTITY = {
    "generation": 1,
    "manifestETag": f'"sha256:{REVISION}"',
    "applyReceiptId": "apply-receipt-0001",
    "bootNonce": "boot-nonce-000001",
}


def expected_binding(binding):
    return {**binding, "expectedApplyIdentity": EXPECTED_APPLY_IDENTITY}


@pytest_asyncio.fixture
async def summary_client(engine, monkeypatch):
    monkeypatch.setattr(settings, "admin_api_key", "drift-summary-test")
    monkeypatch.setattr(
        database, "control_session_factory", async_sessionmaker(engine, expire_on_commit=False)
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"X-Admin-Key": "drift-summary-test"},
    ) as client:
        yield client


@pytest_asyncio.fixture
async def runtime(db_session, seed_user):
    async def create():
        env = await create_env_with_project(
            db_session,
            user_id=seed_user.id,
            machine_id=str(uuid.uuid4()),
            machine_name="Drift summary",
        )
        deployment_id = f"deployment-{env.id}"
        await provision_runtime_environment_fence(
            db_session,
            environment_id=env.id,
            owner_id=seed_user.id,
            deployment_id=deployment_id,
        )
        db_session.add(
            HostedRuntimeState(
                environment_id=env.id,
                deployment_id=deployment_id,
                instance_id=f"instance-{env.id}",
                generation=1,
                source_revision=REVISION,
                source_revision_contract=runtime_source_contract_revision(),
                cli_package_spec="clawdi@1.2.3",
                locale={},
                system={},
                runtimes={},
                live_sync={},
                recovery={},
            )
        )
        await db_session.commit()
        return {"environmentId": str(env.id), "deploymentId": deployment_id}

    # Permanent protocol rows live until the runner destroys its throwaway database.
    return create


async def observe(
    db,
    binding,
    captured_at,
    *,
    boot="boot-1",
    sequence=1,
    activity=None,
    apply_receipt_id="apply-receipt-0001",
    boot_nonce="boot-nonce-000001",
):
    payload = RuntimeObservationEventV2.model_validate(
        {
            "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
            "reportedAt": captured_at,
            "capturedAt": captured_at,
            "runtimeMode": "hosted",
            "status": "ok",
            "activeCliVersion": "1.2.3",
            "applied": {
                "etag": f'"sha256:{REVISION}"',
                "sourceRevision": REVISION,
                "generation": 1,
                "instanceId": f"instance-{binding['environmentId']}",
                "appliedProviderIds": [],
            },
            "boot": None,
            "cli": None,
            "agentPlugins": {"schemaVersion": 1, "installations": []},
            "applyReceiptId": apply_receipt_id,
            "bootNonce": boot_nonce,
            "bootSessionId": boot,
            "sequence": sequence,
            "eventId": str(uuid.uuid4()),
            "userActivity": activity,
        }
    )
    result = await ingest_runtime_observation(
        db,
        environment_id=uuid.UUID(binding["environmentId"]),
        credential_deployment_id=binding["deploymentId"],
        value=payload,
        received_at=captured_at,
    )
    await db.commit()
    return result


@pytest.mark.parametrize(
    "case",
    ["auth", "empty", "oversize", "uuid", "deployment", "duplicate_env", "duplicate_deployment"],
)
async def test_batch_boundary_and_auth(summary_client, case):
    bindings = [
        {"environmentId": str(uuid.uuid4()), "deploymentId": f"deployment-{i}"} for i in range(101)
    ]
    if case == "empty":
        bindings = []
    elif case != "oversize":
        bindings = bindings[:2]
        if case == "auth":
            summary_client.headers.pop("X-Admin-Key")
        elif case == "uuid":
            bindings[0]["environmentId"] = "invalid"
        elif case == "deployment":
            bindings[0].pop("deploymentId")
        elif case == "duplicate_env":
            bindings[1]["environmentId"] = bindings[0]["environmentId"]
        else:
            bindings[1]["deploymentId"] = bindings[0]["deploymentId"]
    response = await summary_client.post(ENDPOINT, json={"bindings": bindings})
    assert response.status_code == (401 if case == "auth" else 422)


async def test_order_binding_source_and_read_only_batch(
    summary_client, runtime, db_session, seed_user, engine
):
    active = await runtime()
    retired = await runtime()
    await observe(db_session, retired, datetime.now(UTC))
    await retire_runtime_environment(
        db_session,
        environment_id=uuid.UUID(retired["environmentId"]),
        owner_id=seed_user.id,
        expected_deployment_id=retired["deploymentId"],
        retirement_id="retirement-drift-test",
    )
    fence_mismatch = {**await runtime(), "deploymentId": "wrong-deployment"}
    state_mismatch = await runtime()
    missing_source = await runtime()
    await db_session.execute(
        update(HostedRuntimeState)
        .where(HostedRuntimeState.environment_id == uuid.UUID(state_mismatch["environmentId"]))
        .values(deployment_id="wrong-runtime-deployment")
    )
    await db_session.execute(
        delete(HostedRuntimeState).where(
            HostedRuntimeState.environment_id == uuid.UUID(missing_source["environmentId"])
        )
    )
    unavailable = []
    for revision, contract in (
        (None, runtime_source_contract_revision()),
        (REVISION, None),
        (REVISION, "outdated-contract"),
    ):
        binding = await runtime()
        unavailable.append(binding)
        await db_session.execute(
            update(HostedRuntimeState)
            .where(HostedRuntimeState.environment_id == uuid.UUID(binding["environmentId"]))
            .values(source_revision=revision, source_revision_contract=contract)
        )
    await db_session.commit()
    bindings = [retired, fence_mismatch, *unavailable, active, state_mismatch, missing_source]
    bindings.extend(
        {"environmentId": str(uuid.uuid4()), "deploymentId": f"missing-{i}"}
        for i in range(100 - len(bindings))
    )
    statements = []

    def capture(connection, _cursor, statement, _parameters, _context, _executemany):
        assert connection.get_execution_options()["isolation_level"] == "REPEATABLE READ"
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        response = await summary_client.post(ENDPOINT, json={"bindings": bindings})
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [(r["environmentId"], r["deploymentId"]) for r in items] == [
        (b["environmentId"], b["deploymentId"]) for b in bindings
    ]
    assert [(r["binding"], r["sourceAuthority"]["status"]) for r in items] == [
        ("retired", "missing"),
        ("binding_mismatch", "missing"),
        *([("active", "unavailable")] * 3),
        ("active", "present"),
        ("binding_mismatch", "missing"),
        ("active", "missing"),
        *([("missing", "missing")] * 92),
    ]
    authority = items[5]["sourceAuthority"]
    assert authority == {
        "status": "present",
        "instanceId": f"instance-{active['environmentId']}",
        "sourceRevision": REVISION,
        "etag": f'"sha256:{REVISION}"',
    }
    for result in items[2:5]:
        assert result["sourceAuthority"]["instanceId"] == f"instance-{result['environmentId']}"
        assert result["sourceAuthority"]["sourceRevision"] is None
        assert result["sourceAuthority"]["etag"] is None
    for invalid in (
        {"instanceId": None},
        {"sourceRevision": None},
        {"etag": None},
        {"status": "missing"},
        {"status": "unavailable"},
    ):
        with pytest.raises(ValidationError):
            RuntimeDriftSourceAuthority.model_validate({**authority, **invalid})
    assert all(r["observation"] == {"status": "missing", "head": None} for r in items)
    assert len(statements) == 2
    assert all(query.startswith("SELECT ") and "FOR UPDATE" not in query for query in statements)
    assert all("consumer_cursors" not in query for query in statements)


async def test_fresh_expired_ambiguous_heads_and_coalesced_user_activity(
    summary_client, runtime, db_session
):
    now = datetime.now(UTC) - timedelta(seconds=2)
    old = now - timedelta(seconds=settings.runtime_observation_freshness_seconds + 10)
    fresh, expired, ambiguous, selected = (
        await runtime(),
        await runtime(),
        await runtime(),
        await runtime(),
    )
    activity = {
        "schemaVersion": 1,
        "classifierVersion": 1,
        "classification": "known_no_user_input",
        "lastUserInputAt": None,
        "observedAt": old.isoformat(),
        "completeAt": old.isoformat(),
        "enabledRuntimes": ["openclaw"],
        "error": None,
    }
    first = await observe(db_session, fresh, old, activity=activity)
    coalesced = await observe(db_session, fresh, now, sequence=2, activity=activity)
    assert first.stream_position == coalesced.stream_position
    await observe(db_session, expired, old - timedelta(seconds=1), boot="boot-older")
    await observe(db_session, expired, old, boot="boot-expired")
    await db_session.execute(
        update(V2RuntimeObservationInbox)
        .where(V2RuntimeObservationInbox.environment_id == uuid.UUID(expired["environmentId"]))
        .values(diagnostics={}, payload_purged_at=now)
    )
    await db_session.commit()
    await observe(db_session, ambiguous, now, boot="boot-one")
    await observe(db_session, ambiguous, now, boot="boot-two")
    await observe(db_session, selected, old, boot="boot-stale")
    await observe(db_session, selected, now, boot="boot-current")
    await observe(
        db_session,
        selected,
        now,
        boot="boot-other-identity",
        apply_receipt_id="apply-receipt-0002",
        boot_nonce="boot-nonce-000002",
    )
    bindings = [
        expected_binding(ambiguous),
        expected_binding(expired),
        expected_binding(fresh),
        expected_binding(selected),
    ]
    response = await summary_client.post(ENDPOINT, json={"bindings": bindings})
    assert response.status_code == 200, response.text
    observations = [item["observation"] for item in response.json()["items"]]
    assert [item["status"] for item in observations] == [
        "ambiguous",
        "expired",
        "fresh",
        "fresh",
    ]
    assert observations[0] == {"status": "ambiguous", "head": None}
    assert observations[1]["head"]["runtimeIdentity"]["bootSessionId"] == "boot-expired"
    head = observations[2]["head"]
    assert set(head) == {
        "runtimeIdentity",
        "capturedAt",
        "freshnessDeadline",
        "health",
        "diagnostics",
    }
    assert datetime.fromisoformat(head["capturedAt"]) == now
    assert datetime.fromisoformat(head["freshnessDeadline"]) == now + timedelta(
        seconds=settings.runtime_observation_freshness_seconds
    )
    assert head["runtimeIdentity"] == {
        "generation": 1,
        "manifestETag": f'"sha256:{REVISION}"',
        "applyReceiptId": "apply-receipt-0001",
        "bootNonce": "boot-nonce-000001",
        "bootSessionId": "boot-1",
    }
    assert head["health"] == "ok"
    diagnostics = head["diagnostics"]
    assert set(diagnostics) == {"activeCliVersion", "applied", "agentPlugins", "userActivity"}
    assert observations[1]["head"]["diagnostics"] == dict.fromkeys(diagnostics)
    assert diagnostics["activeCliVersion"] == "1.2.3"
    assert diagnostics["agentPlugins"] == {"schemaVersion": 1, "installations": []}
    assert diagnostics["applied"]["sourceRevision"] == REVISION
    assert diagnostics["applied"]["instanceId"] == f"instance-{fresh['environmentId']}"
    assert diagnostics["userActivity"] == {
        **activity,
        "observedAt": old.isoformat().replace("+00:00", "Z"),
        "completeAt": old.isoformat().replace("+00:00", "Z"),
    }
    assert observations[3]["head"]["runtimeIdentity"]["bootSessionId"] == "boot-current"
    legacy = await summary_client.post(ENDPOINT, json={"bindings": [selected]})
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()["items"][0]["observation"] == {
        "status": "ambiguous",
        "head": None,
    }
    for invalid in (
        {"activeCliVersion": 123},
        {"applied": {}},
        {"agentPlugins": {}},
        {"userActivity": {}},
        {"rawPayload": {}},
    ):
        with pytest.raises(ValidationError):
            RuntimeDriftObservationHead.model_validate(
                {**head, "diagnostics": {**diagnostics, **invalid}}
            )
