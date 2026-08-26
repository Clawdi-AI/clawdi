from __future__ import annotations

import hmac
import io
import tarfile
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import (
    AuthContext,
    is_connected_agent_principal,
    require_auth_scopes,
    require_cli_auth,
)
from app.core.config import settings
from app.core.database import get_session, runtime_snapshot_session
from app.models.agent_project_binding import AgentProjectBinding
from app.models.api_key import ApiKey
from app.models.hosted_runtime import HostedRuntimeState
from app.models.project import PROJECT_KIND_WORKSPACE, Project
from app.models.project_membership import ProjectMembership
from app.models.session import AgentEnvironment
from app.models.skill import SKILL_AUTHORITY_CLOUD, Skill
from app.schemas.runtime import ProjectSkillCapabilityReport
from app.schemas.session import AgentProjectSkillDesiredItem, AgentProjectSkillDesiredResponse
from app.services.file_store import get_file_store
from app.services.http_cache import if_none_match_contains
from app.services.project_runtime_skills import (
    MAX_AGENT_PROJECT_SKILLS,
    assert_agent_project_skill_total,
    assert_project_skill_runtime_identity,
    project_skill_file_signature,
    project_skill_runtime_identity,
)
from app.services.runtime_source import (
    RUNTIME_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY,
    RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY,
    RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    RUNTIME_CAPABILITIES_HEADER,
    RenderedRuntimeSource,
    RuntimeSourceError,
    RuntimeSourceNotFoundError,
    ensure_runtime_whatsapp_credentials,
    expected_runtime_bundle_v2_etag,
    load_runtime_source_batch,
    render_runtime_bundle,
    render_runtime_source,
    runtime_whatsapp_credential_repair_link_ids,
    vault_key_identity,
)
from app.services.runtime_source_authority import load_persisted_runtime_source_authority
from app.services.runtime_source_revision import (
    persisted_runtime_source_revision,
    repair_runtime_source_revision,
)
from app.services.sync_events import queue_environment_runtime_manifest_changed
from app.services.tar_utils import reroot_skill_archive, tar_from_content

router = APIRouter(prefix="/runtime", tags=["runtime"])
_RUNTIME_MANIFEST_CACHE_CONTROL = "no-store, no-transform"
_RUNTIME_MANIFEST_VARY = f"Accept, {RUNTIME_CAPABILITIES_HEADER}"
_PROJECT_SKILL_SUPPORT_DIRS = {"references", "templates", "scripts", "assets", "examples"}
_MAX_PROJECT_SKILL_FILE_BYTES = 16 * 1024 * 1024
_MAX_PROJECT_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024
file_store = get_file_store()


@dataclass(frozen=True, slots=True)
class _RuntimeManifestSnapshot:
    source: RenderedRuntimeSource | None
    etag: str | None
    repair_link_ids: tuple[UUID, ...]


