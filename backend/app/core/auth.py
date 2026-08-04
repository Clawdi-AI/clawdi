from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import canonical_clerk_issuer, settings
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.principal_lifecycle import PrincipalLifecycle
from app.models.user import PRINCIPAL_KIND_CLERK, User
from app.services.app_setting_registry import CLERK_CLI_OAUTH_SPEC
from app.services.app_settings import AppSettingUnavailable, resolve_app_setting
from app.services.clerk_backend import clerk_backend_headers, clerk_user_url
from app.services.clerk_cli_oauth_settings import ClerkCliOAuthSetting
from app.services.principal_lifecycle import (
    PrincipalIdentityConflictError,
    PrincipalTerminatedError,
    assert_clerk_principal_active,
    assert_user_authority_active,
    load_clerk_user_for_issuer,
)
from app.services.user_provisioning import lazy_create_user_with_personal_project

bearer_scheme = HTTPBearer()

# Same scheme but with `auto_error=False` so missing-credential requests
# don't 401 at the FastAPI dependency layer — handlers using this can
# treat the request as anonymous and decide their own response. Used by
# routes that serve both signed-in and signed-out visitors (e.g. the
# public share read where owner sees one view and anonymous sees
# another).
optional_bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)

API_KEY_PREFIX = "clawdi_"
_OAUTH_ACCESS_JWT_TYPES = frozenset({"at+jwt", "application/at+jwt"})
_CLERK_JWKS_LIFESPAN_SECONDS = 300
_CLERK_JWKS_TIMEOUT_SECONDS = 5

type _JwtClaims = dict[str, JsonValue]
_JWT_CLAIMS_ADAPTER: TypeAdapter[_JwtClaims] = TypeAdapter(dict[str, JsonValue])


class ClerkEmailVerification(BaseModel):
    status: str | None = None


class ClerkEmailAddress(BaseModel):
    id: str
    email_address: str
    verification: ClerkEmailVerification | None = None


class ClerkUserResponse(BaseModel):
    primary_email_address_id: str | None = None
    email_addresses: list[ClerkEmailAddress] = Field(default_factory=list)


_clerk_jwks_client = (
    jwt.PyJWKClient(
        f"{settings.clerk_jwt_issuer}/.well-known/jwks.json",
        cache_keys=True,
        lifespan=_CLERK_JWKS_LIFESPAN_SECONDS,
        timeout=_CLERK_JWKS_TIMEOUT_SECONDS,
    )
    if settings.clerk_jwt_issuer
    else None
)

# Only touch api_key.last_used_at if the previous update was at least this
# long ago. Every authenticated CLI request used to write+commit the row,
# which becomes write-lock contention on a hot key at scale.
LAST_USED_THROTTLE = timedelta(minutes=1)
# Daemons reconcile skills on a 60s cadence. The cache needs to span that
# interval to avoid turning every conditional GET into three auth DB reads.
# Dashboard revocation calls `invalidate_api_key_auth_cache`, so user-initiated
# revokes still take effect immediately in the single-process deployment model.
API_KEY_AUTH_CACHE_TTL_SECONDS = 75.0
API_KEY_AUTH_CACHE_MAX_SIZE = 4096


@dataclass(frozen=True)
class _CachedApiKeyAuth:
    api_key_id: UUID
    user_id: UUID
    key_hash: str
    key_prefix: str
    label: str
    scopes: tuple[str, ...] | None
    environment_id: UUID | None
    runtime_deployment_id: str | None
    managed: bool
    expires_at: datetime | None
    user_clerk_id: str | None
    user_clerk_issuer: str | None
    user_principal_kind: str
    user_partner_tenant_ref: str | None
    user_email: str | None
    user_name: str | None
    user_avatar_url: str | None
    skills_revision: int
    api_key_project_id: UUID | None

    def to_auth_context(self) -> AuthContext:
        user = User(
            id=self.user_id,
            clerk_id=self.user_clerk_id,
            clerk_issuer=self.user_clerk_issuer,
            principal_kind=self.user_principal_kind,
            partner_tenant_ref=self.user_partner_tenant_ref,
            email=self.user_email,
            name=self.user_name,
            avatar_url=self.user_avatar_url,
            skills_revision=self.skills_revision,
        )
        api_key = ApiKey(
            id=self.api_key_id,
            user_id=self.user_id,
            key_hash=self.key_hash,
            key_prefix=self.key_prefix,
            label=self.label,
            scopes=list(self.scopes) if self.scopes is not None else None,
            environment_id=self.environment_id,
            runtime_deployment_id=self.runtime_deployment_id,
            managed=self.managed,
            expires_at=self.expires_at,
            revoked_at=None,
        )
        return AuthContext(user=user, api_key=api_key, api_key_project_id=self.api_key_project_id)


_api_key_auth_cache: dict[str, tuple[float, _CachedApiKeyAuth]] = {}


def _get_cached_api_key_auth(key_hash: str) -> AuthContext | None:
    cached = _api_key_auth_cache.get(key_hash)
    if cached is None:
        return None
    expires_at, snapshot = cached
    if expires_at <= monotonic():
        _api_key_auth_cache.pop(key_hash, None)
        return None
    return snapshot.to_auth_context()


