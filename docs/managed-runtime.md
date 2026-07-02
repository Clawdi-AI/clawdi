# Managed Runtime Contract

| Field | Value |
| --- | --- |
| Status | Public runtime contract |
| Last updated | 2026-07-01 |
| Owner | CLI runtime layer |

This document describes the public Clawdi CLI and dashboard contract for managed
runtime environments. It intentionally avoids deployment-specific topology,
private service details, live service hosts, and internal runtime orchestration.

Related public docs:

- CLI notes: [`plans/managed-runtime-cli.md`](plans/managed-runtime-cli.md)
- Roadmap: [`plans/managed-runtime-roadmap.md`](plans/managed-runtime-roadmap.md)
- Projection boundary:
  [`plans/runtime-projection-boundary.md`](plans/runtime-projection-boundary.md)

## Scope

The open-source CLI owns local runtime convergence, command wrapping, external
runtime projections, agent-facing MCP, optional runtime UI bridging, and
diagnostics. The web app owns the hosted deployment dashboard surfaces,
including Control UI and Terminal tabs. A separate control plane may provide
desired state, credentials, terminal authorization, rollout policy, and
deployment lifecycle, but that platform-specific implementation is outside this
repository.

The public contract covers:

- validating runtime desired state;
- installing or verifying supported agent runtimes through their normal
  installers;
- writing non-secret local run configuration;
- projecting short-lived secrets only for the current runtime session;
- starting commands through `clawdi run -- <command>`;
- providing stable command shims for managed runtime names;
- projecting backend URL-based MCP for official external runtime containers;
- exposing sidecar-local MCP only for explicitly declared compatibility
  targets;
- optionally proxying local runtime browser UIs through the runtime bridge when
  a manifest explicitly declares bridge surfaces;
- exposing a dashboard Terminal contract for one deployment shell;
- publishing a stable Clawdi runtime sidecar image contract;
- reporting status and diagnostics through runtime commands.

The public contract does not cover:

- deployment-specific topology;
- private control-plane endpoints;
- tenant or billing policy;
- internal service implementation;
- private platform rollout implementation details.

## Core Architecture

Managed runtime mode keeps the Clawdi sidecar stable and runs agent processes in
their official runtime containers. The stable identity is the runtime target id
(`agent_id`). Runtime `type` is adapter and image metadata only.

```mermaid
flowchart LR
    Dashboard[Dashboard] -->|target route id<br/>env_id or deployment_id:agent_id| DeployAPI[Hosted deployment API]
    Dashboard -->|POST terminal<br/>{ agent_id }| DeployAPI
    ControlPlane[Control plane<br/>desired state + secrets] --> Controller[Deployment controller<br/>Pod spec + rollout]
    BackendMcp[Clawdi backend<br/>/mcp/clawdi]
    ControlPlane -->|manifest| Sidecar
    Controller -->|creates/updates| Pod

    subgraph Pod["One Kubernetes Pod / localhost network namespace"]
        Sidecar[Clawdi sidecar<br/>runtime init/watch<br/>config projection]
        OpenClawA[Official OpenClaw container<br/>agent_id=openclaw-a<br/>type=openclaw]
        OpenClawB[Official OpenClaw container<br/>agent_id=openclaw-b<br/>type=openclaw]
        HermesA[Official Hermes container<br/>agent_id=hermes-a<br/>type=hermes]
        VolA[(PVC /state/openclaw-a)]
        VolB[(PVC /state/openclaw-b)]
        VolH[(PVC /state/hermes-a)]

        Sidecar -->|controlCommand<br/>native config projection| OpenClawA
        Sidecar -->|controlCommand<br/>native config projection| OpenClawB
        Sidecar -->|config file merge| HermesA
        Sidecar -->|project backend MCP URL + bearer header| OpenClawA
        Sidecar -->|project backend MCP URL + bearer header| OpenClawB
        Sidecar -->|project backend MCP URL + bearer header| HermesA
        OpenClawA --- VolA
        OpenClawB --- VolB
        HermesA --- VolH
    end

    OpenClawA --> BackendMcp
    OpenClawB --> BackendMcp
    HermesA --> BackendMcp
    DeployAPI -->|terminal broker<br/>exec into exact container| OpenClawA
    DeployAPI -->|terminal broker<br/>exec into exact container| OpenClawB
    DeployAPI -->|terminal broker<br/>exec into exact container| HermesA
```

The Clawdi runtime sidecar image contains only the stable host envelope:

- runtime user and home directory;
- base packages required by the CLI and supported installers;
- a host policy file that marks the environment as hosted;
- a stable CLI bootstrap path;
- PATH ordering that puts the service-state shim directory first;
- supervisor or equivalent process entrypoint;
- the native Clawdi MITM broker bundle.

