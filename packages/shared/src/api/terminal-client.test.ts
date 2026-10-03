import { expect, test } from "bun:test";
import { ApiClientResponseError } from "./read-transport";
import { createTerminalClient } from "./terminal-client";

const baseUrl = "https://compute.example";
const fixture = () => ({
	deployment_id: "dep",
	websocket_url: "wss://compute.example/v2/deployments/dep/terminal/ws#token=fixture.jwt.token",
	expires_at: new Date(Date.now() + 60000).toISOString(),
});
test("terminal credentials use explicit authenticated POST without retry", async () => {
	let sends = 0;
	const client = createTerminalClient({
		baseUrl,
		getToken: async () => "account-token",
		fetch: async (request) => {
			sends++;
			expect(request.method).toBe("POST");
			expect(request.url).toBe(`${baseUrl}/v2/deployments/dep/terminal`);
			expect(request.headers.get("authorization")).toBe("Bearer account-token");
			return sends === 1
				? Response.json({ detail: "private error" }, { status: 503 })
				: Response.json(fixture());
		},
	});
	await expect(client.createSession("dep")).rejects.toMatchObject({ status: 503 });
	expect(sends).toBe(1);
	expect((await client.createSession("dep")).deployment_id).toBe("dep");
});
test("terminal rejects foreign, mismatched, expired or ambiguous capabilities", async () => {
	for (const session of [
		{ ...fixture(), deployment_id: "other" },
		{ ...fixture(), expires_at: "2000-01-01T00:00:00Z" },
		{
			...fixture(),
			websocket_url: "wss://other.example/v2/deployments/dep/terminal/ws#token=secret",
		},
		{
			...fixture(),
			websocket_url: "wss://compute.example/v2/deployments/other/terminal/ws#token=secret",
		},
		{
			...fixture(),
			websocket_url: "wss://compute.example/v2/deployments/dep/terminal/ws?token=one#token=two",
		},
		{ ...fixture(), websocket_url: "wss://compute.example/v2/deployments/dep/terminal/ws" },
	]) {
		const client = createTerminalClient({
			baseUrl,
			getToken: async () => "fixture",
			fetch: async () => Response.json(session),
		});
		await expect(client.createSession("dep")).rejects.toBeInstanceOf(ApiClientResponseError);
	}
});
