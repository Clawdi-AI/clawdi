import { expect, test } from "bun:test";
import { ApiClientResponseError } from "./read-transport";
import {
	buildSessionShareRequest,
	sessionShareExportUrl,
	sessionShareMatchesTarget,
} from "./session-sharing";
import { createSessionSharingClient } from "./session-sharing-client";

test("sharing retains canonical event positions and does not widen excerpt scope", () => {
	const target = { scope: "response", position: 17 } as const;
	expect(buildSessionShareRequest(target)).toEqual({ scope: "response", position: 17 });
	expect(sessionShareMatchesTarget({ scope: "response", end_position: 17 }, target)).toBe(true);
	expect(sessionShareMatchesTarget({ scope: "through", end_position: 17 }, target)).toBe(false);
	expect(sessionShareMatchesTarget({ scope: "response", end_position: 16 }, target)).toBe(false);
	for (const position of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
		expect(() => buildSessionShareRequest({ scope: "through", position })).toThrow();
	expect(sessionShareExportUrl("https://example.test/cloud/s/share-id", "json")).toBe(
		"https://example.test/cloud/s/share-id.json",
	);
	for (const url of [
		"https://example.test/v1/sessions/id",
		"https://example.test/s/id?token=x",
		"https://user:secret@example.test/s/id",
		"http://example.test/s/id",
	])
		expect(sessionShareExportUrl(url, "md")).toBeNull();
});

test("share revocation accepts actual 204 responses and Markdown export preserves text", async () => {
	const requests: { method: string; path: string; query: string; body: unknown }[] = [];
	const markdown = "---\nsource: clawdi-session\n---\n# Private conversation\n";
	let html = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				path: url.pathname,
				query: url.search,
				body: request.method === "POST" ? await request.json() : null,
			});
			if (url.pathname.endsWith("export.md"))
				return new Response(html ? "<html>Login</html>" : markdown, {
					headers: { "content-type": html ? "text/html" : "text/markdown; charset=utf-8" },
				});
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			return Response.json({ id: "share" }, { status: 201 });
		},
	});
	try {
		const client = createSessionSharingClient({
			baseUrl: server.url.href,
			getToken: async () => "test-token",
			fetch: (request) => fetch(request),
		});
		await client.create("session", { scope: "response", position: 17 });
		await expect(client.revoke("link", "snapshot")).resolves.toBeNull();
		await expect(client.exportMarkdown("session")).resolves.toBe(markdown);
		expect(requests[0]?.body).toEqual({ scope: "response", position: 17 });
		expect(requests[1]).toEqual({
			method: "DELETE",
			path: "/v1/session-shares/link",
			query: "",
			body: null,
		});
		html = true;
		await expect(client.exportMarkdown("session")).rejects.toBeInstanceOf(ApiClientResponseError);
	} finally {
		await server.stop(true);
	}
});
