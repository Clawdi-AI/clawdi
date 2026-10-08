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
`EXPO_PUBLIC_REVENUECAT_CUSTOMER_CENTER_ENABLED=1` is an owner-controlled native
build flag for the RevenueCat Customer Center; it defaults to disabled, so the
official App Store/Google Play management links remain the default path.
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

`purchase()` passes one fixed overall deadline through confirmation and polling.
After a confirmation returns `verification_pending` (including hosted lock
contention), polling that observes `expired` with the saved transaction hint
returns `submitted` and clears the journal without confirming again. Each attempt
is confirmed at most once per purchase/recovery invocation; retries after an
uncertain failure remain idempotent.

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

## M2 UI

`PaywallHost` (mounted in `MobileProviders`) presents the official
`<RevenueCatUI.Paywall>` for the `credits` offering inside a React Native
`Modal`; `paywall-session.ts` turns its listeners into the `showPaywall` result
above. `loadCreditsOffering()` reads `Purchases.getOfferings().all.credits`
before the attempt is created; a missing, empty or failed offering surfaces
`store_offering_unavailable` without opening the Paywall. A Paywall that cannot
render (no native `PaywallView`) resolves null with `paywall_unavailable`.

**Owner configuration requirement:** the Paywall attached to the `credits`
offering must include a close button. `displayCloseButton: true` (passed by
`PaywallHost`) applies only to original-template Paywalls; V2 Paywalls ignore it
and show only the close button configured in the RevenueCat Paywall editor. The
full-screen React Native `Modal` has no iOS swipe-to-dismiss (Android back maps
to `requestClose`), so without that button an iOS user cannot leave the Paywall
until the operation deadline. Test Store acceptance must verify that the close
button dismisses the Paywall, that the flow returns `cancelled` without a charge,
and that a retry reopens it.

`AddCreditsAction` is the only purchase entry. It runs
`flow.purchase({ purpose: "standalone_topup" }, …)` from the Wallet balance card,
Wallet-rail `top_up` recovery (dunning banner and subscription details) and the
deploy wizard's Wallet shortfall, which re-quotes after funding. Funded,
submitted, pending and unconfirmed outcomes refresh the Wallet queries; nothing
auto-deploys. Store builds also show "Check pending purchases" (disabled while
purchases are unavailable), which runs `flow.recover()` (never a Paywall or
store charge) and refreshes the Wallet.

`storeSurfaces()` (`store-policy.ts`) gates presentation. Store builds hide
auto-reload, saved cards/card setup, browser-wallet USDC funding, Stripe
receipt/invoice links, card `fix_payment` and card-only management copy, show Wallet amounts and compute
prices in credits, and keep the Add credits entry visible (disabled with a
neutral status while purchases are unavailable). Preview/development builds keep
Web parity; they show Add credits only when a debug build has a usable store
flow (Test Store key plus enabled hosted bootstrap).

## Compute subscriptions (P2-M2)

Entries render only on store builds while bootstrap reports
`compute_subscriptions_enabled`; new purchases also need `compute_slot.available`,
the loaded `compute` offering and the Paywall host (`useComputePurchaseGate`).

- **Subscribe / upgrade** (deploy wizard source, Agent → Compute on Included Basic)
  present the official Paywall for the `compute` offering. A compute attempt needs its
  product up front, so `compute-paywall.ts` holds the Paywall's purchase in the
  documented `onPurchasePackageInitiated` gate, lets M1 journal and create the attempt
  for the selected package (deploy: the wizard first persists its draft with the
  package's plan and passes `pending_deploy_request_id`; upgrade: `target_deployment_id`),
  then resumes so the Paywall buys exactly that package. A refused attempt resumes
  `false` and closes the Paywall. A cancelled store sheet closes it with no purchase;
  Ask-to-Buy / Play `PENDING` shows "Waiting for approval" and never deploys. After
  `funding_applied` the wizard runs the existing explicit admission with the same
  `deploy_request_id`.
- **Store rows** use the shared presentation and
  `resolveStoreSubscriptionActions` (platform-aware; Web keeps store rows read-only).
  Change plan buys another compute product through the M1 plan-change flow with the
  live contract from `compute_slot` and the server's replacement mode, and always shows
  the shared `CLAWDI_LEGAL_URLS` (Terms of Use (EULA), Privacy Policy) with the
  auto-renew disclosure. Manage opens the Customer Center when the build flag
  is on, otherwise `showManageSubscriptions()` (iOS, Apple link fallback) or the Play
  link; rows billed by the other store show "Managed in … on your … device", no link.
- **Billing**: store slot card and "Restore purchases" (`owned_by_other_account` is
  reported, never transferred).
- **Deletion**: store-funded Agents never offer cancellation choices; the custom
  account-deletion page adds a "cancel it first" step using the shared rule over the
  subscriptions list plus `compute_slot`.

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