The sidecar image must not include OpenClaw or Hermes binaries. Those processes
run from official upstream images. The published OSS image is:

```text
ghcr.io/clawdi-ai/clawdi-runtime-sidecar:<git-sha>
```

The image entrypoint creates the hosted policy files when they are not mounted,
optionally materializes `/etc/clawdi/runtime-source.json` from
`CLAWDI_RUNTIME_MANIFEST_URL`, loads the configured auth token from env or an
`*_FILE` secret, runs `clawdi runtime init --non-interactive --json`, and then
execs `supervisord` with the rendered supervisor config.

The image also contains an image-built CLI bootstrap tarball at:

```text
/usr/local/share/clawdi/bootstrap/clawdi-runtime-bootstrap.tgz
```

When the hosted manifest does not declare `clawdiCli.packageSpec`, the sidecar
image sets `CLAWDI_RUNTIME_DEFAULT_CLI_PACKAGE_SPEC` to that tarball. A
controller can still roll the CLI independently by pinning
`clawdiCli.packageSpec` to a specific npm version or managed tarball in desired
state.

Runtime behavior should come from:

- the runtime manifest;
- the `clawdi` CLI package selected by manifest policy;
- `execution.mode = external` entries for runtimes supplied by official
  containers instead of launched by the sidecar;
- explicit `run.command` entries for future or externally installed runtimes.

Adding a new target should not require adding a new image-level wrapper. The
controller chooses the official image and Pod layout; the manifest names the
target id, type, image metadata, mounted paths, control command, MCP source, and
terminal target. Runtime availability and enabled/disabled policy belong to the
manifest and control plane, not to the sidecar image.

### Target Identity

Every hosted runtime instance has one stable target id:

- `agent_id` / runtime target id: unique instance identity, for example
  `openclaw-a`, `openclaw-b`, or `hermes-a`.
- `type`: adapter metadata, one of `codex`, `openclaw`, or `hermes`.
- `environmentId`: cloud-api agent environment id when minted.
- `image` and `version`: controller-declared desired image and sidecar-observed
  native CLI/runtime version.

No dashboard, terminal, provider, channel, or live-sync path selects a runtime by
`type`. If two OpenClaw targets exist, every operation names `openclaw-a` or
`openclaw-b` explicitly.

One Clawdi sidecar naturally manages only the targets in its own Pod because it
depends on same-Pod networking, mounted volumes, and local control commands.
Multiple Pods require a controller/operator that renders one target manifest per
Pod and rolls Pod specs forward. A single sidecar must not reach across Pod
boundaries to mutate another Pod's volumes or containers.

### Same-Pod Config Injection

Config injection is same-Pod and explicit:

- The sidecar owns `/var/lib/clawdi`, `/run/clawdi`, and `/home/clawdi`.
- Each runtime target owns a distinct state volume, for example
  `/state/openclaw-a`, `/state/openclaw-b`, and `/state/hermes-a`.
- The sidecar may mount several target volumes, but each mounted path must map
  to exactly one `agent_id`; two enabled targets must not share the same
  `execution.stateDir` or `execution.home`.
- Hermes config projection is a direct merge into
  `runtimeTargets.<agent_id>.execution.home/config.yaml`.
- OpenClaw provider, channel, and MCP projection uses OpenClaw's native config
  patch contract. In external mode, manifests that declare those projections
  must provide `execution.controlCommand`; otherwise the manifest is rejected.
  This keeps the Clawdi sidecar image free of OpenClaw binaries while making the
  deployment's control adapter explicit.
- Terminal injection is not config injection. The deployment-side terminal
  broker resolves `execution.terminal` after the dashboard selects `agent_id`
  and execs into the exact target container.

## Manifest Shapes

The CLI accepts two related shapes:

- `clawdi.hosted-runtime.manifest.v1` is the hosted control-plane response
  shape. It can include `system`, `controlPlane`, `clawdiCli`, `runtimes`,
  `providers`, `liveSync`, `mitmProfiles`, `mcp`, `tools`, and `recovery`.
- `clawdi.runtimeDesiredState.v1` is the normalized internal convergence shape
  consumed by `runtime init`.

Normalization maps hosted fields into the internal shape:

