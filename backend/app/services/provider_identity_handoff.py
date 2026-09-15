"""A resumable owner-authorized journal handoff, committed only after all native owners agree."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AiProvider
from app.schemas.provider_environment_repair import (
    NativeIdentityProof,
    ProviderIdentityHandoffComplete,
    ProviderIdentityHandoffReceipt,
    ProviderIdentityHandoffRequest,
)
from app.services.ai_provider_capabilities import effective_provider_api_mode
from app.services.platform_contract import platform_request_hash
from app.services.provider_environment_repair import (
    _provider,
    _revision,
    environment_repair_inventory,
)
from app.services.sync_events import queue_runtime_manifests_changed


def identity_boundary(revision: str, proofs: list[NativeIdentityProof]) -> str:
    return platform_request_hash(
        {
            "revision": revision,
            "proofs": [
                proof.model_dump(mode="json", by_alias=True)
                for proof in sorted(proofs, key=lambda item: str(item.binding.environment_id))
            ],
        }
    )


def require_fresh(observed_at: datetime) -> None:
    now = datetime.now(UTC)
    if not now - timedelta(minutes=5) <= observed_at <= now:
        raise HTTPException(409, "Native identity attestation expired")


async def prepare_identity_handoff(
    db: AsyncSession, *, owner_id: UUID, body: ProviderIdentityHandoffRequest
) -> ProviderIdentityHandoffReceipt:
    provider, _ = await _provider(db, owner_id, body.provider_id)
    if provider.identity_handoff_pending:
        pending = ProviderIdentityHandoffReceipt.model_validate(provider.identity_handoff)
        if (
            body.supersedes_handoff_id != pending.handoff_id
            or body.operator_ref != pending.intent.operator_ref
            or body.operator_fingerprint != pending.intent.operator_fingerprint
        ):
            raise HTTPException(409, "Explicitly supersede the existing operator handoff intent")
    elif body.supersedes_handoff_id is not None:
        raise HTTPException(412, "The expected pending handoff no longer exists")
    inventory = await environment_repair_inventory(
        db, owner_id=owner_id, provider_id=body.provider_id
    )
    require_fresh(body.observed_at)
    if (
        inventory.provider_uuid != body.expected_provider_uuid
        or inventory.incarnation_id != body.expected_incarnation_id
        or inventory.revision != body.expected_revision
        or inventory.runtime_env_name != body.expected_env_name
        or identity_boundary(inventory.revision, body.proofs) != body.expected_boundary
        or [p.binding for p in sorted(body.proofs, key=lambda p: str(p.binding.environment_id))]
        != inventory.bindings
    ):
        raise HTTPException(412, "Provider identity or consumer boundary changed")
    owned = [p for p in body.proofs if p.native_env_name is not None]
    if not owned:
        raise HTTPException(409, "No native credential owner can attest this handoff")
    for proof in body.proofs:
        if proof.native_env_name is None:
            if body.provider_id in proof.binding.provider_ids or (
                proof.native_state != "stopped"
                and proof.applied_push_generation != proof.binding.push_generation
            ):
                raise HTTPException(409, "Unbound consumer checkpoint is incomplete")
            continue
        if (
            proof.native_state != "running"
            or proof.native_env_name != body.native_env_name
            or not proof.config_sha256
            or not proof.journal_sha256
            or not proof.native_env_sha256
            or proof.native_base_url is None
            or proof.native_base_url.rstrip("/") != provider.base_url.rstrip("/")
            or proof.native_api_mode
            != effective_provider_api_mode(provider.type, provider.api_mode)
            or (
                proof.journal_provider_uuid is not None
                and proof.journal_provider_uuid != provider.id
            )
            or (
                proof.journal_incarnation_id is not None
                and proof.journal_incarnation_id != provider.incarnation_id
            )
        ):
            raise HTTPException(
                409,
                "Native owners must be running with matching provider identity and routing",
            )
    await require_available_environment(db, provider, body.native_env_name)
    # Reserve this provider until all local CAS acknowledgements arrive. Ordinary auth,
    # metadata and archive paths reject this state; no credential or native file changes here.
    receipt = ProviderIdentityHandoffReceipt(
        handoff_id=uuid4(),
        provider_id=provider.provider_id,
        provider_uuid=provider.id,
        incarnation_id=provider.incarnation_id,
        state="prepared",
        native_env_name=body.native_env_name,
        prepared_revision=inventory.revision,
        intent=body,
    )
    provider.identity_enabled = True
    provider.identity_handoff = receipt.model_dump(mode="json")
    await db.flush()
    await db.refresh(provider, attribute_names=["updated_at"])
    receipt.prepared_revision = await _revision(db, provider)
    provider.identity_handoff = receipt.model_dump(mode="json")
    await queue_runtime_manifests_changed(
        db, [(owner_id, proof.binding.environment_id) for proof in receipt.intent.proofs]
    )
    return receipt


async def complete_identity_handoff(
    db: AsyncSession, *, owner_id: UUID, provider_id: str, body: ProviderIdentityHandoffComplete
) -> ProviderIdentityHandoffReceipt:
    provider, _ = await _provider(db, owner_id, provider_id)
    if not provider.identity_handoff_pending:
        raise HTTPException(409, "No pending provider identity handoff")
    receipt = ProviderIdentityHandoffReceipt.model_validate(provider.identity_handoff)
    inventory = await environment_repair_inventory(db, owner_id=owner_id, provider_id=provider_id)
    require_fresh(body.observed_at)
    if (
        body.handoff_id != receipt.handoff_id
        or provider.id != receipt.provider_uuid
        or provider.incarnation_id != receipt.incarnation_id
        or inventory.revision != receipt.prepared_revision
        or [p.binding for p in sorted(body.proofs, key=lambda p: str(p.binding.environment_id))]
        != inventory.bindings
    ):
        raise HTTPException(412, "Prepared provider identity or consumers changed")
    before = {p.binding.environment_id: p for p in receipt.intent.proofs}
    for proof in body.proofs:
        previous = before.get(proof.binding.environment_id)
        if (
            previous is None
            or proof.binding != previous.binding
            or proof.incus_instance_uuid != previous.incus_instance_uuid
            or proof.hosted_spec_revision != previous.hosted_spec_revision
        ):
            raise HTTPException(412, "Native consumer authority changed")
        if previous.native_env_name is None:
            if proof != previous:
                raise HTTPException(412, "Unbound consumer changed")
        elif (
            proof.native_env_name != receipt.native_env_name
            or proof.journal_env_name != receipt.native_env_name
            or proof.config_sha256 != previous.config_sha256
            or proof.native_env_sha256 != previous.native_env_sha256
            or proof.journal_provider_uuid != receipt.provider_uuid
            or proof.journal_incarnation_id != receipt.incarnation_id
            or proof.handoff_id != receipt.handoff_id
            or not proof.journal_sha256
        ):
            raise HTTPException(412, "A native owner has not acknowledged the exact handoff")
    # Metadata commits only after every root journal acknowledges the same durable intent.
    # Normal convergence remains blocked by the pending manifest until this transaction commits.
    await require_available_environment(db, provider, receipt.native_env_name)
    provider.runtime_env_name = receipt.native_env_name
    receipt.state = "completed"
    provider.identity_handoff = receipt.model_dump(mode="json")
    await queue_runtime_manifests_changed(
        db, [(owner_id, proof.binding.environment_id) for proof in receipt.intent.proofs]
    )
    return receipt


async def require_available_environment(
    db: AsyncSession, provider: AiProvider, environment: str
) -> None:
    conflict = await db.scalar(
        select(AiProvider.id)
        .where(
            AiProvider.owner_user_id == provider.owner_user_id,
            AiProvider.id != provider.id,
            AiProvider.archived_at.is_(None),
            AiProvider.configuration_mode != "native",
            (AiProvider.runtime_env_name == environment)
            | (AiProvider.auth_ref == f"env:{environment}")
            | (AiProvider.identity_handoff["native_env_name"].astext == environment),
        )
        .limit(1)
    )
    if conflict is not None:
        raise HTTPException(409, "Credential environment is reserved by another provider")
