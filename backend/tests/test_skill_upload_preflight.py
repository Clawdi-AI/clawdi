from __future__ import annotations

import httpx
import pytest
from starlette.types import Message, Receive, Scope, Send

from app.middleware.skill_upload_preflight import SkillUploadPreflightMiddleware


def _multipart_body(*, skill_key: str | None) -> tuple[bytes, str]:
    boundary = "----clawdi-test-boundary"
    parts: list[bytes] = []
    if skill_key is not None:
        parts.append(
            (
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="skill_key"\r\n'
                "\r\n"
                f"{skill_key}\r\n"
            ).encode()
        )
    parts.append(
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="skill.tar.gz"\r\n'
            "Content-Type: application/gzip\r\n"
            "\r\n"
            "not-a-real-archive\r\n"
            f"--{boundary}--\r\n"
        ).encode()
    )
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


@pytest.mark.asyncio
async def test_skill_upload_preflight_rejects_invalid_key_before_inner_app():
    called = False

    async def inner_app(_scope: Scope, _receive: Receive, _send: Send) -> None:
        nonlocal called
        called = True
        raise AssertionError("inner app should not receive invalid skill uploads")

    app = SkillUploadPreflightMiddleware(inner_app)
    body, content_type = _multipart_body(skill_key=".system")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/projects/00000000-0000-0000-0000-000000000000/skills/upload",
            content=body,
            headers={"Content-Type": content_type},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid skill_key"}
    assert called is False


@pytest.mark.asyncio
async def test_skill_upload_preflight_replays_valid_upload_to_inner_app():
    seen_body = bytearray()

    async def inner_app(_scope: Scope, receive: Receive, send: Send) -> None:
        while True:
            message: Message = await receive()
            if message["type"] != "http.request":
                break
            seen_body.extend(message.get("body", b""))
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    app = SkillUploadPreflightMiddleware(inner_app)
    body, content_type = _multipart_body(skill_key="valid-skill")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/projects/00000000-0000-0000-0000-000000000000/skills/upload",
            content=body,
            headers={"Content-Type": content_type},
        )

    assert response.status_code == 204
    assert bytes(seen_body) == body


@pytest.mark.asyncio
async def test_skill_upload_preflight_replays_when_skill_key_is_not_in_prefix():
    called = False

    async def inner_app(_scope: Scope, receive: Receive, send: Send) -> None:
        nonlocal called
        called = True
        while True:
            message: Message = await receive()
            if message["type"] != "http.request" or not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    app = SkillUploadPreflightMiddleware(inner_app)
    body, content_type = _multipart_body(skill_key=None)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/projects/00000000-0000-0000-0000-000000000000/skills/upload",
            content=body,
            headers={"Content-Type": content_type},
        )

    assert response.status_code == 204
    assert called is True
