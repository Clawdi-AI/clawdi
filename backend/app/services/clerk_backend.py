"""Small shared contract for direct Clerk Backend API requests."""

from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import quote

import httpx

from app.core.config import settings

CLERK_BACKEND_API_ROOT = "https://api.clerk.com/v1"
CLERK_BACKEND_API_VERSION = "2026-05-12"
CLERK_BACKEND_TIMEOUT = httpx.Timeout(5.0, connect=5.0, read=5.0, write=5.0, pool=5.0)


class ClerkBackendError(RuntimeError):
    """Base error for Clerk Backend API transport failures."""


class ClerkBackendTimeoutError(ClerkBackendError):
    """The Clerk Backend API did not respond before the configured timeout."""


class ClerkBackendTransportError(ClerkBackendError):
    """The Clerk Backend API request could not be sent or received."""


_shared_client: httpx.AsyncClient | None = None


class ClerkBackendClient:
    async def _request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        json: object | None = None,
    ) -> httpx.Response:
        client = _shared_client
        if client is not None:
            return await self._request_with(client, method, url, headers=headers, json=json)
        # ASGI unit tests do not drive application lifespan. Keep that path
        # deterministic while production uses the lifespan-owned client.
        async with httpx.AsyncClient(timeout=CLERK_BACKEND_TIMEOUT) as transient:
            return await self._request_with(transient, method, url, headers=headers, json=json)

    @staticmethod
    async def _request_with(
        client: httpx.AsyncClient,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None,
        json: object | None,
    ) -> httpx.Response:
        try:
            if method == "GET":
                return await client.get(url, headers=headers)
            return await client.post(url, headers=headers, json=json)
        except httpx.TimeoutException as exc:
            raise ClerkBackendTimeoutError("Clerk Backend API request timed out") from exc
        except httpx.HTTPError as exc:
            raise ClerkBackendTransportError("Clerk Backend API request failed") from exc

    async def get(self, url: str, *, headers: Mapping[str, str] | None = None) -> httpx.Response:
        return await self._request("GET", url, headers=headers)

    async def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        json: object | None = None,
    ) -> httpx.Response:
        return await self._request("POST", url, headers=headers, json=json)


_clerk_backend_client = ClerkBackendClient()


async def start_clerk_backend_client() -> None:
    global _shared_client
    if _shared_client is None:
        _shared_client = httpx.AsyncClient(timeout=CLERK_BACKEND_TIMEOUT)


async def close_clerk_backend_client() -> None:
    global _shared_client
    client = _shared_client
    _shared_client = None
    if client is not None:
        await client.aclose()


def get_clerk_backend_client() -> ClerkBackendClient:
    return _clerk_backend_client


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
    "CLERK_BACKEND_TIMEOUT",
    "CLERK_BACKEND_API_ROOT",
    "CLERK_BACKEND_API_VERSION",
    "clerk_backend_headers",
    "clerk_backend_url",
    "clerk_user_url",
    "ClerkBackendClient",
    "ClerkBackendError",
    "ClerkBackendTimeoutError",
    "ClerkBackendTransportError",
    "close_clerk_backend_client",
    "get_clerk_backend_client",
    "start_clerk_backend_client",
]