| Hosted field | Internal purpose |
| --- | --- |
| `deploymentId`, `environmentId`, `instanceId`, `generation` | Identity, cache keys, status, and idempotence |
| `system.home`, `system.workspace` | Runtime HOME and workspace root |
| `controlPlane.manifestUrl`, `controlPlane.cloudApiUrl` | Manifest datasource and API origin |
| `clawdiCli.packageSpec` | System-managed CLI package selection |
| `runtimeTargets.<agent_id>.type` | Adapter/image family metadata |
| `runtimeTargets.<agent_id>.enabled` | Target availability |
| `runtimeTargets.<agent_id>.environmentId` | Cloud-api agent environment id |
| `runtimeTargets.<agent_id>.image` | Desired official image ref/tag/digest |
| `runtimeTargets.<agent_id>.version` | Desired/observed runtime version metadata |
| `runtimeTargets.<agent_id>.execution` | External-container execution facts |
| `runtimeTargets.<agent_id>.run` | Explicit managed-process command override |
| `bridge.surfaces` | Optional authenticated compatibility surface mappings |
| `providers.<agent_id>` | Target-scoped AI provider projections and secret refs |
| `mcp`, `tools` | Runtime MCP/tool projection input |
| `liveSync.agents[].agentId` | Target id for daemon sync |
| `mitmProfiles` | Explicit local broker profiles |
| `recovery` | Manifest cache and offline-boot behavior |

The normalized `clawdi.runtimeDesiredState.v1` keeps a target-id keyed
`runtimes` map for convergence, plus `runtimeTargets` for the public target
contract. Each entry must declare `type`; the CLI never infers type from the key
name.

External official containers use `runtimeTargets.<agent_id>.execution` as the
deployment boundary:

- `mode: "external"` tells the sidecar not to install, supervise, or launch the
  agent process.
- `home`, `stateDir`, and `workspace` describe the agent-native mounted paths.
  Each enabled target must have its own writable state path. For example,
  `openclaw-a` and `openclaw-b` must not share `/home/node/.openclaw`.
- `controlCommand` is the deployment-provided command that runs the native agent
  CLI in the target runtime environment for config projection.
- `execution.mcp.source` defaults to backend direct MCP when omitted. A custom
  URL must explicitly set `source` to `backend-direct` or `sidecar-local`.
- `execution.mcp.url` is only required for `source: "sidecar-local"`, where it
  must use `http://` and `streamable-http`. Backend direct MCP derives the URL
  from `controlPlane.apiUrl` when omitted.
- `terminal` is consumed by the deployment-side terminal broker after the
  dashboard selects `agent_id`; it describes the exact container/user/cwd/env
  for the real shell target.

Image upgrades are not performed by the sidecar. The sidecar records desired
image metadata and observes the native runtime version through
`execution.versionCommand`, `controlCommand --version`, or the installed CLI when
available. A controller/operator performs the actual upgrade by changing the Pod
spec image tag/digest and rolling the Pod. The sidecar then reports observed
version drift through install inventory and sync state.

Production rollouts should treat images as three independent tracks:

| Image | Owner | Upgrade mechanism |
| --- | --- | --- |
| `ghcr.io/clawdi-ai/clawdi-runtime-sidecar:<git-sha>` | Clawdi OSS release workflow | Controller changes the sidecar image tag/digest and rolls the Pod |
| Official OpenClaw image | OpenClaw upstream / deployment controller | Controller changes the OpenClaw target container image tag/digest |
| Official Hermes image | Hermes upstream / deployment controller | Controller changes the Hermes target container image tag/digest |

The sidecar observes agent versions; it does not mutate agent image tags. If an
agent image update changes config contracts, the controller must update both the
target image and the manifest fields (`image`, `version`, `execution`, and
projection settings) in the same rollout.

## Commands

Runtime operators can use these commands in controlled environments:

```bash
clawdi runtime init --non-interactive
clawdi runtime watch
clawdi runtime bridge
clawdi mcp http --host 0.0.0.0 --port 8788 --path /mcp --auth-token-file <file>
clawdi runtime status --json
clawdi runtime doctor --json
clawdi run -- <command>
```

Normal local onboarding still uses `clawdi setup`. Runtime commands are for
managed environments where configuration is supplied by policy or a manifest,
not by an interactive user setup flow.

`runtime watch` is the long-running reconciliation loop. It refreshes remote
manifest state using ETags, applies changes, records status, and uses
last-good cached manifests only when recovery policy explicitly allows it.
`runtime bridge` exposes manifest-declared runtime surfaces behind hosted access
controls when a deployment needs a local compatibility proxy.

Official external runtime containers use backend direct MCP by default:
`<controlPlane.apiUrl>/mcp/clawdi` with the deployment API key projected as
an `Authorization` header. The backend endpoint is stateless Streamable HTTP,
handles `initialize`, `ping`, `tools/list`, and `tools/call`, and enforces the
same user and environment binding as the rest of the API.

