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
without blocking the rest of the app. `store/store-policy.ts` reads runtime
`environment` (from `EXPO_PUBLIC_CLAWDI_ENV`): production is a store build;
preview/development retain Web parity. M2 applies this policy even when purchases
are unavailable.

An enabled `GET /v2/store/bootstrap?platform=app_store|play_store` supplies the
opaque `app_user_id` and catalogue revision. Configure Purchases once with that
identity, call `Purchases.logIn(app_user_id)`, then verify `getAppUserID()`.
Disabled bootstrap may return a null identity and never initializes the SDK.
Sign-out disables the old account immediately and serializes `logOut()` behind
the active native paywall; the anonymous identity created by logout cannot buy.

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
   After purchase completion **and UI dismissal**, resolve `showPaywall` with
   `onPurchaseCompleted`'s `storeTransaction`. Resolve null only when dismissed
   without buying. `onPurchaseCancelled` alone does not dismiss the paywall and
   must not release the identity lock. On scope abort, dismiss the UI, keeping
   the promise pending until the native purchase/UI actually finishes. A late
   result cannot confirm under the next account.
3. M1 saves the `transactionIdentifier` hint before
   `POST /v2/store/purchase-attempts/{attempt_id}/confirm`. Hosted verification
   binds the product and owns all financial effects.
4. Read `GET /v2/store/purchase-attempts/{attempt_id}` using 2/4/8/16/30-second
   backoff, capped at two minutes. Return `funding_applied`,
   `terminal`, or `pending`; timeout retains the journal. Funded, canceled,
   expired and rejected server attempts release the local journal. A
   `reconciliation_required` hold stops polling and keeps blocking another buy.

`StorePurchaseError.code` uses `readStoreErrorCode` from `@clawdi/shared/api`;
raw SDK/server messages stay private. Uncertain native/deferred errors retain
the purchase-start marker. Retrying reconciles without another store charge.
A lost create response reuses the saved key and original request/revision.

## Recovery and official APIs

`flow.recover()` reconciles the local journal and lists server attempts with
`GET /v2/store/purchase-attempts?state=pending`. It never opens a native purchase.
Interrupted purchases can confirm without a hint; server reconciliation owns
settlement. Prepared attempts without a purchase-start marker are read without
confirmation. Recovery shares one two-minute polling budget across attempts.
Backgrounding cancels recovery; foregrounding refreshes bootstrap
and recovers again. Foreground events during a purchase preserve its SDK identity.

Both RevenueCat packages are **10.11.0**; UI was added with
`npx expo install react-native-purchases-ui@10.11.0 --bun`. Official installed
declarations/source confirm `configure`, `logIn`, `logOut`, `isAnonymous` and
`getAppUserID`; Paywall's completion event carries `storeTransaction`, whereas
`presentPaywall()` returns only `PAYWALL_RESULT` and cannot supply that hint.
`RevenueCatUI.presentCustomerCenter(params?)` returns `Promise<void>`; M2 owns
management/restore UI. Consumable credits cannot be restored. Customer Center
requires owner RevenueCat configuration/plan.

References: [customer identity](https://www.revenuecat.com/docs/customers/identifying-customers),
[displaying Paywalls](https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls),
[Customer Center RN](https://www.revenuecat.com/docs/tools/customer-center/customer-center-react-native),
[official RN SDK](https://github.com/RevenueCat/react-native-purchases).

Done: `bun run --cwd apps/mobile typecheck` and `bash scripts/test.sh mobile`
exit 0. Mock SDK tests cover fencing, restart recovery, idempotency reuse,
persistence failure, pending timeout and typed errors. Native rendering, real
transactions and live settlement require separate M2/sandbox acceptance; an
Android export proves bundling only.
