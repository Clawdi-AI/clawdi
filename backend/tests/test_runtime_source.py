from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.channel import (
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBotAgentLink,
    ChannelWhatsAppAuthCert,
)
from app.models.hosted_runtime import (
    HostedRuntimeSecret,
    HostedRuntimeState,
)
from app.models.session import AgentEnvironment
from app.schemas.runtime import HostedCodexProviderProjection
from app.services.channels import channel_runtime_account_key, channel_runtime_placeholder_token
from app.services.managed_ai_provider import (
    CLAWDI_MANAGED_PROVIDER_ID,
    V2_LEGACY_MANAGED_AI_PROVIDER_ID,
    V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
    V2_MANAGED_AI_PROVIDER_ID,
)
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
AUTH_TOKEN_SECRET_ID = UUID("70000000-0000-0000-0000-000000000009")
GATEWAY_TOKEN_SECRET_ID = UUID("70000000-0000-0000-0000-000000000010")


def test_runtime_bundle_v2_etag_is_derived_from_source_revision() -> None:
    source_revision = "a" * 64
    assert expected_runtime_bundle_v2_etag(source_revision) == f'"sha256:{source_revision}"'
    assert expected_runtime_bundle_v2_etag("b" * 64) != expected_runtime_bundle_v2_etag(
        source_revision
    )


def _batch(
    *,
    provider_label: str = "Primary",
    channel_name: str = "Bot",
    token: bytes = b"token",
    generation: int = 2,
    apply_generation: int | None = 1,
) -> RuntimeSourceBatch:
    now = datetime(2026, 7, 13, tzinfo=UTC)
    environment = AgentEnvironment(id=ENV_ID, user_id=USER_ID)
    state = HostedRuntimeState(
        environment_id=ENV_ID,
        deployment_id="dep_test",
        instance_id="hri_test",
        generation=generation,
        apply_generation=apply_generation,
        cli_package_spec="clawdi@1.2.3-test",
        locale={"language": "en", "timezone": "UTC"},
        system={
            "openclawControlUiAllowedOrigins": ["https://agent.example.test"],
            "openclawGatewayAuth": {
                "mode": "token",
                "tokenRef": "secret://runtime/openclaw/gateway-token",
                "deviceAuthRequired": False,
                "activation": {
                    "enabled": True,
                    "capability": "openclaw-native-auth-v1",
                },
            },
        },
        egress_engine={
            "type": "mitmproxy",
            "version": "12.2.3",
            "url": "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
            "sha256": "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
        },
        runtimes={
            "openclaw": {
                "enabled": True,
                "providerMode": "configured",
                "provider_ids": ["managed"],
                "primary_model": {"provider_id": "managed", "model": "gpt-test"},
                "install": {"source": "official"},
                "run": {
                    "args": [
                        "gateway",
                        "run",
                        "--allow-unconfigured",
                        "--port",
                        "18789",
                        "--bind",
                        "lan",
                        "--force",
                    ],
                    "secretEnv": {
                        "OPENCLAW_GATEWAY_TOKEN": "secret://runtime/openclaw/gateway-token"
                    },
                },
                "services": {},
            }
        },
        live_sync={
            "enabled": True,
            "agents": [{"agentType": "openclaw", "environmentId": str(ENV_ID)}],
        },
        recovery={"cacheManifest": True, "allowOfflineBoot": True},
        skills={"entries": {"clawdi": {"enabled": True, "version": 1}}},
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
        type="custom_openai_compatible",
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
        runtime_secrets={
            ENV_ID: (
                HostedRuntimeSecret(
                    id=AUTH_TOKEN_SECRET_ID,
                    environment_id=ENV_ID,
                    secret_ref="secret://clawdi/auth-token",
                    encrypted_value=b"runtime-auth-ciphertext",
                    nonce=b"runtime-auth-nonce",
                    key_version="vault.v1",
                ),
                HostedRuntimeSecret(
                    id=GATEWAY_TOKEN_SECRET_ID,
                    environment_id=ENV_ID,
                    secret_ref="secret://runtime/openclaw/gateway-token",
                    encrypted_value=b"gateway-token-ciphertext",
                    nonce=b"gateway-token-nonce",
                    key_version="vault.v1",
                ),
            )
        },
    )


