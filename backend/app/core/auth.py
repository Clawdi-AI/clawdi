import hashlib
import hmac
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.user import User
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

# Only touch api_key.last_used_at if the previous update was at least this
# long ago. Every authenticated CLI request used to write+commit the row,
# which becomes write-lock contention on a hot key at scale.
LAST_USED_THROTTLE = timedelta(minutes=1)


class AuthContext:
    def __init__(
        self,
        user: User,
        api_key: ApiKey | None = None,
        api_key_project_id: UUID | None = None,
    ):
        self.user = user
        self.api_key = api_key
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
    result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
    api_key = result.scalar_one_or_none()

    if not api_key:
        return None
    if api_key.revoked_at:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key has been revoked")
    if api_key.expires_at and api_key.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key has expired")

    # Throttle last_used_at writes: once per LAST_USED_THROTTLE per key.
    now = datetime.now(UTC)
    last = api_key.last_used_at
    if last is None or (now - last) > LAST_USED_THROTTLE:
        api_key.last_used_at = now
        await db.commit()

    result = await db.execute(select(User).where(User.id == api_key.user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")

    api_key_project_id = None
    if api_key.environment_id is not None:
        from app.models.session import AgentEnvironment

        api_key_project_id = (
            await db.execute(
                select(AgentEnvironment.default_project_id).where(
                    AgentEnvironment.id == api_key.environment_id,
                    AgentEnvironment.user_id == api_key.user_id,
                )
            )
        ).scalar_one_or_none()

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
    result = await db.execute(select(User).where(User.clerk_id == clerk_id))
    user = result.scalar_one_or_none()
    if user is None:
        user = await lazy_create_user_with_personal_project(
            db,
            clerk_id=clerk_id,
            email=settings.dev_auth_email,
            name=settings.dev_auth_name,
            avatar_url=None,
            race_loser_status=status.HTTP_401_UNAUTHORIZED,
        )
        await db.commit()
        await db.refresh(user)
        logger.info("dev_auth_user_created clerk_id=%s user_id=%s", clerk_id, user.id)
    return AuthContext(user=user)


async def _fetch_clerk_primary_email(clerk_user_id: str) -> str | None:
    """Look up a Clerk user's verified primary email via the Backend API.

    Returns the email only if Clerk explicitly marks it as the user's primary
    AND its verification status is "verified". Returns None for any other
    outcome (network failure, non-200, malformed payload, no primary marked,
    primary unverified). This is identity-binding: callers use the result to
    decide which existing user row to take over, so we refuse to guess.
    """
    url = f"https://api.clerk.com/v1/users/{clerk_user_id}"
    # Clerk's API is fronted by Cloudflare, which serves a 403 (error 1010)
    # for requests lacking a recognizable User-Agent — including httpx's
    # default. Set an explicit one.
    headers = {
        "Authorization": f"Bearer {settings.clerk_secret_key}",
        "User-Agent": "clawdi-backend/1.0",
    }
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
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("clerk backend api lookup failed for %s: %s", clerk_user_id, e)
        return None

    primary_id = data.get("primary_email_address_id")
    if not primary_id:
        logger.warning("clerk user %s has no primary_email_address_id", clerk_user_id)
        return None
    for entry in data.get("email_addresses") or []:
        if entry.get("id") != primary_id:
            continue
        verification = entry.get("verification") or {}
        if verification.get("status") != "verified":
            logger.warning(
                "clerk primary email for %s is not verified (status=%s)",
                clerk_user_id,
                verification.get("status"),
            )
            return None
        return entry.get("email_address")
    logger.warning(
        "clerk user %s primary_email_address_id %s not in email_addresses",
        clerk_user_id,
        primary_id,
    )
    return None


async def _auth_via_clerk_jwt(token: str, db: AsyncSession) -> AuthContext | None:
    if not settings.clerk_pem_public_key:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Clerk public key not configured"
        )

    try:
        payload = jwt.decode(
            token,
            settings.clerk_pem_public_key,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )
    except jwt.InvalidTokenError:
        return None

    clerk_id = payload.get("sub")
    if not clerk_id:
        return None

    result = await db.execute(select(User).where(User.clerk_id == clerk_id))
    user = result.scalar_one_or_none()

    email = payload.get("email") or payload.get("email_address")
    name = payload.get("name")

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
            result = await db.execute(select(User).where(User.clerk_id == clerk_id))
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
            select(User).where(User.email == email).order_by(User.created_at).limit(2)
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
            logger.info(
                "snapshot rebind: user %s clerk_id %s -> %s (email match)",
                user.id,
                user.clerk_id,
                clerk_id,
            )
            user.clerk_id = clerk_id
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
                result = await db.execute(select(User).where(User.clerk_id == clerk_id))
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
            email=email,
            name=name,
            avatar_url=payload.get("picture"),
            race_loser_status=status.HTTP_401_UNAUTHORIZED,
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
    new_avatar = payload.get("picture")
    if new_avatar and user.avatar_url != new_avatar:
        user.avatar_url = new_avatar
        try:
            await db.commit()
        except SQLAlchemyError:
            # Non-fatal — auth still proceeds with the in-memory user.
            # Narrow to SQLAlchemyError so coding bugs surface instead
            # of being silently swallowed.
            await db.rollback()

    return AuthContext(user=user)


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


def require_scope_short_session(*needed: str):
    """Same scope-check semantics as `require_scope`, paired with
    `get_auth_short_session` so the route doesn't pin a DB connection
    for its entire lifetime. Used by `/api/sync/events` and high-frequency
    daemon routes."""

    async def _check(auth: AuthContext = Depends(get_auth_short_session)) -> AuthContext:
        if not auth.is_cli or auth.api_key is None:
            return auth
        if auth.api_key.scopes is None:
            return auth
        missing = [s for s in needed if s not in auth.api_key.scopes]
        if missing:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"missing scope: {', '.join(missing)}",
            )
        return auth

    return _check


