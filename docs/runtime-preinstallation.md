# Anonymous runtime preparation and warm adoption

Implementation review draft. Hosted owns pool lifecycle; the CLI owns
installation, native configuration and readiness. Provisioning defaults off.
OpenClaw hot apply requires `CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY=1`; ordinary
provisioning and restart reconciliation remain the default.

```bash
clawdi runtime prepare --spec spec.json
clawdi runtime warm --runtime openclaw
clawdi runtime warm --runtime hermes
```

The prepare command runs inside the eventual pool instance. npm installs the
current global CLI selector using its ordinary integrity checks, without Cloud or
tenant identity. The CLI then uses the normal official runtime installer path.
The root-only command requires empty homes and a small
`clawdi.runtime-preinstallation.v1` spec containing only image, architecture,
selector and runtime. A root-owned receipt records the installed probes and
home digest; tenant inputs are never accepted.

## Trust model: same as cold install

Preinstallation is the ordinary cold runtime installation performed before a
claim. npm installs the exact global CLI selector with its normal integrity
checks, and that CLI uses the official runtime installer and version policy used
by a fresh deployment. No tenant data, credentials, Cloud identity or tenant
manifest is present. Pool-only artifact approvals, discovery, signing keys,
provenance, private snapshots, artifact proxies and default-deny guest
networking are not part of this path; any future supply-chain hardening must
cover cold and warm installs together.

Pool targets, TTL, global kill switch, owner claim limits and alerts are
runtime-tunable audited control-plane settings; the CLI owns none of their
sizing authority. Each node's maintenance tracks peak accepted creates within
its measured refill duration over seven days, adds headroom and clamps to the
configured min/max. Committed claims trigger immediate leased refill.
Disabling the policy stops new claims/fills, drains idle instances and keeps
tenant claim replay; new requests retain cold provisioning. Stale claims use
ordinary driver fences and tenant-preservation rules. Missing node bindings
leave tombstones and resource alerts until their drain-only connectivity is
restored.

Hosted owns the audited global `v2_runtime_pool_policy` setting, read through
`GET /admin/settings` and updated through `PUT /admin/settings/{key}` with
`value_type:"json"`. Existing rows for removed artifact settings may remain
inert; administrators can delete them during routine settings cleanup.

The sizing formula is `desired = clamp(min, max, ceil(peak arrivals over measured
refill time) + headroom)`. Refill time is the largest successful fill for that
shape over seven days, or the 40-minute fill timeout without measurements.
Committed claims trigger immediate leased refill. Three consecutive node/runtime/
shape fill failures emit `warm_pool_fill_failure`; ready-capacity absence past the
configured interval emits `warm_pool_empty`; stuck resources and repeated teardown
failures emit `warm_pool_resource_leak`.

## First apply

Warm-up rejects tenant inputs. OpenClaw starts an anonymous gateway with a private
random token/CA; Hermes prepares assets and stops anonymous services.

Anonymous egress denies managed traffic until one atomic snapshot publishes the
claimed policy and credentials. Adoption proves hash ACK, idle invocation, units,
environment and CA. A one-second metadata watcher reads changed files; requests
perform no snapshot I/O. Transient I/O errors retain valid policy; invalid replacements
revoke credentials/ACK and stop the engine. First readiness removes snapshot
selection; the next projection restores legacy inputs and sidecar reconciliation.

Hot apply batches gateway, providers, channels and agents through one official
runtime-UID SDK mutation with locking, CAS, ownership, validation and `afterWrite:auto`.
Referenced credentials become private file SecretRefs; versioned paths couple
rotation to native reload. Structural config, environment, CA, software and
non-hybrid modes retain restart reconciliation. The official installer refreshes
units capturing migrated keys. Prepared heap sizing changes only for an unchanged
prepared unit whose capacity changed; user/native edits retain authority.

Four native A/B samples showed only 0.39 s saved by the socket writer, including
its fences; its service and protocol were removed. Complete health proofs gate Cloud `ok`.

After successful convergence, credential GC keeps references from the current
JSON5 config (including includes), all five native `.bak` snapshots and
`.pre-update`, plus two successful credential generations. Failed candidates do
not advance that history; repeated applies retain the same generations. Upgrades
capture the pre-apply config before any candidate writes. Other
managed files are deleted through a pinned directory. Unreadable configs or
unsafe file identities defer cleanup. GC exclusively holds the official
`openclaw.json.lock` sidecar (live PID and creation timestamp) across scanning and
deletion; an occupied lock defers cleanup without stale-lock reclamation. This
matches OpenClaw's [config writer](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/config/write-lock.ts)
and [file-lock protocol](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugin-sdk/file-lock.ts).
Each unlink re-reads current/include/rollback
references and checks their held file identities immediately before deletion;
newly committed references and config replacements defer removal. New files contain referenced credentials
only, never the entire environment.

## Changes visible to existing runtimes

Existing apply, boot, watch, provider and systemd receipts remain readable.
New private receipts are additive and optional.

