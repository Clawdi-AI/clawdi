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
from app.schemas.runtime import HostedCodexProviderProjection
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
PREFIX_COLLISION_ACCOUNT_ID = UUID("50000000-0000-ffff-0000-000000000007")
PREFIX_COLLISION_LINK_ID = UUID("60000000-0000-0000-0000-000000000008")


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
        cli_package_spec="clawdi@0.12.10-beta.54",
        locale={"language": "en", "timezone": "UTC"},
        system={
        },
        runtimes={
            "openclaw": {
                "enabled": True,
                "providerMode": "configured",
                "provider_ids": ["managed"],
                "primary_model": {"provider_id": "managed", "model": "gpt-test"},
                "install": {"source": "official"},
                "run": {"args": ["gateway", "run"]},
                "services": {},
            }
        },
        live_sync={
            "enabled": True,
            "agents": [{"agentType": "openclaw", "environmentId": str(ENV_ID)}],
        },
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        tools={
            "codex": {
                "enabled": True,
                "provider_id": "managed",
                "primary_model": {"provider_id": "managed", "model": "gpt-test"},
            }
        },
    )
    state.created_at = now
    provider = AiProvider(
        id=PROVIDER_ROW_ID,
        owner_user_id=USER_ID,
        provider_id="managed",
        type="openai",
        label=provider_label,
        base_url="https://provider.test/v1",
        api_mode="openai_chat",
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


def _add_managed_provider(
    batch: RuntimeSourceBatch,
    *,
    provider_id: str,
    provider_row_id: UUID,
    auth_row_id: UUID,
) -> None:
    state = batch.rows[ENV_ID].state
    assert state is not None
    runtime = dict(state.runtimes["openclaw"])
    runtime["provider_ids"] = [*runtime["provider_ids"], provider_id]
    state.runtimes = {"openclaw": runtime}
    batch.providers[(USER_ID, provider_id)] = AiProvider(
        id=provider_row_id,
        owner_user_id=USER_ID,
        provider_id=provider_id,
        type="openai",
        label="Second provider",
        base_url="https://provider-two.test/v1",
        api_mode="responses",
        auth_type="api_key",
        auth_metadata={"source": "managed", "profile": "default"},
        managed_by="clawdi",
    )
    batch.auth_payloads[(USER_ID, provider_id, "default")] = AiProviderAuthPayload(
        id=auth_row_id,
        owner_user_id=USER_ID,
        provider_id=provider_id,
        auth_profile="default",
        kind="api_key",
        source="managed",
        encrypted_payload=b"provider-two-ciphertext",
        nonce=b"provider-two-nonce",
    )


def _add_prefix_colliding_channel(batch: RuntimeSourceBatch) -> None:
    account = ChannelAccount(
        id=PREFIX_COLLISION_ACCOUNT_ID,
        user_id=USER_ID,
        provider="telegram",
        name="Second bot",
        status="active",
        visibility="private",
        webhook_secret_hash="second-hash",
    )
    link = ChannelBotAgentLink(
        id=PREFIX_COLLISION_LINK_ID,
        account_id=PREFIX_COLLISION_ACCOUNT_ID,
        user_id=USER_ID,
        agent_id=ENV_ID,
        status="active",
        encrypted_agent_token=b"second-channel-token",
        agent_token_nonce=b"second-channel-nonce",
    )
    batch.channels[ENV_ID] = (*batch.channels[ENV_ID], (account, link))


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
            "accountKey": f"clawdi_{ACCOUNT_ID.hex}",
            "agentTokenSecretRef": (
                f"secret://channels/telegram/clawdi_{ACCOUNT_ID.hex}/agent-token"
            ),
            "placeholderTokenSecretRef": (
                f"secret://channels/telegram/clawdi_{ACCOUNT_ID.hex}/placeholder-token"
            ),
        }
    ]


def test_unmanaged_runtime_tool_secret_uses_auth_payload_without_user_vault_refs(
    monkeypatch,
) -> None:
    from app.services import runtime_source

    batch = _batch()
    state = batch.rows[ENV_ID].state
    assert state is not None
    runtime = dict(state.runtimes["openclaw"])
    runtime["providerMode"] = "unmanaged"
    runtime["provider_ids"] = []
    runtime.pop("primary_model")
    state.runtimes = {"openclaw": runtime}
    batch.channels.clear()
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "sk-codex-tool"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)
    source = render_runtime_source(
        batch,
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="platform-key-generation-1",
        decrypt_secrets=True,
    )
    bundle = render_runtime_bundle(source)

    assert source.manifest["providers"] == {}
    assert source.manifest["runtimes"]["openclaw"]["providerMode"] == "unmanaged"
    assert source.manifest["terminalTooling"]["codex"]["provider_id"] == "managed"
    assert source.manifest["terminalTooling"]["codex"]["provider"]["apiMode"] == (
        "openai_responses"
    )
    assert source.secret_values == {"tool.codex.apiKey": "sk-codex-tool"}
    assert decrypt_calls == [(b"provider-ciphertext", b"provider-nonce")]
    assert "clawdi://" not in json.dumps(bundle)


