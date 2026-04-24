# Sharing Clerk sessions between `clawdi.ai` and `cloud.clawdi.ai`

Goal: a user signs in on `clawdi.ai`, opens `cloud.clawdi.ai`, lands on the dashboard — no second login. Both apps see the same `userId`.

This works because both apps use the **same Clerk application**, and Clerk's session cookie (`__session`) is scoped to `.clawdi.ai` — every sibling subdomain reads it.

## Clerk dashboard setup (one-time)

1. In the Clerk dashboard, open the application that owns `clawdi.ai`. We do **not** create a new application for cloud.
2. **Domains** → add `cloud.clawdi.ai` as a **primary** domain (not satellite — each app serves its own `/sign-in` and `/sign-up`, but the resulting cookie is valid on both hosts).

That's it. No `IS_SATELLITE` / `DOMAIN` / cross-origin redirect config needed.

## Env vars on `cloud.clawdi.ai` (Vercel)

Reuse the same keys as `clawdi.ai`:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<same pk_live_… as clawdi.ai>
CLERK_SECRET_KEY=<same sk_live_… as clawdi.ai>
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_API_URL=https://cloud-api.clawdi.ai
```

## Backend

`backend/app/core/auth.py` validates Clerk JWTs with `CLERK_PEM_PUBLIC_KEY`. That key is per-Clerk-application, not per-host — both `api.clawdi.ai` and `cloud-api.clawdi.ai` use the same PEM. Rotate on both together if Clerk ever rolls the key.

## CORS

The web app (`cloud.clawdi.ai`) calls the API on a different origin (`cloud-api.clawdi.ai`). Clerk's cookie is `.clawdi.ai`-scoped so the browser sends it, but we use bearer tokens anyway via `auth().getToken()` + `Authorization: Bearer`. So:

1. `CORS_ORIGINS` on the API includes `https://cloud.clawdi.ai`.
2. `allow_credentials=True` is on (see `app/main.py`).

## Local dev

Both apps point at the same Clerk **dev** application (`pk_test_…`). Dev instances accept any `localhost:PORT` origin — two local apps with the same dev keys share sessions in the same browser profile automatically.
