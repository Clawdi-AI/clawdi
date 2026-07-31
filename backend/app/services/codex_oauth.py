"""OpenAI Codex device authorization protocol adapter.

This module contains only the upstream HTTP contract. Persistence, ownership,
and API response shaping stay in the AI provider route.
"""

from dataclasses import dataclass

import httpx

CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device"
CODEX_DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
CODEX_DEVICE_CALLBACK_URL = "https://auth.openai.com/deviceauth/callback"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_DEVICE_RESPONSE_LIMIT_BYTES = 256 * 1024


@dataclass(frozen=True)
class CodexDeviceAuthorization:
    device_auth_id: str
    user_code: str
    poll_interval_seconds: int


@dataclass(frozen=True)
class CodexDevicePoll:
    pending: bool
    authorization_code: str | None = None
    code_verifier: str | None = None


class CodexOAuthUpstreamError(Exception):
    def __init__(
        self,
        message: str,
        *,
        unavailable: bool = False,
        retry_after: int | None = None,
        pending_retry: bool = False,
    ):
        super().__init__(message)
        self.unavailable = unavailable
        self.retry_after = retry_after
        self.pending_retry = pending_retry


def device_headers(content_type: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": content_type,
        "User-Agent": "clawdi",
        "originator": "clawdi",
    }


def response_json(response: httpx.Response) -> dict:
    if len(response.content) > CODEX_DEVICE_RESPONSE_LIMIT_BYTES:
        raise CodexOAuthUpstreamError("ChatGPT returned an oversized response")
    try:
        data = response.json()
    except ValueError as exc:
        raise CodexOAuthUpstreamError("ChatGPT returned an invalid response") from exc
    if not isinstance(data, dict):
        raise CodexOAuthUpstreamError("ChatGPT returned an invalid response")
    return data


def required_field(data: dict, field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise CodexOAuthUpstreamError("ChatGPT returned an incomplete response")
    return value


def _retry_after(response: httpx.Response) -> int | None:
    raw = response.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return min(max(int(raw), 1), 60)
    except ValueError:
        return None


async def start_device_authorization(
    client: httpx.AsyncClient,
    client_id: str,
) -> CodexDeviceAuthorization:
    try:
        response = await client.post(
            CODEX_DEVICE_USER_CODE_URL,
            headers=device_headers("application/json"),
            json={"client_id": client_id},
        )
    except httpx.HTTPError as exc:
        raise CodexOAuthUpstreamError(
            "ChatGPT device sign-in is temporarily unavailable",
            unavailable=True,
        ) from exc
    if response.status_code == 404:
        raise CodexOAuthUpstreamError(
            "ChatGPT device sign-in is not enabled for this account or workspace",
            unavailable=True,
        )
    if response.status_code == 429:
        raise CodexOAuthUpstreamError(
            "Too many ChatGPT sign-in attempts. Try again shortly",
            retry_after=_retry_after(response) or 5,
        )
    if response.status_code >= 400:
        raise CodexOAuthUpstreamError("ChatGPT device sign-in could not be started")
    data = response_json(response)
    user_code = data.get("user_code") or data.get("usercode")
    if not isinstance(user_code, str) or not user_code:
        raise CodexOAuthUpstreamError("ChatGPT returned an incomplete response")
    interval = data.get("interval")
    return CodexDeviceAuthorization(
        device_auth_id=required_field(data, "device_auth_id"),
        user_code=user_code,
        poll_interval_seconds=min(max(interval, 1), 30) if isinstance(interval, int) else 5,
    )


async def poll_device_authorization(
    client: httpx.AsyncClient,
    *,
    device_auth_id: str,
    user_code: str,
) -> CodexDevicePoll:
    try:
        response = await client.post(
            CODEX_DEVICE_TOKEN_URL,
            headers=device_headers("application/json"),
            json={"device_auth_id": device_auth_id, "user_code": user_code},
        )
    except httpx.HTTPError as exc:
        raise CodexOAuthUpstreamError(
            "ChatGPT device sign-in is temporarily unavailable",
            unavailable=True,
        ) from exc
    if response.status_code in {403, 404}:
        return CodexDevicePoll(pending=True)
    if response.status_code == 429:
        raise CodexOAuthUpstreamError(
            "ChatGPT authorization is being checked too quickly",
            retry_after=_retry_after(response) or 5,
            pending_retry=True,
        )
    if response.status_code >= 400:
        raise CodexOAuthUpstreamError("ChatGPT device authorization failed")
    data = response_json(response)
    return CodexDevicePoll(
        pending=False,
        authorization_code=required_field(data, "authorization_code"),
        code_verifier=required_field(data, "code_verifier"),
    )


async def exchange_device_code(
    client: httpx.AsyncClient,
    *,
    client_id: str,
    authorization_code: str,
    code_verifier: str,
) -> httpx.Response:
    try:
        response = await client.post(
            CODEX_OAUTH_TOKEN_URL,
            headers=device_headers("application/x-www-form-urlencoded"),
            data={
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": CODEX_DEVICE_CALLBACK_URL,
                "client_id": client_id,
                "code_verifier": code_verifier,
            },
        )
    except httpx.HTTPError as exc:
        raise CodexOAuthUpstreamError(
            "ChatGPT device sign-in is temporarily unavailable",
            unavailable=True,
        ) from exc
    if response.status_code == 429:
        raise CodexOAuthUpstreamError(
            "ChatGPT is temporarily rate-limiting token exchange. Try again shortly",
            retry_after=_retry_after(response) or 5,
        )
    if response.status_code >= 400:
        raise CodexOAuthUpstreamError("ChatGPT device token exchange failed")
    return response
