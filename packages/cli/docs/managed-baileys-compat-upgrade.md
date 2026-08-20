# Managed Baileys Compatibility Upgrade

Use this runbook when an OpenClaw or Hermes upgrade changes the bundled Baileys
artifact audited by
[`managed-baileys-compat.ts`](../src/runtime/managed-baileys-compat.ts).

## Patch Contract

The compatibility layer has three ordered safeguards:

1. `auditPristineSha256` identifies each accepted, unmodified upstream file.
2. Exact `before` and `after` hunks classify and patch only known source layouts.
3. A durable ownership receipt records the hunks Clawdi applied so rollback removes
   only Clawdi-owned changes.

The audited targets are:

| Target | Current pristine SHA-256 |
| --- | --- |
| `lib/Socket/socket.js` | `ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9` |
| `lib/Utils/noise-handler.js` | `970f9526ce0e5a6bebf937328b3d835966a9282c0d232f31b5c0bb283531afe8` |
| `lib/Utils/noise-handler.d.ts` | `a556ca0b67c3448769ad5ed0d59acbf566a21115fa107cd582b1dcb28c4fd516` |

The current patch revision is `clawdi.managedBaileysCompat.v3`; the current
receipt schema is `clawdi.managedBaileysPatchReceipt.v4`.

## Retarget The Patch

1. Update the OpenClaw and Hermes fixture pins, integrity values, and downloaded
   artifacts for the intended runtime versions.
2. Extract or install each new artifact without running Clawdi reconciliation.
   Copy the three pristine target files to a separate scratch directory.
3. Compute each audit hash from those pristine files:

   ```bash
   sha256sum lib/Socket/socket.js lib/Utils/noise-handler.js lib/Utils/noise-handler.d.ts
   ```

4. Update each `auditPristineSha256` and retarget its exact `before`/`after`
   hunks. Keep a hunk ID when its semantic transformation is unchanged; increment
   the hunk ID and patch revision when owned behavior changes. Increment the
   receipt schema only when the serialized receipt layout changes.
5. Confirm every `before` and `after` string occurs exactly once in its target and
   that a target cannot classify as both states.

Do not derive audit hashes from a previously patched installation. The qualified
rc14 fixture in `managed-baileys-compat.test.ts` currently has socket hash
`ff8b19ff02491fa080ee371f066d49c94acb903207dd0d9fdb5548e5a594fb4a`; it is a
fixture assertion, not a replacement for hashing the new pristine runtime
artifact.

## Verify

Run the focused compatibility suite from the repository root:

```bash
bun test packages/cli/src/runtime/managed-baileys-compat.test.ts
bun run --cwd packages/cli typecheck
bunx biome check packages/cli/src/runtime/managed-baileys-compat.ts packages/cli/src/runtime/managed-baileys-compat.test.ts packages/cli/docs/managed-baileys-compat-upgrade.md
```

The suite must cover pristine apply, repeated reconciliation, owned rollback,
artifact version replacement, recognized mixed state, and unknown-state refusal.
Run the managed WhatsApp native fixture E2E separately when qualifying a real
runtime upgrade.

Done: all focused commands exit 0, and the compatibility suite passes without
weakening mixed-state or unknown-state refusal.
