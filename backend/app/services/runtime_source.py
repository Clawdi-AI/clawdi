from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, TypeGuard
from urllib.parse import quote
from uuid import UUID

from pydantic import JsonValue, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models.agent_project_binding import AgentProjectBinding
from app.models.ai_provider import AiProvider, AiProviderAuthPayload
from app.models.channel import (
    BOT_AGENT_LINK_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_PROVIDER_TELEGRAM,
    CHANNEL_PROVIDER_WHATSAPP,
    CHANNEL_STATUS_ACTIVE,
    ChannelAccount,
    ChannelAgentCredential,
    ChannelBotAgentLink,
    ChannelWhatsAppAuthCert,
)
from app.models.hosted_runtime import (
    HostedRuntimeConfigObservation,
    HostedRuntimeSecret,
    HostedRuntimeState,
)
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_CLOUD, Skill
from app.schemas.ai_provider import AiProviderModel
from app.schemas.runtime import (
    HostedAgentPluginInstallation,
    HostedAgentPlugins,
    HostedCodexProviderProjection,
    HostedEgressEngine,
    HostedEgressProfiles,
    HostedRuntimeCompanions,
    HostedRuntimeLiveSync,
    HostedRuntimeLocale,
    HostedRuntimeMcp,
    HostedRuntimeName,
    HostedRuntimePlatformMcpServer,
    HostedRuntimeRecovery,
    HostedRuntimeRemoteMcpServer,
    HostedRuntimeSystem,
    HostedRuntimeTools,
    PersistedHostedRuntimeSkills,
    is_canonical_secret_ref,
    parse_exact_semver,
    validate_clawdi_cli_package_spec,
    validate_hosted_runtime_desired_state,
)
from app.schemas.runtime_observed import HostedRuntimeObservedV2
from app.services.channels import (
    HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS,
    channel_runtime_account_key,
    channel_runtime_placeholder_token,
    hosted_agent_provider_link_limit_detail,
)
from app.services.hosted_runtime_secrets import validate_hosted_runtime_secret_key_version
from app.services.managed_ai_provider import (
    V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX,
    V2_MANAGED_AI_PROVIDER_IDS,
    is_managed_provider_id,
    is_v2_deployment_managed_provider_id,
    managed_provider_api_mode,
    runtime_managed_provider_id,
)
from app.services.project_runtime_skills import (
    RUNTIME_PROJECT_SKILL_KEY_PATTERN,
    agent_supports_project_skills,
    project_skill_file_signature,
)
from app.services.runtime_generation import resolve_runtime_apply_generation
from app.services.url_security import UnsafePublicHttpsUrlError, validate_public_https_url
from app.services.vault_crypto import decrypt
from app.services.whatsapp_baileys import (
    buffer_json,
    ensure_whatsapp_agent_credential,
    whatsapp_credential_needs_self_identity_repair,
    whatsapp_self_identity_from_config,
)

RUNTIME_BUNDLE_V2_MEDIA_TYPE = "application/vnd.clawdi.runtime-bundle.v2+json"
RUNTIME_BUNDLE_V2_SCHEMA_VERSION = "clawdi.hosted-runtime.bundle.v2"
RUNTIME_CAPABILITIES_HEADER = "X-Clawdi-Runtime-Capabilities"
RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY = "agent-plugins-manifest-v1"
RUNTIME_AGENT_PLUGIN_PROOF_HEADER = "X-Clawdi-Agent-Plugin-Proof"
_CLAWDI_AGENT_PLUGIN_PACKAGE = "clawdi-cloud"
_CLAWDI_AGENT_PLUGIN_COMPONENT = "clawdi"
_CLAWDI_AGENT_PLUGIN_INSTALLATION_ID = "first-party:clawdi-cloud"
_CLAWDI_AGENT_PLUGIN_VERSION = "1.0.0"
_CLAWDI_AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
_CLAWDI_AGENT_PLUGIN_STORE_URL = "https://github.com/Clawdi-AI/store"
_CLAWDI_AGENT_PLUGIN_STORE_PATH = "v2/plugins/clawdi-cloud"
_CLAWDI_AGENT_PLUGIN_CONTENT_DIGEST = (
    "sha256-tree-v1:f47e156aa043d9f09f8e5e1e7dfa58a3300fb12699a716f887b633d4a21bc38c"
)
_CLAWDI_AGENT_PLUGIN_EGRESS_PROFILE_ID = "first-party-clawdi-cloud-mcp"
_CLAWDI_AGENT_PLUGIN_EGRESS_PROFILE_OWNER = "first-party:clawdi-cloud"
_CLAWDI_AGENT_PLUGIN_MCP_AUTHORITY = "cloud-api.clawdi.ai:443"
_CLAWDI_AGENT_PLUGIN_MCP_PATH = "/v1/mcp/clawdi"
_CLAWDI_AGENT_PLUGIN_MARKER_HEADER = "X-Clawdi-Agent-Plugin"
_CLAWDI_AUTH_TOKEN_SECRET_REF = "secret://clawdi/auth-token"
_AGENT_PLUGIN_PROOF_PATTERN = re.compile(r"^v1:(openclaw|hermes):([0-9a-f]{64}):([0-9a-f]{64})$")
_SUPPORTED_RUNTIMES = {"hermes", "openclaw"}
_MANAGED_PROVIDER_RUNTIME_ENV = "CLAWDI_AI_API_KEY"
_CODEX_TOOL_LEGACY_RUNTIME_ENV = "OPENAI_API_KEY"
_CODEX_TOOL_CANONICAL_ENV_MINIMUM_CLI_VERSION = (0, 13, 69)
_CODEX_TOOL_SECRET_REF = "secret://tool.codex.apiKey"
_CODEX_TOOL_API_MODE = "openai_responses"
_CODEX_PROVIDER_SOURCE_API_MODES = {"openai_chat", "openai_responses"}
_AI_PROVIDER_MODELS_ADAPTER: TypeAdapter[list[AiProviderModel]] = TypeAdapter(list[AiProviderModel])


class RuntimeSourceError(ValueError):
    pass


class RuntimeSourceNotFoundError(RuntimeSourceError):
    pass


def expected_runtime_bundle_v2_etag(source_revision: str) -> str:
    """Return the frozen v2 validator derived from its complete source identity."""
    if not re.fullmatch(r"[0-9a-f]{64}", source_revision):
        raise ValueError("runtime bundle source revision must be a SHA-256 digest")
    return f'"sha256:{source_revision}"'