`clawdi mcp http` is compatibility mode only. It exposes a sidecar-owned MCP
server for runtimes that cannot reach the backend route directly. A runtime must
declare `execution.mcp.source: "sidecar-local"` and an explicit `http://` URL
before the sidecar starts this program. The endpoint requires a sidecar-local
bearer token from `CLAWDI_MCP_HTTP_TOKEN` or `--auth-token-file`, and projected
URL MCP configs pass that token in an `Authorization` header, not in the URL.
When multiple sidecar-local external runtimes are enabled, their projected MCP
URLs must share the same sidecar port and path.

Bridge surfaces are browser-facing compatibility surfaces. Each surface declares
its listen address, upstream target, protocol behavior, auth model, and header
rewrite rules. The bridge must not become a generic arbitrary-port forwarder.
Static upstream headers should be non-secret policy values; bearer tokens,
cookies, and API keys should be injected through `upstreamHeaderEnv`.
Terminal is deliberately out of scope because it is a shell-exec authorization
path, not a browser UI proxy.

## Desired State Boundary

The CLI consumes a desired-state document plus optional secret values. The
desired state should contain only non-secret configuration such as enabled
runtimes, command launch settings, channel projections, and provider routing
metadata. Secret values are delivered separately and must not be cached in
plain text.

At the boundary:

- the control plane owns desired-state generation and secret resolution;
- the CLI owns local validation, projection, diagnostics, and command launch;
- the runtime process owns normal agent behavior after launch.

The CLI writes durable non-secret state under the service state root. Important
outputs include:

| Output | Purpose |
| --- | --- |
| `config/clawdi.json` | Redacted managed runtime config |
| `sync/runtimes.json` | Runtime sync state |
| `cache/manifest.last-good.json` | Last accepted manifest |
| `cache/manifest.etag`, `cache/channels.etag` | Remote refresh cache validators |
| `install-inventory/<runtime>.json` | Install/verify observation |
| `config/projections/<runtime>.json` | Runtime projection payload |
| `config/run/<runtime>.json` | `clawdi run` launch config |
| `config/runtime-command-shims.json` | Active generated command shims |
| `supervisor/supervisord.conf` | Process supervision plan |

Short-lived secrets belong under the runtime run directory, not in durable
config. Status and diagnostic output must redact secrets.

## Command And Shim Model

`clawdi run -- <command>` is both a local vault-injection command and the hosted
runtime activation boundary. In hosted mode, it first tries to resolve the
command against a generated runtime run config. If a matching enabled config
exists, it launches that runtime with the configured command, args, cwd, env,
PATH, secret refs, and optional broker profile. If the config exists but is
disabled, `clawdi run` exits with a disabled-runtime error.

Generated shims make managed runtime commands feel native:

1. `runtime init` writes one dispatcher script under the service-state bin
   directory.
2. Each managed runtime command, such as `openclaw` or `hermes`, is a symlink to
   that dispatcher.
3. The host PATH puts the shim directory first for login and non-login shells.
4. The dispatcher removes its own directory from PATH and executes:

   ```bash
   clawdi run -- "$command_name" "$@"
   ```

This prevents accidental fallback to native binaries for disabled runtimes while
keeping ordinary shell commands real. A user typing `ls`, `git`, or `python`
gets the normal shell binary. A user typing a managed runtime name gets the
manifest-controlled `clawdi run` path.

Supervisor uses the same boundary:

```ini
command=/usr/bin/env clawdi run -- <runtime>
```

The image does not need per-agent supervisor wrappers.

## Provider And Channel Routing

Provider configuration uses standard Clawdi AI Provider modes:

- `openai_chat`;
- `openai_responses`;
- `anthropic_messages`;
- `google_generate_content`.

Agent-specific transport details belong to the target runtime projection layer.
For example, if a runtime needs a target-native transport name, the CLI maps the
standard provider contract into that runtime's configuration format at launch
time. The Clawdi provider model itself should stay provider-oriented, not
runtime-transport-oriented.

Channel configuration follows the same rule: the open-source contract describes
the local projection shape and validation rules, while service-specific channel
control planes remain outside this repository.

## Control UI And Terminal

Hosted deployment pages expose two live surfaces:

- **Control UI** embeds or links to the runtime's browser UI. In the optimized
  official-container model, the deployment layer should publish the upstream
  runtime UI directly through its own authenticated route. `clawdi runtime
  bridge` is an opt-in compatibility surface for runtimes or deployment targets
  that cannot expose the upstream UI directly and need same-origin, CSP, or
  header mediation.
