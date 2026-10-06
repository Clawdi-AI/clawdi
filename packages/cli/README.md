# Clawdi CLI

This package publishes the `clawdi` command-line interface. The CLI registers
local AI agents, syncs sessions and skills, manages memory and vault workflows,
installs the MCP server, and controls the background sync daemon.

For product usage, start with the
[Connected Agent quickstart](https://docs.clawdi.ai/getting-started/quickstart).
For Cloud context and remote Skill commands, testing, and contributor workflows,
read [`docs/cli-development.md`](../../docs/cli-development.md). For a full local
backend + dashboard + CLI stack, use the canonical runbook in
[`AGENTS.md`](../../AGENTS.md#local-end-to-end).

## Quickstart

Recommended on macOS and Linux (no Node.js required):

```bash
curl -fsSL https://clawdi.ai/install.sh | sh
clawdi auth login
clawdi setup
clawdi doctor
```

Windows and package-manager installations require Node.js 24+:

```bash
npm i -g clawdi
```

Updates follow the current owner: native installs use checksum-verified exact
GitHub Release assets, while npm/Bun installs use exact npm versions. Hosted
version transactions are separate and never invoke native self-update.

To update from a non-interactive shell:

```bash
clawdi update --yes
```

Without `--yes`, non-interactive runs only check for updates and return JSON
with `installed: false` plus an installation hint on stderr when an upgrade is
available. `--check` always checks without installing, even with `--yes`.
Use `--yes --json` for a JSON installation result. Registry or native manifest
download failures exit 1; an unreachable registry returns a
`registry_unreachable` error instead of reporting that the CLI is up to date.

## Development

From the repository root:

```bash
bun install
bun run packages/cli/src/index.ts --help
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bun run --cwd packages/cli build
```

The package manager is Bun; do not use `pdm` for CLI dependencies or tests.
