# Session detail, transcript, and sharing parity

## Port map

| Mobile route | Web reference |
| --- | --- |
| `/sessions/[sessionId]` | `pages/dashboard/sessions/[id]/page.tsx`, session message list, metadata, refs, and sharing controls |
| `/sessions/shared` | `pages/dashboard/sessions/shared-page.tsx`; a `sessionId` opens the session share dialog |
| `/s/[shareId]` | `pages/public-share/session-page.tsx` and its public access gates |
| `/open-share` | Existing native link-entry feature retained, using the shared Web page header, input, and button primitives; Web has no equivalent manual-entry screen |

The native session components live in `src/ui/sessions`. Web recipes now live
in `packages/shared/src/ui`, and both implementations import them. Shared view
functions cover transcript date/group labels, command envelopes, skill setup,
tool payload formatting, timeline filter labels, activity thresholds, share
scope/metadata, dialog copy, and reference URLs. Web Tailwind also scans the
shared recipe directory so moving classes preserves Web styling.

## Data safety

`timeline-state.ts` is unchanged. Transcript queries retain account-scoped
keys and reads, revision-pinned adjacent cursors, 409 window reset, bounded
scroll-to-match retries, and account-keyed remounting. Public reads still abort
on backgrounding/navigation, check content revisions while paging, and fence
native sharing/export against the active account and foreground lease.
Snapshot selection uses the canonical typed session shares endpoint so response
and through-message ranges match exactly. Delete uses the generated canonical
API route and handles an empty 204; confirmations retain failure state.

## Visual evidence

Android files are under `/tmp/clawdi-ui-parity/android/session-detail/`.
Web light references are under `/tmp/clawdi-ui-parity/web-session-detail/`,
and dark references under `/tmp/clawdi-ui-parity/web-session-detail-dark/`.
The original `/tmp/clawdi-ui-parity/web/session-detail.png` was also inspected.
Screenshots were viewed against Web at a 390px viewport.

| Android light / dark | Web light / dark filename |
| --- | --- |
| `detail-light.png`, `detail-dark.png` | `session-tools.png` (all timeline categories) |
| `detail-code-light.png`, `detail-code-dark.png` | `session-tools.png` (scrolled message/code content) |
| `detail-tools-light.png`, `tool-expanded-light.png`, `tool-expanded-dark.png` | `tool-expanded.png` (tool row and payload; native isolates the Tools category) |
| `shared-links-light.png`, `shared-links-dark.png` | `shared-links.png` |
| `share-dialog-light.png`, `share-dialog-dark.png` | `share-dialog.png` |
| `public-light.png`, `public-dark.png`, `public-table-light.png`, `public-table-dark.png` | `public-session.png` |
| `revoked-light.png`, `revoked-dark.png` | `public-revoked.png` |
| `forbidden-light.png`, `forbidden-dark.png` | `public-forbidden.png` |
| `open-share-light.png`, `open-share-dark.png` | Native-only manual-entry surface; Web primitives/source comparison |

The common fixture does not seed snapshot inventories/public content and defaults
timeline responses to messages when `view` is absent. A task-local read-only
proxy supplied snapshot metadata, public access gates, a Markdown table, and the
same tool projection for native `include` requests. It rejected all mutations.
The prebuilt APK bakes runtime config into its manifest; a temporary local runtime
URL override selected this proxy and was removed after verification. Fixture
relative timestamps can drift between captures. The daemon restart required
restarting the assigned read-only emulator and Metro; Android system ANR dialogs
and loading captures were excluded from the final evidence.

## Native adaptations and limits

- No DOM component or new native dependency. Message text, tool JSON, code, and
  table cells remain native/selectable. Code and wide tables scroll horizontally;
  table columns retain the existing native fixed width, unlike browser intrinsic
  column sizing. Native code blocks omit Web's clipboard toolbar.
- System Share replaces clipboard Copy. The readonly share URL remains selectable.
  Touch message actions remain visible with Web's coarse-pointer target size,
  which increases spacing compared with mouse/hover reference captures.
- The native detail header includes its back control and remains outside FlatList
  to preserve initial positioning and pinned prepend behavior. Native status/safe
  areas replace the dashboard shell. Export remains in native overflow controls.
- Shared-link inventory retains native incremental pagination instead of Web's
  page-size selector and numbered pagination. Public branding uses the original
  Web logo; the Web header account avatar is omitted.
- Native dialogs use a backdrop without browser blur. Native share creation keeps
  its explicit confirmation, and revoked/private gates retain refresh access.
- Related refs use shared Web URLs plus the existing native external-link consent
  pattern. The fixture has no refs, slash-command envelope, skill setup expansion,
  or multi-page revision conflict; those states were not visually verified.
- Web's 401 gate currently throws under dev-auth bypass because its sign-in control
  has no Clerk provider. That environment limitation was not changed. Public 404
  remains the existing native session-not-found fallback, rather than the Web
  generic site 404 page. No live mutation was performed during visual verification.

## Checks

- `bun install`: passed, lockfile unchanged.
- Mobile and Web typechecks: passed.
- Mobile `test:internal`: 70 passed, including cursor/account and generated-theme checks.
- Shared `test:internal`: 342 passed; added canonical deletion/204, share-range, and
  transcript formatter/parser coverage.
- Web focused message-list, session-feed, and public export tests: 11 passed.
- Docker-backed Web verification: focused message/feed tests passed, OSS build
  passed, and 9 production SSR checks passed.
- Biome on changed files and `git diff --check`: passed.
