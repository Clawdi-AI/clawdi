# Store purchase boundary

`store/` is the non-UI M1 platform layer. `StoreProvider`, mounted inside the
existing account and API providers, bootstraps the authenticated store identity
and recovers pending attempts on start/foreground. M2 owns RevenueCat Paywalls,
Customer Center and card-only surface hiding. SDK results and `CustomerInfo`
never grant credits or compute; only hosted `funding_applied` acknowledges
settlement. Funding does not automatically spend credits or admit a deployment.

## Configuration and identity

The existing runtime config reads the public
`EXPO_PUBLIC_REVENUECAT_APPLE_KEY` / `EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY` from Expo
config. An unset platform key or compute endpoint leaves purchases unavailable
without blocking the rest of the app. Production runtime configuration rejects
RevenueCat Test Store keys (the official `test_` prefix). The parser permits them
outside production; RevenueCat requires a debug native build to use Test Store.
`store/store-policy.ts` reads runtime
`environment` (from `EXPO_PUBLIC_CLAWDI_ENV`): production is a store build;
preview/development retain Web parity. M2 applies this policy even when purchases
are unavailable.

An enabled `GET /v2/store/bootstrap?platform=app_store|play_store` supplies the
opaque `app_user_id` and catalogue revision. Configure Purchases once with that
identity, call `Purchases.logIn(app_user_id)`, then verify `getAppUserID()`.
Disabled bootstrap may return a null identity and never initializes the SDK.
Sign-out and auth loading disable purchasing through account fencing and keep
the SDK identity. Never call `Purchases.logOut()`: it creates an anonymous ID.
The next enabled bootstrap logs in the next account's opaque identity.

Operations capture the existing account scope and abort signal. SDK identity
changes and native paywall execution are serialized. Account/session/generation
changes or SDK identity mismatch prevent opening a paywall or confirming an old
account's purchase. Journals survive sign-out, scoped by account, compute
endpoint and platform through a SHA-256 SecureStore key.

## M2 purchase integration

Use `useMobileStore()` for availability, the `flow`, recovered outcomes and safe
typed errors. After explicit user intent, call
`flow.purchase({ purpose: "standalone_topup" }, showPaywall)` (or the generated
`deploy_continuation` purpose/target).

1. M1 generates and persists the idempotency key and exact request **before**
   `POST /v2/store/purchase-attempts`. It saves the returned attempt id and a
   purchase-start marker before invoking `showPaywall`.
2. M2 presents the official `<RevenueCatUI.Paywall>` for the offering. The
   paywall selects its package; the attempt request contains no product.
   Use the official `onPurchasePackageInitiated({ resume })` callback to call
   `resume(!signal.aborted)` with the signal supplied to `showPaywall`; an obsolete
   account scope or timed-out operation must call `resume(false)` to block the
   native purchase. This callback is required even while dismissal is underway.
   After purchase completion **and UI dismissal**, resolve `showPaywall` with
   `onPurchaseCompleted`'s `storeTransaction`. Resolve null only for a definitive
   dismissal/cancellation without purchasing. Ask-to-Buy and Play `PENDING`
   must reject/throw, preserving the uncertain purchase-start marker; they must
   never resolve null. `onPurchaseCancelled` alone does not dismiss the paywall.
   On signal abort, dismiss the UI and finish the promise within a bounded time.
   `showPaywall` must settle within five minutes; M1's `withIdentity` guards the
   whole operation with that deadline, aborts its signal and surfaces
   `store_operation_timeout` to the caller. The timeout does **not** release
   the identity lock: the queue waits until the native purchase/UI work actually
   settles, even after reporting failure. M2 must close the UI on abort and
   settle its promise only after native work finishes. Late results remain
   fenced and cannot confirm under the next account.
3. M1 saves the `transactionIdentifier` hint before
   `POST /v2/store/purchase-attempts/{attempt_id}/confirm`. Hosted verification
   binds the product and owns all financial effects.
