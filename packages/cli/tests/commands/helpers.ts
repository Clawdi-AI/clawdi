import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CapturedRequest {
	url: string;
	path: string;
	method: string;
	isMultipart: boolean;
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
		response: () => Response | Promise<Response>;
	}>,
): { captured: CapturedRequest[]; restore: () => void } {
	const orig = globalThis.fetch;
	const captured: CapturedRequest[] = [];

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		const contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"];
		const isMultipart = init?.body instanceof FormData;

		let body: unknown;
		if (!isMultipart && typeof init?.body === "string" && contentType?.includes("json")) {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}

		captured.push({ url, path, method, isMultipart, body });

		for (const h of handlers) {
			if (h.method && h.method.toUpperCase() !== method) continue;
			const m = typeof h.path === "string" ? path.startsWith(h.path) : h.path.test(path);
			if (m) return await h.response();
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
