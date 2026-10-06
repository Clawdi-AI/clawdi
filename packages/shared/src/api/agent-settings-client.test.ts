import { expect, test } from "bun:test";
import { EMPTY_AGENT_OWNERSHIP } from "../client";
import {
	createAgentSettingsClient,
	MAX_AGENT_AVATAR_BYTES,
	normalizeAgentDisplayName,
} from "./agent-settings-client";
import { createHostedComputeClient } from "./compute-client";

test("Agent identity writes use canonical paths, multipart bytes and 204 disconnect", async () => {
	const snapshots: { method: string; path: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			let body: unknown = null;
			if (request.method === "PATCH") body = await request.json();
			if (request.method === "POST") {
				expect(await request.clone().text()).toContain("Content-Type: image/png");
				const file = (await request.formData()).get("file");
				if (!(file instanceof File)) throw new Error("Expected multipart file");
				body = { size: file.size, type: file.type, bytes: await file.text() };
			}
			const path = new URL(request.url).pathname;
			snapshots.push({ method: request.method, path, body });
			return request.method === "DELETE" && !path.endsWith("/avatar")
				? new Response(null, { status: 204 })
				: Response.json({ id: "agent", display_name: "New name" });
		},
	});
	try {
		const client = createAgentSettingsClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		await client.setName("agent", " New name ");
		await client.setName("agent", " ");
		await client.uploadAvatar("agent", new Blob(["pixels"], { type: "image/png" }));
		await client.clearAvatar("agent");
		await client.disconnect("agent", {
			platform: "mobile",
			ownership: EMPTY_AGENT_OWNERSHIP,
			explicitIdentity: false,
		});
		expect(snapshots).toEqual([
			{ method: "PATCH", path: "/v1/agents/agent", body: { display_name: "New name" } },
			{ method: "PATCH", path: "/v1/agents/agent", body: { display_name: null } },
			{
				method: "POST",
				path: "/v1/agents/agent/avatar",
				body: { size: 6, type: "image/png", bytes: "pixels" },
			},
			{ method: "DELETE", path: "/v1/agents/agent/avatar", body: null },
			{ method: "DELETE", path: "/v1/agents/agent", body: null },
		]);
	} finally {
		server.stop(true);
	}
});

test("ownership reads require complete legacy identifiers rather than treating bad data as empty", async () => {
	let response: unknown = { environment_ids: ["agent"] };
	const client = createHostedComputeClient({
		baseUrl: "https://hosted.example",
		getToken: async () => "fixture",
		fetch: async (request) => {
			expect(new URL(request.url).pathname).toBe("/v1/agent-environments");
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			return Response.json(response);
		},
	});
	expect(await client.getLegacyAgentIds()).toEqual(["agent"]);
	for (const invalid of [{}, { environment_ids: [null] }, { environment_ids: [" "] }]) {
		response = invalid;
		await expect(client.getLegacyAgentIds()).rejects.toThrow("API response could not be read");
	}
});

test("invalid names/files and unresolved, managed or explicit identities fail before auth", async () => {
	let tokens = 0;
	const client = createAgentSettingsClient({
		baseUrl: "https://cloud.example",
		getToken: async () => {
			tokens++;
			return "fixture";
		},
		fetch: async () => {
			throw new Error("Unexpected network");
		},
	});
	expect(normalizeAgentDisplayName(" 😀\ud800 ")).toBe("😀");
	await expect(client.setName("agent", "😀".repeat(121))).rejects.toMatchObject({ status: 400 });
	for (const file of [
		new Blob([]),
		new Blob(["<svg/>"], { type: "image/svg+xml" }),
		new Blob([new Uint8Array(MAX_AGENT_AVATAR_BYTES + 1)], { type: "image/png" }),
	])
		await expect(client.uploadAvatar("agent", file)).rejects.toMatchObject({ status: 400 });
	for (const ownership of [
		null,
		{ ...EMPTY_AGENT_OWNERSHIP, isResolved: false },
		{ ...EMPTY_AGENT_OWNERSHIP, cloudAgentIds: new Set(["agent"]) },
		{ ...EMPTY_AGENT_OWNERSHIP, legacyAgentIds: new Set(["agent"]) },
	])
		await expect(
			client.disconnect("agent", { platform: "mobile", ownership }),
		).rejects.toMatchObject({ status: 403 });
	await expect(
		client.disconnect("agent", {
			platform: "mobile",
			ownership: EMPTY_AGENT_OWNERSHIP,
			explicitIdentity: true,
		}),
	).rejects.toMatchObject({ status: 403 });
	expect(tokens).toBe(0);
});

test("identity failures do not auto-retry and foreign responses cannot replace account caches", async () => {
	let sends = 0;
	const client = createAgentSettingsClient({
		baseUrl: "https://cloud.example",
		getToken: async () => "fixture",
		fetch: async () => {
			sends++;
			return sends === 1
				? Response.json({ detail: "Unavailable" }, { status: 503 })
				: Response.json({ id: "other" });
		},
	});
	await expect(client.setName("agent", "Name")).rejects.toMatchObject({ status: 503 });
	expect(sends).toBe(1);
	await expect(client.clearAvatar("agent")).rejects.toThrow("API response could not be read");
	await expect(
		client.disconnect("agent", { platform: "mobile", ownership: EMPTY_AGENT_OWNERSHIP }),
	).rejects.toThrow("API response could not be read");
});
