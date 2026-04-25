import hashlib
import logging
from datetime import UTC, datetime, timedelta

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

    if not user:
        # Auto-create user on first login
        user = User(
            clerk_id=clerk_id,
            email=payload.get("email") or payload.get("email_address"),
            name=payload.get("name"),
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

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


async def require_cli_auth(auth: AuthContext = Depends(get_auth)) -> AuthContext:
    """Require CLI authentication (ApiKey only, not Clerk JWT)."""
    if not auth.is_cli:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This endpoint requires CLI authentication")
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
