from __future__ import annotations

import hmac
import io
import tarfile
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
from app.core.database import get_runtime_snapshot_session, get_session
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
    agent_supports_project_skills,
    assert_agent_project_skill_total,
    project_skill_file_signature,
)
from app.services.runtime_source import (
    RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY,
    RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    RUNTIME_CAPABILITIES_HEADER,
    RuntimeSourceError,
    RuntimeSourceNotFoundError,
    expected_runtime_bundle_v2_etag,
    load_runtime_source_batch,
    render_runtime_bundle,
    render_runtime_source,
    vault_key_identity,
)
from app.services.tar_utils import tar_from_content

router = APIRouter(prefix="/runtime", tags=["runtime"])
_RUNTIME_MANIFEST_CACHE_CONTROL = "no-store, no-transform"
_RUNTIME_MANIFEST_VARY = f"Accept, {RUNTIME_CAPABILITIES_HEADER}"
_PROJECT_SKILL_SUPPORT_DIRS = {"references", "templates", "scripts", "assets", "examples"}
_MAX_PROJECT_SKILL_FILE_BYTES = 16 * 1024 * 1024
_MAX_PROJECT_SKILL_ARCHIVE_BYTES = 25 * 1024 * 1024
file_store = get_file_store()


@router.get("/manifest")
async def get_runtime_manifest(
    request: Request,
    requested_environment_id: UUID | None = Query(default=None, alias="environment_id"),
    auth: AuthContext = Depends(require_cli_auth),
    db: AsyncSession = Depends(get_runtime_snapshot_session),
) -> Response:
    environment_id = _authorized_environment_id(auth, requested_environment_id)
    if request.headers.get("accept") != RUNTIME_BUNDLE_V2_MEDIA_TYPE:
        raise HTTPException(
            status.HTTP_406_NOT_ACCEPTABLE,
            "Unsupported runtime media type",
            headers={"Cache-Control": "no-store", "Vary": "Accept"},
        )

    batch = await load_runtime_source_batch(
        db,
        environment_ids=[environment_id],
        owner_user_id=auth.user_id,
    )
    capabilities = {
        capability.strip()
        for capability in request.headers.get(RUNTIME_CAPABILITIES_HEADER, "").split(",")
        if capability.strip()
    }
    try:
        source = render_runtime_source(
            batch,
            environment_id=environment_id,
            public_api_url=settings.public_api_url,
            vault_key_identity=vault_key_identity(settings.vault_encryption_key),
            decrypt_secrets=True,
            project_agent_plugins=(RUNTIME_AGENT_PLUGINS_MANIFEST_CAPABILITY in capabilities),
        )
    except RuntimeSourceNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except RuntimeSourceError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    payload = render_runtime_bundle(source)
    etag = expected_runtime_bundle_v2_etag(source.source_revision)
    headers = {
        "ETag": etag,
        "Cache-Control": _RUNTIME_MANIFEST_CACHE_CONTROL,
        "Vary": _RUNTIME_MANIFEST_VARY,
        "Content-Type": RUNTIME_BUNDLE_V2_MEDIA_TYPE,
    }
    if if_none_match_contains(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return JSONResponse(payload, headers=headers)


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
    agent = await _connected_agent(db, auth=auth, agent_id=agent_id)
    if not agent_supports_project_skills(
        agent,
        None,
        None,
        has_environment_bound_key=False,
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "project_skill_delivery_update_required",
                "message": "Update this Agent, then try again.",
            },
        )
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
    seen_keys: set[str] = set()
    for skill in rows:
        if skill.skill_key in seen_keys:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f'Skill "{skill.skill_key}" comes from more than one linked Project. '
                "Unlink one Project.",
            )
        seen_keys.add(skill.skill_key)

    base_url = settings.public_api_url.rstrip("/")
    signing_key = vault_key_identity(settings.vault_encryption_key)
    skills: list[AgentProjectSkillDesiredItem] = []
    for skill in rows:
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
                skill_key=skill.skill_key,
                content_hash=skill.content_hash,
                archive_url=(
                    f"{base_url}/v1/runtime/project-skill-archives/{agent_id}/"
                    f"{skill.project_id}/{skill.id}/{skill.content_hash}/{signature}/"
                    f"{quote(skill.skill_key, safe='')}.tar.gz"
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
        skill_key=skill_key,
    )
    if not skill.file_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Skill archive not found")
    try:
        stored = await file_store.get(skill.file_key)
        if skill.file_key.endswith(".md"):
            stored, _file_count = tar_from_content(skill.skill_key, stored.decode("utf-8"))
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
    skill_key: str | None = None,
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
    if skill_key is not None:
        filters.append(Skill.skill_key == skill_key)
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
    if skill is None:
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
