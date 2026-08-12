from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.hosted_runtime import HostedRuntimeState
from app.models.user import User
from app.services.vault_crypto import encrypt

CANONICAL_CODEX_TOOL_PROVIDER_ID = "clawdi-v2-deployment-42"
CANONICAL_CODEX_TOOL_SECRET = "sk-codex-tool"
CANONICAL_CODEX_TOOLS = {
    "codex": {
        "enabled": True,
        "provider_id": CANONICAL_CODEX_TOOL_PROVIDER_ID,
        "primary_model": {
            "provider_id": CANONICAL_CODEX_TOOL_PROVIDER_ID,
            "model": "gpt-5.5",
        },
    }
}


def filebrowser_companion(deployment_id: str, access_revision: str = "a" * 64) -> dict[str, Any]:
    audience = f"clawdi-files:{deployment_id}"
    release = "https://github.com/gtsteffaniak/filebrowser/releases/download/v1.5.0-stable"
    return {
        "filebrowser": {
            "version": "v1.5.0-stable",
            "commit": "79552f8adb27c3e29934c4001660eb98f4aab5d6",
            "listen": "0.0.0.0",
            "port": 9120,
            "baseURL": "/",
            "healthPath": "/health",
            "sourceRoot": "/home/clawdi",
            "assets": {
                "amd64": {
                    "url": f"{release}/linux-amd64-filebrowser",
                    "sha256": "8d51d1718d576d22e73e1f41a5194b451d152ddab0df97697cabe839cf59524e",
                },
                "arm64": {
                    "url": f"{release}/linux-arm64-filebrowser",
                    "sha256": "3e18838ae33750a25da434dc6156a359968bf7935e01bdd884711f47f08ad92f",
                },
            },
            "auth": {
                "method": "jwt",
                "algorithm": "HS256",
                "header": "X-JWT-Assertion",
                "userIdentifier": "sub",
                "groupsClaim": "groups",
                "secret": "s" * 43,
                "audience": audience,
                "subject": f"deployment:{deployment_id}:owner",
                "requiredGroup": f"{audience}:{access_revision}",
                "accessRevision": access_revision,
            },
        }
    }


def canonical_codex_tool_provider_graph(
    user: User,
    *,
    api_key: str = CANONICAL_CODEX_TOOL_SECRET,
) -> tuple[AiProvider, AiProviderAuthPayload]:
    ciphertext, nonce = encrypt(api_key)
    provider = AiProvider(
        owner_user_id=user.id,
        provider_id=CANONICAL_CODEX_TOOL_PROVIDER_ID,
        type="custom_openai_compatible",
        label="Clawdi Managed",
        base_url="https://sub2api.test/v1",
        models=[{"id": "gpt-5.5"}],
        api_mode="openai_chat",
        auth_type="api_key",
        auth_metadata={"source": "managed"},
        managed_by="clawdi",
        runtime_env_name="CLAWDI_AI_API_KEY",
    )
    payload = AiProviderAuthPayload(
        owner_user_id=user.id,
        provider_id=provider.provider_id,
        auth_profile="default",
        kind="api_key",
        source="managed",
        encrypted_payload=ciphertext,
        nonce=nonce,
    )
    return provider, payload


async def ensure_canonical_codex_tool_provider(
    db: AsyncSession,
    user: User,
) -> AiProvider:
    provider = await db.scalar(
        select(AiProvider).where(
            AiProvider.owner_user_id == user.id,
            AiProvider.provider_id == CANONICAL_CODEX_TOOL_PROVIDER_ID,
        )
    )
    if provider is None:
        provider, payload = canonical_codex_tool_provider_graph(user)
        db.add_all([provider, payload])
        await db.flush()
    return provider


def canonical_hosted_runtime_state(**values: Any) -> HostedRuntimeState:
    values.setdefault("tools", CANONICAL_CODEX_TOOLS)
    return HostedRuntimeState(**values)
