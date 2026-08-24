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

Hermes compatibility still installs missing bridge dependencies with an isolated
`npm ci` and writes `.hermes-pkg-hash` in the format expected by the current
fixture. That upstream marker contract has not been independently verified. Keep
both behaviors scoped to this compatibility patch until Hermes exposes a
supported dependency-install contract.

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