def _cache_api_key_auth(
    *,
    key_hash: str,
    api_key: ApiKey,
    user: User,
    api_key_project_id: UUID | None,
    now: datetime,
) -> None:
    ttl_seconds = API_KEY_AUTH_CACHE_TTL_SECONDS
    if api_key.expires_at is not None:
        ttl_seconds = min(ttl_seconds, max(0.0, (api_key.expires_at - now).total_seconds()))
    if ttl_seconds <= 0:
        return

    if len(_api_key_auth_cache) >= API_KEY_AUTH_CACHE_MAX_SIZE:
        current = monotonic()
        expired = [k for k, (expires_at, _) in _api_key_auth_cache.items() if expires_at <= current]
        for k in expired:
            _api_key_auth_cache.pop(k, None)
        while len(_api_key_auth_cache) >= API_KEY_AUTH_CACHE_MAX_SIZE:
            _api_key_auth_cache.pop(next(iter(_api_key_auth_cache)))

    _api_key_auth_cache[key_hash] = (
        monotonic() + ttl_seconds,
        _CachedApiKeyAuth(
            api_key_id=api_key.id,
            user_id=user.id,
            key_hash=api_key.key_hash,
            key_prefix=api_key.key_prefix,
            label=api_key.label,
            scopes=tuple(api_key.scopes) if api_key.scopes is not None else None,
            environment_id=api_key.environment_id,
            runtime_deployment_id=api_key.runtime_deployment_id,
            managed=api_key.managed,
            expires_at=api_key.expires_at,
            user_clerk_id=user.clerk_id,
            user_clerk_issuer=user.clerk_issuer,
            user_principal_kind=user.principal_kind,
            user_partner_tenant_ref=user.partner_tenant_ref,
            user_email=user.email,
            user_name=user.name,
            user_avatar_url=user.avatar_url,
            skills_revision=int(user.skills_revision or 0),
            api_key_project_id=api_key_project_id,
        ),
    )


def invalidate_api_key_auth_cache(api_key_id: UUID) -> None:
    for key_hash, (_, snapshot) in list(_api_key_auth_cache.items()):
        if snapshot.api_key_id == api_key_id:
            _api_key_auth_cache.pop(key_hash, None)


def invalidate_user_api_key_auth_cache(user_id: UUID) -> None:
    for key_hash, (_, snapshot) in list(_api_key_auth_cache.items()):
        if snapshot.user_id == user_id:
            _api_key_auth_cache.pop(key_hash, None)


async def _assert_active_user_or_401(db: AsyncSession, user_id: UUID) -> None:
    try:
        await assert_user_authority_active(db, user_id)
    except PrincipalTerminatedError:
        invalidate_user_api_key_auth_cache(user_id)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account has been terminated") from None


class AuthContext:
    def __init__(
        self,
        user: User,
        api_key: ApiKey | None = None,
        api_key_project_id: UUID | None = None,
        oauth_cli: bool = False,
        oauth_access_expires_at: datetime | None = None,
    ):
        self.user = user
        self.api_key = api_key
        # Keep `is_cli` API-key-only for compatibility with the existing
        # scope and capability gates. OAuth CLI access tokens carry this
        # separate marker so routes can explicitly opt into that identity.
        self.oauth_cli = oauth_cli
        if oauth_cli and (
            oauth_access_expires_at is None
            or oauth_access_expires_at.tzinfo is None
            or oauth_access_expires_at.utcoffset() is None
        ):
            raise ValueError("OAuth CLI auth requires a timezone-aware access-token expiry")
        self.oauth_access_expires_at: datetime | None = oauth_access_expires_at
        self.is_cli = api_key is not None
        self.api_key_project_id = api_key_project_id
        self._user_id = user.id
        self.skills_revision = int(user.skills_revision or 0)

    @property
    def user_id(self):
        return self._user_id


