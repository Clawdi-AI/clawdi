# Managed Baileys Compatibility Upgrade

Use this runbook when an OpenClaw or Hermes upgrade changes the bundled Baileys
artifact audited by
[`managed-baileys-compat.ts`](../src/runtime/managed-baileys-compat.ts).

## Patch Contract

The compatibility layer classifies every exact hunk from the installed files:

1. All `before` hunks are eligible for apply.
2. Exact predecessor hunks are eligible for migration to the current `after`
   state.
3. All `after` hunks are already patched, or eligible for rollback when managed
   WhatsApp is disabled.
4. Mixed, duplicated, or unknown hunks are refused without mutation.

Rollback safety requires every hunk to be in the current or exact predecessor
`after` state before any target is mutated. No separate ownership receipt or
pristine-file hash is needed.

OpenClaw's Baileys artifact is the `baileys` package resolved from the WhatsApp
plugin's `install.installPath` reported by `openclaw plugins inspect whatsapp
--json`, so npm and ClawHub installs are both covered.

The patch targets are:

- `lib/Socket/socket.js`
- `lib/Utils/noise-handler.js`
- `lib/Utils/noise-handler.d.ts`

## Retarget The Patch

1. Update the OpenClaw and Hermes fixture pins, integrity values, and downloaded
   artifacts for the intended runtime versions.
2. Extract or install each new artifact without running Clawdi reconciliation.
3. Retarget the exact `before`/`after` hunks. Keep a hunk ID when its semantic
   transformation is unchanged and increment it when behavior changes.
4. Confirm every `before` and `after` string occurs exactly once in its target and
	 that a target cannot classify as both states.

## Known Technical Debt

Hermes compatibility installs missing bridge dependencies with an isolated
`npm ci` and writes `.hermes-pkg-hash`. The 2026-09-13 review verified the
fixture's pinned [upstream adapter](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/plugins/platforms/whatsapp/adapter.py#L320-L334)
and [dependency check](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/plugins/platforms/whatsapp/adapter.py#L529-L542):
the stamp is the first 16 lowercase SHA-256 hex characters of `package.json`,
read with whitespace stripped. This verifies that exact pin, not future
versions or a stable public dependency-install API. Keep both behaviors scoped
to this compatibility patch and recheck them during each runtime upgrade.

## Verify

Run the focused compatibility suite from the repository root:

```bash
scripts/test.sh cli src/runtime/managed-baileys-compat.test.ts
```

The suite must cover pristine apply, repeated reconciliation, content-based
rollback, runtime switching, mixed state, and unknown-state refusal.
Run the managed WhatsApp native fixture E2E separately when qualifying a real
runtime upgrade.

Done: all focused commands exit 0, and the compatibility suite passes without
weakening mixed-state or unknown-state refusal.
