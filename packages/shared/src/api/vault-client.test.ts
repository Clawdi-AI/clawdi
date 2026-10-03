import { expect, test } from "bun:test";
import { createVaultClient } from "./vault-client";

test("Vault operations retain exact identities and never fetch plaintext", async () => {
	const calls: { url: URL; method: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			calls.push({
				url: new URL(request.url),
				method: request.method,
				body: request.body ? await request.json() : null,
			});
			return Response.json({});
		},
	});
	try {
		const client = createVaultClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		const source = { id: "source-id", slug: "same/name?" };
		const target = { id: "target-id", slug: "target/name?" };
		await client.get(source);
		await client.sections(source);
		await client.upsert(source, { section: "", fields: { KEY: "synthetic" } });
		await client.deleteItems(source, { section: "", fields: ["KEY"] }, true);
		await client.copyItems(source, target, { section: "", fields: ["KEY"] });
		await client.remove(source);
		await client.detach(source, "project-id");
		expect(calls).toHaveLength(7);
		for (const call of calls) {
			expect(call.url.searchParams.get("vault_id")).toBe(source.id);
			expect(call.url.pathname).not.toContain("resolve");
		}
		expect(calls[0]?.url.pathname).toBe("/v1/vault/detail");
		expect(calls[0]?.url.searchParams.get("slug")).toBe(source.slug);
		expect(calls[1]?.url.pathname).toBe("/v1/vault/same%2Fname%3F/items");
		expect(calls[2]?.method).toBe("PUT");
		expect(calls[2]?.body).toEqual({ section: "", fields: { KEY: "synthetic" } });
		expect(calls[3]?.url.searchParams.get("global_delete")).toBe("true");
		expect(calls[4]?.url.searchParams.get("target_vault_id")).toBe(target.id);
		expect(calls[4]?.body).toEqual({ section: "", fields: ["KEY"], target_slug: target.slug });
		expect(calls[5]?.method).toBe("DELETE");
		expect(calls[5]?.url.searchParams.has("project_id")).toBe(false);
		expect(calls[6]?.url.searchParams.get("project_id")).toBe("project-id");
		await client.create({ slug: "new", name: "New" });
		expect(calls[7]?.url.searchParams.get("create_only")).toBe("true");
	} finally {
		server.stop(true);
	}
});

test("stale Vault identity errors do not retry against a slug or expose server details", async () => {
	let calls = 0;
	const client = createVaultClient({
		baseUrl: "https://vault.invalid",
		getToken: async () => "fixture",
		fetch: async () => {
			calls++;
			return Response.json({ detail: "sensitive-server-detail" }, { status: 404 });
		},
	});
	let caught: unknown;
	try {
		await client.get({ id: "deleted-id", slug: "reused-slug" });
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	expect(String(caught)).not.toContain("sensitive-server-detail");
	expect(calls).toBe(1);
});
