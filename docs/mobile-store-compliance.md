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
| UserDefaults | CA92.1 | RN core, Expo Constants/System UI/EAS Client, Sentry Cocoa, RevenueCat |

Sources under `apps/mobile/node_modules`: `react-native/**/PrivacyInfo.xcprivacy`
and `expo-*/ios/PrivacyInfo.xcprivacy`; EAS Client is a transitive Updates
dependency. Re-audit manifests after native dependency changes. CocoaPods/Xcode
are not available in the Linux verification environment: installed pod aggregation
and the signed archive must still be checked on the iOS builder.

Expo's documented [`ios.privacyManifests`](https://docs.expo.dev/versions/latest/config/app/#privacymanifests)
configuration supplies the app manifest through its prebuild config plugin;
see [Apple privacy manifests](https://docs.expo.dev/guides/apple-privacy/) and
[config plugin introspection](https://docs.expo.dev/config-plugins/development-and-debugging/#introspection).
Introspection retains the declared privacy settings but skips the Xcode project
mod that writes the manifest; use prebuild to verify the file and Resources entry.
Apple defines the exact [collected data type keys](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)
and [purpose keys](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatypepurposes).
User content and avatars use `NSPrivacyCollectedDataTypeOtherUserContent` and
`NSPrivacyCollectedDataTypePhotosorVideos`, respectively, linked to the account,
with `NSPrivacyCollectedDataTypeTracking: false` and
`NSPrivacyCollectedDataTypePurposeAppFunctionality`.
WhatsApp phone numbers use `NSPrivacyCollectedDataTypePhoneNumber` with the
same linked, non-tracking App Functionality declaration: stored authenticated
PN JIDs can be mapped back to phone numbers.

From `apps/mobile`, inspect the plugin output, then generate the native project:

```bash
bun expo config --type introspect
bun expo prebuild --platform ios --no-install
```

Done: `ios/Clawdi/PrivacyInfo.xcprivacy` contains the declared reasons and
the Phone Number entry with linked=true, tracking=false and App Functionality;
`NSPrivacyTracking` is false. After the owner signs/uploads, TestFlight must
report no ITMS-91053 warnings; check the archive's merged privacy report too.

## Store disclosures

Use this table as the shared draft for App Store privacy labels and Play Data
safety. Category names follow Apple's [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)
and Google's [Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).
All rows have no advertising, tracking or sale purpose. The identity
rows are linked to the account. Diagnostics are not explicitly associated with
an account by the app: no Sentry user identity is set and outgoing identities,
request bodies, queries and token parameters are removed. Sentry drops events,
transactions and breadcrumbs involving `/vault-request`; replay is disabled.

| App data / recipient | Apple category | Play category | Purpose | Linked / required |
| --- | --- | --- | --- | --- |
| Email / Clerk and Cloud account | Contact Info: Email Address | Personal info: Email address | App functionality, account management | Linked; required for email login |
| Name / Clerk account | Contact Info: Name | Personal info: Name | App functionality, profile | Linked; optional profile field |
| User id / Clerk and Cloud APIs | Identifiers: User ID | Personal info: User IDs | App functionality, account management | Linked; required |
| WhatsApp phone number and linked-account identifiers / Cloud API, Baileys sidecar and WhatsApp (third party) | Contact Info: Phone Number (collected); Identifiers: User ID | Personal info: Phone number (collected and shared with WhatsApp), User IDs | App functionality, linked-device authentication and channel account identification | Linked to the Clawdi account; phone number collection required for the optional WhatsApp channel; manual-code pairing requires phone input, and QR pairing also retains phone-bearing identifiers |
| Purchase history / RevenueCat, StoreKit and Play Billing | Purchases: Purchase History | Financial info: Purchase history | App functionality, purchases, entitlement verification and restoration | Linked via RevenueCat appUserID and credits funding the hosted Wallet; required when purchasing |
| Memories, skill content, Vault entries and user-authored session/channel configuration / Cloud APIs and connected agents | User Content: Other User Content | App activity: Other user-generated content | App functionality, content storage/sync and agent configuration | Linked; optional, collected when using the feature |
| Skill archive uploads / Cloud skill library and connected agents | User Content: Other User Content | Files and docs: Files and docs | App functionality, skill import/sync | Linked; optional upload |
| Agent avatars and optional Clerk profile images / Cloud agent API or Clerk | User Content: Photos or Videos | Photos and videos: Photos | App functionality, profile/agent personalization | Linked; optional upload; system picker does not grant general photo-library access |
| Crash reports / Sentry when DSN configured | Diagnostics: Crash Data | App info and performance: Crash logs | App functionality, reliability | Not explicitly linked; conditional on DSN |
| Performance and diagnostic metadata / Sentry when DSN configured | Diagnostics: Performance Data, Other Diagnostic Data | App info and performance: Diagnostics | App functionality, reliability | Not explicitly linked; conditional on DSN |

Manifest declarations include conditional diagnostic collection so an enabled
Sentry build is covered. Labels must reflect the binary actually submitted.
For Play, describe collection and encryption in transit (release APIs require
HTTPS). Account deletion can be requested in the app. Confirm whether Clerk,
Sentry and other processors qualify for Play's service-provider sharing exception
against the owner's contracts; do not infer a blanket "no sharing" answer.

Store builds use RevenueCat Paywalls for consumable Clawdi Credits and compute
subscriptions. Store subscription management uses the official Customer Center
when enabled by build configuration, with a fallback to the purchasing store's
subscription-management UI or link (`useManageStoreSubscription` in
`apps/mobile/src/hosted/billing/store/compute-store.tsx`). Consumable credits
cannot be restored; subscriptions have Restore purchases, and pending purchases
use explicit recovery. Keep the purchase-history declaration. Purchase history
is linked to the Clawdi account through RevenueCat appUserID and credits funding the hosted Wallet;
the app manifest therefore declares `NSPrivacyCollectedDataTypeLinked: true`.
Confirm payment data handled exclusively by Apple/Google versus data received by
the app or RevenueCat; do not claim the app collects card details without evidence.

The content rows cover the app's memory writes, skill archive imports, Vault
writes and avatar uploads. Selecting an avatar through `File.pickFileAsync`
sends the selected image to the authenticated agent API; this is collection even
without camera or photo-library permissions. Imported skill archives are files
under Google's definitions, rather than only other user-generated content.
User-initiated sharing and connected-agent transfers still require the owner's
review of recipients, retention/deletion and Google's sharing exceptions.

WhatsApp pairing sends phone numbers independently of Clerk phone settings;
see the verified data path and remaining retention/deletion gates below.
Session/channel **messages** have dedicated categories (Apple User Content:
Emails or Text Messages; Play Messages: Other in-app messages), distinct from
the configuration row above. Other User Content alone does not cover messages.
Confirm whether the native app or its embedded runtime sends user messages off
device before adding the dedicated message declaration.
Analytics, push notifications and session replay are deferred.

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

WhatsApp manual-code pairing sends the entered number from
`apps/mobile/src/hosted/v2/channels/whatsapp-device-onboarding.tsx` through
`whatsapp.pairingCode` (`packages/shared/src/api/whatsapp-client.ts`) in the
`phone_number` request body. The backend's
`request_whatsapp_pairing_code` in
`backend/app/services/whatsapp_device_onboarding.py` forwards it to
`client.pairing_code`; the Baileys sidecar calls
`socket.requestPairingCode(phoneNumber)` in
`packages/whatsapp-baileys-sidecar/src/runtime.ts`, transferring the number to
WhatsApp, a third party, for linked-device authentication (App Functionality).
The mobile input is held in component state and cleared on blur/background;
`ChannelWhatsAppOnboardingSession` (`backend/app/models/channel.py`) stores
ownership/lifecycle metadata, not the entered number, QR, pairing code or auth state.
This does not establish that all phone-related data is unretained.

After successful pairing, `_finalize_connected_account` stores the authenticated
phone-number JID as `ChannelAccount.config.self_identity.id` and the LID as
`ChannelAccount.config.self_identity.lid`. `config` is a JSONB column and the
Custom channel account's `user_id` links these identifiers to its Clawdi owner;
`sidecar_account_id` separately identifies the opaque provider-session UUID.
The PN JID contains the WhatsApp phone digits and can be parsed back into a
number (`whatsapp_phone_number_from_pn_jid`), so it is phone-bearing data even
when no raw input is kept in the onboarding row. The sidecar also persists the
authenticated `creds.me` identity in its SQLite `auth_creds` state;
`credentialsForPersistence` in
`packages/whatsapp-baileys-sidecar/src/sqlite-state.ts` drops the pairing code
and excludes the temporary pre-authentication `me` identity. Authenticated
PN/LID identifiers are retained for QR pairing as well as manual-code pairing.

Phone numbers are collected because stored authenticated PN JIDs can be mapped
back to them. The iOS manifest declares `NSPrivacyCollectedDataTypePhoneNumber`
with linked=true, tracking=false and App Functionality. App Store labels must
declare Contact Info: Phone Number as collected and linked to the user; Play
Data safety must declare Personal info: Phone number as collected and shared
with WhatsApp for pairing. This collection is required for the optional WhatsApp
channel and accompanies the linked-account User ID categories. The owner must
confirm retention and deletion periods for the Cloud identifiers, sidecar auth
state, backups and WhatsApp's handling. Confirm any additional Clerk phone
collection separately.

| Input | Status / requirement |
| --- | --- |
| Final privacy labels / Data safety answers | Owner confirms optionality, recipients, retention/deletion, processor sharing exceptions and enabled SDKs for the submitted binary; the manifest does not submit store forms |
| Phone numbers and WhatsApp identifiers | Phone Number is declared in the manifest and collected for App Store labels; Play declares phone number collected and shared with WhatsApp for pairing. Linked to the user, no tracking, App Functionality, required for the optional WhatsApp channel. Owner confirms Cloud/sidecar/backup/provider retention and deletion; check additional Clerk phone fields separately. |
| Session/channel message collection | Owner confirms native/embedded-runtime message collection and the dedicated message categories above; configuration metadata alone is covered here |
| Privacy policy URL | Owner must supply a public URL covering app and service processing, retention and deletion |
| Support URL | Owner must supply a public support URL |
| Play account-deletion web URL | Owner must confirm an existing public deletion-request page or provide one; no page is assumed to exist |
| In-app deletion | Settings > Account > Delete account: Clerk's built-in delete while self-delete is enabled; once the owner disables it, a custom profile page shows the store-billing notice and calls hosted `DELETE /v1/me` (release config requires compute URL) |
| Files access | Agent > Files opens a hosted one-time handoff in the system browser; the browser grant persists until app sign-out or dashboard-access reset |
| App Review access | Owner supplies a working review account without MFA friction |
| Accounts and credentials | Apple team/ASC app record, Play app/service account, Expo project/token, Clerk production/native registration, optional Sentry project/DSN/token |
| Store listing | Owner supplies listing copy and device screenshots |

Other work packages own icons/splash, store IAP behavior, Apple sign-in and web link
associations. Their completion and signed-device verification remain release gates.
No store submissions, EAS account changes or production operations are performed
by this configuration change. See [release configuration](mobile-development.md#release-configuration).
