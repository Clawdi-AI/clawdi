# Standalone Clawdi MCP

One stdio server forwards Cloud tools and provides local `vault_bind` and
`vault_pull`. It runs with Node 24 and Git on Linux (including WSL), without an
installed Clawdi CLI, CLI configuration, daemon, or privileged file RPC.

Build with `bun run --cwd packages/runtime-mcp build`. Copy the resulting
`dist/index.js` as `clawdi-mcp.mjs`; it bundles its dependencies. Managed release
archives carry the same entrypoint in `runtime-mcp/index.js`.

For a self-managed MCP client, configure this command and provide
`CLAWDI_MCP_AUTHORIZATION` through the client's protected environment with the
value `Bearer <Agent-bound API key>`:

```text
node /absolute/path/clawdi-mcp.mjs --api-url https://cloud-api.clawdi.ai --agent-id <uuid> --workspace /absolute/agent/workspace
```

The workspace must be a real directory, not writable by other users. Local
tools accept only an env filename directly inside it, such as `.env`,
`.env.production`, or `service.env`; nested paths are not supported. Git must
already ignore the untracked target. Symlinks, hardlinks, conflicting local
assignments, and changed account/API/Agent/source identities fail closed.
`vault_pull` follows cloud additions, updates and deletions while preserving
unrelated assignments. Files and binding metadata advance atomically at 0600.

Hosted uses administrator-projected `--config` containing the authenticated
manifest's Agent and native workspace, the Cloud API origin, and an egress
placeholder. The existing exact `/v1/mcp/clawdi` credential injector supplies
the runtime key; the tenant never receives the real platform credential.
Explicit `NODE_EXTRA_CA_CERTS` preserves system CA trust across native MCP
subprocess environment filtering.

`vault_resolve` remains the sole Cloud plaintext read tool. Its `material`
input reads a whole Vault or section with exact Agent/Project/Vault identities;
it requires the API key to be bound to that Agent. The adapter verifies the
returned identities and writes locally. `vault_bind` and `vault_pull` return
only status, path, field count, and added/updated/deleted counts. A remote-only
HTTP MCP endpoint does not advertise local tools.

Done: `scripts/test.sh vault-mcp` passes isolated stdio/HTTP/PostgreSQL tests,
including public supply, restart persistence, conflicts and scope rejection.