async def _auth_via_api_key(token: str, db: AsyncSession) -> AuthContext | None:
    if not token.startswith(API_KEY_PREFIX):
        return None

    key_hash = hashlib.sha256(token.encode()).hexdigest()
    cached = _get_cached_api_key_auth(key_hash)
    if cached is not None:
        await _assert_active_user_or_401(db, cached.user_id)
        # Bound Agent keys are an operational authority boundary. Revalidate
        # their durable key + Agent lifecycle on every cache hit so a request
        # racing archive commit cannot re-cache authority after the caller's
        # post-commit invalidation, and so other worker-local caches fail
        # closed immediately after they observe the committed archive.
        if cached.api_key is not None and cached.api_key.environment_id is not None:
            from app.models.session import AgentEnvironment

            active_key_id = await db.scalar(
                select(ApiKey.id)
                .join(
                    AgentEnvironment,
                    AgentEnvironment.id == ApiKey.environment_id,
                )
                .where(
                    ApiKey.id == cached.api_key.id,
                    ApiKey.revoked_at.is_(None),
                    AgentEnvironment.archived_at.is_(None),
                )
            )
            if active_key_id is None:
                _api_key_auth_cache.pop(key_hash, None)
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key has been revoked")
        return cached

    result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
    api_key = result.scalar_one_or_none()

    if not api_key:
        return None
    if api_key.revoked_at:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key has been revoked")
    now = datetime.now(UTC)
    if api_key.expires_at and api_key.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key has expired")

    result = await db.execute(select(User).where(User.id == api_key.user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    await _assert_active_user_or_401(db, user.id)

    # Throttle last_used_at writes: once per LAST_USED_THROTTLE per key.
    last = api_key.last_used_at
    if last is None or (now - last) > LAST_USED_THROTTLE:
        api_key.last_used_at = now
        await db.commit()
        # Commit releases the authority lock. Reacquire and recheck before
        # returning a credential snapshot to the route.
        await _assert_active_user_or_401(db, user.id)

    api_key_project_id = None
    if api_key.environment_id is not None:
        from app.models.session import AgentEnvironment

        api_key_project_id = (
            await db.execute(
                select(AgentEnvironment.default_project_id).where(
                    AgentEnvironment.id == api_key.environment_id,
                    AgentEnvironment.user_id == api_key.user_id,
                    AgentEnvironment.archived_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if api_key_project_id is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Agent is archived")

    # Agent-bound keys are lifecycle authority and must never be installed in
    # a process-local cache. A cache fill racing archive commit could otherwise
    # happen after the archive caller's post-commit invalidation. Unbound keys
    # retain the existing cache behavior.
    if api_key.environment_id is None:
        _cache_api_key_auth(
            key_hash=key_hash,
            api_key=api_key,
            user=user,
            api_key_project_id=api_key_project_id,
            now=now,
        )
    return AuthContext(user=user, api_key=api_key, api_key_project_id=api_key_project_id)


async def _auth_via_dev_bypass(token: str, db: AsyncSession) -> AuthContext | None:
    if not settings.dev_auth_bypass:
        return None
    if token != settings.dev_auth_token:
        return None
    if settings.environment != "development":
        logger.error(
            "dev_auth_bypass refused outside development environment=%s",
            settings.environment,
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "dev auth bypass is only available in development",
        )

    clerk_id = settings.dev_auth_clerk_id
    try:
        issuer = await assert_clerk_principal_active(db, subject=clerk_id)
    except PrincipalTerminatedError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account has been terminated") from None
    if issuer is None:
        user = (
            await db.execute(
                select(User).where(
                    User.principal_kind == PRINCIPAL_KIND_CLERK,
                    User.clerk_id == clerk_id,
                )
            )
        ).scalar_one_or_none()
    else:
        try:
            user = await load_clerk_user_for_issuer(
                db,
                issuer=issuer,
                subject=clerk_id,
                bind_legacy=True,
            )
        except PrincipalIdentityConflictError:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid account identity") from None
    if user is None:
        user = await lazy_create_user_with_personal_project(
            db,
            clerk_id=clerk_id,
            clerk_issuer=issuer,
            email=settings.dev_auth_email,
            name=settings.dev_auth_name,
            avatar_url=None,
            race_loser_status=status.HTTP_401_UNAUTHORIZED,
            inactive_status=status.HTTP_401_UNAUTHORIZED,
        )
        await db.commit()
        await db.refresh(user)
        logger.info("dev_auth_user_created clerk_id=%s user_id=%s", clerk_id, user.id)
    await _assert_active_user_or_401(db, user.id)
    return AuthContext(user=user)


async def _fetch_clerk_primary_email(clerk_user_id: str) -> str | None:
    """Look up a Clerk user's verified primary email via the Backend API.

    Returns the email only if Clerk explicitly marks it as the user's primary
    AND its verification status is "verified". Returns None for any other
    outcome (network failure, non-200, malformed payload, no primary marked,
    primary unverified). This is identity-binding: callers use the result to
    decide which existing user row to take over, so we refuse to guess.
    """
    url = clerk_user_url(clerk_user_id)
    # Clerk's API is fronted by Cloudflare, which serves a 403 (error 1010)
    # for requests lacking a recognizable User-Agent — including httpx's
    # default. Set an explicit one.
    headers = clerk_backend_headers()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            logger.warning(
                "clerk backend api returned %s for user %s",
                resp.status_code,
                clerk_user_id,
            )
            return None
        data = ClerkUserResponse.model_validate_json(resp.content)
    except (httpx.HTTPError, ValidationError) as e:
        logger.warning("clerk backend api lookup failed for %s: %s", clerk_user_id, e)
        return None

    primary_id = data.primary_email_address_id
    if not primary_id:
        logger.warning("clerk user %s has no primary_email_address_id", clerk_user_id)
        return None
    for entry in data.email_addresses:
        if entry.id != primary_id:
            continue
        verification_status = entry.verification.status if entry.verification is not None else None
        if verification_status != "verified":
            logger.warning(
                "clerk primary email for %s is not verified (status=%s)",
                clerk_user_id,
                verification_status,
            )
            return None
        return entry.email_address
    logger.warning(
        "clerk user %s primary_email_address_id %s not in email_addresses",
        clerk_user_id,
        primary_id,
    )
    return None


def _is_oauth_access_jwt(token: str) -> bool:
    """Return whether a token declares Clerk's OAuth access-token media type.

    Header inspection only selects the validation profile; all trust decisions
    still happen in the signature-verified decode below.
    """
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError:
        return False
    token_type: object = header.get("typ")
    return token_type in _OAUTH_ACCESS_JWT_TYPES


def _oauth_audience_matches(payload: _JwtClaims, oauth_setting: ClerkCliOAuthSetting) -> bool:
    expected = oauth_setting.audience
    audience = payload.get("aud")
    if not expected or audience is None:
        return True
    if isinstance(audience, str):
        token_audiences = {audience}
    elif (
        isinstance(audience, list) and audience and all(isinstance(item, str) for item in audience)
    ):
        token_audiences = set(audience)
    else:
        return False

    return expected in token_audiences


def _oauth_authorized_party_matches(
    payload: _JwtClaims, oauth_setting: ClerkCliOAuthSetting
) -> bool:
    expected = set(oauth_setting.authorized_parties)
    if not expected:
        return True
    authorized_party = payload.get("azp")
    if not isinstance(authorized_party, str) or not authorized_party:
        return False
    return authorized_party in expected


def _session_claims_match_configured_clerk_values(payload: _JwtClaims) -> bool:
    """Apply independently configured claim binding to browser sessions.

    Browser session JWTs predate the OAuth Public App integration, so an empty
    setting preserves the historical signature-only behavior. Once an issuer
    or audience is configured, its claim is required and must match exactly.
    """
    if settings.clerk_jwt_issuer and payload.get("iss") != settings.clerk_jwt_issuer:
        return False

    if settings.clerk_jwt_audience:
        audience = payload.get("aud")
        if isinstance(audience, str):
            return audience == settings.clerk_jwt_audience
        if isinstance(audience, list):
            return settings.clerk_jwt_audience in audience
        return False

    return True


async def warm_clerk_jwks() -> None:
    """Warm the shared JWKS cache without making startup depend on Clerk."""
    if settings.clerk_pem_public_key or _clerk_jwks_client is None:
        return
    try:
        await asyncio.to_thread(_clerk_jwks_client.get_signing_keys)
    except Exception:  # noqa: BLE001 - warmup must never prevent startup
        logger.warning("Clerk JWKS warmup failed.", exc_info=True)
    else:
        logger.info("Clerk JWKS cache warmed.")


async def _resolve_clerk_signing_key(token: str) -> str | jwt.PyJWK | None:
    if settings.clerk_pem_public_key:
        return settings.clerk_pem_public_key
    if _clerk_jwks_client is None:
        logger.error("Clerk JWT verification is not configured: CLERK_JWT_ISSUER is empty.")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk JWT verification is not configured",
        )

    try:
        return await asyncio.to_thread(_clerk_jwks_client.get_signing_key_from_jwt, token)
    except jwt.PyJWKClientConnectionError as error:
        logger.exception("Clerk JWKS signing-key lookup failed.")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk JWT verification is temporarily unavailable",
        ) from error
    except (jwt.InvalidTokenError, jwt.PyJWKClientError):
        return None
    except Exception as error:  # noqa: BLE001 - external JWKS failures must be clean auth errors
        logger.exception("Clerk JWKS signing-key lookup failed.")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Clerk JWT verification is temporarily unavailable",
        ) from error


def _decode_clerk_session_jwt(token: str, signing_key: str | jwt.PyJWK) -> _JwtClaims | None:
    try:
        payload = _JWT_CLAIMS_ADAPTER.validate_python(
            jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                options={"verify_aud": False, "verify_iss": False},
            )
        )
    except (jwt.InvalidTokenError, ValidationError):
        return None
    return payload if _session_claims_match_configured_clerk_values(payload) else None


def _decode_clerk_oauth_access_jwt(
    token: str,
    signing_key: str | jwt.PyJWK,
    oauth_setting: ClerkCliOAuthSetting,
) -> _JwtClaims | None:
    try:
        payload = _JWT_CLAIMS_ADAPTER.validate_python(
            jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                issuer=oauth_setting.issuer,
                leeway=5,
                options={
                    "require": ["iss", "exp", "sub", "client_id"],
                    # Clerk OAuth JWTs do not always include aud. Match Clerk's
                    # SDK contract: validate it only when the claim is present.
                    "verify_aud": False,
                    "verify_exp": True,
                    "verify_iat": True,
                    "verify_iss": True,
                    "verify_nbf": True,
                },
            )
        )
    except (jwt.InvalidTokenError, ValidationError):
        return None

    clerk_id = payload.get("sub")
    client_id = payload.get("client_id")
    if not isinstance(clerk_id, str) or not clerk_id.strip():
        return None
    if client_id != oauth_setting.client_id:
        return None
    if not _oauth_audience_matches(payload, oauth_setting):
        return None
    if not _oauth_authorized_party_matches(payload, oauth_setting):
        return None
    return payload


