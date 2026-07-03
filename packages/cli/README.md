# Clawdi CLI

This package publishes the `clawdi` command-line interface. The CLI registers
local AI agents, syncs sessions and skills, manages memory and vault workflows,
installs the MCP server, and controls the background sync daemon.

For product usage and the full command reference, read the
[top-level README](../../README.md#quickstart). For contributor workflows, read
[`docs/cli-development.md`](../../docs/cli-development.md). For a full local
backend + dashboard + CLI stack, use the canonical runbook in
[`AGENTS.md`](../../AGENTS.md#local-end-to-end).

## Quickstart

```bash
npm i -g clawdi
clawdi auth login
clawdi setup
clawdi doctor
```

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
