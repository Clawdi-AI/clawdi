"""Request-ID middleware.

Stamps every request with a correlation ID. If the caller already sent
``X-Request-ID``/``X-Correlation-ID``, we reuse it so distributed tracing
stays coherent end-to-end; otherwise we generate a UUID4.

The ID lands on:
- ``request.state.request_id`` so route handlers can include it in logs
- the outgoing response header ``X-Request-ID`` so clients can surface it
"""

from __future__ import annotations

import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_INBOUND_HEADERS = ("x-request-id", "x-correlation-id")
_OUTBOUND_HEADER = "X-Request-ID"


class RequestIDMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _read_inbound(scope) or uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id

        async def send_with_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)[_OUTBOUND_HEADER] = request_id
            await send(message)

        await self.app(scope, receive, send_with_request_id)


def _read_inbound(scope: Scope) -> str | None:
    headers = Headers(scope=scope)
    for key in _INBOUND_HEADERS:
        value = headers.get(key)
        if value:
            # Trim and cap length so an upstream can't inject gigabyte headers.
            trimmed = value.strip()[:128]
            if trimmed:
                return trimmed
    return None
