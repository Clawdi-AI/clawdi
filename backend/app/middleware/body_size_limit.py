"""ASGI middleware that rejects HTTP requests whose body size
exceeds a configured cap, BEFORE any route handler or body parser
runs.

Two enforcement layers, both required:

1. **Declared `Content-Length` over the cap → 413 immediately.**
   Fast-path for honest clients; no body is read at all.

2. **Streaming receive counter for chunked / no-Content-Length
   uploads.** FastAPI resolves `UploadFile = File(...)` by
   spooling the entire multipart body to disk *before* the
   handler starts. Without intercepting the ASGI `receive`
   stream we have no way to refuse a chunked upload before it
   fills the spool. Wrap the receive callable so each
   `http.request` chunk increments a running total; if the total
   crosses `max_bytes`, drain the remainder and send 413 directly.

The cap is enforced ONLY on body-bearing methods (POST / PUT /
PATCH). GET / HEAD / DELETE / OPTIONS pass through unchanged so
the middleware doesn't add overhead to read paths.
"""

from __future__ import annotations

import logging

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)


class BodySizeLimitMiddleware:
    """Reject requests whose body exceeds `max_bytes` with a 413
    before any route handler or dependency runs.

    Single global cap; per-route handlers can apply tighter caps
    on top as defense-in-depth (e.g. skills upload's 25 MB
    re-check after the streamed read).
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET").upper()
        # DELETE included alongside POST/PUT/PATCH because the
        # vault items endpoint (`DELETE /api/vault/{slug}/items`)
        # accepts a JSON body of field names. Without DELETE in
        # the set, a client could ship an unbounded body to that
        # route and FastAPI would parse it before any limit
        # applied. GET / HEAD / OPTIONS still bypass — they're
        # body-less by RFC.
        if method not in ("POST", "PUT", "PATCH", "DELETE"):
            await self.app(scope, receive, send)
            return

        # Layer 1: declared `Content-Length` fast-path. Reject the
        # request without reading any body when the client is
        # honest about its size.
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value.decode("ascii", errors="replace"))
                except (ValueError, UnicodeDecodeError):
                    # Malformed header — fall through to streaming
                    # check, which is authoritative anyway.
                    declared = -1
                if declared > self.max_bytes:
                    logger.info(
                        "body_size_rejected_header method=%s path=%s declared=%d cap=%d",
                        method,
                        scope.get("path", ""),
                        declared,
                        self.max_bytes,
                    )
                    await _drain_and_413(receive, send)
                    return
                break

        # Layer 2: streaming receive counter. Wrap the upstream
        # `receive` so each `http.request` chunk increments a
        # running byte total. If total > cap, drain whatever
        # remains and send 413. The inner app never sees `receive`
        # again past that point — its parser will hit our
        # disconnect message and bail.
        #
        # Two state flags coordinate with `gated_send` to avoid
        # emitting two response heads on the wire. If the inner
        # app already started its response *before* we noticed the
        # body was too big, we don't 413 (it would be a second
        # `http.response.start`); we just swallow whatever else the
        # inner app tries to emit and trust that the partial
        # response in flight is the one the client sees.
        total = 0
        rejected = False
        # Set to True the moment the inner app emits its
        # response.start. Once true, we will NOT send our own 413
        # (would be a duplicate response head).
        inner_response_started = False

        async def counting_receive() -> Message:
            nonlocal total, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message.get("type") != "http.request":
                return message
            body = message.get("body", b"")
            total += len(body)
            if total > self.max_bytes:
                logger.info(
                    "body_size_rejected_stream method=%s path=%s read=%d cap=%d",
                    method,
                    scope.get("path", ""),
                    total,
                    self.max_bytes,
                )
                rejected = True
                # Bound the post-rejection drain so a malicious or
                # buggy client streaming chunked-encoded forever
                # can't tie up the request indefinitely. Original
                # code drained until `more_body=false`, which a
                # never-ending stream never produces. We give up
                # after one extra chunk's worth and signal
                # disconnect — the ASGI server closes the socket
                # if the client refuses to follow.
                _DRAIN_AFTER_REJECT = 1
                more = bool(message.get("more_body", False))
                drained = 0
                while more and drained < _DRAIN_AFTER_REJECT:
                    drain_msg = await receive()
                    drained += 1
                    if drain_msg.get("type") != "http.request":
                        break
                    more = bool(drain_msg.get("more_body", False))
                # Only send 413 if the inner app hasn't already
                # responded. If it has, we'd be writing a second
                # http.response.start which is a protocol error
                # (Starlette's TestClient raises; ASGI servers
                # in production close the connection). Better to
                # let the partial in-flight response complete
                # under `gated_send`'s swallow rule.
                if not inner_response_started:
                    await _send_413(send)
                return {"type": "http.disconnect"}
            return message

        # Wrap `send` so we can detect whether the inner app has
        # already produced a response head. Two responsibilities:
        #   1. Track inner_response_started so counting_receive
        #      knows whether 413 is still safe to send.
        #   2. Once we've rejected and sent 413 ourselves, swallow
        #      anything the inner app emits afterward to avoid
        #      duplicate response cycles.
        async def gated_send(message: Message) -> None:
            nonlocal inner_response_started
            t = message.get("type")
            if rejected and inner_response_started is False:
                # We already sent 413 from the receive side and
                # the inner app hadn't started — swallow anything
                # late.
                return
            if t == "http.response.start":
                inner_response_started = True
            await send(message)

        await self.app(scope, counting_receive, gated_send)


async def _send_413(send: Send) -> None:
    """Plain JSON 413 response."""
    body = b'{"detail":"Request body too large"}'
    headers: list[tuple[bytes, bytes]] = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    await send({"type": "http.response.start", "status": 413, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


async def _drain_and_413(receive: Receive, send: Send) -> None:
    """For the declared-Content-Length-over-cap fast path. We
    haven't started reading the body yet, but most ASGI servers
    keep the connection alive and expect us to either consume
    the body or signal disconnect cleanly. Send 413 and trust
    the server to recycle the connection."""
    await _send_413(send)
