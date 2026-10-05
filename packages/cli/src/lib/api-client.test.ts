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
		).rejects.toThrow("Invalid skill_key (length=7, components=1, reason=invalid_component_start)");
	});
});

describe("ApiClient session upload origin", () => {
	it("sends the Agent origin for equal local IDs with unbound credentials", async () => {
		const origins: FormDataEntryValue[] = [];
		globalThis.fetch = (async (request: Request) => {
			expect(new URL(request.url).pathname).toBe("/v1/sessions/shared-id/upload");
			const form = await request.formData();
			const origin = form.get("environment_id");
			if (origin === null)
				return Response.json({ detail: "session_origin_required" }, { status: 409 });
			origins.push(origin);
			expect(form.get("expected_content_hash")).toBe("a".repeat(64));
			return Response.json({ status: "uploaded", content_hash: "a".repeat(64) });
		}) as typeof fetch;
		const api = new ApiClient({ requireAuth: false });
		for (const environmentId of ["agent-a", "agent-b"]) {
			await api.uploadSessionContent("shared-id", Buffer.from("[]"), "shared-id.json", {
				environmentId,
				expectedContentHash: "a".repeat(64),
			});
		}
		expect(origins).toEqual(["agent-a", "agent-b"]);
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

describe("ApiClient upload cancellation", () => {
	it.each(["before request", "during credentials"])(
		"does not send an upload canceled %s",
		async (timing) => {
			const abort = new AbortController();
			const api = new ApiClient({ requireAuth: false, abortSignal: abort.signal });
			let requests = 0;
			globalThis.fetch = (async (_request: Request) => {
				requests += 1;
				return Response.json({ status: "ok" });
			}) as typeof fetch;
			if (timing === "before request") abort.abort();
			else {
				api.getAccessToken = async () => {
					abort.abort();
					return "";
				};
			}
			await expect(
				api.uploadSessionEventGenerationChunk({
					localSessionId: "session",
					generation: "generation",
					startSeq: 0,
					baseHeadHash: "a".repeat(64),
					contentHash: "b".repeat(64),
					file: Buffer.from("{}\n"),
				}),
			).rejects.toMatchObject({ name: "ApiError", body: "aborted", isTimeout: false });
			expect(requests).toBe(0);
		},
	);
});
