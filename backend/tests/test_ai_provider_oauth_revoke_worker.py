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
    extract_oauth_token_from_envelope,
)
from app.services.ai_provider_oauth_attempt import purge_expired_oauth_records
from app.services.ai_provider_oauth_lifecycle import (
    OAUTH_TERMINAL_RETENTION,
    terminal_oauth_attempt,
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


def _credential_envelope(*, logical_name: str, content: str) -> str:
    return json.dumps(
        {
            "schemaVersion": 1,
            "kind": "local_agent_profile",
            "tool": "codex",
            "profile": "default",
            "files": [
                {
                    "logicalName": logical_name,
                    "sourcePath": f"/source/.codex/{logical_name}",
                    "targetStrategy": "adapter_default",
                    "content": content,
                    "mode": 0o600,
                    "size": len(content.encode()),
                }
            ],
        }
    )


@pytest.mark.parametrize(
    ("auth_json", "expected_state", "expected_revocable"),
    [
        pytest.param(
            {"tokens": {"access_token": "access", "refresh_token": "refresh"}},
            "revocable",
            ("refresh", "refresh_token"),
            id="legacy-chatgpt-mode",
        ),
        pytest.param(
            {
                "OPENAI_API_KEY": "sk-api-key",
                "tokens": {"access_token": "access", "refresh_token": "refresh"},
            },
            "not_revocable",
            None,
            id="legacy-api-key-mode",
        ),
        pytest.param(
            {
                "auth_mode": "apikey",
                "tokens": {"access_token": "access", "refresh_token": "refresh"},
            },
            "not_revocable",
            None,
            id="explicit-api-key-mode",
        ),
        pytest.param(
            {"auth_mode": "chatgpt", "tokens": {}},
            "corrupt",
            None,
            id="chatgpt-missing-required-token",
        ),
    ],
)
def test_revoke_parser_matches_codex_resolved_auth_mode(
    auth_json: dict,
    expected_state: str,
    expected_revocable: tuple[str, str] | None,
) -> None:
    envelope = _credential_envelope(
        logical_name="auth.json",
        content=json.dumps(auth_json),
    )

    extraction = extract_oauth_token_from_envelope(envelope)

    assert extraction.state == expected_state
    assert extraction.revocable == expected_revocable


def test_revoke_parser_reserves_not_revocable_for_valid_non_chatgpt_envelope() -> None:
    extraction = extract_oauth_token_from_envelope(
        _credential_envelope(
            logical_name="config.toml",
            content='model = "gpt-5"',
        )
    )

    assert extraction.state == "not_revocable"
    assert extraction.revocable is None


@pytest.mark.parametrize(
    "envelope",
    [
        "not-json",
        json.dumps({"files": []}),
        _credential_envelope(
            logical_name="auth.json",
            content="not-json",
        ),
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "local_agent_profile",
                "tool": "codex",
                "profile": "default",
                "files": [
                    {
                        "logicalName": "auth.json",
                        "content": json.dumps(
                            {
                                "auth_mode": "chatgpt",
                                "tokens": {"refresh_token": "refresh"},
                            }
                        ),
                    }
                ],
            }
        ),
    ],
)
def test_revoke_parser_classifies_malformed_envelopes_as_corrupt(envelope: str) -> None:
    assert extract_oauth_token_from_envelope(envelope).state == "corrupt"


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
@pytest.mark.committed_db
async def test_revoke_worker_quarantines_poison_then_processes_next_candidate(
    db_session,
    engine,
    seed_user,
):
    poison = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id="oauth-revoke-poison-first",
        token="poison-token",
    )
    valid = await _enqueue(
        db_session,
        owner_user_id=seed_user.id,
        provider_id="oauth-revoke-valid-second",
        token="valid-token",
    )
    poison_row = await db_session.get(AiProviderOAuthRevokeTombstone, poison.id)
    assert poison_row is not None
    poison_row.encrypted_token = b"corrupt-ciphertext"
    await db_session.commit()

    revoked_tokens: list[str] = []

    async def revoke(claim):
        revoked_tokens.append(claim.token)

    session_factory = async_sessionmaker(engine, expire_on_commit=True)
    worker = AiProviderOAuthRevokeWorker(session_factory, revoke=revoke)

    assert await worker.run_once() == valid.id
    assert revoked_tokens == ["valid-token"]

    async with session_factory() as verification:
        quarantined = await verification.get(AiProviderOAuthRevokeTombstone, poison.id)
        revoked = await verification.get(AiProviderOAuthRevokeTombstone, valid.id)
        assert quarantined is not None
        assert quarantined.status == "quarantined"
        assert quarantined.encrypted_token is None
        assert quarantined.token_nonce is None
        assert quarantined.last_error == "revoke_material_corrupt"
        assert revoked is not None
        assert revoked.status == "revoked"
        assert revoked.encrypted_token is None
        assert revoked.token_nonce is None


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
    terminal_oauth_attempt(
        "failed",
        completed_at=started_at + timedelta(minutes=6),
    ).apply(attempt)
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
    assert attempt.encrypted_flow_payload is None
    assert attempt.flow_payload_nonce is None


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
    owner_id = owner.id
    owner_tombstone = await _enqueue(
        db_session,
        owner_user_id=owner_id,
        provider_id="oauth-revoke-owner-delete",
        token="refresh-owner-delete",
    )
    await db_session.delete(owner)
    await db_session.commit()
    surviving_tombstone = await db_session.get(
        AiProviderOAuthRevokeTombstone,
        owner_tombstone.id,
    )
    assert surviving_tombstone is not None
    assert surviving_tombstone.owner_user_id == owner_id


