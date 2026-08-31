<h1 align="center">Clawdi</h1>

<p align="center">
  <strong>The best home for all your AI agents.<br>Run them in the cloud or connect your own—with their context and tools in one place.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clawdi"><img src="https://img.shields.io/npm/v/clawdi?style=for-the-badge&logo=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/Clawdi-AI/clawdi/actions/workflows/cli-publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/Clawdi-AI/clawdi/cli-publish.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI status"></a>
  <a href="https://github.com/Clawdi-AI/clawdi/stargazers"><img src="https://img.shields.io/github/stars/Clawdi-AI/clawdi?style=for-the-badge&logo=github" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://clawdi.ai">Website</a> ·
  <a href="https://docs.clawdi.ai">Docs</a> ·
  <a href="docs/clawdi-cloud-product-tour.md">Product tour</a> ·
  <a href="https://www.npmjs.com/package/clawdi">npm</a>
</p>

<p align="center">
  <img src="docs/images/dashboard-activity.png" alt="Clawdi overview with two running demo Agents and a 12-month activity history" width="900">
</p>

Clawdi supports two run paths:

- **Cloud Agents:** managed Hermes or OpenClaw runtimes.
- **Connected Agents:** supported Agent software running on your computer.

Features vary by Agent software and run path.

## Start

Deploy a [Cloud Agent](https://docs.clawdi.ai/cloud-agents/deploy), or connect an Agent on macOS or Linux:

```bash
curl -fsSL https://clawdi.ai/install.sh | sh
clawdi auth login
clawdi setup
clawdi doctor
```

Windows and package-manager installs require Node.js 24+:

```bash
npm i -g clawdi
```

See the [Connected Agent quickstart](https://docs.clawdi.ai/getting-started/quickstart).

## Capabilities

- **Context:** Sessions and durable Memories.
- **Resources:** Projects, Skills, and Vaults.
- **Integrations:** MCP Connectors and messaging Channels.
- **AI Providers:** model access for supported local and Cloud Agent runtimes.
- **Open source:** MIT-licensed CLI, FastAPI backend, TanStack dashboard, and PostgreSQL.

See [Core concepts](https://docs.clawdi.ai/concepts/core-concepts) for support and access boundaries.

## Connected Agent support

| Agent | Sessions | Skills | MCP setup |
| --- | --- | --- | --- |
| Claude Code | Yes | Yes | Automatic |
| Codex | Yes | Yes | Automatic |
| Hermes | Yes | Yes | Automatic |
| OpenClaw | Yes | Yes | Manual hint where required |
| Pi | Yes | No | No |
| OpenCode | Yes | No | No |

## Self-host

```bash
git clone https://github.com/Clawdi-AI/clawdi.git
cd clawdi
bun install
```

```text
apps/web/          TanStack dashboard
backend/           FastAPI backend and migrations
packages/cli/      CLI, Agent adapters, and MCP server
packages/shared/   Shared API types and schemas
docs/              Architecture and contributor guides
```

Follow [`AGENTS.md#local-end-to-end`](AGENTS.md#local-end-to-end). Technical references: [Architecture](docs/architecture.md), [AI Providers](docs/ai-providers.md), and [Managed runtime](docs/managed-runtime.md).

## Development

```bash
bun run typecheck
bun run test
bun run check
```

See [`AGENTS.md`](AGENTS.md) for repository workflows.

## License

MIT. See [`LICENSE`](LICENSE).