- **Terminal** opens a shell for the deployment and should exec into the
  selected runtime container when the runtime is external. The sidecar is not
  the terminal target for agent work.

```mermaid
flowchart LR
    Dashboard[Dashboard] -->|Control UI URL| RuntimeUI[Runtime browser UI<br/>authenticated route]
    Dashboard -. compatibility Control UI URL .-> Bridge[clawdi runtime bridge]
    Bridge -. declared surface .-> RuntimeUI
    Dashboard -->|POST terminal { agent_id }| HostedAPI[Hosted API]
    HostedAPI --> Shell[Exact target container shell]
```

The browser Terminal contract is:

1. The dashboard calls `POST /v2/deployments/{deployment_id}/terminal` with
   the selected `agent_id`.
2. The API returns a short-lived `websocket_url`.
3. The frontend removes the fragment token from the URL and sends it only as a
   WebSocket subprotocol named `clawdi-terminal.<token>`.
4. The frontend also sends the `tty` subprotocol and uses tty-style frames:
   `0` for terminal input/output and `1` for resize.
5. The terminal uses xterm, auto-fits to the panel, focuses on pointer down, and
   switches theme when the dashboard switches light/dark mode.

The service-side implementation is outside this repository. It must
authenticate the user, require the deployment to be running, bind the terminal
token to the deployment and exact `agent_id`, and bridge the WebSocket to a
shell in that target container.

## Security Rules

- Do not persist control-plane auth tokens, private keys, provider secrets, or
  resolved vault values in durable runtime config.
- Official external runtime MCP should point at `/mcp/clawdi` on the
  backend. It uses the deployment API key and backend-side user/environment
  isolation; the sidecar does not host a multi-tenant MCP control plane.
- A sidecar-local MCP bearer may be projected into official agent MCP config
  only for explicit compatibility mode, because upstream URL MCP clients need
  an `Authorization` header. Scope it to the private container network and
  rotate it through runtime convergence.
- Keep non-secret desired state separate from secret values.
- Treat runtime policy as an input to the CLI, not as hardcoded private logic.
- Prefer official runtime configuration and installers before proxying or
  request rewriting.
- Keep defensive validation at every boundary: manifests, provider references,
  channel descriptors, filesystem paths, and process launch arguments.
- Remove `CLAWDI_AUTH_TOKEN` from agent child process environments unless that
  process is explicitly the Clawdi daemon or runtime reconciler.
- Start runtime browser UIs behind authenticated deployment routes. Disable
  public gateway auth inside the runtime only when access is otherwise confined
  to a private route or an explicitly declared local runtime bridge.
- Expose `clawdi mcp http` only on a trusted container/pod network and only
  when `execution.mcp.source` is `sidecar-local`. It uses plaintext bearer auth
  because it is a compatibility integration endpoint, not an internet-facing
  API.
- Require WebSocket subprotocol auth for Terminal sessions so bearer tokens do
  not appear in URLs or proxy access logs.

## Recovery Rules

- Cache only manifests that validate and converge without install/projection
  errors.
- Use ETags for remote refreshes where the datasource supports them.
- Offline boot is allowed only when `recovery.allowOfflineBoot` is true and the
  cached manifest does not require missing secret values.
- `runtime status --json` and `runtime doctor --json` should surface enough
  state to distinguish manifest fetch failures, manifest rejection, degraded
  offline boot, install failures, and disabled runtimes.

## Implementation Notes

The CLI implementation should remain portable and testable:

- runtime commands must support JSON output for automation;
- local fixture manifests may be used for tests;
- generated provider and channel projections should be deterministic;
- diagnostics should report actionable local state without exposing secrets;
- operator-only behavior should not change normal laptop onboarding.

Primary implementation files:

| Area | Files |
| --- | --- |
| Manifest schema | `packages/cli/src/runtime/manifest-contract.ts` |
| Manifest fetch/normalize/validate | `packages/cli/src/runtime/manifest-source.ts` |
| Runtime convergence | `packages/cli/src/runtime/manifest.ts` |
| Runtime paths | `packages/cli/src/runtime/paths.ts` |
| Host policy | `packages/cli/src/runtime/host-policy.ts` |
| Run config | `packages/cli/src/runtime/run-config.ts` |
| Command execution | `packages/cli/src/commands/run.ts` |
| CLI update policy | `packages/cli/src/runtime/cli-update.ts` |
| Runtime bridge | `packages/cli/src/runtime/bridge.ts` |
| Dashboard terminal | `apps/web/src/hosted/agents/hosted-terminal-panel.tsx` |
| Dashboard hosted detail page | `apps/web/src/hosted/agents/hosted-agent-detail.tsx` |