def _replace_runtime_provider(
    batch: RuntimeSourceBatch,
    *,
    provider_id: str,
    provider_row_id: UUID,
    auth_row_id: UUID,
) -> None:
    state = batch.rows[ENV_ID].state
    assert state is not None
    runtime = dict(state.runtimes["openclaw"])
    runtime["provider_ids"] = [provider_id]
    runtime["primary_model"] = {"provider_id": provider_id, "model": "gpt-test"}
    state.runtimes = {"openclaw": runtime}
    batch.providers[(USER_ID, provider_id)] = AiProvider(
        id=provider_row_id,
        owner_user_id=USER_ID,
        provider_id=provider_id,
        type="openai",
        label="Runtime provider",
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
        provider="discord",
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


def _use_whatsapp_channel(
    batch: RuntimeSourceBatch,
) -> tuple[ChannelAgentCredential, ChannelWhatsAppAuthCert]:
    account, link = batch.channels[ENV_ID][0]
    account.provider = "whatsapp"
    credential = ChannelAgentCredential(
        id=UUID("80000000-0000-0000-0000-000000000011"),
        account_id=account.id,
        bot_agent_link_id=link.id,
        user_id=USER_ID,
        provider="whatsapp",
        identity_pub_key_hash="1" * 64,
        identity_public_key=b"identity-public-key",
        synthetic_jid="15551234567:1@s.whatsapp.net",
        encrypted_credentials=b'{"advSecretKey":"managed-whatsapp"}',
        credential_nonce=b"credential-nonce",
    )
    auth_cert = ChannelWhatsAppAuthCert(
        id=UUID("90000000-0000-0000-0000-000000000012"),
        account_id=account.id,
        user_id=USER_ID,
        root_public_key=b"r" * 32,
        encrypted_root_private_key=b"root-private",
        root_private_key_nonce=b"root-nonce",
        intermediate_public_key=b"i" * 32,
        encrypted_intermediate_private_key=b"intermediate-private",
        intermediate_private_key_nonce=b"intermediate-nonce",
        serial=7,
    )
    batch.channel_credentials[link.id] = credential
    batch.whatsapp_auth_certs[account.id] = auth_cert
    return credential, auth_cert


def _use_managed_provider(
    batch: RuntimeSourceBatch,
    *,
    bound_provider_id: str,
    source_provider_id: str,
) -> str:
    state = batch.rows[ENV_ID].state
    assert state is not None
    state.deployment_id = "42"
    runtime = dict(state.runtimes["openclaw"])
    runtime["provider_ids"] = [bound_provider_id]
    runtime["primary_model"] = {
        "provider_id": bound_provider_id,
        "model": "gpt-test",
    }
    state.runtimes = {"openclaw": runtime}
    state.tools = {
        "codex": {
            "enabled": True,
            "provider_id": bound_provider_id,
            "primary_model": {
                "provider_id": bound_provider_id,
                "model": "gpt-test",
            },
        }
    }

    provider = batch.providers.pop((USER_ID, "managed"))
    provider.provider_id = source_provider_id
    batch.providers[(USER_ID, source_provider_id)] = provider
    auth = batch.auth_payloads.pop((USER_ID, "managed", "default"))
    auth.provider_id = source_provider_id
    batch.auth_payloads[(USER_ID, source_provider_id, "default")] = auth
    return source_provider_id


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
    assert initial.manifest["skills"] == {"entries": {"clawdi": {"enabled": True, "version": 1}}}
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


def test_runtime_source_binds_whatsapp_capability_and_revision_to_link_credential_and_cert(
    monkeypatch,
) -> None:
    from app.services import runtime_source

    batch = _batch()
    credential, auth_cert = _use_whatsapp_channel(batch)
    account, link = batch.channels[ENV_ID][0]
    monkeypatch.setattr(runtime_source, "decrypt", lambda ciphertext, _nonce: ciphertext.decode())

    source = render_runtime_source(
        batch,
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=True,
    )
    account_key = channel_runtime_account_key(account.id)
    agent_ref = f"secret://channels/whatsapp/{account_key}/links/{link.id}/agent-token"
    capability_ref = f"secret://channels/whatsapp/{account_key}/links/{link.id}/egress-capability"
    credential_ref = (
        f"secret://channels/whatsapp/{account_key}/credentials/{credential.id}/creds-json"
    )
    assert source.channel_bindings == [
        {
            "provider": "whatsapp",
            "accountId": str(account.id),
            "accountKey": account_key,
            "linkId": str(link.id),
            "agentTokenSecretRef": agent_ref,
            "placeholderTokenSecretRef": capability_ref,
            "credential": {
                "id": str(credential.id),
                "credsSecretRef": credential_ref,
                "authCert": {
                    "SERIAL": 7,
                    "ISSUER": "clawdi",
                    "PUBLIC_KEY": {
                        "type": "Buffer",
                        "data": "cnJycnJycnJycnJycnJycnJycnJycnJycnJycnJycnI=",
                    },
                },
            },
        }
    ]
    assert source.secret_values[capability_ref] == channel_runtime_placeholder_token(
        "whatsapp", account_key, link_id=link.id
    )
    assert source.secret_values[credential_ref] == credential.encrypted_credentials.decode()

    initial_revision = source.source_revision
    credential.encrypted_credentials = b'{"advSecretKey":"rotated"}'
    credential_rotated = _render(batch)
    credential.encrypted_credentials = b'{"advSecretKey":"managed-whatsapp"}'
    auth_cert.root_public_key = b"s" * 32
    cert_rotated = _render(batch)

    assert credential_rotated.source_revision != initial_revision
    assert cert_rotated.source_revision != initial_revision


def test_runtime_source_delivers_owned_oauth_only_to_selected_runtime(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    state = batch.rows[ENV_ID].state
    assert state is not None
    runtime = dict(state.runtimes["openclaw"])
    runtime["provider_ids"] = ["openai-codex"]
    runtime["primary_model"] = {
        "provider_id": "openai-codex",
        "model": "gpt-test",
    }
    state.runtimes = {"openclaw": runtime}
    provider = AiProvider(
        id=uuid4(),
        owner_user_id=USER_ID,
        provider_id="openai-codex",
        type="openai",
        label="ChatGPT",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        auth_type="agent_profile",
        auth_metadata={"tool": "codex", "profile": "default"},
        managed_by="user",
    )
    payload = AiProviderAuthPayload(
        id=uuid4(),
        owner_user_id=USER_ID,
        provider_id="openai-codex",
        auth_profile="default",
        kind="agent_profile",
        source="managed",
        encrypted_payload=b"oauth-ciphertext",
        nonce=b"oauth-nonce",
        credential_revision="oauth-revision-1",
        consumer_environment_id=ENV_ID,
        consumer_runtime="openclaw",
    )
    batch.providers[(USER_ID, provider.provider_id)] = provider
    batch.auth_payloads[(USER_ID, provider.provider_id, "default")] = payload

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        if ciphertext == b"oauth-ciphertext" and nonce == b"oauth-nonce":
            return '{"kind":"local_agent_profile","files":[]}'
        return "managed-tool-key"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)
    source = render_runtime_source(
        batch,
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=True,
    )

    projected_provider = source.manifest["providers"]["openai-codex"]
    auth = projected_provider["auth"]
    assert auth == {
        "type": "agent_profile",
        "tool": "codex",
        "profile": "default",
        "credentialSecretRef": "secret://provider.openai-codex.oauthProfile",
        "credentialRevision": "oauth-revision-1",
    }
    assert source.secret_values["secret://provider.openai-codex.oauthProfile"] == (
        '{"kind":"local_agent_profile","files":[]}'
    )
    assert "apiKeySecretRef" not in projected_provider
    terminal_provider = source.manifest["terminalTooling"]["codex"]["provider"]
    assert terminal_provider["apiKeySecretRef"] == "secret://tool.codex.apiKey"
    assert "auth" not in terminal_provider


def test_runtime_source_refuses_oauth_owned_by_another_runtime() -> None:
    batch = _batch()
    state = batch.rows[ENV_ID].state
    assert state is not None
    runtime = dict(state.runtimes["openclaw"])
    runtime["provider_ids"] = ["openai-codex"]
    runtime["primary_model"] = {
        "provider_id": "openai-codex",
        "model": "gpt-test",
    }
    state.runtimes = {"openclaw": runtime}
    batch.providers[(USER_ID, "openai-codex")] = AiProvider(
        id=uuid4(),
        owner_user_id=USER_ID,
        provider_id="openai-codex",
        type="openai",
        base_url="https://api.openai.com/v1",
        api_mode="openai_responses",
        auth_type="agent_profile",
        auth_metadata={"tool": "codex", "profile": "default"},
        managed_by="user",
    )
    batch.auth_payloads[(USER_ID, "openai-codex", "default")] = AiProviderAuthPayload(
        id=uuid4(),
        owner_user_id=USER_ID,
        provider_id="openai-codex",
        auth_profile="default",
        kind="agent_profile",
        source="managed",
        encrypted_payload=b"oauth-ciphertext",
        nonce=b"oauth-nonce",
        credential_revision="oauth-revision-1",
        consumer_environment_id=uuid4(),
        consumer_runtime="hermes",
    )

    source = _render(batch)

    projected = source.manifest["providers"]["openai-codex"]
    assert projected["status"] == "error"
    assert projected["error"]["code"] == "provider_oauth_credential_unavailable"
    assert "credentialSecretRef" not in projected["auth"]


def test_runtime_secret_summary_uses_ciphertext_identity_without_decrypt(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()

    def fail_decrypt(_ciphertext: bytes, _nonce: bytes) -> str:
        raise AssertionError("summary rendering must not decrypt runtime secrets")

    monkeypatch.setattr(runtime_source, "decrypt", fail_decrypt)
    initial = _render(batch)
    assert initial.secret_values == {}
    rotated = _batch()
    rotated.runtime_secrets[ENV_ID][0].encrypted_value = b"rotated-runtime-auth-ciphertext"
    assert _render(rotated).source_revision != initial.source_revision


def test_runtime_secret_source_collision_fails_before_decrypt(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    batch.runtime_secrets[ENV_ID][0].secret_ref = "secret://tool.codex.apiKey"
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "unused"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)
    with pytest.raises(
        RuntimeSourceError,
        match=r"Runtime secret reference collision: secret://tool\.codex\.apiKey",
    ):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=True,
        )
    assert decrypt_calls == []


def test_runtime_source_rejects_non_public_provider_without_decrypting_secret(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    provider = batch.providers[(USER_ID, "managed")]
    provider.base_url = "https://provider.home.arpa/v1"

    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "must-not-be-projected"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(RuntimeSourceError, match="public host"):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://api.example.test",
            vault_key_identity="vault-key",
            decrypt_secrets=True,
        )
    assert decrypt_calls == []


def test_runtime_source_never_decrypts_or_projects_channel_provider_token(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    account, _link = batch.channels[ENV_ID][0]
    account.encrypted_provider_token = b"real-provider-token-ciphertext"
    account.provider_token_nonce = b"real-provider-token-nonce"
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "projected-secret"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)
    bundle = render_runtime_bundle(
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=True,
        )
    )

    assert (b"real-provider-token-ciphertext", b"real-provider-token-nonce") not in decrypt_calls
    assert "real-provider-token" not in json.dumps(bundle)


