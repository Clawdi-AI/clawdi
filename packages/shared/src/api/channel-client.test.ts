import { expect, test } from "bun:test";
import type { components } from "./api.generated";
import { createChannelClient } from "./channel-client";

test("channel links and pairing never expose runtime Agent tokens to consumers or caches", async () => {
	const client = createChannelClient({
		baseUrl: "https://cloud.example",
		getToken: async () => "fixture",
		fetch: async (request) => {
			const link = { id: "link", account_id: "bot", agent_id: "agent", agent_token: "sensitive" };
			if (request.method === "GET") return Response.json([link]);
			return Response.json({ ...link, code: "code", agent_link_id: "link" });
		},
	});
	expect((await client.links("bot"))[0]).not.toHaveProperty("agent_token");
	expect((await client.agentLinks("agent"))[0]).not.toHaveProperty("agent_token");
	expect(await client.link("bot", "agent", false)).not.toHaveProperty("agent_token");
	expect(await client.pair("bot", "link")).not.toHaveProperty("agent_token");
});

test("Custom bot creation preserves explicit inventory-only intent and does not return secrets", async () => {
	let sends = 0;
	const client = createChannelClient({
		baseUrl: "https://cloud.example",
		getToken: async () => "fixture",
		fetch: async (request) => {
			sends++;
			expect(await request.json()).toEqual({
				provider: "telegram",
				name: "Work",
				provider_token: "fixture-token",
				agent_id: null,
			});
			return Response.json({
				id: "bot",
				provider: "telegram",
				name: "Work",
				webhook_url: "https://cloud.example/hook",
				webhook_secret: "secret",
				agent_token: "runtime-secret",
			});
		},
	});
	expect(
		await client.create({
			provider: "telegram",
			name: "Work",
			provider_token: "fixture-token",
			agent_id: null,
		}),
	).toEqual({
		id: "bot",
		provider: "telegram",
		name: "Work",
		webhook_url: "https://cloud.example/hook",
	});
	expect(sends).toBe(1);
});

test("channel replacement is explicit; a conflict never triggers a replacement or an automatic retry", async () => {
	const requests: { path: string; method: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			requests.push({
				path: new URL(request.url).pathname,
				method: request.method,
				body: await request.json(),
			});
			return Response.json({ detail: "conflict" }, { status: 409 });
		},
	});
	try {
		const client = createChannelClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		await expect(client.link("bot/a", "agent", false)).rejects.toMatchObject({ status: 409 });
		expect(requests).toEqual([
			{ path: "/v1/channels/bot%2Fa/agent-links", method: "POST", body: { agent_id: "agent" } },
		]);
		await expect(client.link("bot/a", "agent", true)).rejects.toMatchObject({ status: 409 });
		expect(requests).toHaveLength(2);
		expect(requests[1]?.body).toEqual({ agent_id: "agent", replace_existing_provider_link: true });
	} finally {
		server.stop(true);
	}
});

test("empty 204 confirms deletion and unlinking; refusal is never reported as success", async () => {
	let status = 204;
	const client = createChannelClient({
		baseUrl: "https://cloud.example",
		getToken: async () => "fixture",
		fetch: async () => new Response(null, { status }),
	});
	expect(await client.remove("bot")).toBeNull();
	expect(await client.unlink("bot", "link")).toBeNull();
	status = 403;
	await expect(client.remove("bot")).rejects.toMatchObject({ status: 403 });
	await expect(client.unlink("bot", "link")).rejects.toMatchObject({ status: 403 });
});

test("unpair preserves partial cleanup and notification outcomes", async () => {
	const response = {
		binding_id: "chat",
		unpaired: true,
		notification_status: "failed",
		provider_cleanup_status: "failed",
		warning: "Partial cleanup",
	} satisfies components["schemas"]["ChannelBindingDeleteResponse"];
	const client = createChannelClient({
		baseUrl: "https://cloud.example",
		getToken: async () => "fixture",
		fetch: async (request) => {
			expect(request.method).toBe("DELETE");
			expect(new URL(request.url).pathname).toBe("/v1/channels/bot/bindings/chat");
			return Response.json(response);
		},
	});
	expect(await client.unpair("bot", "chat")).toEqual(response);
});
