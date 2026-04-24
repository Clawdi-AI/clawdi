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
});

describe("ApiClient error classification", () => {
	it("throws ApiError with status + hint on 401", async () => {
		fakeLogin("http://127.0.0.1:0");
		const origFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
		try {
			const { ApiClient } = await import("../src/lib/api-client");
			const api = new ApiClient();
			let caught: unknown;
			try {
				await api.get("/anything");
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
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		try {
			const { ApiClient } = await import("../src/lib/api-client");
			const api = new ApiClient();
			const result = await api.get<{ ok: boolean }>("/retry-test");
			expect(result).toEqual({ ok: true });
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
			const { ApiClient } = await import("../src/lib/api-client");
			const api = new ApiClient();
			let caught: unknown;
			try {
				await api.post("/upload", { hello: "world" });
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
			const { ApiClient } = await import("../src/lib/api-client");
			const api = new ApiClient();
			let caught: unknown;
			try {
				await api.delete("/thing");
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
