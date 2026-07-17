from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol
from urllib.parse import urlsplit

import jwt
from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_admin_api_key
from app.core.config import settings
from app.core.database import get_session
from app.models.platform_workload_auth import (
    PLATFORM_WORKLOAD_CLIENT_ACTIVE,
    PLATFORM_WORKLOAD_SIGNING_KEY_ACTIVE,
    PLATFORM_WORKLOAD_SIGNING_KEY_RETIRED,
    PlatformWorkloadAssertionReplay,
    PlatformWorkloadClient,
    PlatformWorkloadSigningKey,
)

PLATFORM_WORKLOAD_ACCESS_TOKEN_AUDIENCE = "clawdi-cloud-platform-admin"
PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS = 300
PLATFORM_WORKLOAD_ASSERTION_MAX_TTL_SECONDS = 300
PLATFORM_WORKLOAD_CLOCK_SKEW_SECONDS = 60
PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
PLATFORM_WORKLOAD_ALLOWED_ALGORITHMS = frozenset({"RS256", "ES256"})
PLATFORM_WORKLOAD_SCOPES = (
    "platform:agents:create",
    "platform:agents:delete",
    "platform:runtime-state:write",
    "platform:keys:mint",
    "platform:keys:revoke",
    "platform:runtime-observations:read",
)

_PRIVATE_JWK_FIELDS = frozenset({"d", "p", "q", "dp", "dq", "qi", "oth", "k"})
_MAX_JWT_LENGTH = 16_384


class PlatformWorkloadKeyUnavailable(RuntimeError):
    pass


class PlatformWorkloadConfigurationUnavailable(RuntimeError):
    pass


class PlatformWorkloadKeyResolver(Protocol):
    async def sign_jwt(
        self,
        *,
        private_key_ref: str,
        payload: dict[str, Any],
        algorithm: str,
        headers: dict[str, Any],
    ) -> str: ...

    async def resolve_verification_key(
        self,
        *,
        private_key_ref: str,
        algorithm: str,
    ) -> Any: ...


class UnconfiguredPlatformWorkloadKeyResolver:
    async def sign_jwt(
        self,
        *,
        private_key_ref: str,
        payload: dict[str, Any],
        algorithm: str,
        headers: dict[str, Any],
    ) -> str:
        raise PlatformWorkloadKeyUnavailable("platform workload signing resolver is unavailable")

    async def resolve_verification_key(
        self,
        *,
        private_key_ref: str,
        algorithm: str,
    ) -> Any:
        raise PlatformWorkloadKeyUnavailable("platform workload signing resolver is unavailable")


class InMemoryPlatformWorkloadKeyResolver:
    """Local/test resolver that never persists private key material in the database."""

    def __init__(self, keys: dict[str, Any]):
        self._keys = dict(keys)

    def _private_key(self, private_key_ref: str) -> Any:
        try:
            return self._keys[private_key_ref]
        except KeyError as exc:
            raise PlatformWorkloadKeyUnavailable(
                f"unknown platform workload private key ref: {private_key_ref}"
            ) from exc

    async def sign_jwt(
        self,
        *,
        private_key_ref: str,
        payload: dict[str, Any],
        algorithm: str,
        headers: dict[str, Any],
    ) -> str:
        try:
            return jwt.encode(
                payload,
                self._private_key(private_key_ref),
                algorithm=algorithm,
                headers=headers,
            )
        except (TypeError, ValueError, jwt.PyJWTError) as exc:
            raise PlatformWorkloadKeyUnavailable(
                f"platform workload signing failed for ref: {private_key_ref}"
            ) from exc

    async def resolve_verification_key(
        self,
        *,
        private_key_ref: str,
        algorithm: str,
    ) -> Any:
        private_key = self._private_key(private_key_ref)
        public_key = getattr(private_key, "public_key", None)
        return public_key() if callable(public_key) else private_key


_unconfigured_key_resolver = UnconfiguredPlatformWorkloadKeyResolver()


