"""Early `skill_key` validation for skill multipart uploads.

FastAPI validates `Form(..., pattern=...)` only after Starlette has parsed the
multipart body. A daemon with an invalid local skill directory can therefore
make the server parse and log a doomed archive before returning 422. This
middleware peeks at the small metadata prefix our clients send before the file
part and rejects invalid `skill_key` values before the upload reaches the
multipart parser.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.skill_key import (
    RESERVED_SKILL_KEY_SUFFIXES,
    has_reserved_skill_key_suffix,
    is_valid_skill_key,
)

_PROJECT_SKILL_UPLOAD_RE = re.compile(
    r"^/(api|v1)/projects/[0-9a-fA-F-]{36}/skills/upload$",
)
_MAX_PREFLIGHT_BYTES = 64 * 1024


class SkillUploadPreflightMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not _should_preflight(scope):
            await self.app(scope, receive, send)
            return

        buffered: list[Message] = []
        body_prefix = bytearray()

        while len(body_prefix) < _MAX_PREFLIGHT_BYTES:
            message = await receive()
            buffered.append(message)
            if message.get("type") != "http.request":
                break

            body = message.get("body", b"")
            if body:
                body_prefix.extend(body)
                skill_key = _extract_skill_key(bytes(body_prefix))
                if skill_key is not None:
                    if has_reserved_skill_key_suffix(skill_key):
                        await _send_reserved_skill_key(send)
                        return
                    if not is_valid_skill_key(skill_key):
                        await _send_invalid_skill_key(send)
                        return
                    break

            if not message.get("more_body", False):
                break

        replay = _ReplayReceive(buffered, receive)
        await self.app(scope, replay, send)


def _should_preflight(scope: Scope) -> bool:
    if scope.get("type") != "http":
        return False
    if scope.get("method", "").upper() != "POST":
        return False

    path = str(scope.get("path", ""))
    if path not in ("/api/skills/upload", "/v1/skills/upload") and not (
        _PROJECT_SKILL_UPLOAD_RE.match(path)
    ):
        return False

    content_type = _header(scope, b"content-type")
    return content_type.startswith("multipart/form-data;")


def _extract_skill_key(body_prefix: bytes) -> str | None:
    marker = b'name="skill_key"'
    marker_pos = body_prefix.find(marker)
    if marker_pos < 0:
        return None

    header_end = body_prefix.find(b"\r\n\r\n", marker_pos)
    if header_end < 0:
        return None

    value_start = header_end + 4
    value_end = body_prefix.find(b"\r\n--", value_start)
    if value_end < 0:
        return None

    return body_prefix[value_start:value_end].decode("utf-8", errors="replace")


def _header(scope: Scope, name: bytes) -> str:
    for header_name, header_value in scope.get("headers", []):
        if header_name == name:
            return header_value.decode("latin-1", errors="replace")
    return ""


class _ReplayReceive:
    def __init__(self, buffered: list[Message], receive: Receive) -> None:
        self._buffered = buffered
        self._receive = receive

    def __call__(self) -> Awaitable[Message]:
        if self._buffered:
            message = self._buffered.pop(0)

            async def _return_buffered() -> Message:
                return message

            return _return_buffered()
        return self._receive()


async def _send_invalid_skill_key(send: Send) -> None:
    body = json.dumps({"detail": "Invalid skill_key"}).encode("utf-8")
    await _send_json(send, status=422, body=body)


async def _send_reserved_skill_key(send: Send) -> None:
    detail = (
        "skill_key cannot end with reserved suffix "
        f"({', '.join(sorted(RESERVED_SKILL_KEY_SUFFIXES))})"
    )
    body = json.dumps({"detail": detail}).encode("utf-8")
    await _send_json(send, status=400, body=body)


async def _send_json(send: Send, *, status: int, body: bytes) -> None:
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})