async def _auth_via_clerk_jwt(token: str, db: AsyncSession) -> AuthContext | None:
    oauth_setting: ClerkCliOAuthSetting | None = None
    if _is_oauth_access_jwt(token):
        try:
            oauth_setting = await resolve_app_setting(db, CLERK_CLI_OAUTH_SPEC)
        except AppSettingUnavailable as error:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "OAuth CLI authentication is not configured",
            ) from error
        if not oauth_setting.enabled:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "OAuth CLI authentication is not configured",
            )
    signing_key = await _resolve_clerk_signing_key(token)
    if signing_key is None:
        return None
    if oauth_setting is None:
        payload = _decode_clerk_session_jwt(token, signing_key)
    else:
        payload = _decode_clerk_oauth_access_jwt(token, signing_key, oauth_setting)
    if payload is None:
        return None

    clerk_id = payload.get("sub")
    if not isinstance(clerk_id, str) or not clerk_id:
        return None
    # OAuth access tokens are independently bound to the issuer stored in the
    # validated Public App setting. Browser sessions use the configured Clerk
    # JWT issuer (or, for the legacy PEM-only mode, their verified claim).
    issuer = oauth_setting.issuer if oauth_setting is not None else settings.clerk_jwt_issuer
    if not issuer:
        claimed_issuer = payload.get("iss")
        if isinstance(claimed_issuer, str):
            try:
                issuer = canonical_clerk_issuer(claimed_issuer)
            except ValueError:
                return None
    try:
        await assert_clerk_principal_active(
            db,
            subject=clerk_id,
            issuer=issuer or None,
        )
        if issuer:
            user = await load_clerk_user_for_issuer(
                db,
                issuer=issuer,
                subject=clerk_id,
                bind_legacy=True,
            )
        else:
            user = (
                await db.execute(
                    select(User).where(
                        User.principal_kind == PRINCIPAL_KIND_CLERK,
                        User.clerk_id == clerk_id,
                    )
                )
            ).scalar_one_or_none()
    except PrincipalTerminatedError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account has been terminated") from None
    except PrincipalIdentityConflictError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid account identity") from None
    if user is not None:
        await _assert_active_user_or_401(db, user.id)

    raw_email = payload.get("email") or payload.get("email_address")
    email = raw_email if isinstance(raw_email, str) and raw_email else None
    raw_name = payload.get("name")
    name = raw_name if isinstance(raw_name, str) and raw_name else None
    raw_picture = payload.get("picture")
    picture = raw_picture if isinstance(raw_picture, str) and raw_picture else None

    # Backfill email/name on rows that were lazy-created via the
    # admin path (`_resolve_or_create_user` in routes/admin.py) — that
    # path doesn't have a Clerk JWT in context so the row starts with
    # email=None / name=None. The first time the user signs into
    # cloud.clawdi.ai directly, this branch fills them in.
    #
    # Idempotent: once filled, subsequent JWTs hit the same row,
    # see non-null values, and skip the update. Backfill only — we
    # NEVER overwrite an existing email/name because that would let
    # a Clerk-side display-name change silently rewrite our row
    # (Clerk is the source of truth for identity, not display).
    if user is not None and ((user.email is None and email) or (user.name is None and name)):
        if user.email is None and email:
            user.email = email
        if user.name is None and name:
            user.name = name
        try:
            await db.commit()
            await db.refresh(user)
            # Log only on the success path. If the commit raises and
            # we fall into the rollback branch below, this request is
            # the race LOSER — the winner already wrote the values
            # and is the one whose log line should claim the backfill.
            # Logging here both ways would lie about who wrote what
            # and corrupt audit / debugging trails.
            logger.info("user_backfill clerk_id=%s user_id=%s", clerk_id, user.id)
        except IntegrityError:
            # Concurrent backfill — another request won. Re-read the
            # row (which now carries the winner's values) instead of
            # 500-ing the user out of their session.
            await db.rollback()
            result = await db.execute(
                select(User).where(
                    User.principal_kind == PRINCIPAL_KIND_CLERK,
                    User.clerk_id == clerk_id,
                )
            )
            user = result.scalar_one()

    # Sub miss + snapshot-rebind opted in: try to attach to an existing
    # snapshot row by verified email. We deliberately fail closed if any
    # part of the identity proof is missing or ambiguous — a flaky Clerk
    # API or a duplicate-email row must NOT silently fall through to
    # auto-create, because the resulting empty row would then match this
    # Clerk sub on every subsequent login and permanently shadow the
    # real snapshot row.
    if not user and settings.enable_snapshot_email_rebind:
        if not email and settings.clerk_secret_key:
            email = await _fetch_clerk_primary_email(clerk_id)
        if not email:
            logger.warning(
                "snapshot rebind: refusing sign-in for clerk_id %s — no verified email",
                clerk_id,
            )
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Could not verify account identity for snapshot rebind.",
            )

        # `users.email` is not unique in the schema (production allows
        # duplicates). Refuse to pick one if the result is ambiguous —
        # whoever signs in first would otherwise get to choose which
        # row they take over.
        result = await db.execute(
            select(User)
            .where(
                User.principal_kind == PRINCIPAL_KIND_CLERK,
                User.email == email,
                ~select(PrincipalLifecycle.id)
                .where(PrincipalLifecycle.user_id == User.id)
                .exists(),
                or_(
                    User.clerk_issuer.is_(None),
                    User.clerk_issuer == issuer,
                )
                if issuer
                else User.clerk_issuer.is_(None),
            )
            .order_by(User.created_at)
            .limit(2)
        )
        candidates = list(result.scalars())
        if len(candidates) > 1:
            logger.error("snapshot rebind: ambiguous email match for %s (>=2 users)", email)
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Multiple accounts match this email; cannot rebind.",
            )
        if candidates:
            user = candidates[0]
            await _assert_active_user_or_401(db, user.id)
            logger.info(
                "snapshot rebind: user %s clerk_id %s -> %s (email match)",
                user.id,
                user.clerk_id,
                clerk_id,
            )
            user.clerk_id = clerk_id
            user.clerk_issuer = issuer or None
            # Concurrent rebind race: two requests carrying the
            # same Clerk JWT can both read the same candidate
            # row, both write the same `clerk_id`, and the
            # second commit hits `users_clerk_id_key` unique
            # violation. Pre-fix this 500'd dashboard /stats /
            # contribution / memories for affected users (14
            # events observed in prod log post-#66 deploy).
            # Catch the IntegrityError, rollback, and re-query
            # by clerk_id — by the time we get here the winner
            # has committed and the row carries the new
            # clerk_id, so the lookup converges.
            try:
                await db.commit()
                await db.refresh(user)
            except IntegrityError:
                await db.rollback()
                if issuer:
                    try:
                        user = await load_clerk_user_for_issuer(
                            db,
                            issuer=issuer,
                            subject=clerk_id,
                            bind_legacy=True,
                        )
                    except PrincipalIdentityConflictError:
                        user = None
                else:
                    result = await db.execute(
                        select(User).where(
                            User.principal_kind == PRINCIPAL_KIND_CLERK,
                            User.clerk_id == clerk_id,
                        )
                    )
                    user = result.scalar_one_or_none()
                if user is None:
                    # Both writers somehow lost the row — extremely
                    # unlikely (would require a concurrent delete
                    # of all matching rows). Fail closed with
                    # 401 rather than 500 so the client retries.
                    raise HTTPException(
                        status.HTTP_401_UNAUTHORIZED,
                        "could not load user after rebind race",
                    ) from None

    if not user:
        # First login (production path, or rebind enabled with no
        # match): create a fresh user row + Personal project bound to
        # this Clerk sub. Downstream resolvers assume every user has
        # a Personal project; the helper enforces that invariant in a
        # single transaction.
        #
        # Race-loser status is 401: this is a user-auth flow, so a
        # vanishing winner row is fail-closed-and-let-the-client-
        # retry territory, not the operational 500 the admin path
        # uses.
        user = await lazy_create_user_with_personal_project(
            db,
            clerk_id=clerk_id,
            clerk_issuer=issuer or None,
            email=email,
            name=name,
            avatar_url=picture,
            race_loser_status=status.HTTP_401_UNAUTHORIZED,
            inactive_status=status.HTTP_401_UNAUTHORIZED,
        )
        # Helper leaves rows flushed-not-committed so admin callers
        # can bundle their own writes. The JWT path has nothing else
        # to write, so commit + refresh here.
        await db.commit()
        await db.refresh(user)

    # Refresh `avatar_url` opportunistically on every login — Clerk
    # rotates signed picture URLs, and the share page would otherwise
    # render a stale 404'd avatar. Only commit when the value actually
    # changed to avoid a write-per-request. `name` is intentionally NOT
    # synced here: the contract elsewhere (see backfill tests) is that
    # user.name is one-way — once set, it's user-owned and not
    # clobbered by Clerk on subsequent logins.
    new_avatar = picture
    if new_avatar and user.avatar_url != new_avatar:
        user.avatar_url = new_avatar
        try:
            await db.commit()
        except SQLAlchemyError:
            # Non-fatal — auth still proceeds with the in-memory user.
            # Narrow to SQLAlchemyError so coding bugs surface instead
            # of being silently swallowed.
            await db.rollback()

    oauth_cli = oauth_setting is not None
    oauth_access_expires_at: datetime | None = None
    if oauth_cli:
        expires_at = payload.get("exp")
        if not isinstance(expires_at, (int, float)) or isinstance(expires_at, bool):
            return None
        try:
            oauth_access_expires_at = datetime.fromtimestamp(expires_at, UTC)
        except (OverflowError, OSError, ValueError):
            # PyJWT can validate a numerically huge future exp even when the
            # platform datetime cannot represent it. Treat hostile/unusable
            # timestamps as invalid auth instead of turning them into a 500.
            return None

    try:
        await assert_clerk_principal_active(
            db,
            subject=clerk_id,
            issuer=issuer or None,
        )
    except PrincipalTerminatedError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account has been terminated") from None
    await _assert_active_user_or_401(db, user.id)
    return AuthContext(
        user=user,
        oauth_cli=oauth_cli,
        oauth_access_expires_at=oauth_access_expires_at,
    )


