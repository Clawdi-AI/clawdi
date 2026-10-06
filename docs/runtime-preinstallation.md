# Anonymous runtime preparation and warm adoption

Implementation review draft. Hosted owns pool lifecycle; the CLI owns
installation, native configuration and readiness. Provisioning defaults off.
OpenClaw hot apply requires `CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY=1`; ordinary
provisioning and restart reconciliation remain the default.

```bash
clawdi runtime prepare --spec spec.json --installer install.sh --cli-archive clawdi.tgz
clawdi runtime warm --runtime openclaw
clawdi runtime warm --runtime hermes
```

The prepare command runs inside the eventual pool instance. Its CLI arrives as
an exact SHA-512-verified public package authorized by a separate administrator
approval, without Cloud/tenant identity.
These root-only commands require empty homes and a strict
`clawdi.runtime-preinstallation.v1` spec binding CLI integrity, architecture,
image, runtime version/commit and pinned official installers/artifacts.
Tenant inputs, mutable versions and integrity mismatches are rejected.

Preparation uses official installers and builds Hermes assets. OpenClaw
is staged in the same pool instance before warm-up. A root-owned 0400 receipt
binds software, home digest and probes to launcher/package/source identity;
mismatches retain ordinary probes.

## Preparation trust and isolation

The control plane supplies the independent trust root: an administrator-approved
allowlist of exact runtime identities, installer SHA-256 and npm archive SHA-512,
including the CLI itself. A newly discovered digest is a review candidate and
cannot authorize a fill. If npm registry signatures accompany an approved
artifact, the control plane verifies them against independently pinned registry
public keys. The CLI's strict spec validates the projection and verifies bytes;
it does not promote upstream metadata into approval. Installer execution and
CLI archive installation use the verified byte snapshots in a root-owned
private directory. CLI verification commands execute a private package snapshot
so path replacement between verification steps cannot change the executed bytes.
Ordinary cold provisioning and tenant updates keep their existing upstream
trust model; their release-approval model is outside this change.

The control plane starts kernel default-deny ingress/egress before executing
any installer or CLI. A separate UID runs an exact-host HTTPS artifact proxy;
only that UID can open external HTTPS, with public-address checks, and DNS is
restricted to the configured gateway. Fixed proxy environment settings are
available only during anonymous preparation. Approved hosts cover official
artifact and dependency distribution endpoints. Anonymous managed egress is
also deny-all. The anonymous OpenClaw official LAN binding is protected by the
kernel ingress deny. Isolation stays active through warm-up and idle reboots;
the claim unit removes it only after verified tenant projection publishes the
claim marker. This ordering is verified by the paired native fixture.

Pool targets, TTL, global kill switch, owner claim limits and alerts are
runtime-tunable audited control-plane settings; the CLI owns none of their
sizing authority. Each node's maintenance tracks peak accepted creates within
its measured refill duration over seven days, adds headroom and clamps to the
configured min/max. Committed claims trigger immediate leased refill. Disabling
the policy stops new claims/fills, drains idle instances and keeps tenant claim
replay; new requests retain cold provisioning. Stale claims use ordinary driver
fences and tenant-preservation rules. Missing node bindings leave tombstones
and resource alerts until their drain-only connectivity is restored.

Hosted owns four global settings, read through `GET /admin/settings` and updated
through audited `PUT /admin/settings/{key}` with `value_type:"json"`:

| Setting | Authority |
| --- | --- |
| `v2_runtime_pool_policy` | Default-off kill switch and discovery switch, per runtime/CPU/memory/disk min/max/TTL/enabled/headroom, owner limit/window and alert thresholds |
| `v2_runtime_pool_approved_artifacts` | Independently reviewed exact runtime/CLI identities, digests, signatures and artifact hosts |
| `v2_runtime_pool_npm_signing_keys` | Independently pinned public registry signing keys |
| `v2_runtime_pool_artifact_candidates` | Server-managed discovery results; administrative writes are rejected |

The sizing formula is `desired = clamp(min, max, ceil(peak arrivals over measured
refill time) + headroom)`. Refill time is the largest successful fill for that
shape over seven days, or the 40-minute timeout without measurements. Arrivals
come from accepted v2 create operations joined to the recorded deployment shape.
Each opted-in node applies the target within its declared remaining capacity;
smaller targets preserve claims and in-flight fills.

Enable only after releasing the paired CLI, reviewing artifacts/keys and opting
in static node capability (architecture, fill concurrency, enabled). Then enable
small policy targets. Three consecutive node/runtime/shape fill failures emit
`warm_pool_fill_failure`; ready-capacity absence past the configured interval
emits `warm_pool_empty`; stuck resources, repeated teardown failures or removed
node bindings emit `warm_pool_resource_leak`. Claim events include CPU, memory
and disk. Audit history is available at `GET /admin/settings-audit-log`.