def test_runtime_bundle_omits_legacy_apply_generation_and_tracks_explicit_apply_only_changes() -> (
    None
):
    legacy = render_runtime_source(
        _batch(apply_generation=None),
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=False,
    )
    apply_one = render_runtime_source(
        _batch(apply_generation=1),
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=False,
    )
    apply_three = render_runtime_source(
        _batch(apply_generation=3),
        environment_id=ENV_ID,
        public_api_url="https://cloud.test/",
        vault_key_identity="vault-key-generation-1",
        decrypt_secrets=False,
    )

    legacy_bundle = render_runtime_bundle(legacy)
    assert "applyGeneration" not in legacy_bundle
    assert legacy_bundle["manifest"]["generation"] == 2
    assert apply_one.manifest == apply_three.manifest
    assert apply_one.source_revision != apply_three.source_revision
    assert render_runtime_bundle(apply_one)["applyGeneration"] == 1
    assert render_runtime_bundle(apply_three)["applyGeneration"] == 3


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
    batch.runtime_secrets.clear()
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
    assert source.secret_values == {"secret://tool.codex.apiKey": "sk-codex-tool"}
    assert decrypt_calls == [(b"provider-ciphertext", b"provider-nonce")]
    assert "clawdi://" not in json.dumps(bundle)


