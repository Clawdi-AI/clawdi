# Desktop shared sign-in

One Clerk OAuth device-code approval signs in CLI and Desktop using
`~/.clawdi/auth.json`. Desktop loads the live `https://cloud.clawdi.ai` dashboard
in a dedicated sandboxed BrowserWindow. Connect remains a bundled local window.

The restored exchange follows the implementation before #1746/#1751:
`auth desktop-session --json` calls `POST /v1/cli/auth/oauth/desktop-ticket`
with the saved first-party CLI OAuth credential. Cloud calls Clerk's
`POST /v1/sign_in_tokens` with the verified user ID and `expires_in_seconds: 60`.
Clerk owns token expiry and single-use consumption. The response is `no-store`;
private machine stdout carries the ticket to Electron, never diagnostic logs.

Only the dashboard main frame on `/desktop-auth` can request a ticket over the
preload bridge. Normal browsers refuse the handoff and ignore URL tickets.
The bridge verifies the local Clawdi account before and after the exchange.
The exchange returns the verified Clerk user ID for web-session matching; the
CLI account ID is a different, internal Clawdi UUID. The page
uses Clerk `signIn.ticket()` / `finalize()` and refuses an account mismatch.
Tickets are never put in navigation URLs or persisted. The dashboard session
uses an in-memory Electron partition; reopening Desktop obtains a fresh ticket.

Navigation trusts only exact HTTPS origins: `cloud.clawdi.ai`, `clerk.clawdi.ai`
and `accounts.clawdi.ai`. External HTTPS links use validated `shell.openExternal`.
Permissions, devices, downloads and webviews are denied. Remote content has no
Node access. Sign-out closes the remote window, clears its storage and removes
the shared CLI credential. External browser sessions are independent. CLI
sign-out/account changes close the embedded session at the next status refresh
(up to one minute).

## Sensitive actions: Clerk Reverification

We use the documented `strict` preset, equivalent to
`has({ reverification: 'strict' })`: second factor under 10 minutes, falling
back to the first when the second is unavailable. Both unverified ages, missing
claims and malformed claims fail closed. The Python gate reads `fva` only after
the normal JWT signature/issuer/expiry validation; API keys and CLI OAuth remain
ineligible. The web uses Clerk `useReverification()` with its default modal,
`session.checkAuthorization()` and a fresh session token after verification.
The server returns Clerk's documented `clerk_error` reverification hint on 403.

Cloud applies this gate to API key list and revoke, including compatibility
aliases. Personal API key creation remains retired (410); no key is issued.
Internal admin key creation is outside this browser surface.

### Hosted changes required (outside this repository)

The UI gates the following Hosted routes. Add the equivalent signed-session
`fva` check after Hosted's existing web-auth dependency and before mutation or
Stripe calls. Require Clerk session auth, return the documented 403 hint, and
test absent/malformed/stale ages, recent first/second factors, CLI OAuth and API
key rejection. This PR does not change or deploy Hosted; UI gating alone does
not protect its APIs.

| Method | Route | Sensitive behavior |
| --- | --- | --- |
| POST | `/v2/wallet/auto-reload/setup-intent` | Payment method entry |
| POST | `/v2/wallet/auto-reload/setup-intent/finalize` | Save payment method |
| PUT | `/v2/wallet/auto-reload` | Enable or change auto-reload |
| POST | `/v2/wallet/topup` | Create payment checkout |
| POST | `/v2/subscription/portal` | Enter payment/plan portal |
| POST | `/v2/subscription/fix-payment` | Payment recovery |
| POST | `/v2/subscription/checkout` | Purchase/plan entry |
| POST | `/v2/subscription/plan/change` | Change plan |
| POST | `/v2/subscription/plan/cancel-scheduled-change` | Change scheduled plan |

Clerk must issue version-2 session tokens with the default `fva` claim. Users
need an eligible verification factor; password, email/phone code and MFA are
documented. Users with only unsupported factors cannot reverify. We do not
change Clerk Dashboard settings. Deploy Cloud and the web restoration together;
old Cloud returns 410 to ticket requests. Deploy Hosted enforcement before
claiming payment/plan actions are protected server-side.

## Verification

With Docker available, run:

```bash
bash apps/desktop/scripts/shared-login-e2e.sh
```

Done: the isolated real-Electron runner exits 0 and reports `Verified real
Electron`, covering device approval, Connect, the actual `/desktop-auth` page
with mocked Clerk, browser ticket refusal, navigation/IPC and shared sign-out.
Linux container execution disables the OS sandbox only for the test process;
production sandbox/context-isolation options are checked by Desktop unit tests.

## Official references

- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Clerk sign-in token creation](https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token)
- [Clerk ticket sign-in](https://clerk.com/docs/guides/development/custom-flows/authentication/embedded-email-links)
- [Clerk session tokens: default `fva` claim](https://clerk.com/docs/guides/sessions/session-tokens)
- [Clerk Reverification](https://clerk.com/docs/guides/secure/reverification)
- [Clerk `useReverification`](https://clerk.com/docs/reference/hooks/use-reverification)
- [Clerk Auth `has()`](https://clerk.com/docs/reference/backend/types/auth-object#has)
- [Official strict-preset implementation](https://github.com/clerk/javascript/blob/main/packages/shared/src/authorization.ts)
- [Official authorization error format](https://github.com/clerk/javascript/blob/main/packages/shared/src/authorization-errors.ts)
