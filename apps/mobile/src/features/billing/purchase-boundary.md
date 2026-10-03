# RevenueCat purchase boundary

The Wave3 mobile surface intentionally exposes billing inventory and server-owned
Basic admission only. It does not start a store purchase, restore purchases, or
claim a client-side entitlement. `purchase-boundary.ts` keeps this boundary
explicit: web/unknown platforms are `unsupported`; incomplete native setup and
the missing Hosted sync contract are `disabled`; an injected provider is only
called after all gates pass. The adapter also accepts the auth provider's
account-generation `isCurrent` fence, so a late provider result is discarded
after sign-out or account switch.

No RevenueCat SDK dependency or public key is committed here. A future native
integration must inject the SDK adapter and configure only the platform's public
RevenueCat key at build time. It must also pass `hostedSyncAvailable: true` only
after the following authenticated Hosted contract exists:

1. `POST /v2/store/revenuecat/purchase` (or an equivalent versioned route), with
   an idempotency key, store/platform, product identifier, and the RevenueCat
   customer/transaction reference. The server must own product-to-plan mapping
   and return a durable purchase/entitlement status.
2. `POST /v2/store/revenuecat/restore` (or an equivalent versioned route), with
   the current RevenueCat customer identifier and an idempotency key. The server
   must reconcile webhook-delivered state and return the authoritative
   entitlement projection; a client restore alone must never grant compute.
3. A read endpoint (for example `GET /v2/store/entitlements`) that returns
   account-scoped status, product, plan, period, revocation, and pending-sync
   state. Responses need stable IDs, explicit unavailable/pending states, and
   no pricing or product inference by the client.

All three mutations need Clerk authentication, account ownership fencing, replay
safe idempotency semantics, and public error codes for pending, rejected,
revoked, and unavailable outcomes. The current Wave3 generated Hosted contract
contains Stripe/wallet routes and read-only subscription data but none of these
store routes, so the mobile app must remain purchase-disabled until Hosted owns
this schema and the generated client is refreshed.
