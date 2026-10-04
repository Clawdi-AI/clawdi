# Anonymous runtime preinstallation

Software-only preparation of a Hosted data volume without a Cloud identity or
manifest. The provisioning owner (Hosted golden builder) owns scheduling,
expiry, copying and cleanup. Tenant convergence is unchanged: it finds the
prepared, content-addressed artifacts present and skips their downloads.

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
3. records probe answers (`--version`, Hermes `config path`) with the launcher
   file revision and installed source identity (Hermes git commit or OpenClaw
   package version);
4. prefetches the pinned mitmproxy egress engine and Files companion binary into
   their content-addressed managed locations, and bootstraps Codex;
5. installs this exact CLI from the integrity-verified archive into the managed
   CLI layout with a verified receipt, so the image shim executes it without npm.

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