def test_codex_tool_projection_pydantic_contract_rejects_openai_chat() -> None:
    with pytest.raises(ValueError):
        HostedCodexProviderProjection.model_validate(
            {
                "kind": "openai-compatible",
                "type": "custom_openai_compatible",
                "baseUrl": "https://provider.test/v1",
                "apiMode": "openai_chat",
                "managed_by": "clawdi",
                "runtimeEnvName": "OPENAI_API_KEY",
                "apiKeySecretRef": "secret://tool.codex.apiKey",
            }
        )


def test_shared_managed_provider_material_has_distinct_codex_wire_mode() -> None:
    source = _render(_batch())

    assert source.manifest["providers"]["managed"]["apiMode"] == "openai_chat"
    codex_provider = source.manifest["terminalTooling"]["codex"]["provider"]
    assert codex_provider == {
        "kind": "openai-compatible",
        "type": "custom_openai_compatible",
        "baseUrl": "https://provider.test/v1",
        "apiMode": "openai_responses",
        "managed_by": "clawdi",
        "runtimeEnvName": "OPENAI_API_KEY",
        "apiKeySecretRef": "secret://tool.codex.apiKey",
    }


@pytest.mark.parametrize(
    ("bound_provider_id", "source_provider_id"),
    [
        (CLAWDI_MANAGED_PROVIDER_ID, "clawdi-v2-deployment-42"),
        (CLAWDI_MANAGED_PROVIDER_ID, V2_MANAGED_AI_PROVIDER_ID),
        (CLAWDI_MANAGED_PROVIDER_ID, V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID),
        (CLAWDI_MANAGED_PROVIDER_ID, V2_LEGACY_MANAGED_AI_PROVIDER_ID),
        (V2_MANAGED_AI_PROVIDER_ID, "clawdi-v2-deployment-42"),
        ("clawdi-v2-deployment-42", "clawdi-v2-deployment-42"),
        (
            V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
            V2_LEGACY_PUBLIC_MANAGED_AI_PROVIDER_ID,
        ),
        (V2_LEGACY_MANAGED_AI_PROVIDER_ID, V2_LEGACY_MANAGED_AI_PROVIDER_ID),
    ],
    ids=[
        "agent-alias-scoped-source",
        "agent-alias-base-source",
        "agent-alias-legacy-public-source",
        "agent-alias-legacy-source",
        "stable-internal",
        "deployment-scoped",
        "legacy-public",
        "legacy-internal",
    ],
)
def test_managed_v2_provider_projects_bare_agent_identity(
    bound_provider_id: str,
    source_provider_id: str,
) -> None:
    batch = _batch()
    persisted_provider_id = _use_managed_provider(
        batch,
        bound_provider_id=bound_provider_id,
        source_provider_id=source_provider_id,
    )

    source = _render(batch)
    manifest = source.manifest

    assert manifest["runtimes"]["openclaw"]["provider_ids"] == [CLAWDI_MANAGED_PROVIDER_ID]
    assert manifest["runtimes"]["openclaw"]["primary_model"] == {
        "provider_id": CLAWDI_MANAGED_PROVIDER_ID,
        "model": "gpt-test",
    }
    assert set(manifest["providers"]) == {CLAWDI_MANAGED_PROVIDER_ID}
    assert manifest["providers"][CLAWDI_MANAGED_PROVIDER_ID]["apiKeySecretRef"] == (
        "secret://tool.codex.apiKey"
    )
    assert manifest["terminalTooling"]["codex"]["provider_id"] == CLAWDI_MANAGED_PROVIDER_ID
    assert manifest["terminalTooling"]["codex"]["primary_model"]["provider_id"] == (
        CLAWDI_MANAGED_PROVIDER_ID
    )
    if persisted_provider_id != CLAWDI_MANAGED_PROVIDER_ID:
        assert persisted_provider_id not in json.dumps(manifest)


