# Sharing Clerk sessions between `clawdi.ai` and `cloud.clawdi.ai`

**Goal:** A user signs in on `clawdi.ai`, then opens `cloud.clawdi.ai` and is already signed in. No second login. Both apps see the same `userId` and can exchange API tokens without re-auth.

This works in Clerk out of the box when both apps use the **same Clerk application** and live on **sibling subdomains of the same apex domain**. The cookie Clerk sets on `.clawdi.ai` is readable by every subdomain.

## One-time Clerk Dashboard setup

1. Pick the Clerk application that owns `clawdi.ai` in the Clerk Dashboard — we do **not** create a new application for cloud.
2. Clerk → **Domains** → add `cloud.clawdi.ai` as a satellite domain. In a single-apex-domain setup, mark it as a primary domain if you want `/sign-in` on the cloud app to be self-contained, or as a satellite if you want sign-ins to redirect to `clawdi.ai/sign-in`.
3. Clerk → **Paths** → confirm `Sign-in URL`, `Sign-up URL`, `After sign-in URL`, `After sign-up URL` are each absolute, not relative, so they can point back to the main `clawdi.ai` app if you want a single sign-in surface.

Clerk's session cookie (`__session`) is already scoped to `.clawdi.ai` once both domains are registered — nothing to configure on the cookie level.

## Environment variables on `cloud.clawdi.ai`

Reuse the same keys as `clawdi.ai`. Specifically in `apps/web/.env.production`:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<same pk_live_... as clawdi.ai>
CLERK_SECRET_KEY=<same sk_live_... as clawdi.ai>

# If you went satellite-mode in step 2 above (recommended):
NEXT_PUBLIC_CLERK_IS_SATELLITE=true
NEXT_PUBLIC_CLERK_DOMAIN=cloud.clawdi.ai
NEXT_PUBLIC_CLERK_SIGN_IN_URL=https://clawdi.ai/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=https://clawdi.ai/sign-up

# If both apps host their own sign-in surface (primary-mode):
# leave the IS_SATELLITE / DOMAIN vars unset; just share pk/sk.
```

With primary-mode on both: each app serves its own `/sign-in` and `/sign-up`, but the resulting session cookie is valid on both hosts, so you only actually sign in once per browser.

## Backend (FastAPI) verification

`backend/app/core/auth.py` already uses `CLERK_PEM_PUBLIC_KEY` to validate tokens. That key is per-Clerk-application — it doesn't care which host the token came from. No backend change is needed as long as both apps share the Clerk application.

If you've also split backends (one API behind `api.clawdi.ai`, another behind `api.cloud.clawdi.ai`), both backends need the **same** `CLERK_PEM_PUBLIC_KEY`. Rotate keys on both simultaneously.

## CORS / cookie considerations

If `cloud.clawdi.ai` calls `api.clawdi.ai` (cross-subdomain API):

1. Add `https://cloud.clawdi.ai` to the backend's `CORS_ORIGINS`.
2. Make sure the CORS middleware has `allow_credentials=True` (we do).
3. If you serve the API over a different origin, Clerk's session cookie won't go cross-origin on its own — use `auth().getToken()` on the client, pass it as `Authorization: Bearer` to the API (what we already do), and let the API verify via the PEM public key.

## Local dev

For local testing without real subdomains, point both apps at the same Clerk **development** application (`pk_test_…`). Clerk dev instances accept any `localhost:PORT` origin, so two `localhost` apps sharing a dev Clerk key will share sessions in the same browser profile automatically.

## Verifying it works

1. Sign in at `https://clawdi.ai` in a fresh browser.
2. Open `https://cloud.clawdi.ai` in a new tab of the same window.
3. You should land straight on the dashboard. Request headers on the cloud app should carry the same `__session` cookie.
4. `useUser()` on cloud should return the same `userId`.
5. A CLI token minted from cloud (`/api/auth/keys`) should authenticate against the clawdi.ai API (both share the Clerk app, so the user id is identical).

## Rolling back / un-linking

If cloud needs its own user base later, create a separate Clerk application and swap the keys on cloud only. The clawdi.ai session cookie will be invalid on cloud and vice versa — users will have to re-authenticate the first time.
