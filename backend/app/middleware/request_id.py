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

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

_INBOUND_HEADERS = ("x-request-id", "x-correlation-id")
_OUTBOUND_HEADER = "X-Request-ID"


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = _read_inbound(request) or uuid.uuid4().hex
        request.state.request_id = request_id

        response = await call_next(request)
        response.headers[_OUTBOUND_HEADER] = request_id
        return response


def _read_inbound(request: Request) -> str | None:
    for key in _INBOUND_HEADERS:
        value = request.headers.get(key)
        if value:
            # Trim and cap length so an upstream can't inject gigabyte headers.
            trimmed = value.strip()[:128]
            if trimmed:
                return trimmed
    return None
