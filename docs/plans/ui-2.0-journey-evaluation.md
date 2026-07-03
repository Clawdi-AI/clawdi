# UI 2.0 — simulated journey evaluation (10 goals)

> HISTORICAL - UI journey evaluation from the 2026-06 redesign pass. Use
> [`../frontend-development.md`](../frontend-development.md) for current web
> verification and `apps/web/src/` for current UI state.

Driven live in a real browser against the full prod-mirrored dataset
(2026-06-03, post-vivid-identity build). Each journey lists steps actually
taken, the felt experience, and negative feelings found. Severity:
🔴 blocks/embarrasses · 🟡 friction · ⚪ nitpick.

| # | Goal | Steps | Feel | Negative findings |
|---|---|---|---|---|
| J1 | Find a past session ("telegram") | 2 (open Sessions → type) | Instant results, relevance sort auto-engages | 🟡 **All matches rendered muted** (they were Cron rows) — search results looked disabled. **FIXED**: muting now off while searching. ⚪ No "N results" count |
| J2 | Share that session publicly | 3 (open → Share → toggle/copy) | Toggle + URL visible in one popover; optimistic toggle | ⚪ URL visually truncated in the 320px popover — **FIXED**: widened to 384px. 🟡 Landed on a session whose conversation wasn't uploaded: "not uploaded yet" was a dead end — **FIXED**: empty state now gives the `clawdi push` command |
| J3 | Create a project | 2 (New project → name → create) | Lands on the new hub with toast; emoji identity assigned immediately; every empty section has its action | none — best journey of the ten |
| J4 | Install a skill into it | 3 (Install skill → paste path → install) | Stat tile flips 0→1 live, row appears, toast | ⚪ "Skill Installed" Title Case — **FIXED**. ⚪ form stays open after success (kept: useful for installing several) |
| J5 | Add API keys manually | 4 (New vault → name → Add key → fill) | "1 key saved" toast; masked row appears | ⚪ "Create Vault" Title Case in hub form — **FIXED** |
| J6 | Share keys with a colleague | 3 (Share keys → choose project → invite) | The two-hop chain is explained in plain words | 🟡 When the vault is already in a shareable project the dialog still made me pick it — **FIXED**: preselects the attached project |
| J7 | Add project to an agent | 3 (Add to agent → picker preselected → confirm) | Agent preselected; toast offers "Open Agent" deep-link | ⚪ "Add Project"/"Project Added" Title Case (pre-existing dialog) |
| J8 | Save + find a memory | 4 (New memory → type → save → search) | Modal composer focused; search found it immediately | none |
| J9 | Check agent health | 2 (overview tile → sync badge) | Badge click opens remediation dialog with exact commands | none — the daemon-status dialog is genuinely good |
| J10 | Jump anywhere via search | 2 (sidebar Search → type) | Full-text hits across sessions/memories/skills | 🔴 **Projects and vaults are not in palette results** — searching "redpill" finds sessions *about* redpill but not the Redpill project or vault; fastest nav path can't reach the core objects (needs `/api/search` backend support — backlogged). 🟡 ⌘K keypress didn't open the palette in the headless run — worth a manual check on real hardware. ⚪ Result rows lack type grouping headers |

## Pattern-level negatives (cross-journey)

1. **Search is the weakest pillar**: palette misses projects/vaults (J10),
   sessions search lacks a result count (J1). Everything else has caught up;
   search now lags the new IA.
2. **Title Case keeps regrowing** in toasts/buttons that predate the sweeps —
   worth a CI grep on `toast.success("[A-Z][a-z]+ [A-Z]` (added to backlog).
3. Single-use forms staying open after success is ambiguous — fine for
   repeat-entry (skills, keys), odd for one-shot creates.

## Fixed in this pass

Muted search results · truncated share URL · dead-end un-uploaded
conversation (now shows the back-fill command) · share-keys project
preselection · hub toast/button casing.

## Backlog (needs backend or deliberate design)

- `/api/search` to index projects + vaults; palette type-group headers.
- Result count line on sessions search.
- Verify ⌘K listener on real hardware (headless keypress did not fire it).
