import { expect, test } from "bun:test";
import { createAiProviderClient } from "./ai-provider-client";

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
