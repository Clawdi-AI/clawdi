import { describe, expect, it } from "bun:test";
import {
	directProviderPassthroughProfile,
	directProviderPassthroughProfiles,
	hostedManifestMitmProfiles,
} from "../src/runtime/hosted-mitm-profiles";
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

	it("accepts passthrough profiles without rewrite rules", () => {
		expect(
			mitmProfileSchema.safeParse({
				id: "direct-egress",
				enabled: true,
				kind: "passthrough",
				match: { scheme: "https", host: "example.com", pathPrefix: "/" },
			}).success,
		).toBe(true);
		expect(
			mitmProfileSchema.safeParse({
				id: "direct-egress",
				enabled: true,
				kind: "passthrough",
				match: { scheme: "https", host: "example.com", pathPrefix: "/" },
				rewrite: { upstreamBaseUrl: "https://router.test" },
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

	it("does not enable the hosted broker for directly projected providers", () => {
		const bundle = hostedManifestMitmProfiles({
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			providers: {
				default: {
					baseUrl: "https://ai-gateway.example.test/v1",
					apiMode: "openai_chat",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(bundle.profiles).toEqual([]);
	});

	it("does not derive provider MITM profiles from hosted provider projection", () => {
		const bundle = hostedManifestMitmProfiles({
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			providers: {
				default: {
					baseUrl: "https://ai-gateway.example.test/v1",
					apiMode: "openai_responses",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(bundle.profiles).toEqual([]);
	});

	it("builds a direct provider allowlist only when another manifest feature enables the broker", () => {
		const direct = directProviderPassthroughProfile({
			providers: {
				default: {
					baseUrl: "https://ai-gateway.example.test/v1",
					apiMode: "openai_chat",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(direct).toMatchObject({
			enabled: true,
			kind: "passthrough",
			match: {
				scheme: "https",
				host: "ai-gateway.example.test",
				pathPrefix: "/v1/",
				headers: {},
				query: {},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 240,
			owner: "provider-projection",
		});
	});

	it("builds direct provider allowlists for runtime-scoped providers", () => {
		const direct = directProviderPassthroughProfiles({
			providers: {
				openclaw: {
					baseUrl: "https://openclaw-provider.example.test/v1",
					apiMode: "openai_chat",
					apiKeySecretRef: "provider.openclaw.apiKey",
				},
				hermes: {
					baseUrl: "https://hermes-provider.example.test/v1",
					apiMode: "openai_responses",
					apiKeySecretRef: "provider.hermes.apiKey",
				},
			},
		});

		expect(direct.map((profile) => profile.id)).toEqual([
			"direct-provider-passthrough-hermes",
			"direct-provider-passthrough-openclaw",
		]);
		expect(direct.map((profile) => profile.match.host)).toEqual([
			"hermes-provider.example.test",
			"openclaw-provider.example.test",
		]);
	});

	it("does not derive provider MITM profiles without explicit manifest profiles", () => {
		const bundle = hostedManifestMitmProfiles({
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			providers: {
				default: {
					baseUrl: "https://sub2api.test/v1",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(bundle.profiles).toEqual([]);
	});
});