def test_bare_managed_alias_prefers_deployment_source_over_fallback_rows() -> None:
    batch = _batch()
    _use_managed_provider(
        batch,
        bound_provider_id=CLAWDI_MANAGED_PROVIDER_ID,
        source_provider_id="clawdi-v2-deployment-42",
    )
    scoped_provider = batch.providers[(USER_ID, "clawdi-v2-deployment-42")]
    scoped_provider.models = [{"id": "scoped-model"}]
    for provider_id, model in [
        (V2_MANAGED_AI_PROVIDER_ID, "base-model"),
        (V2_LEGACY_MANAGED_AI_PROVIDER_ID, "legacy-model"),
    ]:
        batch.providers[(USER_ID, provider_id)] = AiProvider(
            id=uuid4(),
            owner_user_id=USER_ID,
            provider_id=provider_id,
            type=scoped_provider.type,
            label=scoped_provider.label,
            base_url=scoped_provider.base_url,
            api_mode=scoped_provider.api_mode,
            auth_type=scoped_provider.auth_type,
            auth_metadata=scoped_provider.auth_metadata,
            managed_by=scoped_provider.managed_by,
            models=[{"id": model}],
        )

    manifest = _render(batch).manifest

    assert manifest["providers"][CLAWDI_MANAGED_PROVIDER_ID]["models"] == [{"id": "scoped-model"}]


