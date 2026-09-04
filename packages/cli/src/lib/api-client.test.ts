import { afterEach, describe, expect, it } from "bun:test";
import { ApiClient } from "./api-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("ApiClient.uploadSkill", () => {
	it("rejects invalid skill_key before building a multipart request", async () => {
		const api = new ApiClient({ requireAuth: false });

		await expect(
			api.uploadSkill(
				"00000000-0000-0000-0000-000000000000",
				".system",
				Buffer.from("not a tar"),
				".system.tar.gz",
			),
		).rejects.toThrow('Invalid skill_key: ".system"');
	});
});

describe("ApiClient machine fence", () => {
	it("sends one normalized identity through generated and handwritten request paths", async () => {
		const captured: Request[] = [];
		globalThis.fetch = (async (request: Request) => {
			captured.push(request.clone());
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			if (new URL(request.url).pathname === "/bytes") return new Response("content");
			return Response.json({ status: "ok" });
		}) as typeof fetch;

		const api = new ApiClient({ requireAuth: false, machineId: "  machine-1  " });
		await api.GET("/health");
		await api.uploadAgentSkill(
			"agent-1",
			"project-1",
			"demo",
			Buffer.from("archive"),
			"demo.tar.gz",
		);
		await api.deleteAgentSkill("agent-1", "demo", "project-1");
		await api.postJson<Record<string, unknown>>("/post");
		await api.postJsonBody<Record<string, unknown>>("/post-body", { ok: true });
		await api.getBytes("/bytes");

		expect(captured).toHaveLength(6);
		expect(
			captured.every((request) => request.headers.get("X-Clawdi-Machine-Id") === "machine-1"),
		).toBe(true);
	});
});
