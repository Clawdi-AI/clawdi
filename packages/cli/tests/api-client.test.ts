import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSkillSyncNotFoundError, ApiError, retryingFetch } from "../src/lib/api-client";
import {
	SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
	SKILL_SYNC_PROTOCOL_HEADER,
} from "../src/lib/skill-sync-protocol";

// ApiClient reads ~/.clawdi/{auth,config}.json at construction via getAuth/getConfig.
// We redirect HOME to a tmpdir so each test gets a fresh auth/config.
let origHome: string | undefined;
let fakeHome: string;

function fakeLogin(apiUrl: string) {
	const dir = join(fakeHome, ".clawdi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			userId: "u1",
			email: "e",
			endpointBinding: { version: 1, cloudApiOrigin: apiUrl },
		}),
	);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ apiUrl }));
}

beforeEach(() => {
	origHome = process.env.HOME;
	fakeHome = join(tmpdir(), `clawdi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(fakeHome, { recursive: true });
	process.env.HOME = fakeHome;
	delete process.env.CLAWDI_API_URL;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("ApiClient construction", () => {
	it("throws ApiError(401) when not logged in", async () => {
		const { ApiClient } = await import("../src/lib/api-client");
		expect(() => new ApiClient()).toThrow(ApiError);
	});

	it("`requireAuth: false` constructs without credentials (public bootstrap)", async () => {
		// The CLI auth login flow needs a transport BEFORE a key exists. Any
		// other caller passing this flag is a bug — gate it behind an explicit
		// review. This test pins the contract so a refactor that makes
		// `requireAuth: false` the default will fail loudly.
		const { ApiClient } = await import("../src/lib/api-client");
		const api = new ApiClient({ requireAuth: false });
		expect(api).toBeDefined();
		// And — crucially — Authorization header must NOT be sent when no
		// credentials are present. Otherwise an unauth-construction call
		// could send `Bearer ` (empty value) and the server might log it.
		const origFetch = globalThis.fetch;
		let sentAuth: string | null = null;
		globalThis.fetch = async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(input);
			sentAuth = req.headers.get("authorization");
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		try {
			await api.GET("/v1/auth/me");
		} finally {
			globalThis.fetch = origFetch;
		}
		expect(sentAuth).toBeNull();
	});
});

describe("ApiClient error classification", () => {
	// Each test stubs `globalThis.fetch`, so the actual URL doesn't matter —
	// but the path literal must type-check against the generated OpenAPI
	// `paths` map. Pick any real endpoint for the method under test.

	it("throws ApiError with status + hint on 401", async () => {
		fakeLogin("http://127.0.0.1:0");
		const origFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
		try {
			const { ApiClient, unwrap } = await import("../src/lib/api-client");
			const api = new ApiClient();
			let caught: unknown;
			try {
				unwrap(await api.GET("/v1/auth/me"));
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ApiError);
			expect((caught as ApiError).status).toBe(401);
			expect((caught as ApiError).hint).toContain("clawdi auth login");
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("retries 5xx on GET up to the configured max", async () => {
		fakeLogin("http://127.0.0.1:0");
		const origFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			if (calls < 3) return new Response("oops", { status: 503 });
			return new Response(JSON.stringify({ email: "e@x" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		try {
			const { ApiClient, unwrap } = await import("../src/lib/api-client");
			const api = new ApiClient();
			const result = unwrap(await api.GET("/v1/auth/me"));
			expect(result).toMatchObject({ email: "e@x" });
			expect(calls).toBe(3);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("does not retry POST by default (non-idempotent)", async () => {
		fakeLogin("http://127.0.0.1:0");
		const origFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response("server error", { status: 500 });
		};
		try {
			const { ApiClient, unwrap } = await import("../src/lib/api-client");
			const api = new ApiClient();
			let caught: unknown;
			try {
				unwrap(
					await api.POST("/v1/memories", {
						body: { content: "x", category: "fact", source: "test" },
					}),
				);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ApiError);
			expect((caught as ApiError).status).toBe(500);
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("maps network errors to ApiError(status=0, isNetwork=true)", async () => {
		fakeLogin("http://127.0.0.1:0");
		const origFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new TypeError("fetch failed");
		};
		try {
			const { ApiClient, unwrap } = await import("../src/lib/api-client");
			const api = new ApiClient();
			let caught: unknown;
			try {
				unwrap(
					await api.DELETE("/v1/memories/{memory_id}", {
						params: { path: { memory_id: "abc" } },
					}),
				);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ApiError);
			expect((caught as ApiError).status).toBe(0);
			expect((caught as ApiError).isNetwork).toBe(true);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("readJson maps empty success bodies to ApiError instead of SyntaxError", async () => {
		const { readJson } = await import("../src/lib/api-client");
		let caught: unknown;
		try {
			await readJson(new Response("", { status: 200 }), "empty response");
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ApiError);
		expect((caught as ApiError).status).toBe(200);
		expect((caught as ApiError).body).toContain("empty response");
	});

	it("keeps timeout and caller abort active while consuming non-2xx bodies", async () => {
		const origFetch = globalThis.fetch;
		let externalBodyStartedResolve: (() => void) | undefined;
		const externalBodyStarted = new Promise<void>((resolve) => {
			externalBodyStartedResolve = resolve;
		});
		let fetchCalls = 0;
		globalThis.fetch = async (_input, init) => {
			fetchCalls += 1;
			const fetchCall = fetchCalls;
			const signal = init?.signal;
			if (!signal) throw new Error("expected request abort signal");
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						const abort = () => controller.error(new DOMException("Aborted", "AbortError"));
						if (signal.aborted) abort();
						else signal.addEventListener("abort", abort, { once: true });
					},
					pull() {
						if (fetchCall === 2) externalBodyStartedResolve?.();
						return new Promise<void>(() => {});
					},
				}),
				{ status: 422 },
			);
		};

		try {
			await expect(
				retryingFetch(new Request("http://127.0.0.1:0", { method: "POST" }), 10, undefined),
			).rejects.toMatchObject({ name: "ApiError", status: 0, isTimeout: true });

			const callerAbort = new AbortController();
			const pending = retryingFetch(
				new Request("http://127.0.0.1:0", { method: "POST" }),
				1_000,
				callerAbort.signal,
			);
			await externalBodyStarted;
			callerAbort.abort();
			await expect(pending).rejects.toMatchObject({
				name: "ApiError",
				body: "aborted",
				isTimeout: false,
			});
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("keeps Retry-After outside the attempt timeout but abortable by the caller", async () => {
		const origFetch = globalThis.fetch;
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			return new Response("rate limited", {
				status: 429,
				headers: { "retry-after": "60" },
			});
		};
		const callerAbort = new AbortController();
		const abortTimer = setTimeout(() => callerAbort.abort(), 20);

		try {
			await expect(
				retryingFetch(new Request("http://127.0.0.1:0"), 1, callerAbort.signal),
			).rejects.toMatchObject({ name: "ApiError", body: "aborted", isTimeout: false });
			expect(fetchCalls).toBe(1);
		} finally {
			clearTimeout(abortTimer);
			globalThis.fetch = origFetch;
		}
	});
});

describe("Agent-authoritative Skill sync rollout", () => {
	const notFoundCases = [
		{
			name: "route-not-found from an older backend",
			agentId: "agent-1",
			projectId: "project-1",
			body: '{"detail":"Not Found"}',
		},
		{
			name: "semantic Agent not found",
			agentId: "missing-agent",
			projectId: "project-1",
			body: '{"detail":"Agent not found"}',
		},
		{
			name: "wrong Agent id paired with a valid Project id",
			agentId: "wrong-agent",
			projectId: "valid-project",
			body: '{"detail":"Agent not found"}',
		},
		{
			name: "environment-bound Agent mismatch",
			agentId: "other-agent",
			projectId: "bound-agent-project",
			body: '{"detail":"Agent not found"}',
		},
	] as const;

	for (const scenario of notFoundCases) {
		it(`fails closed on upload ${scenario.name}`, async () => {
			fakeLogin("http://127.0.0.1:0");
			const originalFetch = globalThis.fetch;
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => {
				requests.push(input instanceof Request ? input : new Request(input, init));
				return new Response(scenario.body, {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			};
			try {
				const { ApiClient } = await import("../src/lib/api-client");
				await expect(
					new ApiClient().uploadAgentSkill(
						scenario.agentId,
						scenario.projectId,
						"demo",
						Buffer.from("archive"),
						"demo.tar.gz",
					),
				).rejects.toMatchObject({
					name: "AgentSkillSyncNotFoundError",
					status: 404,
					body: scenario.body,
				});
			} finally {
				globalThis.fetch = originalFetch;
			}

			expect(requests).toHaveLength(1);
			expect(new URL(requests[0].url).pathname).toBe(
				`/v1/agents/${scenario.agentId}/skills/sync/upload`,
			);
			expect(new URL(requests[0].url).pathname).not.toContain("/v1/projects/");
			expect(requests[0].headers.get(SKILL_SYNC_PROTOCOL_HEADER)).toBe(
				SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
			);
		});

		it(`fails closed on delete ${scenario.name}`, async () => {
			fakeLogin("http://127.0.0.1:0");
			const originalFetch = globalThis.fetch;
			const requests: Request[] = [];
			globalThis.fetch = async (input, init) => {
				requests.push(input instanceof Request ? input : new Request(input, init));
				return new Response(scenario.body, {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			};
			try {
				const { ApiClient } = await import("../src/lib/api-client");
				await expect(
					new ApiClient().deleteAgentSkill(scenario.agentId, "demo", scenario.projectId),
				).rejects.toBeInstanceOf(AgentSkillSyncNotFoundError);
			} finally {
				globalThis.fetch = originalFetch;
			}

			expect(requests).toHaveLength(1);
			const requestUrl = new URL(requests[0].url);
			expect(requestUrl.pathname).toBe(`/v1/agents/${scenario.agentId}/skills/sync/demo`);
			expect(requestUrl.searchParams.get("project_id")).toBe(scenario.projectId);
			expect(requestUrl.pathname).not.toContain("/v1/projects/");
			expect(requests[0].headers.get(SKILL_SYNC_PROTOCOL_HEADER)).toBe(
				SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
			);
		});
	}

	it("accepts a bodyless dedicated delete replay response", async () => {
		fakeLogin("http://127.0.0.1:0");
		const originalFetch = globalThis.fetch;
		const requests: Request[] = [];
		globalThis.fetch = async (input, init) => {
			requests.push(input instanceof Request ? input : new Request(input, init));
			return new Response(null, { status: 204 });
		};
		try {
			const { ApiClient } = await import("../src/lib/api-client");
			await new ApiClient().deleteAgentSkill("agent-1", "demo", "project-1");
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v1/agents/agent-1/skills/sync/demo",
		]);
	});

	it("keeps workspace and personal Project mutations on the generic Cloud boundary", async () => {
		fakeLogin("http://127.0.0.1:0");
		const originalFetch = globalThis.fetch;
		const requests: Request[] = [];
		globalThis.fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			requests.push(request);
			if (request.method === "POST") {
				return Response.json({ skill_key: "demo", version: 1, file_count: 1 });
			}
			return Response.json({ status: "deleted" });
		};
		try {
			const { ApiClient, unwrap } = await import("../src/lib/api-client");
			const api = new ApiClient();
			await api.uploadSkill("workspace-project", "demo", Buffer.from("archive"), "demo.tar.gz");
			unwrap(
				await api.DELETE("/v1/projects/{project_id}/skills/{skill_key}", {
					params: {
						path: { project_id: "personal-project", skill_key: "demo" },
					},
				}),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
			[
				"POST /v1/projects/workspace-project/skills/upload",
				"DELETE /v1/projects/personal-project/skills/demo",
			],
		);
	});
});