def test_codex_tool_projection_pydantic_contract_rejects_openai_chat() -> None:
    with pytest.raises(ValueError):
        HostedCodexProviderProjection.model_validate(
            {
                "kind": "openai-compatible",
                "baseUrl": "https://provider.test/v1",
                "apiMode": "openai_chat",
                "managed_by": "clawdi",
                "runtimeEnvName": "OPENAI_API_KEY",
                "apiKeySecretRef": "tool.codex.apiKey",
            }
        )


def test_shared_managed_provider_material_has_distinct_codex_wire_mode() -> None:
    source = _render(_batch())

    assert source.manifest["providers"]["managed"]["apiMode"] == "openai_chat"
    assert source.manifest["terminalTooling"]["codex"]["provider"]["apiMode"] == (
        "openai_responses"
    )


@pytest.mark.parametrize(
    "failure",
    [
        "missing_provider",
        "user_owned",
        "missing_payload",
        "payload_kind",
        "payload_source",
        "api_mode",
    ],
)
def test_codex_tool_provider_fails_closed_without_platform_credential(failure: str) -> None:
    batch = _batch()
    if failure == "missing_provider":
        batch.providers.clear()
    elif failure == "user_owned":
        batch.providers[(USER_ID, "managed")].managed_by = "user"
    elif failure == "missing_payload":
        batch.auth_payloads.clear()
    elif failure == "payload_kind":
        batch.auth_payloads[(USER_ID, "managed", "default")].kind = "oauth_profile"
    elif failure == "payload_source":
        batch.auth_payloads[(USER_ID, "managed", "default")].source = "vault"
    else:
        batch.providers[(USER_ID, "managed")].api_mode = "anthropic_messages"

    with pytest.raises(RuntimeSourceError, match="Hosted Codex tool provider"):
        _render(batch)


def test_runtime_source_preserves_distinct_valid_provider_ids(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    _add_managed_provider(
        batch,
        provider_id="managed-",
        provider_row_id=UUID("30000000-0000-0000-0000-000000000013"),
        auth_row_id=UUID("40000000-0000-0000-0000-000000000014"),
    )

    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return ciphertext.decode()

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    source = render_runtime_source(
        batch,
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=True,
    )
    assert source.secret_values["tool.codex.apiKey"] == "provider-ciphertext"
    assert source.secret_values["provider.managed-.apiKey"] == "provider-two-ciphertext"
    assert len(decrypt_calls) == 3


def test_runtime_source_rejects_duplicate_normalized_provider_ref_before_decrypt(
    monkeypatch,
) -> None:
    from app.services import runtime_source

    batch = _batch()
    _add_managed_provider(
        batch,
        provider_id="managed-",
        provider_row_id=UUID("30000000-0000-0000-0000-000000000013"),
        auth_row_id=UUID("40000000-0000-0000-0000-000000000014"),
    )
    # Collision rejection must remain independent of how provider refs are projected.
    monkeypatch.setattr(
        runtime_source,
        "_provider_secret_ref",
        lambda value: f"provider.{value.rstrip('-')}.apiKey",
    )
    monkeypatch.setattr(
        runtime_source,
        "_CODEX_TOOL_SECRET_REF",
        "provider.managed.apiKey",
    )
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "unused"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(
        RuntimeSourceError,
        match=r"Runtime secret reference collision: provider\.managed\.apiKey",
    ):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=True,
        )
    assert decrypt_calls == []


def test_runtime_source_rejects_duplicate_channel_ref_before_decrypt(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    batch.channels[ENV_ID] = (*batch.channels[ENV_ID], *batch.channels[ENV_ID])
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "unused"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(
        RuntimeSourceError,
        match=(
            "Runtime secret reference collision: "
            rf"secret://channels/telegram/clawdi_{ACCOUNT_ID.hex}/agent-token"
        ),
    ):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=True,
        )
    assert decrypt_calls == []


def test_runtime_source_account_keys_use_full_uuid_and_avoid_prefix_collisions() -> None:
    batch = _batch()
    _add_prefix_colliding_channel(batch)

    first = _render(batch)
    second = _render(batch)

    assert first.channel_bindings == second.channel_bindings
    assert [binding["accountKey"] for binding in first.channel_bindings] == [
        f"clawdi_{ACCOUNT_ID.hex}",
        f"clawdi_{PREFIX_COLLISION_ACCOUNT_ID.hex}",
    ]
    assert all(
        len(binding["accountKey"]) == len("clawdi_") + 32
        and binding["accountKey"].removeprefix("clawdi_")
        in {ACCOUNT_ID.hex, PREFIX_COLLISION_ACCOUNT_ID.hex}
        for binding in first.channel_bindings
    )


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
