# RevenueCat purchase boundary

The Wave3 mobile surface intentionally exposes billing inventory and server-owned
admission against existing Basic/Performance entitlements only. It does not start
a store purchase, restore purchases, or claim a client-side entitlement. No
purchase action is wired into the product yet. The native adapter is deliberately
isolated: a local SDK result is not proof of server entitlement or financial
settlement.

The native RevenueCat SDK is now isolated in `revenuecat.ts`; it configures only
the platform's public key and a server-selected customer identity. It does not
grant entitlement from `CustomerInfo`. A future server route must still reconcile
the store transaction before the app enables compute. Purchase attempts must
must be durable before opening the store sheet, account-generation fenced, and
recoverable after app termination. The following routes are illustrative contract
requirements, not implemented endpoints or an approved schema:

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

Purchase/restore mutations need Clerk authentication, account ownership fencing,
replay-safe idempotency semantics, and public error codes for pending, rejected,
revoked, and unavailable outcomes. Reads must enforce the same ownership. Webhook
and reconciliation writers must deduplicate financial effects by transaction,
not merely event ID; refunds and account termination must preserve provenance.
Each Agent retains its independent subscription; no account-wide slot or bundle
is implied. The current generated Hosted contract
contains Stripe/wallet routes and read-only subscription data but none of these
store routes, so the mobile app must remain purchase-disabled until Hosted owns
this schema and the generated client is refreshed.
