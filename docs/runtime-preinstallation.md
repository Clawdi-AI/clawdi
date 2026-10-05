# Anonymous runtime preinstallation

Software-only preparation of a Hosted data volume without a Cloud identity or
manifest. The provisioning owner (Hosted golden builder) owns scheduling,
expiry, copying and cleanup. Tenant convergence finds the prepared, content-addressed artifacts and skips
their downloads. OpenClaw preparation also moves tenant-independent official
service and bundled Skill installation off first apply.

```bash
clawdi runtime prepare --spec spec.json --installer install.sh --cli-archive clawdi.tgz
```

The root-only hidden command accepts a strict `clawdi.runtime-preinstallation.v1`
spec: exact `cliPackageSpec` (this CLI's own version) and its npm `cliIntegrity`,
`architecture`, `imageFingerprint`, `runtime`, exact `runtimeVersion` (OpenClaw
release or Hermes commit), official `installerUrl` and `installerSha256`, and
optional pinned `egressEngine` and `fileBrowserAsset`. OpenClaw also requires the
official npm `runtimeTarballUrl` and `runtimeIntegrity`. Unknown fields, tenant
identifiers, mutable versions and integrity mismatches are rejected.

Preparation requires empty `/home/clawdi` and `/var/lib/clawdi`, then:

1. runs the verified official installer as the runtime user in a clean
   environment (OpenClaw `--runtime-only --no-onboard`; Hermes `--commit
   --force-commit --skip-setup --skip-browser --non-interactive`) and checks the
   installed identity;
2. for Hermes, builds the dashboard with the shared build helper and revision
   marker;
3. for Hosted OpenClaw, installs the official gateway unit and the bundled
   Clawdi Skill through the same native installer and reservation transaction as
   tenant apply. The unit is stopped and disabled before sealing; the anonymous
   token is removed. No tenant identity or credentials enter the reservation;
4. records probe answers (`--version`, Hermes `config path`) with the launcher
   file revision and installed source identity (Hermes git commit or OpenClaw
   package version);
5. prefetches the pinned mitmproxy egress engine and Files companion binary into
   their content-addressed managed locations, and bootstraps Codex;
6. installs this exact CLI from the integrity-verified archive into the managed
   CLI layout with a verified receipt, so the image shim executes it without npm.

OpenClaw probe preparation includes version-bound auth SDK capability answers
and empty-store discovery. JSON5 roster inputs are supported; included native
config retains live roster and auth-cleanup probes. Auth-cleanup reuse checks the auth configuration,
agent roster and native store write identities; provider, channel and Skill
changes do not invalidate it alone.

A root-only `0400` receipt at `/var/lib/clawdi/preinstallation/receipt.json`
records the spec, health, probes and home content digest.

During tenant convergence the recorded `--version`/`config path` answers are
reused only while the launcher revision and source identity still match; any
update or reinstall falls back to the live probes. Reusing the sealed version
output also keeps the prebuilt Hermes dashboard revision stable, instead of
depending on upstream update notices in live `--version` output.

Verify through the hermetic entrypoint:

```bash
bash scripts/test.sh cli src/runtime/preinstallation.test.ts src/runtime/preinstalled-probes.test.ts
```

For a paired native fixture, pack the CLI exactly as published into a task-owned
empty directory inside this checkout (the caller removes it):

```bash
bash scripts/test.sh preinstallation-artifact /path/to/checkout/task-artifacts
```

Done: CLI typecheck and these tests pass; native qualification is run by the
Hosted `backend-golden-native` suite.

## Anonymous warm qualification and opt-in hot apply

The hidden root-only `clawdi runtime warm` command keeps its existing interface.
It requires an unclaimed Hosted OpenClaw home with no applied state, last-good
manifest or cached tenant secrets. It creates this instance's egress CA and a
random gateway token, reuses the prepared official unit, starts the gateway and
records its unit, drop-in, environment, CA and structural-config identity.
The provisioning owner controls when and where this command runs.

`clawdi runtime warm --runtime hermes` uses the same unclaimed-state guard. It
refreshes the copied managed CLI verification, installs the official gateway
unit without starting it, prepares the instance's egress CA, byte-compiles the
application and dependency tree, then starts the
official dashboard in a transient user unit on loopback to complete first-use
local work. Warm-up stops that unit and any gateway it started before returning.
The first tenant apply starts fresh services with the tenant's environment and
OAuth gate; Hermes authentication is resolved at process startup and is not
hot-adopted. No placeholder manifest or Cloud identity is used. Warm-up can be
repeated on an unclaimed home; failed warm-up must not qualify it for a claim.
A root-owned private warm marker enables first-apply ordering on small tenant
shapes: after the platform/egress services become ready, start the dashboard,
wait for its local HTTP response, then start the gateway. Normal gateway and
channel observation still determine readiness. Existing tenants keep their
normal startup order. Final systemd state is freshly read in one batch per
scope, including unit enablement; warm-up does not replace this proof.

Tenant apply opts in with `CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY=1`; absence keeps the
existing restart behavior. The flag propagates into root-managed watch and
daemon units. Managed catalog, native/connection provider and channel credentials
become runtime-user-owned file SecretRefs (0700 directory, 0600 files). One
official config writer commits gateway, provider, channel and agent changes
under the native config lock with `afterWrite: auto`. Key rotation changes the
versioned credential path so the gateway reloads config and keys together.
Normal rotation does not require a secrets RPC.

The official installer fixes heap sizing at installation. A private platform
receipt binds the anonymous unit revision to observed memory capacity. A copy
with different capacity replaces only that exact prepared unit through the
official uninstaller and installer, preserving native updates and user edits.
Warm-up does this before qualification; normal apply retains its restart boundary.

An existing official unit that still captures a migrated credential is refreshed
through the official installer on its next opted-in normal apply. Changing the
unit, process environment, CA or runtime/plugin installation keeps the normal
restart boundary. Hybrid reload is required for hot adoption; native `off`,
`hot` and `restart` preferences retain normal service reconciliation.

Old credential versions remain private and are retained for active snapshots and
native rollback backups. The official `secrets reload` refreshes the active
snapshot's source config; success does not prove it has adopted the latest file
path from disk. Retention cleanup needs a separate live snapshot acknowledgement
and is deferred rather than deleting credentials a running gateway may still use.

Done: Docker CLI tests and changed-file Biome pass; the paired native fixture
proves authenticated tenant adoption, unchanged gateway PID on hot claim and
stop/start preservation. Production enablement and Hosted pool lifecycle belong
to the provisioning owner.