@pytest.mark.asyncio
@pytest.mark.committed_db
async def test_revoke_worker_processes_tombstone_after_owner_deletion(db_session, engine):
    owner = User(clerk_id=f"oauth-revoke-deleted-owner-{uuid.uuid4().hex}")
    db_session.add(owner)
    await db_session.flush()
    owner_id = owner.id
    tombstone = await _enqueue(
        db_session,
        owner_user_id=owner_id,
        provider_id="oauth-revoke-deleted-owner",
        token="refresh-deleted-owner",
    )
    await db_session.delete(owner)
    await db_session.commit()

    revoked_tokens: list[str] = []

    async def revoke(claim):
        revoked_tokens.append(claim.token)

    session_factory = async_sessionmaker(engine, expire_on_commit=True)
    worker = AiProviderOAuthRevokeWorker(session_factory, revoke=revoke)

    assert await worker.run_once() == tombstone.id
    assert revoked_tokens == ["refresh-deleted-owner"]
    async with session_factory() as verification:
        row = await verification.get(AiProviderOAuthRevokeTombstone, tombstone.id)
        assert row is not None
        assert row.owner_user_id == owner_id
        assert row.status == "revoked"
        assert row.encrypted_token is None
        assert row.token_nonce is None


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


@pytest.mark.asyncio
async def test_oauth_terminal_retention_is_bounded_and_keeps_recent_or_active_rows(
    db_session,
    seed_user,
):
    provider = AiProvider(
        owner_user_id=seed_user.id,
        provider_id="oauth-retention",
        type="openai",
        base_url="https://api.openai.com/v1",
        auth_type="none",
        managed_by="user",
    )
    db_session.add(provider)
    await db_session.flush()
    now = datetime.now(UTC)
    expired_at = now - OAUTH_TERMINAL_RETENTION - timedelta(seconds=1)
    recent_at = now - OAUTH_TERMINAL_RETENTION + timedelta(seconds=1)

    def terminal_attempt(status: str, completed_at: datetime) -> AiProviderOAuthAttempt:
        return AiProviderOAuthAttempt(
            owner_user_id=seed_user.id,
            provider_row_id=provider.id,
            provider_id=provider.provider_id,
            oauth_provider="codex",
            auth_profile="default",
            flow_kind="authorization_code",
            status=status,
            state_sha256=uuid.uuid4().hex + uuid.uuid4().hex,
            encrypted_flow_payload=None,
            flow_payload_nonce=None,
            receipt={} if status == "committed" else None,
            expires_at=now,
            completed_at=completed_at,
        )

    expired_attempts = [
        terminal_attempt("committed", expired_at),
        terminal_attempt("failed", expired_at),
    ]
    recent_attempt = terminal_attempt("failed", recent_at)
    db_session.add_all([*expired_attempts, recent_attempt])

    expired_tombstones = [
        AiProviderOAuthRevokeTombstone(
            owner_user_id=seed_user.id,
            provider_id=f"oauth-retention-{status}",
            oauth_provider="codex",
            token_type="refresh_token",
            token_sha256=uuid.uuid4().hex + uuid.uuid4().hex,
            encrypted_token=None,
            token_nonce=None,
            status=status,
            last_error="revoke_material_corrupt" if status == "quarantined" else None,
            created_at=expired_at,
            updated_at=expired_at,
        )
        for status in ("cancelled", "revoked", "quarantined")
    ]
    recent_tombstone = AiProviderOAuthRevokeTombstone(
        owner_user_id=seed_user.id,
        provider_id="oauth-retention-recent",
        oauth_provider="codex",
        token_type="refresh_token",
        token_sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        encrypted_token=None,
        token_nonce=None,
        status="cancelled",
        created_at=recent_at,
        updated_at=recent_at,
    )
    active_ciphertext, active_nonce = encrypt("active-token")
    active_tombstone = AiProviderOAuthRevokeTombstone(
        owner_user_id=seed_user.id,
        provider_id="oauth-retention-active",
        oauth_provider="codex",
        token_type="refresh_token",
        token_sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        encrypted_token=active_ciphertext,
        token_nonce=active_nonce,
        status="pending",
        next_attempt_at=expired_at,
        created_at=expired_at,
        updated_at=expired_at,
    )
    db_session.add_all([*expired_tombstones, recent_tombstone, active_tombstone])
    await db_session.flush()
    expired_attempt_ids = {attempt.id for attempt in expired_attempts}
    expired_tombstone_ids = {tombstone.id for tombstone in expired_tombstones}

    first = await purge_expired_oauth_records(db_session, now=now, limit=1)
    second = await purge_expired_oauth_records(db_session, now=now, limit=100)
    await db_session.flush()

    assert first.attempts == 1
    assert first.tombstones == 1
    assert second.attempts == 1
    assert second.tombstones == 2
    for attempt_id in expired_attempt_ids:
        assert await db_session.get(AiProviderOAuthAttempt, attempt_id) is None
    for tombstone_id in expired_tombstone_ids:
        assert await db_session.get(AiProviderOAuthRevokeTombstone, tombstone_id) is None
    assert await db_session.get(AiProviderOAuthAttempt, recent_attempt.id) is not None
    assert await db_session.get(AiProviderOAuthRevokeTombstone, recent_tombstone.id) is not None
    assert await db_session.get(AiProviderOAuthRevokeTombstone, active_tombstone.id) is not None