def get_platform_workload_key_resolver() -> PlatformWorkloadKeyResolver:
    # TODO(A0.7d0): Real KMS/secret-manager signing and public-key resolution is
    # an M3 launch prerequisite. The OSS default must remain fail-closed until it is wired.
    return _unconfigured_key_resolver


def canonical_platform_workload_token_endpoint() -> str:
    configured = settings.platform_workload_token_endpoint.strip()
    endpoint = configured or f"{settings.public_api_url.rstrip('/')}/v1/platform/oauth/token"
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
    ):
        raise PlatformWorkloadConfigurationUnavailable(
            "platform workload token endpoint must be an absolute HTTP(S) URL"
        )
    return endpoint


def platform_workload_issuer() -> str:
    issuer = settings.platform_workload_issuer.strip()
    if not issuer:
        raise PlatformWorkloadConfigurationUnavailable(
            "platform workload issuer must be configured"
        )
    return issuer


@dataclass(frozen=True)
class PlatformOAuthProtocolError(Exception):
    error: str
    description: str
    status_code: int = status.HTTP_400_BAD_REQUEST


@dataclass(frozen=True)
class IssuedPlatformWorkloadToken:
    access_token: str
    expires_in: int
    scope: str


@dataclass(frozen=True)
class PlatformMutationAuth:
    kind: Literal["admin", "workload"]
    client_id: str | None = None
    credential_id: uuid.UUID | None = None
    token_jti: str | None = None
    scopes: tuple[str, ...] = ()


class PlatformWorkloadAccessError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _invalid_client(
    description: str = "client authentication failed",
) -> PlatformOAuthProtocolError:
    return PlatformOAuthProtocolError(
        error="invalid_client",
        description=description,
        status_code=status.HTTP_401_UNAUTHORIZED,
    )