async def get_auth(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_session),
) -> AuthContext:
    token = credentials.credentials

    ctx = await _auth_via_dev_bypass(token, db)
    if ctx:
        return ctx

    # Try ApiKey first (fast path, prefix check)
    ctx = await _auth_via_api_key(token, db)
    if ctx:
        return ctx

    # Fall through to Clerk JWT
    ctx = await _auth_via_clerk_jwt(token, db)
    if ctx:
        return ctx

    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")


async def get_auth_short_session(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> AuthContext:
    """Like `get_auth` but opens and CLOSES its own short-lived DB
    session before returning, instead of consuming the request-scoped
    `get_session` dependency.

    Long-lived endpoints (SSE) use this so each connected daemon
    doesn't pin one `AsyncSession` / DB connection for the entire
    stream lifetime. High-frequency routes that do their own DB work
    also use it so auth does not keep a request-scoped transaction open
    while the handler reads request bodies or object storage. FastAPI's
    yield-dependency contract finalises `get_session` only after the
    response ends, which would otherwise exhaust the pool under daemon
    fan-out. The handler is responsible for opening its own short-lived
    sessions inside the stream loop (see `routes/sync.py`) or releasing
    read transactions before slow external I/O.
    """
    from app.core.database import async_session_factory

    token = credentials.credentials
    async with async_session_factory() as db:
        ctx = await _auth_via_dev_bypass(token, db)
        if not ctx:
            ctx = await _auth_via_api_key(token, db)
        if not ctx:
            ctx = await _auth_via_clerk_jwt(token, db)
    if not ctx:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    return ctx


def require_auth_scopes(auth: AuthContext, *needed: str) -> None:
    """Enforce API-key scopes consistently across HTTP and MCP boundaries."""
    if not auth.is_cli or auth.api_key is None:
        return
    scopes = auth.api_key.scopes
    if scopes is None and not is_runtime_deployment_principal(auth):
        return
    missing = list(needed) if scopes is None else [scope for scope in needed if scope not in scopes]
    if missing:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"missing scope: {', '.join(missing)}",
        )