def _codex_tool_runtime_env(
    state: HostedRuntimeState,
    observation: HostedRuntimeConfigObservation | None,
) -> str:
    desired_version = state.cli_package_spec.removeprefix("clawdi@")
    parsed_version = parse_exact_semver(desired_version)
    if parsed_version is None or (
        parsed_version[:3] < _CODEX_TOOL_CANONICAL_ENV_MINIMUM_CLI_VERSION
        or (
            parsed_version[:3] == _CODEX_TOOL_CANONICAL_ENV_MINIMUM_CLI_VERSION
            and parsed_version[3]
        )
    ):
        return _CODEX_TOOL_LEGACY_RUNTIME_ENV
    if observation is None:
        return _CODEX_TOOL_LEGACY_RUNTIME_ENV
    try:
        observed = HostedRuntimeObservedV2.model_validate(observation.diagnostics)
    except ValidationError:
        return _CODEX_TOOL_LEGACY_RUNTIME_ENV
    expected_generation = resolve_runtime_apply_generation(
        generation=state.generation,
        apply_generation=state.apply_generation,
    )
    # The env-name change creates the next source revision, so gate only on the
    # last applied record's internal identity instead of this render's revision.
    if not (
        observed.status == "ok"
        and observed.converge_error is None
        and observed.active_cli_version == desired_version
        and observed.applied is not None
        and observed.applied.instance_id == state.instance_id
        and observed.applied.generation == expected_generation
        and observation.observed_config_generation == expected_generation
        and observation.observed_manifest_etag == observed.applied.etag
        and observation.observed_source_revision == observed.applied.source_revision
    ):
        return _CODEX_TOOL_LEGACY_RUNTIME_ENV
    return _MANAGED_PROVIDER_RUNTIME_ENV


@dataclass(frozen=True)
class RuntimeSourceRow:
    environment: AgentEnvironment
    state: HostedRuntimeState | None
    observation: HostedRuntimeConfigObservation | None = None


@dataclass(frozen=True)
class RuntimeProjectSkill:
    id: UUID
    project_id: UUID
    skill_key: str
    content_hash: str