@router.get("/manifest")
async def get_runtime_manifest(
    request: Request,
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> Response:
    environment_id = _authorized_environment_id(auth, requested_environment_id)
    if request.headers.get("accept") != RUNTIME_BUNDLE_V2_MEDIA_TYPE:
        raise HTTPException(
            status.HTTP_406_NOT_ACCEPTABLE,
            "Unsupported runtime media type",
            headers={"Cache-Control": "no-store", "Vary": "Accept"},
        )

    capabilities = {
        capability.strip()
        for capability in request.headers.get(RUNTIME_CAPABILITIES_HEADER, "").split(",")
        if capability.strip()
    }
    project_agent_plugins = RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY in capabilities
    project_agent_plugin_github_release_sources = (
        RUNTIME_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY in capabilities
    )
    if_none_match = request.headers.get("if-none-match")
    try:
        snapshot = await _render_runtime_source_snapshot(
            db=db,
            environment_id=environment_id,
            owner_user_id=auth.user_id,
            if_none_match=if_none_match,
            project_agent_plugins=project_agent_plugins,
            project_agent_plugin_github_release_sources=project_agent_plugin_github_release_sources,
        )
        if snapshot.repair_link_ids:
            await ensure_runtime_whatsapp_credentials(
                db,
                environment_id=environment_id,
                owner_user_id=auth.user_id,
                link_ids=snapshot.repair_link_ids,
            )
            await queue_environment_runtime_manifest_changed(
                db,
                auth.user_id,
                environment_id,
            )
            await db.commit()
            snapshot = await _render_runtime_source_snapshot(
                db=db,
                environment_id=environment_id,
                owner_user_id=auth.user_id,
                if_none_match=if_none_match,
                project_agent_plugins=project_agent_plugins,
                project_agent_plugin_github_release_sources=project_agent_plugin_github_release_sources,
            )
        if snapshot.repair_link_ids or snapshot.etag is None:
            raise RuntimeSourceError(
                "Active runtime WhatsApp Link has no synthetic credential material"
            )
    except RuntimeSourceNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except RuntimeSourceError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    headers = {
        "ETag": snapshot.etag,
        "Cache-Control": _RUNTIME_MANIFEST_CACHE_CONTROL,
        "Vary": _RUNTIME_MANIFEST_VARY,
        "Content-Type": RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    }
    if snapshot.source is None:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    payload = render_runtime_bundle(snapshot.source)
    return JSONResponse(payload, headers=headers)


async def _render_runtime_source_snapshot(
    *,
    db: AsyncSession,
    environment_id: UUID,
    owner_user_id: UUID,
    if_none_match: str | None,
    project_agent_plugins: bool,
    project_agent_plugin_github_release_sources: bool,
) -> _RuntimeManifestSnapshot:
    canonical_projection = project_agent_plugins and project_agent_plugin_github_release_sources
    if if_none_match is not None:
        async with runtime_snapshot_session() as source_db:
            authority = await load_persisted_runtime_source_authority(
                source_db,
                environment_id=environment_id,
                owner_user_id=owner_user_id,
            )
        if (
            authority.matches_projection(
                project_agent_plugins=project_agent_plugins,
                project_agent_plugin_github_release_sources=(
                    project_agent_plugin_github_release_sources
                ),
            )
            and authority.etag is not None
            and if_none_match_contains(if_none_match, authority.etag)
        ):
            return _RuntimeManifestSnapshot(
                source=None,
                etag=authority.etag,
                repair_link_ids=(),
            )

    async with runtime_snapshot_session() as source_db:
        batch = await load_runtime_source_batch(
            source_db,
            environment_ids=[environment_id],
            owner_user_id=owner_user_id,
        )
        repair_link_ids = runtime_whatsapp_credential_repair_link_ids(
            batch,
            environment_id=environment_id,
        )
        if repair_link_ids:
            return _RuntimeManifestSnapshot(
                source=None,
                etag=None,
                repair_link_ids=repair_link_ids,
            )
        source_row = batch.rows.get(environment_id)
        if source_row is None:
            raise RuntimeSourceNotFoundError("Agent environment not found")
        state = source_row.state
        if state is None:
            raise RuntimeSourceNotFoundError("Hosted runtime state not found")
        expected_revision = state.source_revision
        expected_contract = state.source_revision_contract
        try:
            canonical_source = render_runtime_source(
                batch,
                environment_id=environment_id,
                public_api_url=settings.public_api_url,
                vault_key_identity=vault_key_identity(settings.vault_encryption_key),
                decrypt_secrets=False,
            )
            source_without_secrets = (
                canonical_source
                if canonical_projection
                else render_runtime_source(
                    batch,
                    environment_id=environment_id,
                    public_api_url=settings.public_api_url,
                    vault_key_identity=vault_key_identity(settings.vault_encryption_key),
                    decrypt_secrets=False,
                    project_agent_plugins=project_agent_plugins,
                    project_agent_plugin_github_release_sources=(
                        project_agent_plugin_github_release_sources
                    ),
                )
            )
        except RuntimeSourceError:
            if expected_revision is not None:
                repaired = await repair_runtime_source_revision(
                    db,
                    environment_id=environment_id,
                    expected_revision=expected_revision,
                    expected_contract=expected_contract,
                    computed_revision=None,
                )
                if repaired:
                    await db.commit()
            raise
        etag = expected_runtime_bundle_v2_etag(source_without_secrets.source_revision)
        source = None
        if not if_none_match_contains(if_none_match, etag):
            source = render_runtime_source(
                batch,
                environment_id=environment_id,
                public_api_url=settings.public_api_url,
                vault_key_identity=vault_key_identity(settings.vault_encryption_key),
                decrypt_secrets=True,
                project_agent_plugins=project_agent_plugins,
                project_agent_plugin_github_release_sources=(
                    project_agent_plugin_github_release_sources
                ),
            )
            if source.source_revision != source_without_secrets.source_revision:
                raise RuntimeSourceError("Runtime source revision depends on secret decryption")

    if (
        expected_revision != canonical_source.source_revision
        or persisted_runtime_source_revision(state) is None
    ):
        repaired = await repair_runtime_source_revision(
            db,
            environment_id=environment_id,
            expected_revision=expected_revision,
            expected_contract=expected_contract,
            computed_revision=canonical_source.source_revision,
        )
        if repaired:
            await db.commit()
    return _RuntimeManifestSnapshot(source=source, etag=etag, repair_link_ids=())


def _authorized_environment_id(auth: AuthContext, requested_environment_id: UUID | None) -> UUID:
    bound = auth.api_key.environment_id if auth.api_key is not None else None
    if bound is not None:
        if requested_environment_id is not None and requested_environment_id != bound:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "api key bound to a different environment"
            )
        return bound
    if requested_environment_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "runtime manifest requires an environment id"
        )
    return requested_environment_id


