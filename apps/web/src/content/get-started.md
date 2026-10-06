# Clawdi Setup

You're connecting this machine to Clawdi, the home for the user's AI agents. When you're done,
their agents are registered, Clawdi's skill and MCP tools are installed, and their session
history appears in their Clawdi dashboard.

## How to run this

Do every step yourself in your shell. Don't hand commands to the user to copy. The only thing
the user does is approve the sign-in in their browser. Don't ask any other questions. If a step
fails, say what failed, then continue with the next step.

## Install the CLI

If `clawdi --version` already works, run `clawdi update --yes` and go to **Sign in**.

On macOS or Linux:

```bash
curl -fsSL https://clawdi.ai/install.sh | sh
```

It installs to `~/.local/bin` and adds that directory to the user's shell profile. If `clawdi`
still isn't found in your current shell, run `export PATH="$HOME/.local/bin:$PATH"`.

Alternative for Windows, Node.js users, or CI (requires Node.js 24+):

```bash
npm install -g clawdi@latest
```

Don't use `sudo`. Then check:

```bash
clawdi --version
```

## Sign in

```bash
clawdi auth status --json
```

If `authenticated` is `true`, go to the next step. Otherwise run:

```bash
clawdi auth login
```

It prints a sign-in link and a short code, then waits. Show the user exactly that link and code,
and ask them to open the link, check that the page shows the same code, and approve. Only relay
the link and code that your own command printed. Never invent a sign-in URL or code. The command
finishes on its own after they approve. Don't ask them to tell you when they're done.

Give the command a timeout of at least 10 minutes, or run it in the background. If your tool
stops it early, run `clawdi auth complete` to keep waiting for the same sign-in. If it says the
code expired or was denied, run `clawdi auth login` again. When the command finishes, run
`clawdi auth status --json` to confirm.

If sign-in says this server doesn't allow device sign-in, stop and tell the user. Their
administrator has to enable it, or they can sign in with `clawdi auth login --manual` and an API
key in their own terminal.

## Set up this machine

```bash
clawdi setup
```

This registers every AI agent it finds on this machine, including Claude Code, Codex, Hermes,
OpenClaw, Pi, OpenCode, and DeepSeek Harness (`dsh`). It installs the Clawdi skill and MCP tools
into each agent that supports them, and starts background sync.
Don't install https://clawdi.ai/skills/clawdi/SKILL.md separately.

If the output includes a "Run manually" MCP command for the agent you are running in, run that
command yourself. Ignore manual MCP commands for other agents.

If setup couldn't install the background service (for example, there's no systemd in a
container), registration still worked. Tell the user that sync runs only when they run
`clawdi push`. Don't start `clawdi daemon run` in your shell; it never exits.

## Upload existing history

```bash
clawdi push --modules sessions --all-agents --all --json
```

Read `totals.sessions` from the JSON result (`clawdi.push.v1`). For the summary,
N = `new + updated + unchanged`; report `failed` and any `errors` too.

## Check

```bash
clawdi doctor
```

All checks should pass. Agents that aren't installed on this machine show as skipped.

## Tell the user

Send one short message based on what `clawdi setup` printed and the push totals. Report any
failures; only say background sync is on if setup installed it:

> Clawdi is set up. I registered {agents}, installed Clawdi's skill and tools, and turned on
> background sync, so your session history and skills upload to your Clawdi account
> automatically. {N} sessions are already there: {dashboard link from setup}
>
> To stop background sync: `clawdi daemon uninstall`. You can delete uploaded sessions in the
> dashboard.

## Optional: back up authored skills

If the user has their own skills under `~/.claude/skills/`, `~/.codex/skills/`, or similar:

```bash
clawdi push --modules skills --all-agents
```

## Troubleshooting

**Push reports 0 sessions but the user has history.** Reset the local cache and push again:

```bash
rm -f ~/.clawdi/sessions-lock.json
clawdi push --modules sessions --all-agents --all --json
```

**An older CLI doesn't know a command in this guide.** Run `clawdi update --yes`, then retry.