@dataclass(frozen=True)
class RuntimeSourceBatch:
    rows: dict[UUID, RuntimeSourceRow]
    providers: dict[tuple[UUID, str], AiProvider]
    auth_payloads: dict[tuple[UUID, str, str], AiProviderAuthPayload]
    channels: dict[UUID, tuple[tuple[ChannelAccount, ChannelBotAgentLink], ...]]
    channel_credentials: dict[UUID, ChannelAgentCredential] = field(default_factory=dict)
    whatsapp_auth_certs: dict[UUID, ChannelWhatsAppAuthCert] = field(default_factory=dict)
    runtime_secrets: dict[UUID, tuple[HostedRuntimeSecret, ...]] = field(default_factory=dict)
    project_skills: dict[UUID, tuple[RuntimeProjectSkill, ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class RenderedRuntimeSource:
    manifest: dict[str, Any]
    channel_bindings: list[dict[str, Any]]
    secret_values: dict[str, str]
    source_revision: str
    apply_generation: int | None


@dataclass(frozen=True)
class RuntimeSecretMaterial:
    secret_ref: str
    ciphertext: bytes
    nonce: bytes
    error_message: str


async def load_runtime_source_batch(
    db: AsyncSession,
    *,
    environment_ids: list[UUID],
    owner_user_id: UUID | None = None,
) -> RuntimeSourceBatch:
    if not environment_ids:
        return RuntimeSourceBatch(rows={}, providers={}, auth_payloads={}, channels={})
    env_filters: list[ColumnElement[bool]] = [
        AgentEnvironment.id.in_(environment_ids),
        AgentEnvironment.archived_at.is_(None),
    ]
    if owner_user_id is not None:
        env_filters.append(AgentEnvironment.user_id == owner_user_id)
    env_rows = (
        await db.execute(
            select(
                AgentEnvironment,
                HostedRuntimeState,
                HostedRuntimeConfigObservation,
            )
            .outerjoin(HostedRuntimeState, HostedRuntimeState.environment_id == AgentEnvironment.id)
            .outerjoin(
                HostedRuntimeConfigObservation,
                HostedRuntimeConfigObservation.environment_id == AgentEnvironment.id,
            )
            .where(*env_filters)
        )
    ).all()
    rows = {
        env.id: RuntimeSourceRow(environment=env, state=state, observation=observation)
        for env, state, observation in env_rows
    }
    user_ids = sorted({row.environment.user_id for row in rows.values()}, key=str)
    if not user_ids:
        return RuntimeSourceBatch(rows=rows, providers={}, auth_payloads={}, channels={})
    providers = list(
        (
            await db.execute(
                select(AiProvider).where(
                    AiProvider.owner_user_id.in_(user_ids),
                    AiProvider.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    auth_payloads = list(
        (
            await db.execute(
                select(AiProviderAuthPayload).where(
                    AiProviderAuthPayload.owner_user_id.in_(user_ids),
                    AiProviderAuthPayload.archived_at.is_(None),
                )
            )
        ).scalars()
    )
    channel_rows = (
        await db.execute(
            select(ChannelBotAgentLink.agent_id, ChannelAccount, ChannelBotAgentLink)
            .join(ChannelAccount, ChannelAccount.id == ChannelBotAgentLink.account_id)
            .where(
                ChannelBotAgentLink.agent_id.in_(list(rows)),
                ChannelBotAgentLink.user_id.in_(user_ids),
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelAccount.provider.in_(
                    (
                        CHANNEL_PROVIDER_TELEGRAM,
                        CHANNEL_PROVIDER_DISCORD,
                        CHANNEL_PROVIDER_WHATSAPP,
                    )
                ),
            )
            .order_by(
                ChannelBotAgentLink.agent_id,
                ChannelAccount.provider,
                ChannelAccount.id,
                ChannelBotAgentLink.id,
            )
        )
    ).all()
    channels: dict[UUID, list[tuple[ChannelAccount, ChannelBotAgentLink]]] = {}
    for environment_id, account, link in channel_rows:
        channels.setdefault(environment_id, []).append((account, link))
    whatsapp_links = [
        (account, link)
        for _environment_id, account, link in channel_rows
        if account.provider == CHANNEL_PROVIDER_WHATSAPP
    ]
    credential_rows = (
        list(
            (
                await db.execute(
                    select(ChannelAgentCredential)
                    .where(
                        ChannelAgentCredential.bot_agent_link_id.in_(
                            [link.id for _account, link in whatsapp_links]
                        ),
                        ChannelAgentCredential.provider == CHANNEL_PROVIDER_WHATSAPP,
                        ChannelAgentCredential.revoked_at.is_(None),
                    )
                    .order_by(
                        ChannelAgentCredential.bot_agent_link_id,
                        ChannelAgentCredential.created_at.desc(),
                        ChannelAgentCredential.id.desc(),
                    )
                )
            ).scalars()
        )
        if whatsapp_links
        else []
    )
    channel_credentials: dict[UUID, ChannelAgentCredential] = {}
    for credential in credential_rows:
        channel_credentials.setdefault(credential.bot_agent_link_id, credential)
    auth_cert_rows = (
        list(
            (
                await db.execute(
                    select(ChannelWhatsAppAuthCert).where(
                        ChannelWhatsAppAuthCert.account_id.in_(
                            [account.id for account, _link in whatsapp_links]
                        )
                    )
                )
            ).scalars()
        )
        if whatsapp_links
        else []
    )
    runtime_secret_rows = list(
        (
            await db.execute(
                select(HostedRuntimeSecret)
                .where(HostedRuntimeSecret.environment_id.in_(list(rows)))
                .order_by(HostedRuntimeSecret.environment_id, HostedRuntimeSecret.secret_ref)
            )
        ).scalars()
    )
    runtime_secrets: dict[UUID, list[HostedRuntimeSecret]] = {}
    for secret in runtime_secret_rows:
        runtime_secrets.setdefault(secret.environment_id, []).append(secret)
    membership = ProjectMembership.__table__.alias("runtime_project_membership")
    project_skill_rows = (
        await db.execute(
            select(AgentProjectBinding.agent_id, Skill)
            .join(
                AgentEnvironment,
                AgentEnvironment.id == AgentProjectBinding.agent_id,
            )
            .join(Project, Project.id == AgentProjectBinding.project_id)
            .join(Skill, Skill.project_id == Project.id)
            .outerjoin(
                membership,
                (membership.c.project_id == Project.id)
                & (membership.c.member_user_id == AgentEnvironment.user_id),
            )
            .where(
                AgentProjectBinding.agent_id.in_(list(rows)),
                AgentProjectBinding.binding_type == "context",
                Project.kind == PROJECT_KIND_WORKSPACE,
                Project.archived_at.is_(None),
                Skill.authority == SKILL_AUTHORITY_CLOUD,
                Skill.is_active,
                (Project.user_id == AgentEnvironment.user_id) | membership.c.id.is_not(None),
            )
            .order_by(
                AgentProjectBinding.agent_id,
                AgentProjectBinding.priority,
                Project.id,
                Skill.skill_key,
            )
        )
    ).all()
    project_skills: dict[UUID, list[RuntimeProjectSkill]] = {}
    for environment_id, skill in project_skill_rows:
        runtime_row = rows.get(environment_id)
        if (
            runtime_row is None
            or runtime_row.state is None
            or not agent_supports_project_skills(
                runtime_row.environment,
                runtime_row.state,
                runtime_row.observation,
                has_environment_bound_key=False,
            )
        ):
            # Existing Vault-only bindings predate Project Skill delivery. Keep
            # those links usable, but never render the new source shape until
            # this exact Hosted V2 deployment has proven a compatible, Ready CLI.
            continue
        project_skills.setdefault(environment_id, []).append(
            RuntimeProjectSkill(
                id=skill.id,
                project_id=skill.project_id,
                skill_key=skill.skill_key,
                content_hash=skill.content_hash,
            )
        )
    return RuntimeSourceBatch(
        rows=rows,
        providers={(item.owner_user_id, item.provider_id): item for item in providers},
        auth_payloads={
            (item.owner_user_id, item.provider_id, item.auth_profile): item
            for item in auth_payloads
        },
        channels={key: tuple(value) for key, value in channels.items()},
        channel_credentials=channel_credentials,
        whatsapp_auth_certs={item.account_id: item for item in auth_cert_rows},
        runtime_secrets={key: tuple(value) for key, value in runtime_secrets.items()},
        project_skills={key: tuple(value) for key, value in project_skills.items()},
    )


async def ensure_runtime_whatsapp_credentials(
    db: AsyncSession,
    *,
    environment_id: UUID,
    owner_user_id: UUID,
    link_ids: tuple[UUID, ...],
) -> None:
    if not link_ids:
        return
    rows = (
        await db.execute(
            select(ChannelAccount, ChannelBotAgentLink)
            .join(ChannelBotAgentLink, ChannelBotAgentLink.account_id == ChannelAccount.id)
            .where(
                ChannelBotAgentLink.id.in_(link_ids),
                ChannelBotAgentLink.agent_id == environment_id,
                ChannelBotAgentLink.user_id == owner_user_id,
                ChannelBotAgentLink.status == BOT_AGENT_LINK_STATUS_ACTIVE,
                ChannelBotAgentLink.archived_at.is_(None),
                ChannelAccount.provider == CHANNEL_PROVIDER_WHATSAPP,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
            )
            .order_by(ChannelAccount.id, ChannelBotAgentLink.id)
        )
    ).all()
    try:
        for account, link in rows:
            await ensure_whatsapp_agent_credential(db, account=account, link=link)
    except Exception as exc:
        raise RuntimeSourceError("Hosted runtime WhatsApp credential source is invalid") from exc


def runtime_whatsapp_credential_repair_link_ids(
    batch: RuntimeSourceBatch,
    *,
    environment_id: UUID,
) -> tuple[UUID, ...]:
    repair_link_ids: list[UUID] = []
    try:
        for account, link in batch.channels.get(environment_id, ()):
            if account.provider != CHANNEL_PROVIDER_WHATSAPP:
                continue
            credential = batch.channel_credentials.get(link.id)
            if credential is None or account.id not in batch.whatsapp_auth_certs:
                repair_link_ids.append(link.id)
                continue
            if whatsapp_credential_needs_self_identity_repair(
                credential,
                self_identity=whatsapp_self_identity_from_config(account.config),
            ):
                repair_link_ids.append(link.id)
    except Exception as exc:
        raise RuntimeSourceError("Hosted runtime WhatsApp credential source is invalid") from exc
    return tuple(repair_link_ids)


def _project_runtime_skills(
    workspace_skills: dict[str, Any] | None,
    project_skills: tuple[RuntimeProjectSkill, ...],
    *,
    environment_id: UUID,
    public_api_url: str,
    signing_key: str,
) -> dict[str, Any] | None:
    """Compose Workspace and linked-Project intent without key precedence."""
    entries: dict[str, Any] = {}
    if workspace_skills is not None:
        raw_entries = workspace_skills.get("entries")
        if not _is_string_object_dict(raw_entries):
            raise RuntimeSourceError("Hosted runtime skills state is invalid")
        entries.update(raw_entries)

    base_url = public_api_url.rstrip("/")
    owners: dict[str, UUID] = {}
    for skill in project_skills:
        if RUNTIME_PROJECT_SKILL_KEY_PATTERN.fullmatch(skill.skill_key) is None:
            raise RuntimeSourceError(
                f'Project Skill "{skill.skill_key}" is not compatible with managed Agent delivery'
            )
        if skill.skill_key in entries:
            raise RuntimeSourceError(
                f'Project Skill "{skill.skill_key}" conflicts with this Agent\'s Workspace'
            )
        existing_project = owners.get(skill.skill_key)
        if existing_project is not None:
            raise RuntimeSourceError(
                f'Project Skill "{skill.skill_key}" is provided by more than one linked Project'
            )
        owners[skill.skill_key] = skill.project_id
        signature = project_skill_file_signature(
            signing_key=signing_key,
            agent_id=environment_id,
            skill_id=skill.id,
            content_hash=skill.content_hash,
        )
        encoded_key = quote(skill.skill_key, safe="")
        entries[skill.skill_key] = {
            "enabled": True,
            "source": {
                "type": "project",
                "projectId": str(skill.project_id),
                "contentHash": skill.content_hash,
                "archiveUrl": (
                    f"{base_url}/v1/runtime/project-skill-archives/{environment_id}/"
                    f"{skill.project_id}/{skill.id}/{skill.content_hash}/{signature}/"
                    f"{encoded_key}.tar.gz"
                ),
                "installUrl": (
                    f"{base_url}/v1/runtime/project-skill-files/{environment_id}/"
                    f"{skill.id}/{skill.content_hash}/{signature}/SKILL.md"
                ),
            },
        }
    return {"entries": entries} if entries else None


def _without_legacy_clawdi_components(
    mcp: dict[str, Any] | None,
    skills: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    projected_mcp = mcp
    if mcp is not None:
        servers = dict(mcp.get("servers", {}))
        servers.pop(_CLAWDI_AGENT_PLUGIN_COMPONENT, None)
        projected_mcp = {**mcp, "servers": servers} if servers else None

    projected_skills = skills
    if skills is not None:
        entries = dict(skills.get("entries", {}))
        entries.pop(_CLAWDI_AGENT_PLUGIN_COMPONENT, None)
        projected_skills = {**skills, "entries": entries} if entries else None
    return projected_mcp, projected_skills


def _is_first_party_clawdi_agent_plugin(
    agent_plugins: HostedAgentPlugins | None,
) -> bool:
    if agent_plugins is None or set(agent_plugins.installations) != {_CLAWDI_AGENT_PLUGIN_PACKAGE}:
        return False
    installation = agent_plugins.installations.get(_CLAWDI_AGENT_PLUGIN_PACKAGE)
    if installation is None:
        return False
    source = installation.source
    return (
        installation.installationId == _CLAWDI_AGENT_PLUGIN_INSTALLATION_ID
        and installation.version == _CLAWDI_AGENT_PLUGIN_VERSION
        and installation.agentPluginsSchema == _CLAWDI_AGENT_PLUGIN_SCHEMA
        and source.type == "github"
        and source.url == _CLAWDI_AGENT_PLUGIN_STORE_URL
        and source.path == _CLAWDI_AGENT_PLUGIN_STORE_PATH
        and installation.contentDigest == _CLAWDI_AGENT_PLUGIN_CONTENT_DIGEST
    )


def _agent_plugin_ownership_identity(
    name: str,
    installation: HostedAgentPluginInstallation,
) -> str:
    source = installation.source
    payload = [
        installation.installationId,
        name,
        installation.version,
        installation.agentPluginsSchema,
        source.type,
        source.url,
        source.path,
        source.commit,
        installation.contentDigest,
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def _matches_agent_plugin_capability_proof(
    proof: str | None,
    *,
    runtime: HostedRuntimeName,
    agent_plugins: HostedAgentPlugins,
) -> bool:
    match = _AGENT_PLUGIN_PROOF_PATTERN.fullmatch(proof or "")
    if match is None or match.group(1) != runtime:
        return False
    installation = agent_plugins.installations[_CLAWDI_AGENT_PLUGIN_PACKAGE]
    return match.group(2) == _agent_plugin_ownership_identity(
        _CLAWDI_AGENT_PLUGIN_PACKAGE,
        installation,
    )


def _has_first_party_clawdi_agent_plugin_egress_profile(
    egress_profiles: HostedEgressProfiles | None,
) -> bool:
    if egress_profiles is None:
        return False
    matching_profiles = [
        profile
        for profile in (egress_profiles.profiles or [])
        if profile.id == _CLAWDI_AGENT_PLUGIN_EGRESS_PROFILE_ID
    ]
    if len(matching_profiles) != 1:
        return False
    profile = matching_profiles[0]
    if profile.rewrite is None or profile.rewrite.upstreamBaseUrl is None:
        return False
    return profile.model_dump(exclude_none=True, mode="json") == {
        "id": _CLAWDI_AGENT_PLUGIN_EGRESS_PROFILE_ID,
        "enabled": True,
        "kind": "http",
        "match": {
            "scheme": "https",
            "host": _CLAWDI_AGENT_PLUGIN_MCP_AUTHORITY,
            "path": {"type": "equals", "value": _CLAWDI_AGENT_PLUGIN_MCP_PATH},
            "headers": {
                _CLAWDI_AGENT_PLUGIN_MARKER_HEADER: {
                    "type": "equals",
                    "value": _CLAWDI_AGENT_PLUGIN_PACKAGE,
                }
            },
            "query": {},
        },
        "rewrite": {
            "upstreamBaseUrl": profile.rewrite.upstreamBaseUrl,
            "preservePath": True,
            "setHeaders": {
                "Authorization": {
                    "type": "secretRef",
                    "secretRef": _CLAWDI_AUTH_TOKEN_SECRET_REF,
                    "prefix": "Bearer ",
                }
            },
        },
        "logging": {
            "redactHeaders": ["Authorization"],
            "redactUrlPatterns": [],
        },
        "priority": 60,
        "owner": _CLAWDI_AGENT_PLUGIN_EGRESS_PROFILE_OWNER,
    }


def render_runtime_source(
    batch: RuntimeSourceBatch,
    *,
    environment_id: UUID,
    public_api_url: str,
    vault_key_identity: str,
    decrypt_secrets: bool,
    project_agent_plugins: bool = True,
    agent_plugin_capability_proof: str | None = None,
) -> RenderedRuntimeSource:
    row = batch.rows.get(environment_id)
    if row is None:
        raise RuntimeSourceNotFoundError("Agent environment not found")
    if row.state is None:
        raise RuntimeSourceNotFoundError("Hosted runtime state not found")
    state = row.state
    user_id = row.environment.user_id
    try:
        locale = HostedRuntimeLocale.model_validate(state.locale)
        system = HostedRuntimeSystem.model_validate(state.system)
        live_sync = HostedRuntimeLiveSync.model_validate(state.live_sync)
        recovery = HostedRuntimeRecovery.model_validate(state.recovery)
    except ValidationError as exc:
        raise RuntimeSourceError(
            "Hosted runtime locale, system, live sync, or recovery state "
            "is invalid or not configured"
        ) from exc
    try:
        egress_engine = (
            HostedEgressEngine.model_validate(state.egress_engine)
            if state.egress_engine is not None
            else None
        )
        egress_profiles = (
            HostedEgressProfiles.model_validate(state.egress_profiles)
            if state.egress_profiles is not None
            else None
        )
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime egress state is invalid") from exc
    try:
        companions = (
            HostedRuntimeCompanions.model_validate(state.companions)
            if state.companions is not None
            else None
        )
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime companion state is invalid") from exc
    try:
        tools = HostedRuntimeTools.model_validate(state.tools)
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime tools state is invalid") from exc
    try:
        mcp_document = HostedRuntimeMcp.model_validate(state.mcp) if state.mcp is not None else None
        workspace_skills = (
            PersistedHostedRuntimeSkills.model_validate(state.skills).model_dump(
                exclude_none=True,
                exclude_unset=True,
                mode="json",
            )
            if state.skills is not None
            else None
        )
    except (ValidationError, ValueError) as exc:
        raise RuntimeSourceError("Hosted runtime MCP or skills state is invalid") from exc
    try:
        agent_plugins = (
            HostedAgentPlugins.model_validate(state.agent_plugins)
            if state.agent_plugins is not None
            else None
        )
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted runtime Agent Plugins state is invalid") from exc
    if mcp_document is None:
        mcp = None
    else:
        clawdi_mcp = mcp_document.servers.get("clawdi")
        public_clawdi_mcp_url = f"{public_api_url.rstrip('/')}/v1/mcp/clawdi"
        if isinstance(clawdi_mcp, HostedRuntimePlatformMcpServer):
            mcp_document.servers["clawdi"] = HostedRuntimeRemoteMcpServer(
                url=public_clawdi_mcp_url,
                transport=clawdi_mcp.transport,
                headers=clawdi_mcp.headers,
            )
        elif isinstance(clawdi_mcp, HostedRuntimeRemoteMcpServer):
            clawdi_mcp.url = public_clawdi_mcp_url
        mcp = mcp_document.model_dump(mode="json")
    skills = _project_runtime_skills(
        workspace_skills,
        batch.project_skills.get(environment_id, ()),
        environment_id=environment_id,
        public_api_url=public_api_url,
        signing_key=vault_key_identity,
    )
    runtime_name, runtime = _runtime(state.runtimes)
    first_party_clawdi_agent_plugin = (
        project_agent_plugins
        and _is_first_party_clawdi_agent_plugin(agent_plugins)
        and _has_first_party_clawdi_agent_plugin_egress_profile(egress_profiles)
    )
    native_clawdi_agent_plugin = bool(
        first_party_clawdi_agent_plugin
        and agent_plugins is not None
        and _matches_agent_plugin_capability_proof(
            agent_plugin_capability_proof,
            runtime=runtime_name,
            agent_plugins=agent_plugins,
        )
    )
    if native_clawdi_agent_plugin:
        mcp, skills = _without_legacy_clawdi_components(mcp, skills)
    try:
        cli_package_spec = validate_clawdi_cli_package_spec(state.cli_package_spec)
    except ValueError as exc:
        raise RuntimeSourceError("Hosted runtime CLI package spec is invalid") from exc
    bound_runtime_provider_ids = list(runtime["provider_ids"])
    runtime = _agent_runtime_binding(runtime)
    dashboard_auth = system.hermesDashboardAuth
    if runtime_name == "hermes":
        if dashboard_auth is None:
            raise RuntimeSourceError(
                "Hermes direct dashboard requires official password authentication"
            )
        if dashboard_auth.activation.enabled is not True:
            raise RuntimeSourceError("Hermes password authentication must be explicitly enabled")
        if runtime.get("services", {}).get("dashboard", {}).get("args") != [
            "dashboard",
            "--host",
            "0.0.0.0",
            "--port",
            "9119",
            "--no-open",
        ]:
            raise RuntimeSourceError("Hermes dashboard must bind directly to 0.0.0.0:9119")
    elif dashboard_auth is not None:
        raise RuntimeSourceError("Hermes dashboard auth is only valid for Hermes runtimes")

    providers: dict[str, Any] = {}
    secrets: dict[str, str] = {}
    secret_sources: dict[str, dict[str, str]] = {}
    secret_materials: list[RuntimeSecretMaterial] = []
    for runtime_secret in batch.runtime_secrets.get(environment_id, ()):
        if not is_canonical_secret_ref(runtime_secret.secret_ref):
            raise RuntimeSourceError("Hosted runtime secret reference is invalid")
        try:
            validate_hosted_runtime_secret_key_version(runtime_secret.key_version)
        except RuntimeError as exc:
            raise RuntimeSourceError("Hosted runtime secret source is invalid") from exc
        _add_secret_source(
            secret_sources,
            runtime_secret.secret_ref,
            _secret_identity(
                runtime_secret.id,
                runtime_secret.encrypted_value,
                runtime_secret.nonce,
                vault_key_identity,
                "runtime-state-secret",
                key_version=runtime_secret.key_version,
            ),
        )
        secret_materials.append(
            RuntimeSecretMaterial(
                secret_ref=runtime_secret.secret_ref,
                ciphertext=runtime_secret.encrypted_value,
                nonce=runtime_secret.nonce,
                error_message="Hosted runtime secret source is invalid",
            )
        )
    codex_tool = tools.codex
    if not is_v2_deployment_managed_provider_id(codex_tool.provider_id):
        raise RuntimeSourceError("Hosted Codex tool provider must use its exact deployment source")
    codex_agent_provider_id = runtime_managed_provider_id(codex_tool.provider_id)
    provider_sources: dict[str, str] = {}
    for bound_provider_id in [*bound_runtime_provider_ids, codex_tool.provider_id]:
        agent_provider_id = runtime_managed_provider_id(bound_provider_id)
        source_provider_id = _exact_provider_source_id(
            bound_provider_id=bound_provider_id,
        )
        existing_source = provider_sources.get(agent_provider_id)
        if existing_source is not None and existing_source != source_provider_id:
            raise RuntimeSourceError(
                f"multiple provider bindings project to agent provider {agent_provider_id}"
            )
        provider_sources[agent_provider_id] = source_provider_id
    provider_material: dict[str, dict[str, Any]] = {}
    runtime_provider_ids = set(runtime["provider_ids"])
    primary_model = runtime.get("primary_model")
    selected_models = (
        {primary_model["provider_id"]: primary_model["model"]} if primary_model else {}
    )
    for agent_provider_id, source_provider_id in sorted(provider_sources.items()):
        provider = batch.providers.get((user_id, source_provider_id))
        is_codex_provider = agent_provider_id == codex_agent_provider_id
        if provider is None:
            if is_codex_provider:
                raise RuntimeSourceError("Hosted Codex tool provider is missing or archived")
            consumer = runtime_name if agent_provider_id in runtime_provider_ids else "codex tool"
            provider_material[agent_provider_id] = _unhealthy_provider(agent_provider_id, consumer)
            continue
        try:
            validate_public_https_url(provider.base_url, label="AI Provider base_url")
        except UnsafePublicHttpsUrlError as exc:
            raise RuntimeSourceError(str(exc)) from exc
        payload = _selected_auth_payload(
            batch,
            provider,
            environment_id=environment_id,
            runtime_name=runtime_name,
            allow_oauth=agent_provider_id in runtime_provider_ids and not is_codex_provider,
        )
        if is_codex_provider and (
            provider.managed_by != "clawdi"
            or payload is None
            or payload.kind != "api_key"
            or payload.source != "managed"
        ):
            raise RuntimeSourceError(
                "Hosted Codex tool provider must use a Clawdi-managed provider auth payload"
            )
        secret_ref = None
        if payload is not None:
            secret_ref = (
                _CODEX_TOOL_SECRET_REF
                if is_codex_provider
                else _provider_oauth_secret_ref(source_provider_id)
                if payload.kind in {"agent_profile", "oauth_profile"}
                else _provider_secret_ref(source_provider_id)
            )
        provider_entry = _provider_entry(
            provider,
            secret_ref=secret_ref,
            credential_revision=(
                payload.credential_revision
                if payload is not None and payload.kind in {"agent_profile", "oauth_profile"}
                else None
            ),
            selected_model=selected_models.get(agent_provider_id),
        )
        if is_codex_provider and (
            provider.api_mode not in _CODEX_PROVIDER_SOURCE_API_MODES
            or provider_entry.get("runtimeEnvName") != _MANAGED_PROVIDER_RUNTIME_ENV
        ):
            raise RuntimeSourceError(
                "Hosted Codex tool provider must use a supported managed OpenAI projection"
            )
        provider_material[agent_provider_id] = provider_entry
        if payload is not None and secret_ref is not None:
            _add_secret_source(
                secret_sources,
                secret_ref,
                _secret_identity(
                    payload.id,
                    payload.encrypted_payload,
                    payload.nonce,
                    vault_key_identity,
                    (
                        "tool-codex-api-key"
                        if is_codex_provider
                        else "provider-oauth-profile"
                        if payload.kind in {"agent_profile", "oauth_profile"}
                        else "provider-api-key"
                    ),
                ),
            )
            secret_materials.append(
                RuntimeSecretMaterial(
                    secret_ref=secret_ref,
                    ciphertext=payload.encrypted_payload,
                    nonce=payload.nonce,
                    error_message="Hosted runtime provider secret source is invalid",
                )
            )

    providers = {
        provider_id: provider_material[provider_id] for provider_id in runtime["provider_ids"]
    }
    tool_projection = tools.model_dump(
        exclude={"codex"},
        exclude_none=True,
        exclude_unset=True,
        mode="json",
    )
    codex_provider_material = provider_material[codex_agent_provider_id]
    codex_provider_input = {
        "kind": "openai-compatible",
        "type": codex_provider_material.get("type"),
        "baseUrl": codex_provider_material.get("baseUrl"),
        "apiMode": _CODEX_TOOL_API_MODE,
        "managed_by": codex_provider_material.get("managed_by"),
        "runtimeEnvName": _codex_tool_runtime_env(state, row.observation),
        "apiKeySecretRef": codex_provider_material.get("apiKeySecretRef"),
    }
    try:
        codex_provider = HostedCodexProviderProjection.model_validate(
            codex_provider_input
        ).model_dump(exclude_none=True, mode="json")
    except ValidationError as exc:
        raise RuntimeSourceError("Hosted Codex tool provider projection is invalid") from exc
    terminal_tooling = {
        "codex": {
            **_agent_codex_tool(codex_tool.model_dump(mode="json")),
            "provider": codex_provider,
        }
    }

    manifest: dict[str, Any] = {
        "schemaVersion": "clawdi.hosted-runtime.manifest.v1",
        "deploymentId": state.deployment_id,
        "environmentId": str(environment_id),
        "instanceId": state.instance_id,
        "generation": state.generation,
        "issuedAt": runtime_manifest_issued_at(state),
        "runtime": runtime_name,
        "locale": locale.model_dump(),
        "system": system.model_dump(
            exclude={"hermesDashboardAuth"}, exclude_none=True, mode="json"
        ),
        "controlPlane": {"cloudApiUrl": public_api_url.rstrip("/")},
        "clawdiCli": {
            "source": "npm:clawdi",
            "packageSpec": cli_package_spec,
            "registry": "https://registry.npmjs.org",
        },
        "runtimes": {runtime_name: runtime},
        "providers": providers,
        "liveSync": live_sync.model_dump(mode="json"),
        "recovery": recovery.model_dump(mode="json"),
    }
    if dashboard_auth is not None:
        manifest["system"]["hermesDashboardAuth"] = dashboard_auth.model_dump(
            exclude_none=True, mode="json"
        )
    if egress_engine is not None:
        manifest["egressEngine"] = egress_engine.model_dump(
            exclude_none=True, exclude_unset=True, mode="json"
        )
    if companions is not None and companions.filebrowser is not None:
        manifest["companions"] = companions.model_dump(
            exclude_none=True, exclude_unset=True, mode="json"
        )
    if egress_profiles is not None:
        manifest["egressProfiles"] = egress_profiles.model_dump(
            exclude_none=True, exclude_unset=True, mode="json"
        )
    if mcp:
        manifest["mcp"] = mcp
    if skills is not None:
        manifest["skills"] = skills
    if project_agent_plugins and agent_plugins is not None:
        manifest["agentPlugins"] = agent_plugins.model_dump(mode="json")
    if first_party_clawdi_agent_plugin and not native_clawdi_agent_plugin:
        manifest["agentPluginCapabilityProbe"] = {"installations": [_CLAWDI_AGENT_PLUGIN_PACKAGE]}
    if tool_projection:
        manifest["tools"] = tool_projection
    manifest["terminalTooling"] = terminal_tooling

    bindings: list[dict[str, Any]] = []
    channel_rows = batch.channels.get(environment_id, ())
    projected_providers: set[str] = set()
    for account, link in channel_rows:
        if (
            account.provider in HOSTED_RUNTIME_SINGLE_ACCOUNT_PROVIDERS
            and account.provider in projected_providers
        ):
            raise RuntimeSourceError(
                hosted_agent_provider_link_limit_detail(account.provider, duplicate=True)
            )
        projected_providers.add(account.provider)
        if not link.encrypted_agent_token or not link.agent_token_nonce:
            raise RuntimeSourceError("Active runtime channel link has no token material")
        account_key = channel_runtime_account_key(account.id)
        if account.provider == CHANNEL_PROVIDER_WHATSAPP:
            agent_ref = f"secret://channels/whatsapp/{account_key}/links/{link.id}/agent-token"
            placeholder_ref = (
                f"secret://channels/whatsapp/{account_key}/links/{link.id}/egress-capability"
            )
            credential = batch.channel_credentials.get(link.id)
            auth_cert = batch.whatsapp_auth_certs.get(account.id)
            if credential is None or auth_cert is None:
                raise RuntimeSourceError(
                    "Active runtime WhatsApp Link has no synthetic credential material"
                )
            credential_ref = (
                f"secret://channels/whatsapp/{account_key}/credentials/{credential.id}/creds-json"
            )
            bindings.append(
                {
                    "provider": CHANNEL_PROVIDER_WHATSAPP,
                    "accountId": str(account.id),
                    "accountKey": account_key,
                    "linkId": str(link.id),
                    "agentTokenSecretRef": agent_ref,
                    "placeholderTokenSecretRef": placeholder_ref,
                    "credential": {
                        "id": str(credential.id),
                        "credsSecretRef": credential_ref,
                        "authCert": {
                            "SERIAL": auth_cert.serial,
                            "ISSUER": "clawdi",
                            "PUBLIC_KEY": buffer_json(auth_cert.root_public_key),
                        },
                    },
                }
            )
            _add_secret_source(
                secret_sources,
                credential_ref,
                _secret_identity(
                    credential.id,
                    credential.encrypted_credentials,
                    credential.credential_nonce,
                    vault_key_identity,
                    "channel-whatsapp-synthetic-credential",
                ),
            )
            secret_materials.append(
                RuntimeSecretMaterial(
                    secret_ref=credential_ref,
                    ciphertext=credential.encrypted_credentials,
                    nonce=credential.credential_nonce,
                    error_message="Hosted runtime WhatsApp credential source is invalid",
                )
            )
        else:
            agent_ref = f"secret://channels/{account.provider}/{account_key}/agent-token"
            placeholder_ref = (
                f"secret://channels/{account.provider}/{account_key}/placeholder-token"
            )
            bindings.append(
                {
                    "provider": account.provider,
                    "accountKey": account_key,
                    "agentTokenSecretRef": agent_ref,
                    "placeholderTokenSecretRef": placeholder_ref,
                }
            )
        _add_secret_source(
            secret_sources,
            agent_ref,
            _secret_identity(
                link.id,
                link.encrypted_agent_token,
                link.agent_token_nonce,
                vault_key_identity,
                "channel-agent-token",
            ),
        )
        secret_materials.append(
            RuntimeSecretMaterial(
                secret_ref=agent_ref,
                ciphertext=link.encrypted_agent_token,
                nonce=link.agent_token_nonce,
                error_message="Hosted runtime channel secret source is invalid",
            )
        )

    if decrypt_secrets:
        for material in secret_materials:
            try:
                secrets[material.secret_ref] = decrypt(material.ciphertext, material.nonce)
            except Exception as exc:
                raise RuntimeSourceError(material.error_message) from exc
        for binding in bindings:
            placeholder_ref = binding["placeholderTokenSecretRef"]
            secrets[placeholder_ref] = channel_runtime_placeholder_token(
                binding["provider"],
                binding["accountKey"],
                link_id=(
                    UUID(binding["linkId"])
                    if binding["provider"] == CHANNEL_PROVIDER_WHATSAPP
                    else None
                ),
            )

    descriptor: dict[str, object] = {
        "schemaVersion": RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
        "manifest": manifest,
        "channelBindings": bindings,
        "secretSources": secret_sources,
    }
    if state.apply_generation is not None:
        descriptor["applyGeneration"] = state.apply_generation
    source_revision = hashlib.sha256(_canonical(descriptor).encode()).hexdigest()
    return RenderedRuntimeSource(
        manifest=manifest,
        channel_bindings=bindings,
        secret_values=secrets,
        source_revision=source_revision,
        apply_generation=state.apply_generation,
    )


def render_runtime_bundle(source: RenderedRuntimeSource) -> dict[str, Any]:
    bundle: dict[str, object] = {
        "schemaVersion": RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
        "sourceRevision": source.source_revision,
        "manifest": source.manifest,
        "channelBindings": source.channel_bindings,
        "secretValues": source.secret_values,
    }
    if source.apply_generation is not None:
        bundle["applyGeneration"] = source.apply_generation
    return bundle


def vault_key_identity(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _runtime(
    value: dict[str, JsonValue] | None,
) -> tuple[HostedRuntimeName, dict[str, Any]]:
    if not isinstance(value, dict) or len(value) != 1:
        raise RuntimeSourceError("hosted runtime state must select exactly one enabled runtime")
    name, raw = next(iter(value.items()))
    if name not in _SUPPORTED_RUNTIMES:
        raise RuntimeSourceError(f"unsupported enabled runtime: {name}")
    try:
        desired = validate_hosted_runtime_desired_state(raw)
    except ValidationError as exc:
        raise RuntimeSourceError(f"hosted runtime state for {name} is invalid") from exc
    runtime_name: HostedRuntimeName = "hermes" if name == "hermes" else "openclaw"
    return runtime_name, desired.model_dump(exclude_none=True, mode="json")


def _agent_runtime_binding(runtime: dict[str, Any]) -> dict[str, Any]:
    provider_ids = [
        runtime_managed_provider_id(provider_id) for provider_id in runtime["provider_ids"]
    ]
    if len(provider_ids) != len(set(provider_ids)):
        duplicate = next(
            provider_id
            for index, provider_id in enumerate(provider_ids)
            if provider_id in provider_ids[:index]
        )
        raise RuntimeSourceError(
            f"multiple provider bindings project to agent provider {duplicate}"
        )
    projected = {**runtime, "provider_ids": provider_ids}
    primary_model = runtime.get("primary_model")
    if _is_string_object_dict(primary_model):
        provider_id = primary_model.get("provider_id")
        if not isinstance(provider_id, str):
            raise RuntimeSourceError("Runtime primary model provider id is invalid")
        projected["primary_model"] = {
            **primary_model,
            "provider_id": runtime_managed_provider_id(provider_id),
        }
    return projected


def _is_string_object_dict(value: object) -> TypeGuard[dict[str, object]]:
    return _is_object_dict(value) and all(isinstance(key, str) for key in value)


def _is_object_dict(value: object) -> TypeGuard[dict[object, object]]:
    return isinstance(value, dict)


def _agent_codex_tool(codex_tool: dict[str, Any]) -> dict[str, Any]:
    provider_id = runtime_managed_provider_id(codex_tool["provider_id"])
    return {
        **codex_tool,
        "provider_id": provider_id,
        "primary_model": {
            **codex_tool["primary_model"],
            "provider_id": provider_id,
        },
    }


def _exact_provider_source_id(
    *,
    bound_provider_id: str,
) -> str:
    """Validate and return the exact provider credential/catalog identity."""

    if bound_provider_id in V2_MANAGED_AI_PROVIDER_IDS:
        raise RuntimeSourceError(
            "Hosted v2 managed provider binding must use its exact deployment source"
        )
    if bound_provider_id.startswith(V2_DEPLOYMENT_MANAGED_AI_PROVIDER_PREFIX) and not (
        is_v2_deployment_managed_provider_id(bound_provider_id)
    ):
        raise RuntimeSourceError("Hosted v2 managed provider source is invalid")
    return bound_provider_id


def _selected_auth_payload(
    batch: RuntimeSourceBatch,
    provider: AiProvider,
    *,
    environment_id: UUID,
    runtime_name: HostedRuntimeName,
    allow_oauth: bool,
) -> AiProviderAuthPayload | None:
    metadata = provider.auth_metadata or {}
    is_managed_api_key = provider.auth_type == "api_key" and metadata.get("source") == "managed"
    is_managed_oauth = provider.auth_type in {"agent_profile", "oauth_profile"}
    if not is_managed_api_key and not is_managed_oauth:
        return None
    if is_managed_oauth and not allow_oauth:
        return None
    raw = metadata.get("profile")
    profile = raw if isinstance(raw, str) else "default"
    payload = batch.auth_payloads.get((provider.owner_user_id, provider.provider_id, profile))
    if payload is None:
        return None
    if is_managed_oauth and (
        payload.consumer_environment_id != environment_id
        or payload.consumer_runtime != runtime_name
    ):
        return None
    return payload


def _provider_entry(
    provider: AiProvider,
    *,
    secret_ref: str | None,
    credential_revision: str | None,
    selected_model: str | None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "kind": "openai-compatible",
        "type": provider.type,
        "baseUrl": provider.base_url,
    }
    managed = is_managed_provider_id(provider.provider_id) or (
        provider.managed_by == "clawdi"
        and provider.auth_type == "api_key"
        and (provider.auth_metadata or {}).get("source") == "managed"
    )
    api_mode = (
        managed_provider_api_mode(provider.provider_id) or provider.api_mode
        if managed
        else provider.api_mode
    )
    runtime_env = _MANAGED_PROVIDER_RUNTIME_ENV if managed else provider.runtime_env_name
    if api_mode:
        result["apiMode"] = api_mode
    if provider.managed_by == "clawdi":
        result["managed_by"] = provider.managed_by
    models: list[dict[str, Any]] = []
    if provider.models is not None:
        try:
            models = [
                model.model_dump(exclude_none=True)
                for model in _AI_PROVIDER_MODELS_ADAPTER.validate_python(provider.models)
            ]
        except ValidationError as exc:
            raise RuntimeSourceError("Stored AI provider model metadata is invalid") from exc
    if selected_model and not any(model["id"] == selected_model for model in models):
        models.insert(0, {"id": selected_model})
    if models:
        result["models"] = models
    if runtime_env:
        result["runtimeEnvName"] = runtime_env
    if provider.auth_type in {"api_key", "secret_ref"} and not secret_ref:
        result["apiKeyRequired"] = True
        result["status"] = "error"
        result["error"] = {
            "code": "provider_secret_unavailable",
            "message": "provider requires an API key but no runtime secret value is available",
        }
    if secret_ref and provider.auth_type in {"api_key", "secret_ref"}:
        result["apiKeySecretRef"] = secret_ref
    metadata = provider.auth_metadata or {}
    if provider.auth_type == "agent_profile" and metadata.get("tool") == "codex":
        profile = metadata.get("profile")
        if isinstance(profile, str) and profile.strip():
            result["auth"] = {
                "type": "agent_profile",
                "tool": "codex",
                "profile": profile.strip(),
            }
            if secret_ref and credential_revision:
                result["auth"]["credentialSecretRef"] = secret_ref
                result["auth"]["credentialRevision"] = credential_revision
            else:
                result["status"] = "error"
                result["error"] = {
                    "code": "provider_oauth_credential_unavailable",
                    "message": "provider OAuth credential is not owned by this runtime",
                }
    return result


def _unhealthy_provider(provider_id: str, consumer: str) -> dict[str, Any]:
    return {
        "kind": "openai-compatible",
        "status": "error",
        "error": {
            "code": "provider_not_found",
            "message": f"provider required by {consumer} is missing or archived",
        },
    }


def _provider_secret_ref(value: str) -> str:
    return f"secret://provider.{value}.apiKey"


def _provider_oauth_secret_ref(value: str) -> str:
    return f"secret://provider.{value}.oauthProfile"


def _secret_identity(
    row_id: UUID,
    ciphertext: bytes,
    nonce: bytes,
    key_identity: str,
    kind: str,
    *,
    key_version: str | None = None,
) -> dict[str, str]:
    identity = {
        "kind": kind,
        "codecVersion": "aes-256-gcm.v1",
        "keyIdentity": key_identity,
        "rowIdentity": str(row_id),
        "ciphertextSha256": hashlib.sha256(ciphertext).hexdigest(),
        "nonceSha256": hashlib.sha256(nonce).hexdigest(),
    }
    if key_version is not None:
        identity["keyVersion"] = key_version
    return identity


def _add_secret_source(
    sources: dict[str, dict[str, str]],
    secret_ref: str,
    identity: dict[str, str],
) -> None:
    if secret_ref in sources:
        raise RuntimeSourceError(f"Runtime secret reference collision: {secret_ref}")
    sources[secret_ref] = identity


def runtime_manifest_issued_at(state: HostedRuntimeState) -> str:
    value = _runtime_manifest_timestamp(state.updated_at, state.created_at)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def _runtime_manifest_timestamp(updated_at: object, created_at: datetime) -> datetime:
    return updated_at if isinstance(updated_at, datetime) else created_at


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
