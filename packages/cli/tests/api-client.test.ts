import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../src/lib/api-client";

// ApiClient reads ~/.clawdi/{auth,config}.json at construction via getAuth/getConfig.
// We redirect HOME to a tmpdir so each test gets a fresh auth/config.
let origHome: string | undefined;
let fakeHome: string;

function fakeLogin(apiUrl: string) {
	const dir = join(fakeHome, ".clawdi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ apiKey: "test-key", userId: "u1", email: "e" }),
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

	it("`requireAuth: false` constructs without credentials (device-flow bootstrap)", async () => {
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
			await api.GET("/api/auth/me");
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
				unwrap(await api.GET("/api/auth/me"));
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
			const result = unwrap(await api.GET("/api/auth/me"));
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
					await api.POST("/api/memories", {
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
					await api.DELETE("/api/memories/{memory_id}", {
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
});
