from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.ai_provider import (
    AiProvider,
    AiProviderOAuthAttempt,
    AiProviderOAuthRevokeTombstone,
)
from app.models.user import User
from app.services.ai_provider_auth_transition import (
    cancel_oauth_revoke_tombstone,
    enqueue_oauth_revoke_tombstone,
    revocable_oauth_token_from_envelope,
)
from app.services.ai_provider_oauth_revoke_worker import (
    AiProviderOAuthRevokeWorker,
    ClaimedOAuthRevoke,
    OAuthRevokeAdapterError,
    claim_oauth_revoke_tombstone,
    record_oauth_revoke_result,
    revoke_oauth_token,
)
from app.services.codex_oauth import CODEX_OAUTH_CLIENT_ID
from app.services.vault_crypto import encrypt


@pytest.mark.parametrize(
    ("auth_json", "expected"),
    [
        pytest.param(
            {"tokens": {"access_token": "access", "refresh_token": "refresh"}},
            ("refresh", "refresh_token"),
            id="legacy-chatgpt-mode",
        ),
        pytest.param(
            {
                "OPENAI_API_KEY": "sk-api-key",
                "tokens": {"access_token": "access", "refresh_token": "refresh"},
            },
            None,
            id="legacy-api-key-mode",
        ),
        pytest.param(
            {
                "auth_mode": "apikey",
                "tokens": {"access_token": "access", "refresh_token": "refresh"},
            },
            None,
            id="explicit-api-key-mode",
        ),
    ],
)
def test_revoke_parser_matches_codex_resolved_auth_mode(auth_json: dict, expected) -> None:
    envelope = json.dumps(
        {
            "files": [
                {
                    "logicalName": "auth.json",
                    "content": json.dumps(auth_json),
                }
            ]
        }
    )

    assert revocable_oauth_token_from_envelope(envelope) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("token_type", "expected_client_id"),
    [
        pytest.param("refresh_token", CODEX_OAUTH_CLIENT_ID, id="refresh-token"),
        pytest.param("access_token", None, id="access-token"),
    ],
)
async def test_revoke_adapter_matches_codex_json_wire_contract(
    token_type: str,
    expected_client_id: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, str]]] = []

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url: str, *, json: dict[str, str]):
            requests.append((url, json))
            return FakeResponse()

    monkeypatch.setattr(
        "app.services.ai_provider_oauth_revoke_worker.httpx.AsyncClient",
        FakeClient,
    )
    claim = ClaimedOAuthRevoke(
        tombstone_id=uuid.uuid4(),
        claim_id="wire-contract-claim",
        oauth_provider="codex",
        token_type=token_type,
        token="wire-contract-token",
        attempt_count=1,
    )

    await revoke_oauth_token(claim)

    payload = {
        "token": "wire-contract-token",
        "token_type_hint": token_type,
    }
    if expected_client_id is not None:
        payload["client_id"] = expected_client_id
    assert requests == [("https://auth.openai.com/oauth/revoke", payload)]


async def _enqueue(
    db,
    *,
    owner_user_id,
    provider_id: str,
    token: str,
    oauth_attempt_id=None,
):
    tombstone = await enqueue_oauth_revoke_tombstone(
        db,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
        oauth_provider="codex",
        revocable=(token, "refresh_token"),
        oauth_attempt_id=oauth_attempt_id,
    )
    assert tombstone is not None
    await db.commit()
    return tombstone