@pytest.mark.parametrize(
    "failure",
    [
        "missing_provider",
        "user_owned",
        "missing_payload",
        "payload_kind",
        "payload_source",
        "provider_auth_type",
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
    elif failure == "provider_auth_type":
        batch.providers[(USER_ID, "managed")].auth_type = "agent_profile"
    else:
        batch.providers[(USER_ID, "managed")].api_mode = "anthropic_messages"

    with pytest.raises(RuntimeSourceError, match="Hosted Codex tool provider"):
        _render(batch)


def test_runtime_source_preserves_runtime_and_codex_tool_provider_ids(monkeypatch) -> None:
    from app.services import runtime_source

    batch = _batch()
    _replace_runtime_provider(
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
    assert source.secret_values["secret://tool.codex.apiKey"] == "provider-ciphertext"
    assert source.secret_values["secret://provider.managed-.apiKey"] == "provider-two-ciphertext"
    assert len(decrypt_calls) == 5


def test_runtime_source_rejects_unknown_runtime_secret_key_version_before_decrypt(
    monkeypatch,
) -> None:
    from app.services import runtime_source

    batch = _batch()
    runtime_secret = batch.runtime_secrets[ENV_ID][0]
    runtime_secret.key_version = "vault.future"
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "must-not-decrypt"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(RuntimeSourceError, match="Hosted runtime secret source is invalid"):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=False,
        )
    assert decrypt_calls == []


def test_runtime_source_rejects_duplicate_normalized_provider_ref_before_decrypt(
    monkeypatch,
) -> None:
    from app.services import runtime_source

    batch = _batch()
    _replace_runtime_provider(
        batch,
        provider_id="managed-",
        provider_row_id=UUID("30000000-0000-0000-0000-000000000013"),
        auth_row_id=UUID("40000000-0000-0000-0000-000000000014"),
    )
    # Collision rejection must remain independent of how provider refs are projected.
    monkeypatch.setattr(
        runtime_source,
        "_provider_secret_ref",
        lambda value: f"secret://provider.{value.rstrip('-')}.apiKey",
    )
    monkeypatch.setattr(
        runtime_source,
        "_CODEX_TOOL_SECRET_REF",
        "secret://provider.managed.apiKey",
    )
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "unused"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(
        RuntimeSourceError,
        match=r"Runtime secret reference collision: secret://provider\.managed\.apiKey",
    ):
        render_runtime_source(
            batch,
            environment_id=ENV_ID,
            public_api_url="https://cloud.test/",
            vault_key_identity="vault-key-generation-1",
            decrypt_secrets=True,
        )
    assert decrypt_calls == []


@pytest.mark.parametrize(
    ("provider", "label"),
    [("telegram", "Telegram"), ("discord", "Discord")],
)
def test_runtime_source_rejects_duplicate_provider_accounts_before_decrypt(
    monkeypatch,
    provider: str,
    label: str,
) -> None:
    from app.services import runtime_source

    batch = _batch()
    account, _link = batch.channels[ENV_ID][0]
    account.provider = provider
    batch.channels[ENV_ID] = (*batch.channels[ENV_ID], *batch.channels[ENV_ID])
    decrypt_calls: list[tuple[bytes, bytes]] = []

    def record_decrypt(ciphertext: bytes, nonce: bytes) -> str:
        decrypt_calls.append((ciphertext, nonce))
        return "unused"

    monkeypatch.setattr(runtime_source, "decrypt", record_decrypt)

    with pytest.raises(
        RuntimeSourceError,
        match=(
            rf"This Agent has multiple active {label} bots\. "
            r"Unlink the extras until only one remains\."
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

    plaintext_by_ciphertext = {
        b"provider-ciphertext": "sk-provider-golden",
        b"runtime-auth-ciphertext": "runtime-auth-token-golden",
        b"gateway-token-ciphertext": "openclaw-gateway-token-golden",
        b"token": "123456789:telegram-agent-golden",
    }
    monkeypatch.setattr(
        runtime_source,
        "decrypt",
        lambda ciphertext, _nonce: plaintext_by_ciphertext[ciphertext],
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
