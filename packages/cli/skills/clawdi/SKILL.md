---
name: clawdi
description: "Cross-agent personal memory + skills + sessions + vault for the current user. Surface this skill BEFORE answering any question that references the user themselves, their work, their history, or any task that might already be a skill they've built. Triggers include possessives ('my X'), habit phrases ('I usually', 'I always'), callbacks ('like last time', 'as I mentioned', 'the one I set up'), how-to questions ('how do I X'), action verbs that map to common workflows (deploy, ship, QA, post, message, send, browse), and any named external service the user might have credentials for. Also provides connected-service tools (Gmail, GitHub, Notion, Drive, Calendar, etc.)."
---

# Clawdi Cloud

You have access to the user's Clawdi Cloud — their cross-agent personal memory, skills, sessions, and vault. Most agents fail by NOT reaching for this when they should. The single most common failure mode is "the user has the answer pre-built in their cloud and the agent answered from general knowledge instead." Don't be that agent.

## What's in Clawdi

Five domains, all queryable through MCP tools. Use the right tool for the right shape of data:

| Domain | What it stores | Tool to query |
|---|---|---|
| **Wiki** | LLM-synthesized 1-paragraph "what we know about this entity" pages — one per real-world thing in the user's life (project, tool, service, person, concept), aggregating evidence from memory + skills + sessions + vault | `wiki_search`, `wiki_get` |
| **Memory** | Atomic durable facts: preferences, decisions, patterns, project context | `memory_search`, `memory_add`, `memory_extract` |
| **Skills** | Executable procedures with full instructions ("how to deploy", "how to post to Twitter") | `skill_search`, `skill_get` |
| **Sessions** | Past conversation transcripts across all agents (Claude Code, Codex, OpenClaw, Hermes) | `session_search`, `session_get` |
| **Vault** | Credential names (NOT values) — Stripe keys, API tokens, OAuth secrets | `vault_list` |
| *Cross-domain* | When you don't know which domain | `clawdi_search` |

## The dispatcher: tiered retrieval

Don't reflexively call a Clawdi tool on every turn. Work in tiers — escalate only when the cheaper tier doesn't answer.

### Tier 0 — local first

Answer from what's already in front of you before reaching for the cloud:

- **Current conversation context** — has the user already given you the answer in this session?
- **Files in CWD** — `Read`, `Grep`, `Glob` over the working repo
- **Run-and-check** — `Bash` to inspect state (e.g. `git log`, `ls`, `curl localhost`)
- **Your training** — purely textbook programming questions

If Tier 0 is sufficient, **stop here**. The Clawdi tools are for user-specific knowledge you can't derive locally.

### Tier 1 — when local doesn't suffice, pick by question shape

The shape of the question tells you which tool fits. **Pick one** — don't fan out unless Tier 1 returns empty.

```
"what do I know about X"                          → wiki_search
"tell me about my/our X"                          → wiki_search
"give me an overview of X"                        → wiki_search
named entity (project, tool, service, person)     → wiki_search
"what's the status / current state of X"          → wiki_search

"what's the URL/key/value/setting for X"          → memory_search
"I usually X" / "I prefer X" / habit              → memory_search
self-reference for a specific fact ("my email")   → memory_search

"how do I X" / action verb                        → skill_search
named service + action ("post to Twitter")        → vault_list, then skill_search

"what did I/we do about X" / past work            → session_search

ambiguous — domain unclear                        → clawdi_search
```

**Wiki vs memory — the routing rule of thumb**:
*Wiki* gives you the synthesized whole picture about a named thing in 1 paragraph plus links to all sources. *Memory* gives you the raw atomic fact. Default to wiki for "what do I have about X" / "tell me about Y" — one read instead of stitching together 5 memory fragments. Default to memory when the user wants a specific value or a one-line preference.

### Tier 2 — escalate when Tier 1 is empty or weak

If Tier 1 returns no useful hits:
- Broaden with `clawdi_search` (fan-out across all 4 domains)
- Or try a sibling domain (wiki → memory, memory → wiki, skill → session)
- Still empty? Declare zero-result out loud (Rule 5) — don't fall back to general knowledge

### Writeback (after, not before)

```
after fixing a non-obvious bug        → memory_add
after making an architecture decision → memory_add
user says "remember this"             → memory_add (or memory_extract for batch)
"save what we discussed"              → memory_extract
```

## The 6 rules

These are the rules every Clawdi-aware agent must follow.

### Rule 1 — Local first, escalate when local fails

Don't reach for Clawdi tools by reflex. Work the tiers (see dispatcher above):

1. **Tier 0** — answer from current context, files, or training
2. **Tier 1** — only if Tier 0 doesn't suffice, pick the right Clawdi tool by question shape
3. **Tier 2** — escalate to `clawdi_search` or a sibling domain only if Tier 1 returns empty/weak