def require_scope(*needed: str):
    """Build a FastAPI dependency that gates a route on `auth.api_key`
    holding all of the given scope strings. Clerk-JWT auth (`is_cli =
    False`) bypasses the check — interactive dashboard sessions
    have implicit full access for now; tightening that comes with
    the authz overhaul, not v1.

    Scoped api_keys with `scopes=NULL` keep wide access (legacy
    keys minted before the v1 migration). v1 only narrows the new
    deploy-keys; nothing in the existing CLI flow regresses.
    """

    async def _check(auth: AuthContext = Depends(get_auth)) -> AuthContext:
        if not auth.is_cli or auth.api_key is None:
            return auth
        if auth.api_key.scopes is None:
            return auth
        missing = [s for s in needed if s not in auth.api_key.scopes]
        if missing:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"missing scope: {', '.join(missing)}",
            )
        return auth

    return _check


async def require_cli_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require CLI authentication (ApiKey only, not Clerk JWT)."""
    if not auth.is_cli:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This endpoint requires CLI authentication")
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


def _is_env_bound_api_key(auth: AuthContext) -> bool:
    """An api_key pinned to a specific `environment_id` —
    independent of whether its `scopes` list is narrow or full.
    Deploy keys mint with `scopes=None` by default (full account
    capability, same as a user's own laptop key), but their
    BLAST RADIUS still has to honour the env binding: a leaked
    env-A key must not read env-B's data. Memory / session /
    skill / vault routes all filter by env when this is true.

    Distinct from `_is_scoped_api_key`: the latter is about
    capability narrowing (used to reject from user-only routes);
    this one is about env-project visibility (used to filter
    list/read/delete results)."""
    return auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None


async def require_user_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Allow Clerk JWT (dashboard) and wide-access CLI keys;
    reject any narrowly-scoped api_key. Use on routes whose
    surface is intended for the user themselves (their laptop
    CLI, the dashboard).

    Agent environment deploy keys with `scopes=None` (the default for
    keys minted via `POST /api/auth/keys` with `environment_id`
    set) PASS this gate by explicit policy: a hosted agent pod
    behaves like a self-installed clawdi — same vault, connectors,
    settings access the user's own laptop has. The blast-radius
    boundary for Agent API keys is enforced inside the route's
    own `project_ids_visible_to` / `_project_filter_*` calls, not
    here.

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
    """CLI auth only (rejects Clerk JWT — no plaintext to web)
    and rejects narrowly-scoped api_keys. Agent API keys
    pass by the same "behaves like user-installed clawdi" policy
    as `require_user_auth` — `clawdi run` from a hosted agent pod
    must resolve vault plaintext for the env it's bound to.
    Per-env data filtering is enforced inside the resolve handler."""
    if not auth.is_cli:
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
    (those go through the owner-auth `/api/sessions/{id}` routes).
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
    return ctx


async def require_web_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require dashboard authentication (Clerk JWT only, not API key).

    Used by endpoints whose intent is human-in-the-browser — e.g. the device
    authorization approval flow. Refusing API keys here means a leaked key
    can't be turned into a *new* API key by an attacker calling the approve
    endpoint themselves.
    """
    if auth.is_cli:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This endpoint requires dashboard authentication"
        )
    return auth


async def require_admin_api_key(
    x_admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
) -> None:
    """Gate admin-only endpoints (`POST/DELETE /api/admin/auth/keys`) with
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

    def __init__(self, project_id, link_id):
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