@router.put("/project-skill-capability", status_code=status.HTTP_204_NO_CONTENT)
async def report_project_skill_capability(
    body: ProjectSkillCapabilityReport,
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Renew the short-lived Connected Project Skill reconciliation lease."""
    require_auth_scopes(auth, "skills:write")
    agent_id = _authorized_environment_id(auth, requested_environment_id)
    agent = await _connected_agent(db, auth=auth, agent_id=agent_id)
    # Compatibility observation only; desired-state reads and writes never
    # consult these fields.
    agent.project_skill_reconcile_version = body.project_skill_reconcile_version
    agent.project_skill_reconcile_observed_at = datetime.now(UTC)
    await db.commit()


async def _connected_agent(
    db: AsyncSession,
    *,
    auth: AuthContext,
    agent_id: UUID,
) -> AgentEnvironment:
    has_environment_bound_key = exists().where(
        ApiKey.environment_id == AgentEnvironment.id,
    )
    row = (
        await db.execute(
            select(AgentEnvironment, HostedRuntimeState, has_environment_bound_key)
            .outerjoin(
                HostedRuntimeState,
                HostedRuntimeState.environment_id == AgentEnvironment.id,
            )
            .where(
                AgentEnvironment.id == agent_id,
                AgentEnvironment.user_id == auth.user_id,
                AgentEnvironment.archived_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent not found")
    agent, hosted_v2_state, has_environment_bound_key = row
    if (
        not is_connected_agent_principal(auth)
        or agent.registration_key is None
        or agent.connected_agent_registered_at is None
        or hosted_v2_state is not None
        or has_environment_bound_key
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "connected_agent_required",
                "message": (
                    "Project Skill capability reports are only accepted from Connected Agents."
                ),
            },
        )
    return agent


@router.get("/project-skills", response_model=AgentProjectSkillDesiredResponse)
async def get_agent_project_skills(
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_session),
) -> AgentProjectSkillDesiredResponse:
    """Return one Agent's complete linked-Project Skill inventory."""
    require_auth_scopes(auth, "skills:read")
    agent_id = _authorized_environment_id(auth, requested_environment_id)
    await _connected_agent(db, auth=auth, agent_id=agent_id)
    membership = ProjectMembership.__table__.alias("desired_project_skill_membership")
    rows = (
        (
            await db.execute(
                select(Skill)
                .join(Project, Project.id == Skill.project_id)
                .join(
                    AgentProjectBinding,
                    (AgentProjectBinding.project_id == Project.id)
                    & (AgentProjectBinding.agent_id == agent_id),
                )
                .join(AgentEnvironment, AgentEnvironment.id == AgentProjectBinding.agent_id)
                .outerjoin(
                    membership,
                    (membership.c.project_id == Project.id)
                    & (membership.c.member_user_id == AgentEnvironment.user_id),
                )
                .where(
                    AgentEnvironment.id == agent_id,
                    AgentEnvironment.user_id == auth.user_id,
                    AgentEnvironment.archived_at.is_(None),
                    AgentProjectBinding.binding_type == "context",
                    Project.kind == PROJECT_KIND_WORKSPACE,
                    Project.archived_at.is_(None),
                    (Project.user_id == AgentEnvironment.user_id) | membership.c.id.is_not(None),
                    Skill.authority == SKILL_AUTHORITY_CLOUD,
                    Skill.is_active,
                )
                .order_by(Skill.skill_key, Skill.project_id, Skill.id)
                .limit(MAX_AGENT_PROJECT_SKILLS + 1)
            )
        )
        .scalars()
        .all()
    )
    assert_agent_project_skill_total(len(rows))
    seen_local_keys: set[str] = set()
    for skill in rows:
        identity = project_skill_runtime_identity(skill.skill_key, skill.name)
        assert_project_skill_runtime_identity(identity)
        if identity.local_skill_key in seen_local_keys:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f'Skill "{identity.local_skill_key}" comes from more than one linked Project. '
                "Unlink one Project.",
            )
        seen_local_keys.add(identity.local_skill_key)

    base_url = settings.public_api_url.rstrip("/")
    signing_key = vault_key_identity(settings.vault_encryption_key)
    skills: list[AgentProjectSkillDesiredItem] = []
    for skill in rows:
        local_skill_key = project_skill_runtime_identity(
            skill.skill_key,
            skill.name,
        ).local_skill_key
        signature = project_skill_file_signature(
            signing_key=signing_key,
            agent_id=agent_id,
            skill_id=skill.id,
            content_hash=skill.content_hash,
        )
        skills.append(
            AgentProjectSkillDesiredItem(
                project_id=str(skill.project_id),
                skill_id=str(skill.id),
                skill_key=local_skill_key,
                content_hash=skill.content_hash,
                archive_url=(
                    f"{base_url}/v1/runtime/project-skill-archives/{agent_id}/"
                    f"{skill.project_id}/{skill.id}/{skill.content_hash}/{signature}/"
                    f"{quote(local_skill_key, safe='')}.tar.gz"
                ),
            )
        )
    return AgentProjectSkillDesiredResponse(agent_id=str(agent_id), skills=skills)


