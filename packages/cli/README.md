# @clawdi-cloud/cli

iCloud for AI Agents. One CLI to sync sessions, skills, memory, and vault secrets across Claude Code, Codex, OpenClaw, and Hermes — with an MCP server on the other end of the pipe.

## Requirements

- **Bun ≥ 1.1** (required; the Hermes adapter uses `bun:sqlite`)
- At least one supported agent installed on the machine (detected automatically)

## Install

Clawdi CLI runs on Bun — it uses `bun:sqlite` for the Hermes adapter and
won't work under plain Node.js. If you don't have Bun yet, grab it from
[bun.sh](https://bun.sh) first.

```bash
bun add -g @clawdi-cloud/cli
```

Installing with `npm i -g @clawdi-cloud/cli` will fail to run on machines
without Bun on `$PATH` — the shipped `bin/clawdi.mjs` uses a
`#!/usr/bin/env bun` shebang. Use Bun to install globally.

## Commands

| Command | What it does |
| --- | --- |
| `clawdi auth login` / `logout` | Authenticate with the Clawdi Cloud backend |
| `clawdi status [--json]` | Show auth + sync state |
| `clawdi config list/get/set/unset` | Manage `~/.clawdi/config.json` |
| `clawdi setup [--agent <type>] [-y]` | Detect installed agents, register this machine, install built-in skill, wire up MCP |
| `clawdi push [--modules --since --project --all --agent --dry-run]` | Upload sessions / skills to the cloud |
| `clawdi pull [--modules --agent --dry-run]` | Download cloud skills to registered agents |
| `clawdi skill list [--json]` | List synced skills |
| `clawdi skill add <path> [-y]` | Upload a skill directory or single `.md` file (prompted preview) |
| `clawdi skill install <repo> [-a --agent] [-l --list] [-y]` | Install a GitHub skill into cloud and one or more agents |
| `clawdi skill rm <key>` | Remove a cloud skill |
| `clawdi skill init [name]` | Scaffold a new `SKILL.md` template |
| `clawdi memory list [--json --limit --category --since]` | List memories |
| `clawdi memory search <query> [--json --limit --category --since]` | Search memories by text |
| `clawdi memory add <content>` / `rm <id>` | Add or delete a memory |
| `clawdi vault set <key>` / `list [--json]` / `import <file>` | Manage secrets |
| `clawdi run -- <cmd>` | Run a command with vault secrets injected into env |
| `clawdi doctor [--json]` | Diagnose auth, agent paths, vault, MCP connectivity |
| `clawdi update [--json]` | Check for a newer CLI version |
| `clawdi mcp` | Start MCP server (stdio transport, for agents) |

Run any command with `--help` to see its flags and real examples.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CLAWDI_API_URL` | Override the backend endpoint (defaults to `http://localhost:8000`) |
| `CLAWDI_DEBUG` | Print stack traces on errors |
| `CLAWDI_NO_UPDATE_CHECK` | Suppress the non-blocking update check |
| `CLAUDE_CONFIG_DIR` | Custom home for the Claude Code adapter (instead of `~/.claude`) |
| `CODEX_HOME` | Custom home for the Codex adapter (instead of `~/.codex`) |
| `HERMES_HOME` | Custom home for the Hermes adapter (instead of `~/.hermes`) |
| `OPENCLAW_STATE_DIR` | Custom OpenClaw state directory |
| `OPENCLAW_AGENT_ID` | Target a specific OpenClaw agent (default `main`) |
| `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `BUILDKITE`, `JENKINS_URL`, `TEAMCITY_VERSION` | Detected as CI; interactive prompts are disabled |

## Local state

Everything clawdi writes lives under `~/.clawdi/`:

```
~/.clawdi/
├── config.json        user config (apiUrl)
├── auth.json          API key (mode 0600)
├── sync.json          per-module last-synced timestamps
├── environments/      one file per registered agent
└── update.json        cached npm registry lookup
```

Corrupted `sync.json` is tolerated with a warning, not a crash.

## Troubleshooting

```bash
clawdi doctor         # a single-shot diagnostic
```

It verifies auth, API reachability, each known agent's install path, vault resolution, and MCP connector config — with actionable hints on every failing check.

## Development

```bash
bun install
bun run packages/cli/src/index.ts --help    # run from source
bun run --cwd packages/cli typecheck         # tsc
bun run --cwd packages/cli test              # bun test
bun run --cwd packages/cli build             # produce dist/
```

## Testing

All tests run with `bun test` (< 3s for the full suite, ~140+ tests) and never
touch the network, your real `~/.clawdi`, or a real agent install. They're
designed to be safe to run on every file save.

### Layers

| Layer | What it covers | Lives in |
| --- | --- | --- |
| Unit | Pure libs: `api-client` retry/errors, `config`, `sanitize`, `frontmatter`, `source-parser`, `tty`, `version` | `tests/*.test.ts` |
| Adapter regression | Per-agent `collectSessions` / `collectSkills` / `writeSkillArchive` against pre-built fixture `$HOME`s | `tests/adapters/*.test.ts` |
| Command regression | `push` / `pull` / `doctor` / `update` / `skill init` with `globalThis.fetch` mocked; assert golden payloads and filesystem state | `tests/commands/*.test.ts` |
| Process smoke | Spawn `bun src/index.ts <args>` — catches bundle / import-level breakage the in-process tests can't see | `tests/smoke.test.ts` |
| Release checklist | Manual; see below | — |

### Fixtures

Synthetic `$HOME` directories for each agent live under
`tests/fixtures/{claude-code,codex,hermes,openclaw}/`. They're regenerated by
one script:

```bash
bun scripts/generate-fixtures.ts
```

Each fixture mirrors the real agent's on-disk layout with enough structure
to exercise every parser branch (tokens, message roles, multiple sessions,
`projectFilter`), and every fixture includes a `skills/node_modules/…` (and
equivalent) sentinel so the adapter tests assert `SKIP_DIRS` actually
filters. The root `.gitignore` has explicit negation rules that keep these
sentinels committed despite `node_modules/` being globally ignored.

Shape:

- `claude-code/` — JSONL with 5 entries (user/assistant messages + usage blocks); `skills/demo` + `skills/node_modules` (SKIP_DIRS sentinel)
- `codex/` — single rollout JSONL under `sessions/YYYY/MM/DD/`: `session_meta` + `turn_context` + `response_item` messages + `event_msg` token_count; `skills/demo` + `skills/.system` (dot-prefix skip) + `skills/node_modules` (SKIP_DIRS)
- `hermes/` — SQLite `state.db` with 3 sessions (plain-string model, JSON-blob model, empty); `skills/core/demo` (nested) + `skills/node_modules/bad` (verifies SKIP_DIRS applies during recursion, not just top-level)
- `openclaw/` — `sessions.json` index + `<id>.jsonl` transcript (with a `model_change` event); `skills/demo` + `skills/node_modules` (SKIP_DIRS)

Fixtures are committed (not regenerated on every test run). Regenerate only
when an upstream agent's on-disk format changes and a test breaks.

### Running tests

```bash
bun test                              # everything (~145 tests, < 3s)
bun test tests/adapters/              # adapter layer only
bun test tests/commands/push.test.ts  # just push regression
bun run test:watch                    # watch mode
```

### Release checklist (manual)

Before publishing `@clawdi-cloud/cli`:

1. `bun test` passes
2. `bun run build` produces a `dist/` that `bun bin/clawdi.mjs --version` runs
3. On a machine with each agent actually installed, run:
   - `clawdi setup --yes` — registers every detected agent + installs the bundled `clawdi` skill + wires up MCP where possible
   - `clawdi doctor` — expects all ✓
   - `clawdi push --agent claude_code --dry-run` (sanity: session count looks right)
   - `clawdi push --agent codex --dry-run`
   - `clawdi push --agent hermes --dry-run` (will warn about no project filter)
   - `clawdi push --agent openclaw --dry-run`
4. `clawdi mcp` launched from a real Claude Code `.mcp.json`; call `memory_search` and see a response
