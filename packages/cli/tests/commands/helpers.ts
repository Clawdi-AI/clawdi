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

export interface CapturedRequest {
	url: string;
	path: string;
	method: string;
	headers: Record<string, string>;
	isMultipart: boolean;
	multipartFields?: Record<string, string>;
	body?: unknown;
}

/**
 * Install a fake global fetch that matches requests by (method, path prefix).
 *
 * Responses are returned by the first matching handler in `handlers`, or a
 * 404 if nothing matches. Every request (matched or not) is appended to the
 * returned `captured` array for after-the-fact assertions.
 */
export function mockFetch(
	handlers: Array<{
		method?: string;
		path: string | RegExp;
		response: (request: CapturedRequest) => Response | Promise<Response>;
	}>,
): { captured: CapturedRequest[]; restore: () => void } {
	const orig = globalThis.fetch;
	const captured: CapturedRequest[] = [];

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		// openapi-fetch passes a Request object; legacy call sites pass a
		// string/URL + init. Normalise so either shape yields the same fields.
		const isRequest = input instanceof Request;
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (isRequest ? input.method : (init?.method ?? "GET")).toUpperCase();
		const path = url.replace(/^https?:\/\/[^/]+/, "");

		const headers = isRequest ? input.headers : new Headers(init?.headers);
		const capturedHeaders = Object.fromEntries(headers.entries());
		const contentType = headers.get("content-type") ?? "";
		const rawBody = isRequest ? input.body : init?.body;
		const isMultipart = rawBody instanceof FormData;

		let body: unknown;
		let multipartFields: Record<string, string> | undefined;
		if (isMultipart) {
			multipartFields = {};
			for (const [key, value] of rawBody.entries()) {
				if (typeof value === "string") multipartFields[key] = value;
			}
		}
		if (!isMultipart && contentType.includes("json")) {
			try {
				const text = isRequest ? await input.clone().text() : String(rawBody ?? "");
				body = text ? JSON.parse(text) : undefined;
			} catch {
				body = undefined;
			}
		}

		const request = {
			url,
			path,
			method,
			headers: capturedHeaders,
			isMultipart,
			multipartFields,
			body,
		};
		captured.push(request);

		for (const h of handlers) {
			if (h.method && h.method.toUpperCase() !== method) continue;
			const m = typeof h.path === "string" ? path.startsWith(h.path) : h.path.test(path);
			if (m) return await h.response(request);
		}
		return new Response(`unhandled ${method} ${path}`, { status: 404 });
	}) as typeof fetch;

	return {
		captured,
		restore: () => {
			globalThis.fetch = orig;
		},
	};
}

/** Seed `~/.clawdi/auth.json` + `~/.clawdi/environments/{agent}.json`. */
export function seedAuthAndEnv(home: string, agent: string, envId = "env-test"): void {
	const clawdiDir = join(home, ".clawdi");
	mkdirSync(join(clawdiDir, "environments"), { recursive: true });
	writeFileSync(
		join(clawdiDir, "auth.json"),
		JSON.stringify({ apiKey: "test-key", userId: "u1", email: "e@x" }),
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
 * `clawdi push` now probes /api/environments/{id} before doing any work, to
 * fail fast on a stale local env_id. Tests that exercise the happy path need
 * the probe to return 200 — drop this handler near the top of the handler
 * list and all push tests "just work".
 *
 * `default_project_id` is part of the env shape because the skill upload path
 * reads it via `fetchProjectIdForEnv` to pin uploads to the agent's own project.
 * Without it, multi-agent users on an unbound CLI key would see skills land
 * under whichever env was touched last (the `/api/projects/default` heuristic
 * we replaced).
 */
export const okEnvironmentProbe = (
	envId = "env-test",
	defaultProjectId = "00000000-0000-0000-0000-000000000099",
) => ({
	method: "GET",
	path: `/api/environments/${envId}`,
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
