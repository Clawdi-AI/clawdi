# Anonymous runtime preparation and warm adoption

Implementation review draft. Hosted owns golden/pool lifecycle; the CLI owns
installation, native configuration and readiness. Provisioning defaults off.
OpenClaw hot apply requires `CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY=1`; ordinary
provisioning and restart reconciliation remain the default.

```bash
clawdi runtime prepare --spec spec.json --installer install.sh --cli-archive clawdi.tgz
clawdi runtime warm --runtime openclaw
clawdi runtime warm --runtime hermes
```

These root-only commands require empty homes and a strict
`clawdi.runtime-preinstallation.v1` spec binding CLI integrity, architecture,
image, runtime version/commit and pinned official installers/artifacts.
Tenant inputs, mutable versions and integrity mismatches are rejected.

Preparation uses official installers and builds Hermes assets. Sealed OpenClaw
is disabled and token-free. A root-owned 0400 receipt binds software, home digest
and probes to launcher/package/source identity; mismatches retain ordinary probes.

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
not advance that history; repeated applies retain the same generations. Other
managed files are deleted through a pinned directory. Unreadable configs or
unsafe file identities defer cleanup. New files contain referenced credentials
only, never the entire environment.

## Changes visible to existing runtimes

Existing apply, boot, watch, provider and systemd receipts remain readable.
New private receipts are additive and optional.

| Change | Default / upgrade behavior | Compatibility evidence |
| --- | --- | --- |
| Persisted step memos | Gated to hot apply or warm snapshot selection. Schema v2 ignores v1; keys bind CLI version captured before UID drops, helper/probe sources, OpenClaw package and SDK files. Includes never authorize skips; cleanup records equal before/after state only. | New-process CLI upgrade, real UID switch, package/layout upgrades in `persisted-step-revisions.test.ts`; cleanup/include races in `manifest-reconciliation.test.ts` |
| Provider/channel writer extraction | Ordinary applies keep official single-step locking/validation; batch and file migration require hot apply. JSON5 local reuse rejects includes and falls back to native probes. | Existing provider drift, ownership, channel replacement/unlink and legacy/current layout fixtures |
| File SecretRef retention | Applies only when the managed credential directory exists, including after hot apply is disabled. Successful commit retains current/include and native rollback references plus two successful generations; failures retain all files. | Rotation, revocation, includes, rollback and unsafe-link tests in `openclaw-file-secrets.test.ts`; failed authority commit in `manifest-reconciliation.test.ts` |
| Native/connection ownership readers | Accept existing env refs and the additive managed file-ref form, including rollback after flag removal. No existing env ref changes meaning. | Native/connection transfer and failed-commit fixtures in `manifest-reconciliation.test.ts` |
| Observation cadence / immediate recapture | Default remains 5 s for the existing 90 s convergence window and 60 s when ready. Only warm/hot apply uses 1 s or bounded immediate recapture; retry backoff is unchanged. | Default/opt-in schedules and tuple-rotation tests in `observation-producer.test.ts` |
| Successful watch-parent comparison | Applied/not-modified events compare as successful only with exact current generation, ETag, source/apply authority, no self-reexec/error and explicitly healthy metadata. Parent/config/invocation fences remain. | Healthy-equivalence and unhealthy-parent tests in `observed-v2.test.ts` |
| Unchanged conditional HTTP 200 | A fully validated response reuses only exact committed source/content/apply identity and verified snapshot. Forced repair still reconciles drift; old/missing state uses ordinary apply. | Conditional response, stale snapshot/authority and forced-repair tests in `tests/runtime.test.ts` |
| Initial bootstrap watch event | Writes the successful bootstrap event only when no watch status exists; existing failures remain authoritative. | Bootstrap/watch parent fixtures in `tests/runtime.test.ts` and `observed-v2.test.ts` |
| Systemd manager batching | Explicit unit IDs, enablement and per-unit fallback preserve old manager output, pending-job admission and final proof. | Real `runtime-systemd` suite plus released receipt reconciliation fixtures |
| Early sidecar start / startup ordering | Early start is gated to the private warm marker; existing first applies retain their order. Hermes overlap additionally requires acknowledged warm egress. | Default marker absence and real systemd ordering regressions |
| Hermes dashboard helper | Extracts the existing build/cache procedure with the same revision marker, install/build timeouts and commands. | Existing service prerequisite/build fixtures |
| Version/config-path reuse | Only a matching anonymous receipt avoids native probes. Existing tenants without it retain probes; Hermes version timeout is bounded at 60 s for upstream first-use maintenance. | `preinstalled-probes.test.ts`, official upstream Hermes contract |
| CLI, Files, egress and Skill helpers | Shared helpers accept anonymous inputs; ordinary integrity, permissions, installer options and reservation semantics remain. | Existing managed CLI/Files/egress/Skill suites plus preinstallation tests |
| Profiling | Default off; `CLAWDI_RUNTIME_PROFILE=1` emits static labels, PID and duration without argv, secrets or payloads. | `profile.test.ts` |

Hosted retains its ordinary readiness polling. Nodes without golden/pool config
perform one history lookup instead of invoking every feature hook; persisted
copies and claims keep their hooks after configuration removal for crash replay.
No tenant or production enablement was performed.

## Verification and limits

```bash
bash scripts/test.sh cli
bash scripts/test.sh runtime-systemd
bash scripts/test.sh cli-lint <changed-files>
bash scripts/test.sh hermes-upstream-contract
```

Pack fixtures with `preinstallation-artifact` into an empty checkout-local
directory. Paired Hosted qualification runs `backend-golden-native` under
`/tmp/clawdi-golden-native.lock`, three pool samples per runtime; results live in
its design document. Production and real model/chat/channel traffic are unqualified.

The final pool medians are 16.95 s OpenClaw and 14.23 s Hermes versus 18.87/13.18 s
previously. All six samples and cleanup passed; Hermes Cloud `ok` increased 1.05 s
despite faster init/HTTP readiness, so its non-regression remains unproved.

Done: Docker CLI typecheck/tests, real systemd and changed-file Biome pass;
PostgreSQL regressions cover fallback/preservation. Paired native qualification
proves tenant-free pre-claim state, authenticated adoption and cleanup.
