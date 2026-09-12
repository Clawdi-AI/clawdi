# Component activation proof

Implementation draft for owner review, 2026-09-12. This is source behavior, not a
released CLI or deployed-service guarantee.

The CLI writes a separate `component-activations.json` version-1 record after
successful apply, bound to the digest of the complete existing apply receipt.
The legacy receipt schema stays unchanged so an older CLI can still replay it. Each entry binds an enabled Files, Hermes UI or OpenClaw UI component
to its committed systemd fingerprint, effective native unit/drop-ins from
`systemctl cat`, configuration bytes, access
revision and observed service invocation. Capture follows the existing complete
activation/authority commit; it never certifies a partially successful apply.

[`component-observation.ts`](../../packages/cli/src/runtime/component-observation.ts)
reads only the component's unit/configuration. Independent observation requires
that configuration to match the committed receipt, a successful component HTTP
probe, and the same live systemd invocation and configuration before and after
the probe. Automatic service restart can qualify a new invocation under the
unchanged committed configuration. Missing configuration, unknown invocation,
probe failure or mutation during observation produces unavailable proof.

The complete observation rechecks the applied receipt and boot/watch health
after asynchronous probes. Only the watch wrapper's top-level `timestamp` is
excluded from its canonical comparison; event, schema, health and identity
changes still invalidate the entire snapshot,
including its aggregate health; it cannot fall back to a stale healthy result.
Buffered event retries retain their original capture timestamp, from which
Cloud computes freshness.

The additive `components` v1 observation envelope inherits the existing exact
apply receipt, boot nonce/session, runtime identity and source revision from its
parent event. Its point-in-time freshness is bounded by the existing observation
deadline. Component entries report `ok` or `unknown`: an unavailable proof is
not proof of a definite service failure. An unknown component downgrades an
otherwise `ok` aggregate to `unknown`; existing `error` and `unknown` remain.
Cloud accepts unknown/error aggregates with unknown proof and continues to reject
contradictory `ok` plus unknown proof. Hosted partial admission still requires
that component's positive proof and unchanged exact identity/freshness gates.
Absent legacy proof retains the existing aggregate fallback.

Access revisions use SHA-256 over compact UTF-8 JSON arrays:

- Files: `["files", auth.accessRevision, auth.secret]`.
- Hermes UI: `["hermes-ui", username, password, sessionSecret]`.
- OpenClaw UI: `["openclaw-ui", gatewayToken]`.

These reuse the existing credential derivation and access-reset generation; they
do not add another secret or revision authority. No secret bytes are reported.
Component identities fix the serving ports to 9120, 9119 and 18789 respectively.
Hermes UI checks `/api/status` for enabled basic form authentication, then GETs
public `/login` HTML independently of gateway health. The aggregate readiness
check still requires the gateway. In the pinned native auth middleware,
`_GATE_PUBLIC_PREFIXES` includes `/login`; anonymous `/` redirects there with 302.
The probe neither assumes HTTP Basic headers nor follows redirects. Systemd v257 documents a new
InvocationID per unit runtime cycle and formats it as 32 hexadecimal characters.

Readers must deploy before the producing CLI. Absent, malformed, truncated,
unknown-version or legacy proof never authorizes partial-runtime admission; the
existing complete-runtime gate remains the fallback. Native OpenClaw `$include`
configurations have no component proof until their resolved dependency set can
be attested. The OSS UI consumes an optional version-1 admission marker on the
published endpoint; credential/route authorization still occurs server-side.

Independent services do not isolate shared RAM, disk, kernel, container or node
failure. This protocol does not promise instantaneous failure detection.

## Verification

```bash
bash scripts/test.sh cli src/runtime/manifest-reconciliation.test.ts --test-name-pattern 'component proof requires'
bash scripts/test.sh runtime-systemd
bash scripts/test.sh web src/hosted/agents/runtime-readiness.test.ts
```

Done: focused tests/typechecks pass, the native fixture verifies invocation
rotation, and the UI keeps aggregate Ready false while admitting a proved healthy
component. Cloud/Hosted schema and authorization verification belongs to the
paired reader changes. Root must qualify the next released CLI with a successful
owner deployment and fresh component observations before enabling this behavior
for that deployment; no fleet or tenant upgrade is implied.

Earlier verification (before the Fable probe correction): component persistence and
configuration/native-override drift scenario passed (1 test, 8 assertions);
`runtime-systemd` passed (8 tests, 42 assertions), including real invocation
rotation and unchanged effective configuration across restart. Observation and
producer regressions passed (33 tests, 141 assertions), including actual local
HTTP responses for a healthy Hermes UI with its gateway stopped. The frontend
component admission test passed (3 tests, 19 assertions), with typecheck,
production build and 9 SSR checks. CLI typecheck and Biome passed. The paired
Hosted reader/admission milestone is `1c5ede6da`; its 134 boundary tests and 13
PostgreSQL route tests passed. These results do not replace owner runtime/CLI
release qualification or Fable's independent final review.


## Fable correction evidence

```bash
bash scripts/test.sh cli src/runtime/hermes-dashboard-auth.test.ts src/runtime/observed-v2.test.ts src/runtime/heartbeat-observation.test.ts
bash scripts/test.sh runtime-systemd
```

The native auth fixture downloads the exact checksum/commit already pinned in
`tests/fixtures/runtime-official-installer-systemd/Dockerfile` and imports its
real `gated_auth_middleware`, `BasicAuthProvider` and dashboard auth router,
including its actual server-rendered `login_page`. Gateway status and systemd
remain fixtures; this does not build or run the complete native SPA or gateway. It proves anonymous root 302, public login 200, healthy aggregate ok,
and usable component UI with gateway state stopped. Ordinary HTTP regressions
also cover timestamp-only watch rewrites surviving probes, meaningful parent
health/receipt changes rejecting snapshots, and unknown proof preserving a
previous definite error. No CLI package/release artifact is produced.

`persistComponentActivations` runs only from `commitRuntimeAppliedState`; the
same-receipt 304 `not_modified` path returns without that commit. Existing
receipts therefore need a successful actual apply to gain proof. No automatic
apply or receipt migration is added. Owner qualification must check proof
presence; this source fact is not evidence of live rollout state.

Fable correction verification (2026-09-12): the command above passed 27 tests
with CLI typecheck, including the native middleware/provider scenario.
`bash scripts/test.sh cli src/serve/sync-engine.test.ts src/serve/sync-module.test.ts`
passed 71 tests, including a null initial `last_sync_error` while normal startup
prepares. The Cloud component contract passed through `scripts/test.sh backend`
(1 selected test), accepting unknown/error with unknown proof while rejecting
contradictory aggregate ok. Wire fields are unchanged, so no client regeneration
is required for this correction. Biome, Ruff and shell syntax checks passed.

The existing privileged systemd CI workflow calls `runtime-systemd`, which now
prepares the pinned dashboard fixture and executes the native auth test alongside
systemd tests. Missing fixture setup in that suite fails instead of silently
skipping. The native check verifies root 302, actual login 200/no-store/password
form, native provider metadata and the unchanged CLI probe. It does not require
an added workflow or a CLI release artifact.

CI wiring follow-up: `bash scripts/test.sh runtime-systemd` passed 9 tests / 53
assertions with the actual native login router and provider. No new workflow was
created; the existing privileged systemd workflow now covers this scenario.
