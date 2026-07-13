from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.channel import ChannelAccount, ChannelBotAgentLink
from app.models.hosted_runtime import HostedRuntimeState
from app.models.session import AgentEnvironment
from app.services.runtime_source import (
    RuntimeSourceBatch,
    RuntimeSourceError,
    RuntimeSourceRow,
    expected_runtime_bundle_v2_etag,
    render_runtime_bundle,
    render_runtime_source,
)

USER_ID = UUID("10000000-0000-0000-0000-000000000001")
ENV_ID = UUID("20000000-0000-0000-0000-000000000002")
PROVIDER_ROW_ID = UUID("30000000-0000-0000-0000-000000000003")
AUTH_ROW_ID = UUID("40000000-0000-0000-0000-000000000004")
ACCOUNT_ID = UUID("50000000-0000-0000-0000-000000000005")
LINK_ID = UUID("60000000-0000-0000-0000-000000000006")


def test_runtime_bundle_v2_etag_is_derived_from_source_revision() -> None:
    source_revision = "a" * 64
    assert expected_runtime_bundle_v2_etag(source_revision) == f'"sha256:{source_revision}"'
    assert expected_runtime_bundle_v2_etag("b" * 64) != expected_runtime_bundle_v2_etag(
        source_revision
    )


def _batch(
    *, provider_label: str = "Primary", channel_name: str = "Bot", token: bytes = b"token"
) -> RuntimeSourceBatch:
    now = datetime(2026, 7, 13, tzinfo=UTC)
    environment = AgentEnvironment(id=ENV_ID, user_id=USER_ID)
    state = HostedRuntimeState(
        environment_id=ENV_ID,
        deployment_id="dep_test",
        instance_id="hri_test",
        generation=7,
        cli_package_spec="clawdi@0.12.10-beta.51",
        locale={"language": "en", "timezone": "UTC"},
        system={
            "user": "clawdi",
            "home": "/home/clawdi",
            "workspace": "/home/clawdi/clawdi",
            "persistentPaths": ["/home/clawdi"],
        },
        runtimes={
            "openclaw": {
                "enabled": True,
                "provider_ids": ["managed"],
                "primary_model": {"provider_id": "managed", "model": "gpt-test"},
                "install": {"source": "official"},
                "run": {"args": ["gateway", "run"]},
                "services": {},
                "paths": {
                    "home": "/home/clawdi",
                    "workspace": "/home/clawdi/clawdi",
                },
            }
        },
        live_sync={
            "enabled": True,
            "agents": [{"agentType": "openclaw", "environmentId": str(ENV_ID)}],
        },
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
    )
    state.created_at = now
    provider = AiProvider(
        id=PROVIDER_ROW_ID,
        owner_user_id=USER_ID,
        provider_id="managed",
        type="openai",
        label=provider_label,
        base_url="https://provider.test/v1",
        api_mode="responses",
        auth_type="api_key",
        auth_metadata={"source": "managed", "profile": "default"},
        managed_by="clawdi",
    )
    auth = AiProviderAuthPayload(
        id=AUTH_ROW_ID,
        owner_user_id=USER_ID,
        provider_id="managed",
        auth_profile="default",
        kind="api_key",
        source="managed",
        encrypted_payload=b"provider-ciphertext",
        nonce=b"provider-nonce",
    )
    account = ChannelAccount(
        id=ACCOUNT_ID,
        user_id=USER_ID,
        provider="telegram",
        name=channel_name,
        status="active",
        visibility="private",
        webhook_secret_hash="hash",
    )
    link = ChannelBotAgentLink(
        id=LINK_ID,
        account_id=ACCOUNT_ID,
        user_id=USER_ID,
        agent_id=ENV_ID,
        status="active",
        encrypted_agent_token=token,
        agent_token_nonce=b"channel-nonce",
    )
    return RuntimeSourceBatch(
        rows={ENV_ID: RuntimeSourceRow(environment, state)},
        providers={(USER_ID, "managed"): provider},
        auth_payloads={(USER_ID, "managed", "default"): auth},
        channels={ENV_ID: ((account, link),)},
    )