When unsure between Tier 0 and Tier 1: **bias toward calling Tier 1 anyway** for anything that references the user themselves (`my X`, `like last time`, named entities they control). The user has 130+ memories, 150+ skills, 90+ sessions, 490+ vault keys, plus the synthesized wiki on top. A search that returns empty costs ~150ms; a missed call makes you look amnesic. The point of "local first" is to not wastefully call Clawdi for textbook programming questions or when the answer is already in this conversation — not to skip search entirely on user-context questions.

### Rule 2 — Skill-first

Before suggesting a manual approach for any task that could be a skill, call `skill_search`. The user has built skills for:
- Deployment, QA, code review, shipping (`gstack/*`)
- ML/data ops and metrics (`mlops/*`)
- External services: Twitter, Slack, Notion, Polymarket, GitHub, Apple Notes/Reminders/iMessage/FindMy
- Delegation to other AI agents (claude-code, codex, hermes)
- Investigation, design review, retros, brainstorming

If a skill exists for the task, **read it (`skill_get`) and follow it** rather than improvising. The user already iterated on it.

### Rule 3 — Vault visibility, not values

When a task needs credentials, **call `vault_list` first** to see what the user already has stored. Then suggest "I see you have `STRIPE_SECRET_KEY` configured — use it?" instead of asking "do you have a Stripe key?"

`vault_list` returns names only. Values are NEVER exposed through any tool. If the user asks for a value, refuse and point them to the dashboard. This is a hard security boundary — do not work around it.

### Rule 4 — Cite-or-abstain

If you used a retrieved memory, skill, session, or vault key in your answer, **name its ID/key** so the user can verify and refine.

Examples:
- ✅ "Per memory `8b83f845…` (Voice Call Twilio Setup), the webhook URL is …"
- ✅ "Following the `research/polymarket` skill, querying the markets endpoint…"
- ❌ "Based on what I remember, …" (← which memory? unfalsifiable)
- ❌ "I see you have a Twitter setup, let me post…" (← which skill? which keys?)

This forces you to actually integrate retrieved content instead of paraphrasing it away. It also lets the user spot stale memories and update them.

### Rule 5 — Zero-result protocol

If a search returns nothing, **say so out loud** — don't silently fall back to general knowledge.

✅ "I don't see any memory or session about the audit log table. Want me to add one when we set it up?"
❌ "*makes something up that sounds plausible*"

The user's trust depends on knowing whether you're using their context or fabricating. Being honest about gaps is part of the contract.

### Rule 6 — Writeback discipline

After significant moments, save to memory. The user-side flow is moving to server-side LLM extraction from sessions, so for now your job is to reach for `memory_add` at these moments:

- **After fixing a non-obvious bug** — save root cause + fix, not just "bug fixed"
- **After making an architecture decision** — save the decision AND the reasoning
- **After learning a user preference** — so neither you nor the next agent re-asks
- **When the user explicitly says "remember this"** — always honor

For batch save at session end (user says "save what we discussed"), use `memory_extract` and follow its list-then-confirm flow. Never save without confirmation.

Write content as **standalone sentences with proper nouns** (not pronouns). A future session will read it without today's context. Examples:
- ✅ "Marvin prefers `rg` over `grep` and `fd` over `find`."
- ❌ "User likes rg." (no proper noun, future-self ambiguous)

Do NOT save: trivia readable from current code, generic programming knowledge, ephemeral conversation noise.

## Memory categories

When calling `memory_add`, pick:
- **`fact`** — technical facts, API details, config values
- **`preference`** — user preferences, coding style, workflow choices
- **`pattern`** — recurring patterns, pitfalls, team conventions
- **`decision`** — architecture decisions and their reasoning
- **`context`** — project context, deadlines, ongoing work

Default if unsure: `fact`.

## Anti-hallucination clause

A retrieved memory naming a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: verify it exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation: verify first.

"The memory says X exists" is not the same as "X exists now."

## Connectors

Connected service tools (Gmail, GitHub, Notion, etc.) are dynamically registered from the user's Clawdi Cloud dashboard. They appear as individual tools like `gmail_fetch_emails`, `github_list_issues`, etc.

- These tools are already authenticated — no OAuth needed at runtime
- If a tool call fails with "No connected account", tell the user to connect the service in the Clawdi Cloud dashboard
- File downloads from connectors return signed URLs — download with `curl` or `fetch` before processing
- Confirm with the user before side-effecting operations (sending email, creating issues, posting tweets)

## When NOT to use Clawdi tools

Skip the search/recall flow when:
- The question is purely textbook programming with zero user-specific signal ("how does `useEffect` work", "explain quicksort")
- The current code or open file already answers the question directly
- The user explicitly says "ignore memory" or "don't use my saved context"

When in doubt: **search**. Empty results are cheap; missing the user's context costs their trust.
