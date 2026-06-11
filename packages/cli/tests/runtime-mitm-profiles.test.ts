import { describe, expect, it } from "bun:test";
import { hostedManifestMitmProfiles } from "../src/runtime/hosted-mitm-profiles";
import { mitmProfileSchema } from "../src/runtime/mitm-profiles";

describe("runtime MITM profile schema", () => {
	it("accepts HTTP and websocket upstream base URLs", () => {
		const base = {
			id: "discord-rest",
			enabled: true,
			kind: "http",
			match: { scheme: "https", host: "discord.com", pathPrefix: "/api/" },
			rewrite: { upstreamBaseUrl: "https://router.test/discord" },
		};

		expect(mitmProfileSchema.safeParse(base).success).toBe(true);
		expect(
			mitmProfileSchema.safeParse({
				...base,
				id: "discord-gateway",
				kind: "websocket",
				match: { scheme: "wss", host: "gateway.discord.gg", pathPrefix: "/" },
				rewrite: { upstreamBaseUrl: "wss://router.test/discord/gateway" },
			}).success,
		).toBe(true);
	});

	it("accepts secretRef-backed rewrite headers", () => {
		expect(
			mitmProfileSchema.safeParse({
				id: "codex-chatgpt-backend-responses",
				enabled: true,
				kind: "provider",
				match: {
					scheme: "https",
					host: "chatgpt.com",
					path: { type: "equals", value: "/backend-api/codex/responses" },
					headers: { authorization: { type: "exists" } },
				},
				rewrite: {
					upstreamBaseUrl: "https://sub2api.test/backend-api/codex/responses",
					preservePath: false,
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: "secret://provider.default.apiKey",
							prefix: "Bearer ",
						},
					},
				},
			}).success,
		).toBe(true);
	});

	it("rejects upstream base URLs with unsupported schemes, credentials, or unsafe hosts", () => {
		const base = {
			id: "bad-upstream",
			enabled: true,
			kind: "http",
			match: { scheme: "https", host: "discord.com", pathPrefix: "/api/" },
		};

		for (const upstreamBaseUrl of [
			"secret://runtime/channels/url",
			"https://user:pass@router.test/discord",
			"https://.router.test/discord",
		]) {
			expect(
				mitmProfileSchema.safeParse({
					...base,
					rewrite: { upstreamBaseUrl },
				}).success,
			).toBe(false);
		}
	});

	it("rejects passthrough profiles", () => {
		expect(
			mitmProfileSchema.safeParse({
				id: "direct-egress",
				enabled: true,
				kind: "passthrough",
				match: { scheme: "https", host: "example.com", pathPrefix: "/" },
			}).success,
		).toBe(false);
	});

	it("rejects path prefixes that the native broker would reject", () => {
		expect(
			mitmProfileSchema.safeParse({
				id: "bad-prefix",
				enabled: true,
				kind: "http",
				match: { scheme: "https", host: "example.com", pathPrefix: "api/" },
				rewrite: { upstreamBaseUrl: "https://router.test" },
			}).success,
		).toBe(false);
	});

	it("routes ChatGPT Codex backend requests to provider responses endpoint", () => {
		const bundle = hostedManifestMitmProfiles({
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			providers: {
				default: {
					baseUrl: "https://sub2api.test/v1",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		const openai = bundle.profiles.find((profile) => profile.id === "codex-openai-responses");
		const chatgpt = bundle.profiles.find(
			(profile) => profile.id === "codex-chatgpt-backend-responses",
		);

		expect(openai?.rewrite.upstreamBaseUrl).toBe("https://sub2api.test/v1/responses");
		expect(openai?.rewrite.preservePath).toBe(false);
		expect(chatgpt?.rewrite.upstreamBaseUrl).toBe("https://sub2api.test/v1/responses");
		expect(chatgpt?.rewrite.preservePath).toBe(false);
	});
});
