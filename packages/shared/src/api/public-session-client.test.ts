import { expect, test } from "bun:test";
import { createPublicSessionClient, publicSessionInput } from "./public-session-client";
import { ApiClientError, ApiClientResponseError } from "./read-transport";

const id = "12345678-1234-1234-1234-123456789abc";
test("snapshot access is anonymous and revocation never falls back to another resource", async () => {
	let tokens = 0;
	let calls = 0;
	const client = createPublicSessionClient({
		baseUrl: "https://api.example.test",
		getToken: async () => {
			tokens++;
			return "account-token";
		},
		fetch: async (request, init) => {
			calls++;
			expect(request.headers.has("authorization")).toBe(false);
			expect(init).toMatchObject({
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			});
			return Response.json({}, { status: 410 });
		},
	});
	await expect(client.resolve(id)).rejects.toMatchObject({ status: 410 });
	expect(tokens).toBe(0);
	expect(calls).toBe(1);
});
test("only a missing snapshot metadata permits authenticated live-link fallback", async () => {
	const paths: string[] = [];
	let tokens = 0;
	const client = createPublicSessionClient({
		baseUrl: "https://api.example.test",
		getToken: async () => {
			tokens++;
			return "account-token";
		},
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			paths.push(path);
			if (path.includes("session-shares")) {
				expect(request.headers.has("authorization")).toBe(false);
				return Response.json({}, { status: 404 });
			}
			expect(request.headers.get("authorization")).toBe("Bearer account-token");
			return Response.json({
				id,
				summary: null,
				agent_type: null,
				model: null,
				started_at: "2026-10-03T00:00:00Z",
				message_count: 0,
			});
		},
	});
	expect((await client.resolve(id)).source).toBe("live");
	expect(tokens).toBe(1);
	expect(paths).toEqual([`/v1/public/session-shares/${id}`, `/v1/public/sessions/${id}`]);
});
test("foreign metadata and incorrect page offsets are rejected rather than appended", async () => {
	const client = createPublicSessionClient({
		baseUrl: "https://api.example.test",
		fetch: async (request) =>
			Response.json(
				request.url.endsWith(id)
					? { id: "other" }
					: { items: [], offset: 0, limit: 50, total: 100 },
			),
	});
	await expect(client.resolve(id)).rejects.toBeInstanceOf(ApiClientResponseError);
	await expect(client.messages(id, "snapshot", 50)).rejects.toBeInstanceOf(ApiClientResponseError);
	await expect(client.messages(id, "snapshot", 0)).rejects.toBeInstanceOf(ApiClientResponseError);
	await expect(client.messages(id, "snapshot", -1)).rejects.toBeInstanceOf(ApiClientError);
});
test("snapshot exports stay anonymous and validate Markdown media type and JSON identity", async () => {
	let tokens = 0;
	const client = createPublicSessionClient({
		baseUrl: "https://api.example.test",
		getToken: async () => {
			tokens++;
			return "private";
		},
		fetch: async (request) => {
			expect(request.headers.has("authorization")).toBe(false);
			return request.url.endsWith("export.md")
				? new Response("# Shared", { headers: { "content-type": "text/markdown; charset=utf-8" } })
				: Response.json({ id, messages: [{ role: "assistant", content: "shared only" }] });
		},
	});
	expect(await client.exportMarkdown(id, "snapshot")).toBe("# Shared");
	expect((await client.exportJson(id, "snapshot")).messages).toHaveLength(1);
	expect(tokens).toBe(0);
});
test("share input yields only an ID, never a remote request target or arbitrary route", () => {
	expect(publicSessionInput(`https://example.test/s/${id}`)).toBe(id);
	expect(publicSessionInput(`clawdi://s/${id}`)).toBe(id);
	for (const input of [
		`https://user:pass@example.test/s/${id}`,
		`https://example.test/s/${id}?redirect=/account`,
		`https://example.test/s/${id}/export.md`,
		`file:///s/${id}`,
		"../account",
	])
		expect(publicSessionInput(input)).toBeNull();
});