async def _exchanging_attempt(db, *, owner_user_id, provider: AiProvider, started_at: datetime):
    encrypted, nonce = encrypt("{}")
    attempt = AiProviderOAuthAttempt(
        owner_user_id=owner_user_id,
        provider_row_id=provider.id,
        provider_id=provider.provider_id,
        oauth_provider="codex",
        auth_profile="default",
        flow_kind="authorization_code",
        status="exchanging",
        state_sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        encrypted_flow_payload=encrypted,
        flow_payload_nonce=nonce,
        expires_at=started_at + timedelta(hours=1),
        exchange_started_at=started_at,
    )
    db.add(attempt)
    await db.flush()
    return attempt


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_revoke_worker_commits_claim_before_network_and_clears_terminal_material(
    db_session,
    engine,
    seed_user,
):
    token = "refresh-secret-claim-before-network"
    tombstone = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id="oauth-revoke-claim",
        token=token,
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=True)
    observed_processing = False

    async def revoke(claim):
        nonlocal observed_processing
        assert claim.token == token
        async with session_factory() as verification:
            row = await verification.get(AiProviderOAuthRevokeTombstone, tombstone.id)
            assert row is not None
            assert row.status == "processing"
            assert row.claim_id == claim.claim_id
            # A NOWAIT lock succeeds only because the claim transaction committed
            # before this network adapter was entered.
            locked = await verification.scalar(
                select(AiProviderOAuthRevokeTombstone.id)
                .where(AiProviderOAuthRevokeTombstone.id == tombstone.id)
                .with_for_update(nowait=True)
            )
            assert locked == tombstone.id
            await verification.rollback()
        observed_processing = True

    worker = AiProviderOAuthRevokeWorker(session_factory, revoke=revoke)
    assert await worker.run_once() == tombstone.id
    assert observed_processing

    async with session_factory() as verification:
        row = await verification.get(AiProviderOAuthRevokeTombstone, tombstone.id)
        assert row is not None
        assert row.status == "revoked"
        assert row.encrypted_token is None
        assert row.token_nonce is None
        assert row.claim_id is None


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_revoke_worker_failure_is_durable_and_token_free(
    db_session,
    engine,
    seed_user,
    caplog,
):
    token = "refresh-secret-never-log-or-store-plain"
    tombstone = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id="oauth-revoke-retry",
        token=token,
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=True)

    async def fail(_claim):
        raise OAuthRevokeAdapterError("oauth_revoke_http_503")

    worker = AiProviderOAuthRevokeWorker(session_factory, revoke=fail)
    assert await worker.run_once() == tombstone.id

    async with session_factory() as verification:
        row = await verification.get(AiProviderOAuthRevokeTombstone, tombstone.id)
        assert row is not None
        assert row.status == "pending"
        assert row.attempt_count == 1
        assert row.next_attempt_at is not None
        assert row.encrypted_token is not None
        assert row.token_nonce is not None
        assert token.encode() not in row.encrypted_token
        assert row.last_error == "oauth_revoke_http_503"
        assert token not in repr(row.__dict__)
    assert token not in caplog.text


@pytest.mark.asyncio
async def test_stale_processing_claim_recovers_and_old_result_loses_cas(db_session, seed_user):
    tombstone = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id="oauth-revoke-stale-claim",
        token="refresh-stale-claim",
    )
    first_time = datetime.now(UTC)
    first = await claim_oauth_revoke_tombstone(db_session, now=first_time)
    assert first is not None
    await db_session.commit()

    second = await claim_oauth_revoke_tombstone(
        db_session,
        now=first_time + timedelta(seconds=61),
    )
    assert second is not None
    assert second.tombstone_id == tombstone.id
    assert second.claim_id != first.claim_id
    await db_session.commit()

    assert not await record_oauth_revoke_result(
        db_session,
        claim=first,
        revoked=True,
        now=first_time + timedelta(seconds=62),
    )
    await db_session.commit()
    row = await db_session.get(AiProviderOAuthRevokeTombstone, tombstone.id)
    assert row is not None
    assert row.status == "processing"
    assert row.claim_id == second.claim_id
    assert row.encrypted_token is not None

    assert await record_oauth_revoke_result(
        db_session,
        claim=second,
        revoked=True,
        now=first_time + timedelta(seconds=63),
    )
    await db_session.commit()
    await db_session.refresh(row)
    assert row.status == "revoked"
    assert row.encrypted_token is None
    assert row.token_nonce is None


