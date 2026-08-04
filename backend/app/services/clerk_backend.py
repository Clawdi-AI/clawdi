"""Small shared contract for direct Clerk Backend API requests."""

from __future__ import annotations

from urllib.parse import quote

from app.core.config import settings

CLERK_BACKEND_API_ROOT = "https://api.clerk.com/v1"
CLERK_BACKEND_API_VERSION = "2026-05-12"


def clerk_backend_url(path: str) -> str:
    return f"{CLERK_BACKEND_API_ROOT}/{path.lstrip('/')}"


def clerk_user_url(subject: str) -> str:
    return clerk_backend_url(f"users/{quote(subject, safe='')}")


def clerk_backend_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.clerk_secret_key}",
        "Clerk-API-Version": CLERK_BACKEND_API_VERSION,
        "User-Agent": "clawdi-backend/1.0",
    }


__all__ = [
    "CLERK_BACKEND_API_ROOT",
    "CLERK_BACKEND_API_VERSION",
    "clerk_backend_headers",
    "clerk_backend_url",
    "clerk_user_url",
]
