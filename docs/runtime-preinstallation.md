# Anonymous runtime preinstallation

Implementation review draft. This software-only CLI contract lets an external
provisioning owner prepare reusable data without a Cloud identity or manifest.
The provisioning owner owns templates, expiry, allocation and cleanup.

The root-only hidden command is:

```bash
clawdi runtime prepare --spec /path/to/spec.json --installer /path/to/official-installer.sh
```

The strict `clawdi.runtime-preinstallation.v1` spec contains exact
`cliPackageSpec` (`clawdi@<version>`), `architecture` (`x64` or `arm64`),
`imageFingerprint`, `runtime`, `runtimeVersion`, official `installerUrl` and
`installerSha256`. OpenClaw additionally requires `runtimeTarballUrl` from the
official npm registry and its `runtimeIntegrity` SHA512 value. Its version is an
exact release version; Hermes requires a full immutable commit and the matching
official installer URL at that commit. Unknown fields, tenant identifiers,
mutable versions and architecture/CLI mismatches are rejected.

Preparation requires empty `/home/clawdi` and `/var/lib/clawdi`. It verifies the
installer hash, uses the CLI's shared numeric privilege-drop implementation to
run as the runtime user with a clean environment and disabled
ambient npm/git/uv/pip configuration, and uses the upstream installers.
OpenClaw receives a checksum-verified local npm archive plus `--runtime-only`
and `--no-onboard`; Hermes receives `--commit`, `--force-commit`,
`--skip-setup`, `--skip-browser` and `--non-interactive`. The latter three
match normal installation; optional browser setup remains tenant-owned.
The trusted official installer runs only in the fresh anonymous home, with no
tenant/Cloud inputs or credentials. Upstream-generated default configuration,
persona and bundled skills are preserved. Existing tenant homes cannot be used
as preparation inputs. This capability does not change legacy provisioning.

Hermes preparation also runs the normal dashboard dependency installation and
frontend build, using the same commands and build-revision marker as ordinary
service preparation. The build runs in the clean anonymous environment; no
services or tenant settings are created. Matching revisions reuse the copied
frontend; missing output or changed revisions follow the normal rebuild path.
The existing revision includes executable identity and complete version output,
so upstream update notices can conservatively invalidate this cache.

Executable health and installed package/commit identity are checked. A root-only
mode `0400` JSON receipt under
`/var/lib/clawdi/preinstallation/receipt.json` records the exact spec, health and
home content digest. No Cloud initialization or tenant manifest convergence is
performed. Failed builds must be destroyed rather than retried in a used home.
The receipt trusts the provisioning owner to preserve the volume and enforce
expiry; it does not sign artifacts or lock all upstream transitive dependencies.
Only npm/uv caches explicitly redirected by this command and its temporary
verified download are removed. Other upstream software and defaults are retained;
optional browser downloads follow upstream/runtime provisioning behavior.

Normal runtime installation already skips the official installer when the
runtime executable is present. Reusing a prepared home therefore bypasses the
OpenClaw/Hermes install during normal convergence; ordinary tenant configuration
and health checks still run. Existing tenant runtime versions are unaffected.

Verify through the repository's hermetic entrypoint:

```bash
bash scripts/test.sh cli src/runtime/preinstallation.test.ts tests/runtime-privilege-drop-contract.test.ts tests/clean-test-runner.test.ts
```

For a paired disposable native fixture, produce the actual current CLI archive
inside a task-owned empty directory in this checkout:

```bash
bash scripts/test.sh preinstallation-artifact /path/to/checkout/task-artifacts
```

The archive and typed observation/convergence fixtures are built in the isolated
Docker runner. The caller owns output
cleanup. Enabling and rollback of any remote pool belong to its provisioning
owner; publishing this CLI alone does not enable prewarming.

Done: CLI typecheck and anonymous-preparation/install-bypass tests pass; native
installation/layout compatibility is separately qualified by the consumer.