@pytest.mark.asyncio
async def test_compensation_waits_for_attempt_failure_not_elapsed_grace(db_session, seed_user):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="oauth-compensation-active-attempt",
        type="openai",
        base_url="https://api.openai.com/v1",
        auth_type="agent_profile",
        auth_metadata={"tool": "codex", "profile": "default"},
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.flush()
    started_at = datetime.now(UTC)
    attempt = await _exchanging_attempt(
        db_session,
        owner_user_id=seed_user.id,
        provider=provider,
        started_at=started_at,
    )
    tombstone = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id=provider.provider_id,
        token="refresh-active-exchange",
        oauth_attempt_id=attempt.id,
    )
    attempt_id = attempt.id

    # Passing the former five-minute grace cannot make an actively exchanging
    # attempt's compensation eligible.
    assert (
        await claim_oauth_revoke_tombstone(
            db_session,
            now=started_at + timedelta(minutes=6),
        )
        is None
    )
    await db_session.rollback()

    attempt = await db_session.get(AiProviderOAuthAttempt, attempt_id)
    assert attempt is not None
    attempt.status = "failed"
    attempt.completed_at = started_at + timedelta(minutes=6)
    await db_session.commit()
    claim = await claim_oauth_revoke_tombstone(
        db_session,
        now=started_at + timedelta(minutes=6, seconds=1),
    )
    assert claim is not None
    assert claim.tombstone_id == tombstone.id


@pytest.mark.asyncio
async def test_compensation_for_stale_exchanging_attempt_becomes_eligible(db_session, seed_user):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="oauth-compensation-stale-attempt",
        type="openai",
        base_url="https://api.openai.com/v1",
        auth_type="agent_profile",
        auth_metadata={"tool": "codex", "profile": "default"},
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.flush()
    now = datetime.now(UTC)
    attempt = await _exchanging_attempt(
        db_session,
        owner_user_id=seed_user.id,
        provider=provider,
        started_at=now - timedelta(minutes=31),
    )
    tombstone = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id=provider.provider_id,
        token="refresh-stale-exchange",
        oauth_attempt_id=attempt.id,
    )

    claim = await claim_oauth_revoke_tombstone(
        db_session,
        now=now + timedelta(seconds=1),
    )
    assert claim is not None
    assert claim.tombstone_id == tombstone.id
    await db_session.commit()
    await db_session.refresh(attempt)
    assert attempt.status == "failed"
    assert attempt.completed_at == now + timedelta(seconds=1)


@pytest.mark.asyncio
async def test_revoke_tombstone_provider_and_owner_fk_contract(db_session, seed_user):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="oauth-revoke-provider-delete",
        type="openai",
        base_url="https://api.openai.com/v1",
        auth_type="agent_profile",
        auth_metadata={"tool": "codex", "profile": "default"},
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.flush()
    tombstone = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id=provider.provider_id,
        token="refresh-survives-provider-delete",
        oauth_attempt_id=(
            await _exchanging_attempt(
                db_session,
                owner_user_id=seed_user.id,
                provider=provider,
                started_at=datetime.now(UTC),
            )
        ).id,
    )

    await db_session.execute(delete(AiProvider).where(AiProvider.id == provider.id))
    await db_session.commit()
    assert await db_session.get(AiProviderOAuthRevokeTombstone, tombstone.id) is not None

    owner = User(clerk_id=f"oauth-revoke-owner-{uuid.uuid4().hex}")
    db_session.add(owner)
    await db_session.flush()
    owner_tombstone = await _enqueue(
        db_session,
        owner_user_id=owner.id,
        provider_id="oauth-revoke-owner-delete",
        token="refresh-owner-delete",
    )
    await db_session.delete(owner)
    await db_session.commit()
    # Owner deletion is the intentional lifecycle boundary for encrypted
    # compensation material; provider archive/physical deletion is not.
    assert await db_session.get(AiProviderOAuthRevokeTombstone, owner_tombstone.id) is None