def _render(batch: RuntimeSourceBatch):
    return render_runtime_source(
        batch,
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=False,
    )


def test_runtime_source_revision_uses_only_projected_descriptor_and_secret_sources() -> None:
    initial = _render(_batch())
    irrelevant = _render(_batch(provider_label="Renamed", channel_name="Renamed bot"))
    rotated = _render(_batch(token=b"rotated-token"))

    assert initial.source_revision == irrelevant.source_revision
    assert initial.source_revision != rotated.source_revision
    assert initial.secret_values == {}
    assert initial.channel_bindings == [
        {
            "provider": "telegram",
            "accountKey": "clawdi_500000000000",
            "agentTokenSecretRef": ("secret://channels/telegram/clawdi_500000000000/agent-token"),
            "placeholderTokenSecretRef": (
                "secret://channels/telegram/clawdi_500000000000/placeholder-token"
            ),
        }
    ]


def test_runtime_source_rejects_colliding_secret_references_before_decrypt(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    state = batch.rows[ENV_ID].state
    assert state is not None
    runtime = dict(state.runtimes["openclaw"])
    runtime["provider_ids"] = ["managed/a", "managed-a"]
    runtime["primary_model"] = {"provider_id": "managed/a", "model": "gpt-test"}
    state.runtimes = {"openclaw": runtime}

    provider = batch.providers.pop((USER_ID, "managed"))
    provider.provider_id = "managed/a"
    auth = batch.auth_payloads.pop((USER_ID, "managed", "default"))
    auth.provider_id = "managed/a"
    batch.providers[(USER_ID, "managed/a")] = provider
    batch.auth_payloads[(USER_ID, "managed/a", "default")] = auth
    batch.providers[(USER_ID, "managed-a")] = AiProvider(
        id=UUID("30000000-0000-0000-0000-000000000013"),
        owner_user_id=USER_ID,
        provider_id="managed-a",
        type="openai",
        label="Colliding provider",
        base_url="https://provider-two.test/v1",
        api_mode="responses",
        auth_type="api_key",
        auth_metadata={"source": "managed", "profile": "default"},
        managed_by="clawdi",
    )
    batch.auth_payloads[(USER_ID, "managed-a", "default")] = AiProviderAuthPayload(
        id=UUID("40000000-0000-0000-0000-000000000014"),
        owner_user_id=USER_ID,
        provider_id="managed-a",
        auth_profile="default",
        kind="api_key",
        source="managed",
        encrypted_payload=b"provider-two-ciphertext",
        nonce=b"provider-two-nonce",
    )

    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "unused"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(
        RuntimeSourceError,
        match=r"Runtime secret reference collision: provider\.managed-a\.apiKey",
    ):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=True,
        )
    assert decrypt_calls == []


def test_runtime_bundle_matches_shared_golden(monkeypatch) -> None:
    from app.services import runtime_source

    monkeypatch.setattr(
        runtime_source,
        "decrypt",
        lambda ciphertext, _nonce: (
            "sk-provider-golden"
            if ciphertext == b"provider-ciphertext"
            else "123456789:telegram-agent-golden"
        ),
    )
    source = render_runtime_source(
        _batch(),
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=True,
    )
    fixture_path = Path(__file__).parents[2] / "test-fixtures/runtime-bundle-v2.golden.json"
    assert render_runtime_bundle(source) == json.loads(fixture_path.read_text())


def test_legacy_manifest_render_ignores_channel_authority(monkeypatch) -> None:
    from app.services import runtime_source

    monkeypatch.setattr(runtime_source, "decrypt", lambda *_args: "sk-provider-golden")
    batch = _batch(token=b"")
    source = render_runtime_source(
        batch,
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=True,
        include_channel_authority=False,
    )

    assert source.channel_bindings == []
    assert source.secret_values == {"provider.managed.apiKey": "sk-provider-golden"}
