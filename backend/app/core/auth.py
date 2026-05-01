import hashlib
import logging
from datetime import UTC, datetime, timedelta

import httpx
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.models.api_key import ApiKey
from app.models.user import User

bearer_scheme = HTTPBearer()
logger = logging.getLogger(__name__)

API_KEY_PREFIX = "clawdi_"

# Only touch api_key.last_used_at if the previous update was at least this
# long ago. Every authenticated CLI request used to write+commit the row,
# which becomes write-lock contention on a hot key at scale.
LAST_USED_THROTTLE = timedelta(minutes=1)


class AuthContext:
    def __init__(self, user: User, api_key: ApiKey | None = None):
        self.user = user
        self.api_key = api_key
        self.is_cli = api_key is not None

    @property
    def user_id(self):
        return self.user.id


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

    return AuthContext(user=user, api_key=api_key)


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
            await db.commit()
            await db.refresh(user)

    if not user:
        # First login (production path, or rebind enabled with no
        # match): create a fresh user row bound to this Clerk sub.
        # The Personal scope is created in the same transaction so
        # every user always has a default-write target — phase 1's
        # resolver assumes it exists and 500s if not. Migration
        # backfilled it for pre-existing users; this covers new
        # signups.
        #
        # Concurrent first-login requests race here: both find
        # user=None, both try to insert. The second commit hits
        # the `users.clerk_id` unique constraint. Catch the
        # IntegrityError, rollback, and re-query — the row is
        # there now from the winner.
        from sqlalchemy.exc import IntegrityError

        from app.models.scope import SCOPE_KIND_PERSONAL
        from app.models.scope import Scope as _Scope

        new_user = User(
            clerk_id=clerk_id,
            email=email,
            name=payload.get("name"),
        )
        db.add(new_user)

        # Narrow IntegrityError handling: ONLY the User flush is
        # racy (clerk_id unique). The Scope insert can't race
        # because new_user.id is freshly generated. Wrapping both
        # in one try would silently swallow a Scope-side error
        # and leave the user without a Personal scope.
        try:
            await db.flush()  # may raise on clerk_id conflict
        except IntegrityError:
            await db.rollback()
            # Winner committed first; adopt its row.
            result = await db.execute(select(User).where(User.clerk_id == clerk_id))
            user = result.scalar_one_or_none()
            if user is None:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "could not create or load user",
                ) from None
        else:
            # Scope insert can't race on user_id (fresh) but the
            # commit() below could still raise on bizarre states
            # (the partial unique index on kind=personal, a
            # connection drop mid-commit). Catch and log instead
            # of letting the SQLAlchemy traceback leak as a 500.
            personal = _Scope(
                user_id=new_user.id,
                name="Personal",
                slug="personal",
                kind=SCOPE_KIND_PERSONAL,
            )
            db.add(personal)
            try:
                await db.commit()
            except Exception:
                logger.exception(
                    "personal_scope_create_failed user=%s clerk_id=%s",
                    new_user.id,
                    clerk_id,
                )
                await db.rollback()
                raise HTTPException(
                    status.HTTP_500_INTERNAL_SERVER_ERROR,
                    "internal server error",
                ) from None
            await db.refresh(new_user)
            user = new_user

    return AuthContext(user=user)


async def get_auth(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_session),
) -> AuthContext:
    token = credentials.credentials

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
    stream lifetime — FastAPI's yield-dependency contract finalises
    `get_session` only after the streaming response ends, which would
    exhaust the pool once a few hundred daemons connect. The handler
    is responsible for opening its own short-lived sessions inside
    the stream loop (see `routes/sync.py`).
    """
    from app.core.database import async_session_factory

    token = credentials.credentials
    async with async_session_factory() as db:
        ctx = await _auth_via_api_key(token, db)
        if not ctx:
            ctx = await _auth_via_clerk_jwt(token, db)
    if not ctx:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    return ctx


def require_scope_short_session(*needed: str):
    """Same scope-check semantics as `require_scope`, paired with
    `get_auth_short_session` so the route doesn't pin a DB connection
    for its entire lifetime. Used by `/api/sync/events`."""

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


def require_environment(env_id_param: str = "environment_id"):
    """Build a FastAPI dependency that asserts an api_key bound to a
    specific `environment_id` is only acting on that env's
    resources. Routes that operate on a single env (push session,
    sync heartbeat, mint deploy-key for env X) declare which path /
    body field carries the env_id and we 403 if it doesn't match
    the key's binding.

    Implemented as a wrapper the route's body picks up via
    `auth.api_key.environment_id` and a manual compare — keeping it
    a helper rather than a Dependency keeps the path-param vs
    body-field difference simple per route.
    """

    def _check(auth: AuthContext, requested_env_id) -> None:
        if not auth.is_cli or auth.api_key is None:
            return
        bound = auth.api_key.environment_id
        if bound is None:
            return
        if bound != requested_env_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "api key bound to a different environment",
            )

    return _check


# Convenience instance — most callers use the default param name.
assert_environment = require_environment()


async def require_cli_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require CLI authentication (ApiKey only, not Clerk JWT)."""
    if not auth.is_cli:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This endpoint requires CLI authentication")
    return auth


def _is_scoped_api_key(auth: AuthContext) -> bool:
    """Any api_key with an explicit scope list is treated as
    "narrow capability" and rejected from user-only routes. Today
    that's just deploy keys (env-bound, narrow scopes), but the
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
    this one is about env-scope visibility (used to filter
    list/read/delete results)."""
    return auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None


async def require_user_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Allow Clerk JWT (dashboard) and wide-access CLI keys;
    reject any narrowly-scoped api_key. Use on routes whose
    surface is intended for the user themselves (their laptop
    CLI, the dashboard).

    Env-bound deploy keys with `scopes=None` (the default for
    keys minted via `POST /api/auth/keys` with `environment_id`
    set) PASS this gate by explicit policy: a hosted agent pod
    behaves like a self-installed clawdi — same vault, connectors,
    settings access the user's own laptop has. The blast-radius
    boundary for env-bound keys is enforced inside the route's
    own `scope_ids_visible_to` / `_scope_filter_*` calls, not
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


async def require_user_cli(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """CLI auth only (rejects Clerk JWT — no plaintext to web)
    and rejects narrowly-scoped api_keys. Env-bound deploy keys
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
