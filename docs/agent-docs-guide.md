# Agent Docs Guide
Use this when editing `AGENTS.md`, `CLAUDE.md`, `apps/web/public/skill.md`, and
contributor docs under `docs/`.

## Rule

Agent docs are command-first, minimal, and verified against code. Use one
executable example per convention. Put detail in `docs/`; keep `AGENTS.md` as
the loaded index.

## When To Add

Add a section only when an agent repeatedly gets a real task wrong. Before
adding text, search for the owner doc:

```bash
rg -n "the behavior or command" AGENTS.md docs README.md
```

Done: the new text links to the owner doc or replaces stale duplication.

## When To Delete

Delete or archive docs when the convention changes, the feature ships, or the
content describes a retired design. Do not silently remove historical context;
add this banner first:

```markdown
> HISTORICAL - <why>, see <current doc>.
```

Done: inbound links still resolve and the stale doc is listed in the PR body.

## Done Criteria

Every task-shaped section needs a check the agent can run. Use this format:

```markdown
Done: `command` exits 0 and output includes `<specific success text>`.
```

If the check needs services, say which service must already be running.

## Verification

Verify every claim about code, routes, commands, or files from the repo before
publishing:

```bash
rg -n "route|command|table|setting" backend packages apps docs
```

Done: the doc cites the current file or links to the current owner doc.

## Acceptance Gate

Use a blank-agent simulation before merging major doc changes. Start from a
fresh clone and only the repo docs. A fresh agent must be able to:

1. Start the local backend, web dashboard, and dev CLI.
2. Run the documented TypeScript, backend, web, and CLI checks.
3. Debug a failed local auth, API, sync, or generated-client workflow.

Done: the agent reaches the documented success output without private notes.

## LLM-Drafted Docs

LLM-authored docs are drafts. Human review must prune them. Keep load-bearing
commands, invariants, and links. Remove broad claims, unverified roadmap
language, repeated prose, and examples that do not run.