| Change | Default / upgrade behavior | Compatibility evidence |
| --- | --- | --- |
| Persisted step memos | Gated to hot apply or warm snapshot selection. Schema v2 ignores v1; keys bind CLI version captured before UID drops, helper/probe sources, OpenClaw package and SDK files. Includes never authorize skips; cleanup records equal before/after state only. | New-process CLI upgrade, real UID switch, package/layout upgrades in `persisted-step-revisions.test.ts`; cleanup/include races in `manifest-reconciliation.test.ts` |
| File SecretRef retention | Applies only when the managed credential directory exists, including after hot apply is disabled. Successful commit retains current/include and native rollback references plus two successful generations; failures retain all files. | Rotation, revocation, includes, rollback and unsafe-link tests in `openclaw-file-secrets.test.ts`; failed authority commit in `manifest-reconciliation.test.ts` |
| Native/connection ownership readers | Accept existing env refs and the additive managed file-ref form, including rollback after flag removal. No existing env ref changes meaning. | Native/connection transfer and failed-commit fixtures in `manifest-reconciliation.test.ts` |
| Observation cadence / immediate recapture | Default remains 5 s for the existing 90 s convergence window and 60 s when ready. Only warm/hot apply uses 1 s or bounded immediate recapture; retry backoff is unchanged. | Default/opt-in schedules and tuple-rotation tests in `observation-producer.test.ts` |
| Successful watch-parent comparison | Pool snapshot or hot-apply paths only; defaults retain the original comparison. Applied/not-modified events compare as successful only with exact current generation, ETag, source/apply authority, no self-reexec/error and explicitly healthy metadata. Parent/config/invocation fences remain. | Healthy-equivalence and unhealthy-parent tests in `observed-v2.test.ts` |
| Unchanged conditional HTTP 200 | Pool snapshot or hot-apply paths only; defaults reapply HTTP 200 as before. A fully validated response reuses only exact committed source/content/apply identity and verified snapshot. Forced repair still reconciles drift; old/missing state uses ordinary apply. | Conditional response, stale snapshot/authority and forced-repair tests in `tests/runtime-watch.test.ts` |
| Initial bootstrap watch event | Pool snapshot or hot-apply paths only; defaults retain the original bootstrap behavior. Writes the successful bootstrap event only when no watch status exists; existing failures remain authoritative. | Bootstrap/watch parent fixtures in `tests/runtime-channels.test.ts` and `observed-v2.test.ts` |
| Systemd manager batching | Pool snapshot or hot-apply paths only; defaults retain per-unit observation/final proof and system-before-user activation. Explicit unit IDs, enablement and per-unit fallback preserve old manager output, pending-job admission and final proof. | Real `runtime-systemd` suite plus released receipt reconciliation fixtures |
| Early sidecar start / startup ordering | Early start is gated to the private warm marker; existing first applies retain their order. Hermes overlap additionally requires acknowledged warm egress. | Default marker absence and real systemd ordering regressions |
| Provider/channel writer extraction | With hot apply disabled, the shared official writer retains standalone mutations, CAS/validation, merge/delete semantics and ordinary reload behavior. Batch writes and file-secret projection require hot apply. | Existing provider/channel, ownership transfer and rollback cases in `manifest-reconciliation.test.ts`, `tests/runtime-channels.test.ts` and `tests/runtime-watch.test.ts` |
| Hermes dashboard helper | Extracts the existing build/cache procedure with the same revision marker, install/build timeouts and commands. | Existing service prerequisite/build fixtures |
| Version/config-path reuse | Only a matching anonymous receipt avoids native probes. Existing tenants without it retain probes and the original Hermes 30 s/OpenClaw 10 s version timeout. | `preinstalled-probes.test.ts`, official upstream Hermes contract |
| CLI, Files, egress and Skill helpers | Shared helpers accept anonymous inputs; ordinary integrity, permissions, installer options and reservation semantics remain. | Existing managed CLI/Files/egress/Skill suites plus preinstallation tests |
| Profiling | Default off; `CLAWDI_RUNTIME_PROFILE=1` emits static labels, PID and duration without argv, secrets or payloads. | `profile.test.ts` |

Hosted retains its ordinary readiness polling. Nodes without pool configuration
perform one claim-history lookup; persisted claims keep their hooks after
configuration removal for crash replay. Empty pools use ordinary cold provisioning.
No tenant or production enablement was performed.

## Verification and limits

```bash
bash scripts/test.sh cli
bash scripts/test.sh runtime-systemd
bash scripts/test.sh ci
BIOME_THREADS=2 bash scripts/test.sh cli-lint <changed-files>
```

The normal installer path is verified by the CLI suites and the paired Hosted
pool qualification. Production and real model/chat/channel traffic remain
outside this qualification.

The CLI, systemd and changed-file lint suites pass. Paired native fill/claim
qualification remains a release gate and requires the Hosted/OSS source pair
(`CLAWDI_POOL_OSS_SOURCE`); it was not run without that checkout.
