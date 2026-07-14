from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.hosted_runtime import HostedRuntimeState
from app.models.user import User
from app.services.vault_crypto import encrypt

CANONICAL_CODEX_TOOL_PROVIDER_ID = "clawdi-managed-v2"
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
        runtime_env_name="CLAWDI_MANAGED_OPENAI_API_KEY",
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