@router.get(
    (
        "/project-skill-archives/{agent_id}/{project_id}/{skill_id}/{content_hash}/"
        "{signature}/{skill_key}.tar.gz"
    ),
    include_in_schema=False,
)
async def get_project_skill_archive(
    agent_id: UUID,
    project_id: UUID,
    skill_id: UUID,
    content_hash: str = Path(pattern=r"^[a-f0-9]{64}$"),
    signature: str = Path(pattern=r"^[a-f0-9]{64}$"),
    skill_key: str = Path(pattern=r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Serve one manifest-bound Project Skill archive to the native installer."""
    _assert_project_skill_signature(agent_id, skill_id, content_hash, signature)
    skill = await _linked_project_skill(
        db,
        agent_id=agent_id,
        project_id=project_id,
        skill_id=skill_id,
        content_hash=content_hash,
        local_skill_key=skill_key,
    )
    if not skill.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found")
    local_skill_key = project_skill_runtime_identity(
        skill.skill_key,
        skill.name,
    ).local_skill_key
    try:
        stored = await file_store.get(skill.file_key)
        if skill.file_key.endswith(".md"):
            stored, _file_count = tar_from_content(local_skill_key, stored.decode("utf-8"))
        else:
            stored = reroot_skill_archive(stored, skill.skill_key, local_skill_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found") from None
    if len(stored) > _MAX_PROJECT_SKILL_ARCHIVE_BYTES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found")
    return Response(
        content=stored,
        media_type="application/gzip",
        headers={
            "Cache-Control": "private, no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/project-skill-files/{agent_id}/{skill_id}/{content_hash}/{signature}/{file_path:path}",
    include_in_schema=False,
)
async def get_project_skill_file(
    agent_id: UUID,
    skill_id: UUID,
    content_hash: str = Path(pattern=r"^[a-f0-9]{64}$"),
    signature: str = Path(pattern=r"^[a-f0-9]{64}$"),
    file_path: str = Path(min_length=1, max_length=1000),
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Serve one manifest-bound Project Skill file to Hermes' native URL installer."""
    _assert_project_skill_signature(agent_id, skill_id, content_hash, signature)
    relative_path = _validated_project_skill_file_path(file_path)
    skill = await _linked_project_skill(
        db,
        agent_id=agent_id,
        skill_id=skill_id,
        content_hash=content_hash,
    )
    if not skill.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
    try:
        stored = await file_store.get(skill.file_key)
    except Exception:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found") from None
    data = _extract_project_skill_file(stored, skill, relative_path)
    media_type = (
        "text/markdown; charset=utf-8"
        if relative_path.endswith(".md")
        else "application/octet-stream"
    )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Cache-Control": "private, no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _assert_project_skill_signature(
    agent_id: UUID,
    skill_id: UUID,
    content_hash: str,
    signature: str,
) -> None:
    expected = project_skill_file_signature(
        signing_key=vault_key_identity(settings.vault_encryption_key),
        agent_id=agent_id,
        skill_id=skill_id,
        content_hash=content_hash,
    )
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")


async def _linked_project_skill(
    db: AsyncSession,
    *,
    agent_id: UUID,
    skill_id: UUID,
    content_hash: str,
    project_id: UUID | None = None,
    local_skill_key: str | None = None,
) -> Skill:
    membership = ProjectMembership.__table__.alias("signed_project_skill_membership")
    filters = [
        Skill.id == skill_id,
        Skill.content_hash == content_hash,
        Skill.authority == SKILL_AUTHORITY_CLOUD,
        Skill.is_active,
        Project.kind == PROJECT_KIND_WORKSPACE,
        Project.archived_at.is_(None),
        AgentProjectBinding.binding_type == "context",
        AgentEnvironment.archived_at.is_(None),
        (Project.user_id == AgentEnvironment.user_id) | membership.c.id.is_not(None),
    ]
    if project_id is not None:
        filters.append(Project.id == project_id)
    skill = (
        await db.execute(
            select(Skill)
            .join(Project, Project.id == Skill.project_id)
            .join(
                AgentProjectBinding,
                (AgentProjectBinding.project_id == Project.id)
                & (AgentProjectBinding.agent_id == agent_id),
            )
            .join(AgentEnvironment, AgentEnvironment.id == AgentProjectBinding.agent_id)
            .outerjoin(
                membership,
                (membership.c.project_id == Project.id)
                & (membership.c.member_user_id == AgentEnvironment.user_id),
            )
            .where(*filters)
        )
    ).scalar_one_or_none()
    if skill is None or (
        local_skill_key is not None
        and project_skill_runtime_identity(
            skill.skill_key,
            skill.name,
        ).local_skill_key
        != local_skill_key
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
    return skill


def _validated_project_skill_file_path(value: str) -> str:
    segments = value.split("/")
    if (
        not segments
        or any(
            not segment
            or segment in {".", ".."}
            or "\\" in segment
            or any(ord(character) <= 0x1F or ord(character) == 0x7F for character in segment)
            for segment in segments
        )
        or (value != "SKILL.md" and segments[0] not in _PROJECT_SKILL_SUPPORT_DIRS)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
    return value


def _extract_project_skill_file(data: bytes, skill: Skill, relative_path: str) -> bytes:
    if skill.file_key and skill.file_key.endswith(".md"):
        if relative_path != "SKILL.md" or len(data) > _MAX_PROJECT_SKILL_FILE_BYTES:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
        return data
    member_name = f"{skill.skill_key}/{relative_path}"
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            member = archive.getmember(member_name)
            if not member.isfile() or member.size > _MAX_PROJECT_SKILL_FILE_BYTES:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
            source = archive.extractfile(member)
            if source is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
            result = source.read(_MAX_PROJECT_SKILL_FILE_BYTES + 1)
    except (KeyError, tarfile.TarError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found") from None
    if len(result) > _MAX_PROJECT_SKILL_FILE_BYTES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill file not found")
    return result