def _temporarily_unavailable() -> PlatformOAuthProtocolError:
    return PlatformOAuthProtocolError(
        error="temporarily_unavailable",
        description="authorization server storage or signing service is unavailable",
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


def _numeric_date(payload: dict[str, Any], claim: str) -> int:
    value = payload.get(claim)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid_client()
    return int(value)


def _validate_time_window(
    payload: dict[str, Any],
    *,
    now: datetime,
    max_ttl_seconds: int,
    clock_skew_seconds: int,
    require_nbf: bool,
) -> tuple[int, int]:
    iat = _numeric_date(payload, "iat")
    exp = _numeric_date(payload, "exp")
    now_seconds = int(now.timestamp())
    if exp <= iat or exp - iat > max_ttl_seconds:
        raise _invalid_client()
    if iat > now_seconds + clock_skew_seconds:
        raise _invalid_client()
    if exp <= now_seconds - clock_skew_seconds:
        raise _invalid_client()
    if require_nbf or "nbf" in payload:
        nbf = _numeric_date(payload, "nbf")
        if nbf > now_seconds + clock_skew_seconds:
            raise _invalid_client()
        if nbf > exp:
            raise _invalid_client()
    return iat, exp


def _parse_scope(value: str) -> tuple[str, ...]:
    scopes = tuple(value.split())
    if not scopes or len(scopes) != len(set(scopes)):
        raise PlatformOAuthProtocolError("invalid_scope", "scope must be non-empty and unique")
    if not set(scopes) <= set(PLATFORM_WORKLOAD_SCOPES):
        raise PlatformOAuthProtocolError("invalid_scope", "requested scope is not approved")
    return tuple(scope for scope in PLATFORM_WORKLOAD_SCOPES if scope in scopes)


def _validated_client_scopes(client: PlatformWorkloadClient) -> frozenset[str]:
    scopes = client.allowed_scopes or []
    if not scopes or len(scopes) != len(set(scopes)):
        raise _temporarily_unavailable()
    if not set(scopes) <= set(PLATFORM_WORKLOAD_SCOPES):
        raise _temporarily_unavailable()
    return frozenset(scopes)


def _unverified_jwt(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not token or len(token) > _MAX_JWT_LENGTH or token.count(".") != 2:
        raise _invalid_client()
    try:
        header = jwt.get_unverified_header(token)
        payload = jwt.decode(
            token,
            options={"verify_signature": False, "verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        raise _invalid_client() from exc
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise _invalid_client()
    return header, payload


def _assertion_verification_key(
    client: PlatformWorkloadClient,
    header: dict[str, Any],
) -> Any:
    algorithm = header.get("alg")
    kid = header.get("kid")
    if algorithm not in PLATFORM_WORKLOAD_ALLOWED_ALGORITHMS:
        raise _invalid_client()
    if algorithm != client.assertion_algorithm or kid != client.assertion_kid:
        raise _invalid_client()
    if header.get("crit"):
        raise _invalid_client()

    jwk = client.public_jwk
    if not isinstance(jwk, dict) or _PRIVATE_JWK_FIELDS.intersection(jwk):
        raise _invalid_client()
    if jwk.get("kid") != client.assertion_kid or jwk.get("alg") != algorithm:
        raise _invalid_client()
    if jwk.get("use") not in (None, "sig"):
        raise _invalid_client()
    key_ops = jwk.get("key_ops")
    if key_ops is not None and (
        not isinstance(key_ops, list) or "verify" not in key_ops or "sign" in key_ops
    ):
        raise _invalid_client()
    try:
        return jwt.PyJWK.from_dict(jwk, algorithm=algorithm).key
    except jwt.PyJWTError as exc:
        raise _invalid_client() from exc


async def load_platform_workload_client(
    db: AsyncSession,
    client_id: str,
) -> PlatformWorkloadClient | None:
    return (
        await db.execute(
            select(PlatformWorkloadClient).where(PlatformWorkloadClient.client_id == client_id)
        )
    ).scalar_one_or_none()


async def load_platform_workload_signing_key_for_issue(
    db: AsyncSession,
    *,
    now: datetime,
    token_expires_at: datetime,
) -> PlatformWorkloadSigningKey | None:
    return (
        await db.execute(
            select(PlatformWorkloadSigningKey)
            .where(
                PlatformWorkloadSigningKey.status == PLATFORM_WORKLOAD_SIGNING_KEY_ACTIVE,
                PlatformWorkloadSigningKey.not_before <= now,
                or_(
                    PlatformWorkloadSigningKey.expires_at.is_(None),
                    PlatformWorkloadSigningKey.expires_at >= token_expires_at,
                ),
            )
            .order_by(
                PlatformWorkloadSigningKey.not_before.desc(),
                PlatformWorkloadSigningKey.created_at.desc(),
            )
            .limit(1)
        )
    ).scalar_one_or_none()


async def load_platform_workload_signing_key(
    db: AsyncSession,
    kid: str,
) -> PlatformWorkloadSigningKey | None:
    return (
        await db.execute(
            select(PlatformWorkloadSigningKey).where(PlatformWorkloadSigningKey.kid == kid)
        )
    ).scalar_one_or_none()


async def store_platform_workload_assertion_replay(
    db: AsyncSession,
    *,
    client_id: str,
    jti: str,
    assertion_expires_at: datetime,
) -> bool:
    statement = (
        postgresql_insert(PlatformWorkloadAssertionReplay)
        .values(
            id=uuid.uuid4(),
            client_id=client_id,
            jti=jti,
            assertion_expires_at=assertion_expires_at,
        )
        .on_conflict_do_nothing(constraint="uq_platform_workload_assertion_replays_client_jti")
        .returning(PlatformWorkloadAssertionReplay.id)
    )
    return (await db.execute(statement)).scalar_one_or_none() is not None


async def _safe_rollback(db: AsyncSession) -> None:
    try:
        await db.rollback()
    except SQLAlchemyError:
        pass


async def issue_platform_workload_token(
    db: AsyncSession,
    resolver: PlatformWorkloadKeyResolver,
    *,
    grant_type: str,
    client_id: str,
    scope: str,
    client_assertion_type: str,
    client_assertion: str,
    now: datetime | None = None,
) -> IssuedPlatformWorkloadToken:
    if grant_type != "client_credentials":
        raise PlatformOAuthProtocolError(
            "unsupported_grant_type",
            "grant_type must be client_credentials",
        )
    if client_assertion_type != PLATFORM_WORKLOAD_CLIENT_ASSERTION_TYPE:
        raise PlatformOAuthProtocolError(
            "invalid_request",
            "client_assertion_type must identify a JWT bearer assertion",
        )
    if not client_id or len(client_id) > 200:
        raise _invalid_client()

    current_time = now or datetime.now(UTC)
    requested_scopes = _parse_scope(scope)
    header, unverified_payload = _unverified_jwt(client_assertion)
    if unverified_payload.get("iss") != client_id or unverified_payload.get("sub") != client_id:
        raise _invalid_client()

    try:
        client = await load_platform_workload_client(db, client_id)
        if client is None or client.status != PLATFORM_WORKLOAD_CLIENT_ACTIVE:
            raise _invalid_client()

        verification_key = _assertion_verification_key(client, header)
        assertion_audience = canonical_platform_workload_token_endpoint()
        try:
            assertion_payload = jwt.decode(
                client_assertion,
                verification_key,
                algorithms=[client.assertion_algorithm],
                audience=assertion_audience,
                issuer=client_id,
                subject=client_id,
                leeway=PLATFORM_WORKLOAD_CLOCK_SKEW_SECONDS,
                options={"require": ["iss", "sub", "aud", "iat", "exp", "jti"]},
            )
        except jwt.PyJWTError as exc:
            raise _invalid_client() from exc

        if assertion_payload.get("aud") != assertion_audience:
            raise _invalid_client()
        iat, assertion_exp = _validate_time_window(
            assertion_payload,
            now=current_time,
            max_ttl_seconds=PLATFORM_WORKLOAD_ASSERTION_MAX_TTL_SECONDS,
            clock_skew_seconds=PLATFORM_WORKLOAD_CLOCK_SKEW_SECONDS,
            require_nbf=False,
        )
        jti = assertion_payload.get("jti")
        if not isinstance(jti, str) or not jti or len(jti) > 200:
            raise _invalid_client()
        if client.revoked_before is not None and iat <= int(client.revoked_before.timestamp()):
            raise _invalid_client()
        allowed_scopes = _validated_client_scopes(client)
        if not set(requested_scopes) <= allowed_scopes:
            raise PlatformOAuthProtocolError(
                "invalid_scope",
                "requested scope exceeds the client's grant",
            )

        token_iat = int(current_time.timestamp())
        token_exp = token_iat + PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS
        token_expires_at = datetime.fromtimestamp(token_exp, tz=UTC)
        signing_key = await load_platform_workload_signing_key_for_issue(
            db,
            now=current_time,
            token_expires_at=token_expires_at,
        )
        if signing_key is None or signing_key.algorithm not in PLATFORM_WORKLOAD_ALLOWED_ALGORITHMS:
            raise _temporarily_unavailable()

        token_jti = str(uuid.uuid4())
        scope_value = " ".join(requested_scopes)
        access_token = await resolver.sign_jwt(
            private_key_ref=signing_key.private_key_ref,
            payload={
                "iss": platform_workload_issuer(),
                "sub": client.client_id,
                "aud": PLATFORM_WORKLOAD_ACCESS_TOKEN_AUDIENCE,
                "iat": token_iat,
                "nbf": token_iat,
                "exp": token_exp,
                "jti": token_jti,
                "client_id": client.client_id,
                "credential_id": str(client.id),
                "token_version": client.token_version,
                "scope": scope_value,
            },
            algorithm=signing_key.algorithm,
            headers={"kid": signing_key.kid, "typ": "at+jwt"},
        )

        inserted = await store_platform_workload_assertion_replay(
            db,
            client_id=client.client_id,
            jti=jti,
            assertion_expires_at=datetime.fromtimestamp(assertion_exp, tz=UTC),
        )
        if not inserted:
            await db.commit()
            raise _invalid_client("client assertion has already been used")
        await db.commit()
        return IssuedPlatformWorkloadToken(
            access_token=access_token,
            expires_in=PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS,
            scope=scope_value,
        )
    except PlatformOAuthProtocolError:
        raise
    except (
        PlatformWorkloadConfigurationUnavailable,
        PlatformWorkloadKeyUnavailable,
        SQLAlchemyError,
    ):
        await _safe_rollback(db)
        raise _temporarily_unavailable() from None


def _invalid_access_token() -> PlatformWorkloadAccessError:
    return PlatformWorkloadAccessError(
        status.HTTP_401_UNAUTHORIZED,
        "invalid workload access token",
    )


async def authenticate_platform_workload_access_token(
    db: AsyncSession,
    resolver: PlatformWorkloadKeyResolver,
    token: str,
    *,
    required_scope: str,
    now: datetime | None = None,
) -> PlatformMutationAuth:
    current_time = now or datetime.now(UTC)
    try:
        header, unverified_payload = _unverified_jwt(token)
    except PlatformOAuthProtocolError as exc:
        raise _invalid_access_token() from exc

    client_id = unverified_payload.get("sub")
    kid = header.get("kid")
    algorithm = header.get("alg")
    if (
        not isinstance(client_id, str)
        or not client_id
        or len(client_id) > 200
        or not isinstance(kid, str)
        or not kid
        or len(kid) > 200
        or algorithm not in PLATFORM_WORKLOAD_ALLOWED_ALGORITHMS
        or header.get("typ") != "at+jwt"
        or header.get("crit")
    ):
        raise _invalid_access_token()

    try:
        client = await load_platform_workload_client(db, client_id)
        signing_key = await load_platform_workload_signing_key(db, kid)
        if client is None or signing_key is None:
            raise _invalid_access_token()
        if client.status != PLATFORM_WORKLOAD_CLIENT_ACTIVE:
            raise _invalid_access_token()
        if signing_key.status not in {
            PLATFORM_WORKLOAD_SIGNING_KEY_ACTIVE,
            PLATFORM_WORKLOAD_SIGNING_KEY_RETIRED,
        }:
            raise _invalid_access_token()
        if signing_key.algorithm != algorithm:
            raise _invalid_access_token()

        verification_key = await resolver.resolve_verification_key(
            private_key_ref=signing_key.private_key_ref,
            algorithm=signing_key.algorithm,
        )
        issuer = platform_workload_issuer()
        try:
            payload = jwt.decode(
                token,
                verification_key,
                algorithms=[signing_key.algorithm],
                audience=PLATFORM_WORKLOAD_ACCESS_TOKEN_AUDIENCE,
                issuer=issuer,
                subject=client.client_id,
                leeway=0,
                options={
                    "require": [
                        "iss",
                        "sub",
                        "aud",
                        "iat",
                        "nbf",
                        "exp",
                        "jti",
                        "client_id",
                        "credential_id",
                        "token_version",
                        "scope",
                    ]
                },
            )
        except jwt.PyJWTError as exc:
            raise _invalid_access_token() from exc

        if payload.get("aud") != PLATFORM_WORKLOAD_ACCESS_TOKEN_AUDIENCE:
            raise _invalid_access_token()
        if payload.get("client_id") != client.client_id:
            raise _invalid_access_token()
        if payload.get("credential_id") != str(client.id):
            raise _invalid_access_token()
        token_version = payload.get("token_version")
        if type(token_version) is not int or token_version != client.token_version:
            raise _invalid_access_token()

        try:
            iat, token_exp = _validate_time_window(
                payload,
                now=current_time,
                max_ttl_seconds=PLATFORM_WORKLOAD_ACCESS_TOKEN_TTL_SECONDS,
                clock_skew_seconds=0,
                require_nbf=True,
            )
        except PlatformOAuthProtocolError as exc:
            raise _invalid_access_token() from exc
        if client.revoked_before is not None and iat <= int(client.revoked_before.timestamp()):
            raise _invalid_access_token()
        if iat < int(signing_key.not_before.timestamp()):
            raise _invalid_access_token()
        if signing_key.expires_at is not None:
            signing_key_expires_at = int(signing_key.expires_at.timestamp())
            if iat >= signing_key_expires_at or token_exp > signing_key_expires_at:
                raise _invalid_access_token()

        token_scope = payload.get("scope")
        if not isinstance(token_scope, str):
            raise _invalid_access_token()
        try:
            scopes = _parse_scope(token_scope)
        except PlatformOAuthProtocolError as exc:
            raise _invalid_access_token() from exc
        try:
            allowed_scopes = _validated_client_scopes(client)
        except PlatformOAuthProtocolError as exc:
            raise PlatformWorkloadAccessError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "workload auth client grant is unavailable",
            ) from exc
        if not set(scopes) <= allowed_scopes or required_scope not in scopes:
            raise PlatformWorkloadAccessError(
                status.HTTP_403_FORBIDDEN,
                "workload access token lacks required scope",
            )
        token_jti = payload.get("jti")
        if not isinstance(token_jti, str) or not token_jti or len(token_jti) > 200:
            raise _invalid_access_token()
        return PlatformMutationAuth(
            kind="workload",
            client_id=client.client_id,
            credential_id=client.id,
            token_jti=token_jti,
            scopes=scopes,
        )
    except PlatformWorkloadAccessError:
        raise
    except (
        PlatformWorkloadConfigurationUnavailable,
        PlatformWorkloadKeyUnavailable,
        SQLAlchemyError,
    ):
        await _safe_rollback(db)
        raise PlatformWorkloadAccessError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "workload auth storage or signing service is unavailable",
        ) from None


def _credential_values(request: Request, name: str) -> list[str]:
    return request.headers.getlist(name)


def require_platform_mutation_auth(required_scope: str):
    if required_scope not in PLATFORM_WORKLOAD_SCOPES:
        raise ValueError(f"unsupported platform workload scope: {required_scope}")

    async def dependency(
        request: Request,
        x_admin_key: Annotated[str | None, Header(alias="X-Admin-Key")] = None,
        authorization: Annotated[str | None, Header(alias="Authorization")] = None,
        db: AsyncSession = Depends(get_session),
        resolver: PlatformWorkloadKeyResolver = Depends(get_platform_workload_key_resolver),
    ) -> PlatformMutationAuth:
        admin_values = _credential_values(request, "x-admin-key")
        authorization_values = _credential_values(request, "authorization")
        if len(admin_values) > 1 or len(authorization_values) > 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "multiple credentials are not allowed")
        if admin_values and authorization_values:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "ambiguous platform credentials")

        if authorization_values:
            raw_authorization = authorization_values[0].strip()
            if "," in raw_authorization:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "multiple credentials are not allowed",
                )
            scheme, separator, token = raw_authorization.partition(" ")
            if separator != " " or scheme.lower() != "bearer" or not token.strip():
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "invalid workload authorization",
                    headers={"WWW-Authenticate": "Bearer"},
                )
            try:
                auth = await authenticate_platform_workload_access_token(
                    db,
                    resolver,
                    token.strip(),
                    required_scope=required_scope,
                )
            except PlatformWorkloadAccessError as exc:
                headers = (
                    {"WWW-Authenticate": 'Bearer error="invalid_token"'}
                    if exc.status_code == status.HTTP_401_UNAUTHORIZED
                    else None
                )
                raise HTTPException(exc.status_code, exc.detail, headers=headers) from exc
            request.state.platform_mutation_auth = auth
            return auth

        if admin_values:
            if "," in admin_values[0]:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "multiple credentials are not allowed",
                )
            if not settings.platform_legacy_admin_auth_enabled:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "legacy platform admin auth is disabled",
                )
            await require_admin_api_key(x_admin_key=admin_values[0])
            auth = PlatformMutationAuth(kind="admin")
            request.state.platform_mutation_auth = auth
            return auth

        if settings.platform_legacy_admin_auth_enabled:
            await require_admin_api_key(x_admin_key=x_admin_key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "platform credentials are required")

    return dependency
