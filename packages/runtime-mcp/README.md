# Standalone Clawdi MCP

One stdio server forwards Cloud tools and provides local `vault_sync`. It runs
with Node 24 and Git on Linux (including WSL), without an
installed Clawdi CLI, CLI configuration, daemon, or privileged file RPC.

Build with `bun run --cwd packages/runtime-mcp build`. Copy the resulting
`dist/index.js` as `clawdi-mcp.mjs`; it bundles its dependencies. The management binary embeds the named `runtime-mcp/index.js` resource; npm packages
also include that file for standalone extraction. Native archives keep only the existing
`clawdi`, `egress-addon`, and `skills` top-level entries, so older native updaters can
validate and install them.

For a self-managed MCP client, configure this command and provide
`CLAWDI_MCP_AUTHORIZATION` through the client's protected environment with the
value `Bearer <Agent-bound API key>`:

```text
node /absolute/path/clawdi-mcp.mjs --api-url https://cloud-api.clawdi.ai --agent-id <uuid> --workspace /absolute/agent/workspace
```

The workspace must be a real directory, not writable by other users. Local
tools require an explicit env filename directly inside it on every call. Choose it
from project conventions and Vault purpose, for example `.env.stripe` or `stripe.env`,
without routine user reconfirmation, and report the chosen path. Git must
already ignore the untracked target. Symlinks, hardlinks, conflicting local
assignments, and changed account/API/Agent/source identities fail closed.
Call `vault_sync` with `path` and, for a file without a binding, `project_id`, `vault_id`,
and optional `section` to save and bind the source. Later calls supply the same `path`
and can omit source arguments to reuse the binding; supplied source must match.
Inspect existing files first; conflicting assignments are never silently overwritten.
`vault_sync` follows cloud additions, updates and deletions while preserving
unrelated assignments. Files and binding metadata advance atomically at 0600.

Hosted uses administrator-projected `--config` containing the authenticated
manifest's Agent and native workspace, the Cloud API origin, and an egress
placeholder. The existing exact `/v1/mcp/clawdi` credential injector supplies
the runtime key; the tenant never receives the real platform credential.
Explicit `NODE_EXTRA_CA_CERTS` preserves system CA trust across native MCP
subprocess environment filtering.

The adapter hides Cloud `vault_resolve` from its tool list and rejects direct
agent calls with a `vault_sync` instruction, without forwarding them. Sync internally
uses its `material` input to read a whole Vault or section with exact
Agent/Project/Vault identities;
it requires the API key to be bound to that Agent. The adapter verifies the
returned identities and writes locally. `vault_sync` returns
only status, path, field count, and added/updated/deleted counts. A remote-only
HTTP MCP endpoint does not advertise local tools; its released `vault_resolve`
plaintext contract remains available for legacy clients.

Done: `scripts/test.sh vault-mcp` passes isolated stdio/HTTP/PostgreSQL tests,
including public supply, restart persistence, conflicts and scope rejection.
