# Mobile store compliance

Draft for owner review before submission. Configuration and local prebuild checks
do not establish App Store or Play acceptance. Identity is `ai.clawdi.app` on
both platforms; v1 is a portrait phone app with iPad support disabled.

## Privacy manifest evidence

`apps/mobile/app.config.js` declares `NSPrivacyTracking: false` and the union
of required reasons in the installed SDK 57 / React Native 0.86.3 manifests.
The Sentry React Native 7.11.0 podspec pins Cocoa 8.58.0; its
[versioned manifest](https://github.com/getsentry/sentry-cocoa/blob/8.58.0/Sources/Resources/PrivacyInfo.xcprivacy)
supplies the same file timestamp, boot time and UserDefaults reasons.
RevenueCat React Native 10.11.0 pins PurchasesHybridCommon 19.5.0, which pins
RevenueCat iOS 5.92.0. Its [manifest](https://github.com/RevenueCat/purchases-ios/blob/5.92.0/Sources/PrivacyInfo.xcprivacy)
declares UserDefaults CA92.1 and purchase history for app functionality.

| Required API | Reasons | Source in native dependencies |
| --- | --- | --- |
| File timestamps | C617.1, 0A2A.1, 3B52.1 | RN core/cxxreact/Folly/boost/glog, Expo Application and File System, Sentry Cocoa |
| System boot time | 35F9.1 | RN timing/boost, Sentry Cocoa |
| Disk space | E174.1, 85F4.1 | Expo File System |
| UserDefaults | CA92.1 | RN core, Expo Constants/Localization/System UI/EAS Client, Sentry Cocoa, RevenueCat |

Sources under `apps/mobile/node_modules`: `react-native/**/PrivacyInfo.xcprivacy`
and `expo-*/ios/PrivacyInfo.xcprivacy`; EAS Client is a transitive Updates
dependency. Re-audit manifests after native dependency changes. CocoaPods/Xcode
are not available in the Linux verification environment: installed pod aggregation
and the signed archive must still be checked on the iOS builder.

From `apps/mobile`, run:

```bash
npx expo prebuild --platform ios --no-install
```

Done: `ios/Clawdi/PrivacyInfo.xcprivacy` contains the declared reasons and
`NSPrivacyTracking` is false. After the owner signs/uploads, TestFlight must
report no ITMS-91053 warnings; check the archive's merged privacy report too.

## Store disclosures

Use this table as the shared draft for App Store privacy labels and Play Data
safety. All rows have no advertising, tracking or sale purpose. The identity
rows are linked to the account. Diagnostics are not explicitly associated with
an account by the app: no Sentry user identity is set and outgoing identities,
request bodies, queries and token parameters are removed. Sentry drops events,
transactions and breadcrumbs involving `/vault-request`; replay is disabled.

| App data / recipient | Apple category | Play category | Purpose | Linked / required |
| --- | --- | --- | --- | --- |
| Email / Clerk and Cloud account | Contact Info: Email Address | Personal info: Email address | App functionality, account management | Linked; required for email login |
| Name / Clerk account | Contact Info: Name | Personal info: Name | App functionality, profile | Linked; optional profile field |
| User id / Clerk and Cloud APIs | Identifiers: User ID | Personal info: User IDs | App functionality, account management | Linked; required |
| Purchase history / RevenueCat, StoreKit and Play Billing | Purchases: Purchase History | Financial info: Purchase history | App functionality, purchases, entitlement verification and restoration | Linked via RevenueCat appUserID and credits funding the hosted Wallet; required when purchasing |
| Crash reports / Sentry when DSN configured | Diagnostics: Crash Data | App info and performance: Crash logs | App functionality, reliability | Not explicitly linked; conditional on DSN |
| Performance and diagnostic metadata / Sentry when DSN configured | Diagnostics: Performance Data, Other Diagnostic Data | App info and performance: Diagnostics | App functionality, reliability | Not explicitly linked; conditional on DSN |

Manifest declarations include conditional diagnostic collection so an enabled
Sentry build is covered. Labels must reflect the binary actually submitted.
For Play, describe collection and encryption in transit (release APIs require
HTTPS). Account deletion can be requested in the app. Confirm whether Clerk,
Sentry and other processors qualify for Play's service-provider sharing exception
against the owner's contracts; do not infer a blanket "no sharing" answer.

The approved release plan uses store in-app purchases through RevenueCat. Keep the purchase-history
declaration even before IAP wiring is complete. Purchase history is linked to the
Clawdi account through RevenueCat appUserID and credits funding the hosted Wallet;
the app manifest therefore declares `NSPrivacyCollectedDataTypeLinked: true`.
Confirm payment data handled exclusively by Apple/Google versus data received by
the app or RevenueCat; do not claim the app collects card details without evidence.

This is the approved identity/purchase/diagnostics inventory, not a complete certification
of all product content. Before submission, reconcile user-created messages,
files, Vault data, optional avatar/phone/profile fields, connected runtime content,
and all remaining SDKs with backend retention and processing practices. WP3 owns
IAP behavior and entitlement integration. Recheck the native manifests and actual
purchase-data/account linkage when that work is integrated. Analytics,
push notifications and session replay are deferred.

## Permissions and encryption

iOS declares `usesNonExemptEncryption: false` for standard platform HTTPS/keychain
usage; the owner must reconfirm export compliance if additional crypto is added.
Android disables backup. Blocked permissions are overlay, legacy external-storage
read/write, fingerprint and vibration: the shipped product has no corresponding
calls; file import uses the system document picker and export uses private cache
plus a share grant. Internet/network access stays. RevenueCat billing and
install-referrer permissions stay; never block billing-related permissions. Audit the merged
release APK, including dependency permissions, before submission.

## Owner inputs and submission gates

| Input | Status / requirement |
| --- | --- |
| Privacy policy URL | Owner must supply a public URL covering app and service processing, retention and deletion |
| Support URL | Owner must supply a public support URL |
| Play account-deletion web URL | Owner must confirm an existing public deletion-request page or provide one; no page is assumed to exist |
| In-app deletion | Settings > Account > Delete account: Clerk's built-in delete while self-delete is enabled; once the owner disables it, a custom profile page shows the store-billing notice and calls hosted `DELETE /v1/me` (release config requires compute URL) |
| App Review access | Owner supplies a working review account without MFA friction |
| Accounts and credentials | Apple team/ASC app record, Play app/service account, Expo project/token, Clerk production/native registration, optional Sentry project/DSN/token |
| Store listing | Owner supplies listing copy and device screenshots |

Other work packages own icons/splash, store IAP behavior, Apple sign-in and web link
associations. Their completion and signed-device verification remain release gates.
No store submissions, EAS account changes or production operations are performed
by this configuration change. See [release configuration](mobile-development.md#release-configuration).