@pytest.mark.asyncio
async def test_revoke_tombstone_db_shape_requires_only_active_material(db_session, seed_user):
    encrypted = b"ciphertext"
    nonce = b"nonce"
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                AiProviderOAuthRevokeTombstone(
                    owner_user_id=seed_user.id,
                    provider_id="invalid-pending-revoke",
                    oauth_provider="codex",
                    token_type="refresh_token",
                    token_sha256="a" * 64,
                    status="pending",
                    encrypted_token=None,
                    token_nonce=None,
                )
            )
            await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                AiProviderOAuthRevokeTombstone(
                    owner_user_id=seed_user.id,
                    provider_id="invalid-terminal-revoke",
                    oauth_provider="codex",
                    token_type="refresh_token",
                    token_sha256="b" * 64,
                    status="revoked",
                    encrypted_token=encrypted,
                    token_nonce=nonce,
                )
            )
            await db_session.flush()


@pytest.mark.asyncio
async def test_same_token_delete_tombstone_cannot_be_adopted_by_reconnect(
    db_session,
    seed_user,
):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="oauth-same-token-reconnect",
        type="openai",
        base_url="https://api.openai.com/v1",
        auth_type="agent_profile",
        auth_metadata={"tool": "codex", "profile": "default"},
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.flush()
    attempt = await _exchanging_attempt(
        db_session,
        owner_user_id=seed_user.id,
        provider=provider,
        started_at=datetime.now(UTC),
    )
    owner_user_id = seed_user.id
    provider_id = provider.provider_id
    attempt_id = attempt.id
    deletion = await _enqueue(
        db_session,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
        token="same-refresh-token",
    )

    compensation = await enqueue_oauth_revoke_tombstone(
        db_session,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
        oauth_provider="codex",
        revocable=("same-refresh-token", "refresh_token"),
        oauth_attempt_id=attempt_id,
    )
    assert compensation is not None
    assert compensation.id == deletion.id
    await db_session.commit()
    row = await db_session.get(AiProviderOAuthRevokeTombstone, deletion.id)
    assert row is not None
    assert row.status == "pending"
    assert row.oauth_attempt_id is None
    assert not await cancel_oauth_revoke_tombstone(
        db_session,
        row.id,
        oauth_attempt_id=attempt_id,
    )
    await db_session.rollback()

    claim = await claim_oauth_revoke_tombstone(
        db_session,
        now=datetime.now(UTC) + timedelta(seconds=1),
    )
    assert claim is not None
    await db_session.commit()
    duplicate = await enqueue_oauth_revoke_tombstone(
        db_session,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
        oauth_provider="codex",
        revocable=("same-refresh-token", "refresh_token"),
        oauth_attempt_id=attempt_id,
    )
    assert duplicate is not None
    assert duplicate.id == deletion.id
    await db_session.commit()
    await db_session.refresh(row)
    assert row.status == "processing"
    assert row.oauth_attempt_id is None
    assert not await cancel_oauth_revoke_tombstone(
        db_session,
        row.id,
        oauth_attempt_id=attempt_id,
    )
    await db_session.rollback()

    assert await record_oauth_revoke_result(
        db_session,
        claim=claim,
        revoked=True,
    )
    await db_session.commit()
    duplicate = await enqueue_oauth_revoke_tombstone(
        db_session,
        owner_user_id=owner_user_id,
        provider_id=provider_id,
        oauth_provider="codex",
        revocable=("same-refresh-token", "refresh_token"),
        oauth_attempt_id=attempt_id,
    )
    assert duplicate is not None
    assert duplicate.id == deletion.id
    await db_session.commit()
    await db_session.refresh(row)
    assert row.status == "revoked"
    assert row.oauth_attempt_id is None
    assert row.encrypted_token is None
    assert row.token_nonce is None
    assert not await cancel_oauth_revoke_tombstone(
        db_session,
        row.id,
        oauth_attempt_id=attempt_id,
    )
