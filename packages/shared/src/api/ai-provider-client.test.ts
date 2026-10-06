import { expect, test } from "bun:test";
import { createAiProviderClient } from "./ai-provider-client";
import type { components } from "./api.generated";

test("provider acceptance preserves the caller's key and body across explicit retries, never auto-retries", async () => {
	const body: components["schemas"]["AiProviderAcceptRequest"] = {
		replace: false,
		credential: { type: "api_key", value: "fixture-secret" },
		provider: {
			provider_id: "openai",
			type: "openai",
			base_url: "https://api.openai.com/v1",
			auth: { type: "api_key", source: "managed" },
			managed_by: "user",
		},
	};
	const requests: { key: string | null; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(new URL(request.url).pathname).toBe("/v1/ai-providers/accept");
			expect(request.method).toBe("POST");
			requests.push({ key: request.headers.get("idempotency-key"), body: await request.json() });
			return Response.json({ detail: "unknown outcome" }, { status: 503 });
		},
	});
	try {
		const client = createAiProviderClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		await expect(client.accept(body, "bad\nkey")).rejects.toMatchObject({ status: 400 });
		expect(requests).toHaveLength(0);
		await expect(client.accept(body, "attempt-1")).rejects.toMatchObject({ status: 503 });
		expect(requests).toHaveLength(1);
		await expect(client.accept(body, "attempt-1")).rejects.toMatchObject({ status: 503 });
		expect(requests).toEqual([
			{ key: "attempt-1", body },
			{ key: "attempt-1", body },
		]);
	} finally {
		server.stop(true);
	}
});

test("provider metadata changes preserve identity, auth and label-only PATCH; failures never retry", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			const path = new URL(request.url).pathname;
			requests.push({
				method: request.method,
				path,
				body: request.method === "PATCH" ? await request.json() : null,
			});
			if (path.endsWith("/validate"))
				return Response.json({ detail: "private server diagnostic" }, { status: 409 });
			return Response.json({ providers: [] });
		},
	});
	try {
		const client = createAiProviderClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		await client.list();
		await client.update("connection/a?b", { label: "Work" });
		await expect(client.validate("connection/a?b")).rejects.toMatchObject({ status: 409 });
		expect(requests).toEqual([
			{ method: "GET", path: "/v1/ai-providers", body: null },
			{ method: "PATCH", path: "/v1/ai-providers/connection%2Fa%3Fb", body: { label: "Work" } },
			{ method: "POST", path: "/v1/ai-providers/connection%2Fa%3Fb/validate", body: null },
		]);
	} finally {
		server.stop(true);
	}
});