def require_scope_short_session(*needed: str):
    """Same scope-check semantics as `require_scope`, paired with
    `get_auth_short_session` so the route doesn't pin a DB connection
    for its entire lifetime. Used by `/v1/sync/events` and high-frequency
    daemon routes."""

    async def _check(auth: AuthContext = Depends(get_auth_short_session)) -> AuthContext:
        require_auth_scopes(auth, *needed)
        return auth

    return _check


def require_scope(*needed: str):
    """Build a FastAPI dependency that gates a route on `auth.api_key`
    holding all of the given scope strings. Clerk-JWT auth (`is_cli =
    False`) bypasses the check — interactive dashboard sessions
    have implicit full access for now; tightening that comes with
    the authz overhaul, not v1.

    API keys with `scopes=NULL` keep wide access for legacy
    compatibility. Strict-v2 runtime deployment keys instead carry
    an explicit issuer-owned scope bundle.
    """

    async def _check(auth: AuthContext = Depends(get_auth)) -> AuthContext:
        require_auth_scopes(auth, *needed)
        return auth

    return _check


async def require_cli_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require a legacy API key or the first-party OAuth CLI identity."""
    if not auth.is_cli and not auth.oauth_cli:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This endpoint requires CLI authentication")
    return auth


async def require_oauth_cli_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require a validated Clerk Public OAuth App CLI access token."""
    if not auth.oauth_cli:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This endpoint requires OAuth CLI authentication",
        )
    return auth


