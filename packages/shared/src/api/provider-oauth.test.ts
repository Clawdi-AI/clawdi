import { expect, test } from "bun:test";
import { createAiProviderClient } from "./ai-provider-client";
import { codexDeviceVerificationUrl, devicePollDelay } from "./provider-oauth";

test("device authorization links cannot redirect users to another origin or leak state through query/fragment", () => {
	expect(codexDeviceVerificationUrl("https://auth.openai.com/codex/device")).toBe(
		"https://auth.openai.com/codex/device",
	);
	for (const value of [
		"http://auth.openai.com/codex/device",
		"https://auth.openai.com.evil.test/codex/device",
		"https://user@auth.openai.com/codex/device",
		"https://auth.openai.com/codex/device?redirect=evil",
		"https://auth.openai.com/codex/device#state",
		"https://auth.openai.com/oauth/authorize",
	])
		expect(() => codexDeviceVerificationUrl(value)).toThrow();
	expect(devicePollDelay(0)).toBe(1000);
	expect(devicePollDelay(7)).toBe(7000);
	for (const value of [-1, NaN, Infinity, 86401]) expect(() => devicePollDelay(value)).toThrow();
});

test("device start and polling use account authentication and body-only state on the exact escaped provider", async () => {
	const calls: { path: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			expect(request.method).toBe("POST");
			calls.push({ path: new URL(request.url).pathname, body: await request.json() });
			return Response.json({ status: "pending", retry_after_seconds: 5 });
		},
	});
	try {
		const client = createAiProviderClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		await client.startDeviceAuthorization("work/a?b");
		await client.pollDeviceAuthorization("work/a?b", "opaque-state");
		expect(calls).toEqual([
			{
				path: "/v1/ai-providers/work%2Fa%3Fb/auth/oauth/device/start",
				body: { provider: "codex" },
			},
			{
				path: "/v1/ai-providers/work%2Fa%3Fb/auth/oauth/device/poll",
				body: { state: "opaque-state" },
			},
		]);
	} finally {
		server.stop(true);
	}
});