Rollback sets policy `enabled:false`; discovery has its own independent switch.
Per-shape disable or node opt-out also drains idle capacity. Keep node connectivity
until drain completes. Preserve committed claims and schema for replay; Hosted's
migration downgrade refuses outstanding resources or claims. Cold requests retain
ordinary provisioning. No production enablement is included in this qualification.

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
unsafe file identities defer cleanup. Each unlink re-reads current/include/rollback
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
bash scripts/test.sh hermes-upstream-contract
```

Pack fixtures with `preinstallation-artifact` into an empty checkout-local
directory. Paired Hosted qualification runs `backend-pool-native` with disposable
Incus/ZFS fixtures; results live in its design document. Production and real model/chat/channel traffic are unqualified.

Hosted qualification now fills blank volumes and installs software in place;
TTL retirement/refill supplies freshness without cloned software volumes.
Before the independent-review fixes, three samples per runtime gave claim-to-first-Cloud-`ok` medians of 16.49 s
OpenClaw and 15.67 s Hermes, within the owner-accepted approximately 17.5/16 s
ceilings. Full fill medians were 189.04/364.99 s respectively; TTL retirement
and replacement readiness took 204.74 s. All six functional samples completed.
The fixture exited 1 solely because its original Hermes ceiling remained
14.23 s; cleanup propagated the status while removing all disposable resources.
An additional startup-order change was discarded after changed-file Biome
failed, before native measurement. The paired Hosted pool design document
retains the complete results and qualification limits.

Independent-review qualification used one sample per runtime: claim to first
fixture Cloud `ok` took 15.71 s for OpenClaw and 13.94 s for Hermes; full fill took
184.24 s and 340.44 s. Both reboot/preservation checks passed, as did a 194.05 s
TTL retire/refill cycle. The fixture exited 0 and cleaned all disposable resources.
This review changes correctness and scope gates; it does not tune performance.

Review Docker qualification on source `a98c6e2c5b55891b839bb2392be5335506fd476f`
(rebased onto main `1089d545d`) passed full CLI typecheck/tests (196 files),
runtime-systemd (25 tests), CI and changed-file Biome (12 files). The official
Hermes upstream contract passed all 14 tests on commit
`93cbf617c7007286a249cc00506c012933fb537c` (`0.21.5+7736.g93cbf61`).
The earlier upstream runner collision with the native artifact directory was
resolved by waiting for that fixture's cleanup, then rerunning successfully.

Done: Docker CLI typecheck/tests, real systemd and changed-file Biome pass;
PostgreSQL regressions cover fallback/preservation. Paired native qualification
proves tenant-free pre-claim state, authenticated adoption and cleanup.


## Astra follow-up qualification

The prior results above describe pre-follow-up source. Current CLI source
`f2122dc89` is rebased onto main `109a66954`. Docker verification passed:

| Suite | Result |
| --- | --- |
| Full CLI typecheck/tests | 205 files, exit 0 |
| Focused verified-byte and credential-GC regressions | 36 tests, 317 assertions |
| `runtime-systemd` | 25 tests, including real service and child-OOM behavior |
| `ci` | Exit 0, including workspace types, mobile, web build, shared and backend smoke |
| Changed-file `cli-lint` | 7 files, no fixes |
| `hermes-upstream-contract` | 14 tests on upstream commit `65bc6727b43c05dff410608c78fa055ec194eee0` (`0.21.5+8490.g65bc672`) |

Paired Hosted source `531389a8c` passed PostgreSQL contracts (1,318 tests),
end-to-end (94), pool (467 unit / 102 PostgreSQL), backend (6,735) and migration
(590) verification. Gated login, generic preservation and provider-transfer
fixtures were outside this request; the pool native case ran separately.
The final locked native invocation passed one sample per runtime, including
default-deny preparation, claim ACK and reboot/preservation. Claim to first
fixture Cloud `ok` was 23.72 s for OpenClaw and 16.37 s for Hermes; full fills
were 268.46/382.88 s. OpenClaw authenticated the tenant token and retained its
gateway PID. Its TTL retirement/replacement took 217.54 s. The fixture exited 0
and removed all disposable resources and work directories. These are functional
samples, not performance SLOs or production evidence.

Regression
coverage includes installer replacement after hashing, new credential references
after the initial GC scan, and ordinary CLI upgrade/rollback behavior. Native
checks cover kernel default-deny isolation, permitted artifact preparation,
authenticated adoption, preservation and TTL replacement. These fixtures use
explicit disposable approvals; no production enablement or artifact approval
was performed.

Done: required Docker suites pass, both native runtime samples and one TTL cycle
complete, disposable resources are removed, and the paired worktrees are committed
and clean. Production behavior and npm provenance remain unqualified.