def _is_scoped_api_key(auth: AuthContext) -> bool:
    """Any api_key with an explicit scope list is treated as
    "narrow capability" and rejected from user-only routes. Today
    that's just Agent API keys with narrow scopes, but the
    check is on the scope list rather than `environment_id` so a
    future scoped Personal key — minted with explicit scopes but
    no env binding — slips into the same protective bucket
    instead of inheriting Personal's wide-access bypass."""
    return auth.is_cli and auth.api_key is not None and auth.api_key.scopes is not None


def is_runtime_deployment_principal(auth: AuthContext) -> bool:
    """Identify one fenced strict-v2 workload independently of its permissions."""
    key = auth.api_key
    return bool(
        auth.is_cli
        and key is not None
        and key.managed
        and key.environment_id is not None
        and key.runtime_deployment_id
    )


def is_env_bound_api_key(auth: AuthContext) -> bool:
    """An api_key pinned to a specific `environment_id` —
    independent of whether its `scopes` list is narrow or full.
    Legacy v1 Agent keys may have `scopes=None` (full account
    capability, same as a user's own laptop key), while strict-v2
    runtime deployment keys carry an issuer-owned scope bundle.
    Project-scoped resources (skills and Vault attachments) honour this
    binding. Memory is account-shared, and strict Hosted runtimes also receive
    account session history; legacy environment keys retain environment-local
    session visibility. The environment id remains provenance for Memory.

    Distinct from `_is_scoped_api_key`: the latter is about
    capability narrowing (used to reject from user-only routes);
    this one is about env-project identity and visibility."""
    return auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None