4. Read `GET /v2/store/purchase-attempts/{attempt_id}` using 2/4/8/16/30-second
   backoff, capped at two minutes. Return `funding_applied`,
   `submitted`, `terminal`, `pending`, or `cancelled`; timeout retains the journal.
   A locally cancelled `prepared` attempt retains its journal and cancellation status
   across restart; an explicit retry of that intent can reopen the Paywall.
   Funded, canceled, expired and rejected server attempts release the local
   journal. An **expired attempt with a transaction hint** confirms once; if
   hosted still returns `expired`, M1 clears the journal and returns `submitted`.
   Hosted credits the transaction independently and never moves that expired
   attempt to `funding_applied`. M2 shows the localized equivalent of "Purchase
   submitted; credit will arrive in your wallet" and refreshes the Wallet
   balance. `submitted` does not acknowledge settlement or automatically resume
   a deploy continuation. A
   `reconciliation_required` hold stops polling and keeps blocking another buy.

`StorePurchaseError.code` uses `readStoreErrorCode` from `@clawdi/shared/api`;
raw SDK/server messages stay private. Uncertain native/deferred errors retain
the purchase-start marker. Retrying reconciles without another store charge.
A lost create response reuses the saved key and original request/revision.
An explicit typed 4xx create rejection clears the journal when no attempt id
was received and surfaces the original typed code. Network, 5xx and unknown
outcomes retain the journal. Recovery errors surface through `error` while
preserving bootstrap availability and `flow`, so a retry remains possible.
Before blocking a different purpose/target with `purchase_pending`, M1 reads
the previous server attempt and finishes any completed state other than
`reconciliation_required` before proceeding. Paid expired evidence is submitted
through confirm before its journal is released.

## Recovery and official APIs

`flow.recover()` reconciles the local journal and lists server attempts with
`GET /v2/store/purchase-attempts?state=pending`. It never opens a native purchase.
Confirm requires a persisted transaction hint from a completed SDK purchase.
An interrupted `prepared` purchase with a start marker and no hint calls official
`Purchases.syncPurchases()`, then **only reads** attempt state. Sync is not
evidence of payment. Webhooks/workers claim real purchases; a never-paid prepared
attempt expires through the server TTL. Other attempts without local transaction
evidence also recover through reads, never confirm. Prepared attempts without a
purchase-start marker are read without sync or confirmation. Recovery shares
one two-minute polling budget across attempts.
Backgrounding cancels recovery; foregrounding refreshes bootstrap
and recovers again. Foreground events during a purchase preserve its SDK identity.

Accepted residual behavior (C): a different-purpose purchase remains blocked by
a locally cancelled `prepared` attempt until the server expires it (up to 15
minutes), despite reading its current state. Accepted residual behavior (E):
each foreground recovery of an interrupted `prepared` attempt without a hint
calls `syncPurchases()` again; repeated foreground refreshes can repeat the sync.

Both RevenueCat packages are **10.11.0**; UI was added with
`npx expo install react-native-purchases-ui@10.11.0 --bun`. Official installed
declarations/source confirm `configure`, `logIn`, `getAppUserID` and
`syncPurchases`; Paywall's `onPurchasePackageInitiated` supplies `resume(boolean)`
and its completion event carries `storeTransaction`, whereas
`presentPaywall()` returns only `PAYWALL_RESULT` and cannot supply that hint.
`RevenueCatUI.presentCustomerCenter(params?)` returns `Promise<void>`; M2 owns
management/restore UI. Consumable credits cannot be restored. Customer Center
requires owner RevenueCat configuration/plan.

References: [customer identity](https://www.revenuecat.com/docs/customers/identifying-customers),
[displaying Paywalls](https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls),
[Customer Center RN](https://www.revenuecat.com/docs/tools/customer-center/customer-center-react-native),
[Test Store](https://www.revenuecat.com/docs/test-and-launch/sandbox/test-store),
[official RN SDK](https://github.com/RevenueCat/react-native-purchases).

Done: `bun run --cwd apps/mobile typecheck` and `bash scripts/test.sh mobile`
exit 0. Mock SDK tests cover fencing, restart recovery, idempotency reuse,
persistence failure, recovery errors, evidence-free sync/read recovery, late
paid expiry, cancellation, Paywall timeout, production Test Store key rejection
and typed errors. Native rendering, real transactions and live settlement
require separate M2/sandbox acceptance; an
Android export proves bundling only.
