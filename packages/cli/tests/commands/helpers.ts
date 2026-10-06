import { mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";

const AGENT_HOME_OVERRIDE_KEYS = [
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"HERMES_HOME",
	"OPENCLAW_STATE_DIR",
] as const;

type AgentHomeOverrideKey = (typeof AGENT_HOME_OVERRIDE_KEYS)[number];

export type AgentHomeOverrideSnapshot = Partial<Record<AgentHomeOverrideKey, string>>;

/**
 * Tests that set only `HOME` still need to neutralize agent-specific home
 * overrides; those env vars take precedence over `HOME` in adapter path
 * resolution and can leak host state into fixtures.
 */
export function snapshotAndClearAgentHomeOverrides(): AgentHomeOverrideSnapshot {
	const snapshot: AgentHomeOverrideSnapshot = {};
	for (const key of AGENT_HOME_OVERRIDE_KEYS) {
		const value = process.env[key];
		if (value !== undefined) snapshot[key] = value;
		delete process.env[key];
	}
	return snapshot;
}

export function restoreAgentHomeOverrides(snapshot: AgentHomeOverrideSnapshot): void {
	for (const key of AGENT_HOME_OVERRIDE_KEYS) {
		const value = snapshot[key];
		if (value !== undefined) process.env[key] = value;
		else delete process.env[key];
	}
}

/** Seed `~/.clawdi/auth.json` + `~/.clawdi/environments/{agent}.json`. */
export function seedAuthAndEnv(home: string, agent: string, envId = "env-test"): void {
	const clawdiDir = join(home, ".clawdi");
	mkdirSync(join(clawdiDir, "environments"), { recursive: true });
	writeFileSync(
		join(clawdiDir, "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			userId: "u1",
			email: "e@x",
			endpointBinding: { version: 1, cloudApiOrigin: "http://localhost:8000" },
		}),
	);
	writeFileSync(
		join(clawdiDir, "environments", `${agent}.json`),
		JSON.stringify({ id: envId, agentType: agent }),
	);
}

export const jsonResponse = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

/**
 * `clawdi push` now probes /v1/agents/{id} before doing any work, to
 * fail fast on a stale local env_id. Tests that exercise the happy path need
 * the probe to return 200 — drop this handler near the top of the handler
 * list and all push tests "just work".
 *
 * `default_project_id` is part of the env shape because the skill upload path
 * reads it via `fetchProjectIdForEnv` to pin uploads to the agent's own project.
 * Without it, multi-agent users on an unbound CLI key would see skills land
 * under whichever env was touched last (the `/v1/projects/default` heuristic
 * we replaced).
 */
export const okEnvironmentProbe = (
	envId = "env-test",
	defaultProjectId = "00000000-0000-0000-0000-000000000099",
) => ({
	method: "GET",
	path: `/v1/agents/${envId}`,
	response: () =>
		jsonResponse({
			id: envId,
			machine_name: "Test Mac",
			agent_type: "claude_code",
			agent_version: "0.1.0",
			os: "darwin",
			last_seen_at: new Date().toISOString(),
			created_at: new Date().toISOString(),
			default_project_id: defaultProjectId,
		}),
});

export { type CapturedRequest, mockFetch } from "../../src/test-support/mock-fetch";