async def require_user_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Allow Clerk JWT (dashboard) and wide-access CLI keys;
    reject any narrowly-scoped api_key. Use on routes whose
    surface is intended for the user themselves (their laptop
    CLI, the dashboard).

    Legacy v1 Agent environment keys with `scopes=None` (the default
    for keys minted via `POST /v1/auth/keys` with `environment_id`
    set) PASS this gate by explicit policy. Strict-v2 runtime
    deployment keys carry explicit scopes and are evaluated as scoped
    keys. The blast-radius boundary for Agent API keys is enforced
    inside the route's own `project_ids_visible_to` /
    `_project_filter_*` calls, not here.

    Only narrowly-scoped keys (explicit `scopes` list) are
    rejected — those are deliberate capability narrowing and
    have no business hitting the user's full surface.
    """
    if _is_scoped_api_key(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This endpoint is not available to scoped api keys",
        )
    return auth


def require_clerk_id(auth: AuthContext) -> str:
    """Return the Clerk id required by user-scoped integrations."""
    clerk_id = auth.user.clerk_id
    if not clerk_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Clerk user authentication is required",
        )
    return clerk_id


async def require_user_auth_unbound(
    auth: AuthContext = Depends(require_user_auth),
) -> AuthContext:
    """Require Clerk JWT OR fully-unbound CLI api_key.

    `require_user_auth` already rejects narrowly-scoped api_keys
    (those with explicit `scopes` list). This wrapper adds the
    additional rejection: api_keys bound to a specific environment
    cannot invoke sharing operations.
    """
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "user-level auth is required (Agent API keys cannot manage account resources)",
        )
    return auth


async def require_user_cli(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """CLI auth only (legacy API key or first-party OAuth access token).

    Browser session JWTs remain rejected so plaintext is never exposed to the
    web adapter. Narrowly-scoped API keys are also rejected. Agent API keys
    pass by the same "behaves like user-installed clawdi" policy
    as `require_user_auth` — `clawdi run` from a hosted agent pod
    must resolve vault plaintext for the env it's bound to.
    Per-env data filtering is enforced inside the resolve handler."""
    if not auth.is_cli and not auth.oauth_cli:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This endpoint requires CLI authentication")
    if _is_scoped_api_key(auth):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Vault plaintext is not available to scoped api keys",
        )
    return auth


async def optional_web_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_bearer_scheme),
    db: AsyncSession = Depends(get_session),
) -> AuthContext | None:
    """Best-effort dashboard auth — returns the AuthContext if a valid
    Clerk JWT is present, otherwise None. Never raises.

    Used by the public share routes to detect the visitor: the owner
    bypasses the permission check (their own private session is always
    accessible to them), and direct `kind='user'` grants need a
    visitor identity to match against. CLI api-keys are deliberately
    ignored here — share URLs are for human browsers, not agent fetches
    (those go through the owner-auth `/v1/sessions/{id}` routes).
    """
    if credentials is None:
        return None
    token = credentials.credentials
    ctx = await _auth_via_dev_bypass(token, db)
    if ctx:
        return ctx
    try:
        ctx = await _auth_via_clerk_jwt(token, db)
    except HTTPException:
        # Treat any auth failure as anonymous — caller will then check
        # public access permissions. We deliberately do NOT fall back to
        # API-key auth here (see docstring).
        return None
    return None if ctx is not None and ctx.oauth_cli else ctx


async def require_web_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require dashboard authentication (Clerk JWT only, not API key).

    Used by endpoints whose intent is human-in-the-browser — e.g. the device
    authorization approval flow. Refusing API keys here means a leaked key
    can't be turned into a *new* API key by an attacker calling the approve
    endpoint themselves.
    """
    if auth.is_cli or auth.oauth_cli:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This endpoint requires dashboard authentication"
        )
    return auth


async def require_admin_api_key(
    x_admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
) -> None:
    """Gate admin-only endpoints (`POST/DELETE /v1/admin/auth/keys`) with
    a shared secret in the `X-Admin-Key` header. Used by SaaS batch tooling
    + ops-side scripts that don't have a per-user Clerk JWT in context.

    503 when `admin_api_key` is empty — endpoints are disabled by default
    for OSS self-hosters who don't need ops tooling. Constant-time
    comparison once configured (defense against timing oracle even though
    the gate is binary).
    """
    expected = settings.admin_api_key
    if not expected:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "admin endpoints are disabled (admin_api_key not configured)",
        )
    if not x_admin_key or not hmac.compare_digest(x_admin_key, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid admin auth")


class ShareTokenContext:
    """What require_share_token returns."""

    def __init__(self, project_id: UUID, link_id: UUID) -> None:
        self.project_id = project_id
        self.link_id = link_id


async def require_share_token(
    token: str,
    db: AsyncSession = Depends(get_session),
) -> ShareTokenContext:
    """Validate an opaque share token from the URL path.

    Anonymous endpoint dep - does NOT establish an AuthContext and
    does NOT carry user identity. Token holders are bearers of access
    to one specific project's skill content, nothing more.
    """
    from app.models.project_share_link import ProjectShareLink
    from app.services.sharing import hash_share_token

    token_hash = hash_share_token(token)
    result = await db.execute(
        select(ProjectShareLink).where(ProjectShareLink.token_hash == token_hash)
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share link not found")
    if link.revoked_at is not None:
        raise HTTPException(status.HTTP_410_GONE, "share link has been revoked")
    if link.expires_at is not None and link.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "share link has expired")
    return ShareTokenContext(project_id=link.project_id, link_id=link.id)
