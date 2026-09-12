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

The additive `components` v1 observation envelope inherits the existing exact
apply receipt, boot nonce/session, runtime identity and source revision from its
parent event. Its point-in-time freshness is bounded by the existing observation
deadline. A required component's unavailable proof cannot certify aggregate
healthy status. Aggregate Ready remains independent of component admission.

Access revisions use SHA-256 over compact UTF-8 JSON arrays:

- Files: `["files", auth.accessRevision, auth.secret]`.
- Hermes UI: `["hermes-ui", username, password, sessionSecret]`.
- OpenClaw UI: `["openclaw-ui", gatewayToken]`.

These reuse the existing credential derivation and access-reset generation; they
do not add another secret or revision authority. No secret bytes are reported.
Component identities fix the serving ports to 9120, 9119 and 18789 respectively.
Hermes UI checks its own basic-auth status and served SPA independently of
gateway health; the aggregate readiness check still requires the gateway.
The pinned native Hermes SPA is a FastAPI GET route, so this component probe
uses GET rather than assuming HEAD support. Systemd v257 documents a new
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

Local implementation verification (2026-09-12): component persistence and
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
