"""Security response headers — defense-in-depth.

Sets the trio of headers that every browser-facing response in
2026 should carry, even though the dashboard sits behind Vercel
which already injects most of these. Belt-and-braces: if a
self-hoster runs the backend without an edge proxy, the headers
still fire; if they DO have an edge proxy, the proxy's headers
override (last writer wins is fine).

- `X-Content-Type-Options: nosniff` — stops MIME-type sniffing
  attacks where a JSON payload gets reinterpreted as HTML.
- `X-Frame-Options: DENY` — clickjacking. Dashboard never
  legitimately loads inside an iframe.
- `Referrer-Policy: strict-origin-when-cross-origin` — keeps
  the dashboard's path (e.g. `/skills/<key>`) from leaking to
  the marketplace repos we link to.
- `Strict-Transport-Security` — only in production
  (HSTS over plaintext localhost would brick dev). Sub-domains
  excluded by default to avoid affecting unrelated tenants.

Round-P4 (security gate) flagged the absence of these. Even
though Vercel sets most automatically, baking them at the
backend keeps every deployment shape (self-hosted, custom
ingress, dev) consistent.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.config import settings


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response: Response = await call_next(request)
        # Only set if absent — don't clobber edge-proxy values.
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if settings.environment == "production":
            h.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
        return response
